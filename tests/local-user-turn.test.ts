import assert from "node:assert/strict";
import test from "node:test";
import { appendPendingUserMessage, bindQueuedAdmission, bindQueuedDispatch, markLocalTurnQueued, nextLocalTurnTotal, protectTranscriptWithLocalTurns, removeLocalTurnAndRebase, transcriptConfirmsLocalTurn, transcriptTurnTotal, type LocalUserTurn } from "../src/web/lib/local-user-turn";
import { SessionViewCache } from "../src/web/lib/session-view-cache";
import type { PiMessage, SessionViewData } from "../src/shared/types";

const previous: PiMessage = { role: "user", content: "earlier" };
const local: PiMessage = { role: "user", content: "submitted just now" };
const pending: LocalUserTurn = { sessionId: "session-a", message: local, expectedTurnTotal: 2 };

test("the immediate composer overlay does not duplicate its protected local turn", () => {
  const localWithTimestamp: PiMessage = { role: "user", content: "submitted just now", timestamp: 42 };
  assert.deepEqual(appendPendingUserMessage([previous, localWithTimestamp], localWithTimestamp), [previous, localWithTimestamp]);
  // Same text and same millisecond timestamp in a separate instruction must
  // remain a real second turn; Date.now() is not a unique message identity.
  const secondIdenticalInstruction: PiMessage = { role: "user", content: "submitted just now", timestamp: 42 };
  assert.deepEqual(appendPendingUserMessage([previous, localWithTimestamp], secondIdenticalInstruction), [previous, localWithTimestamp, secondIdenticalInstruction]);
});

test("a stale busy transcript keeps the accepted local user turn visible", () => {
  const stale = protectTranscriptWithLocalTurns([pending], [previous], 1, 1);

  assert.equal(stale.pendingTurns.length, 1);
  assert.deepEqual(stale.messages, [previous, local]);
  assert.equal(stale.messageTotal, 2);
  assert.equal(stale.turnTotal, 2);
});

test("the authoritative transcript replaces the local turn exactly once when persisted", () => {
  const persistedLocal: PiMessage = { role: "user", content: [{ type: "text", text: "submitted just now" }] };
  const authoritative = [previous, persistedLocal, { role: "assistant", content: "answer" }];
  const protectedTranscript = protectTranscriptWithLocalTurns([pending], authoritative, 3, 2);

  assert.equal(transcriptConfirmsLocalTurn(pending, authoritative, 2), true);
  assert.equal(protectedTranscript.pendingTurns.length, 0);
  assert.equal(protectedTranscript.messages, authoritative);
  assert.equal(transcriptTurnTotal(protectedTranscript.messages, protectedTranscript.turnTotal), 2);
});

test("a turn-count watermark cannot hide a local message before its content reaches the authoritative window", () => {
  const staleMessages = [previous, { role: "assistant", content: "previous answer" }];
  assert.equal(transcriptConfirmsLocalTurn(pending, staleMessages, 2), false);
  const protectedTranscript = protectTranscriptWithLocalTurns([pending], staleMessages, 2, 2);
  assert.deepEqual(protectedTranscript.pendingTurns, [pending]);
  assert.deepEqual(protectedTranscript.messages, [...staleMessages, local]);
});

test("a local user overlay stays before an already-cached assistant terminal", () => {
  const timedLocal: PiMessage = { role: "user", content: "new question", timestamp: 30 };
  const timedPending: LocalUserTurn = { sessionId: "session-a", message: timedLocal, expectedTurnTotal: 2 };
  const staleWithTerminal: PiMessage[] = [
    { role: "user", content: "old question", timestamp: 10 },
    { role: "assistant", content: "old answer", timestamp: 20 },
    { role: "assistant", content: "new answer", timestamp: 40 },
  ];
  const protectedTranscript = protectTranscriptWithLocalTurns([timedPending], staleWithTerminal, 4, 2);
  assert.deepEqual(protectedTranscript.messages, [staleWithTerminal[0], staleWithTerminal[1], timedLocal, staleWithTerminal[2]]);
  assert.deepEqual(protectedTranscript.pendingTurns, [timedPending]);
});

test("waiting queued turns stay only in the queue until each is dispatched", () => {
  const first: LocalUserTurn = { sessionId: "session-a", message: local, expectedTurnTotal: 2, queueId: "queue-a", queueState: "waiting" };
  const second: LocalUserTurn = { sessionId: "session-a", message: { role: "user", content: "and one more" }, expectedTurnTotal: 3, queueId: "queue-b", queueState: "waiting" };
  const stale = protectTranscriptWithLocalTurns([first, second], [previous], 1, 1);

  assert.deepEqual(stale.messages, [previous]);
  assert.deepEqual(stale.pendingTurns, [first, second]);
  assert.equal(stale.messageTotal, 1);
  assert.equal(stale.turnTotal, 1);
  assert.equal(nextLocalTurnTotal([previous], 1, [first, second]), 4);

  first.queueState = "dispatched";
  const firstDispatched = protectTranscriptWithLocalTurns([first, second], [previous], 1, 1);
  assert.deepEqual(firstDispatched.messages, [previous, local]);
  assert.equal(firstDispatched.messageTotal, 2);
  assert.equal(firstDispatched.turnTotal, 2);

  const firstPersistedMessage: PiMessage = { role: "user", content: [{ type: "text", text: "submitted just now" }] };
  const firstPersisted = protectTranscriptWithLocalTurns([first, second], [previous, firstPersistedMessage], 2, 2);
  assert.deepEqual(firstPersisted.pendingTurns, [second]);
  assert.deepEqual(firstPersisted.messages, [previous, firstPersistedMessage]);
  assert.equal(firstPersisted.turnTotal, 2);
});

test("queue update hides an optimistic turn before its HTTP acknowledgement", () => {
  const first: LocalUserTurn = { sessionId: "session-a", message: { role: "user", content: "same" }, expectedTurnTotal: 2, renderedInTranscript: true };
  const second: LocalUserTurn = { sessionId: "session-a", message: { role: "user", content: "same" }, expectedTurnTotal: 3, renderedInTranscript: true };
  const turns = [first, second];
  assert.equal(bindQueuedAdmission(turns, "queue-1", "same", 0), first);
  assert.equal(first.queueState, "waiting");
  assert.equal(bindQueuedAdmission(turns, "queue-2", "same", 0), second);
  assert.equal(second.queueState, "waiting");
  assert.equal(bindQueuedDispatch(turns, "queue-1", "same", 0), first);
  assert.equal(first.queueState, "dispatched");
});

test("queue dispatch binds to an unacknowledged local turn instead of duplicating it", () => {
  const imageTurn: LocalUserTurn = {
    sessionId: "session-a",
    message: { role: "user", content: [{ type: "text", text: "inspect" }, { type: "image", data: "AA==", mimeType: "image/png" }] },
    expectedTurnTotal: 2,
  };
  const turns = [imageTurn];
  assert.equal(bindQueuedDispatch(turns, "queue-1", "inspect", 1), imageTurn);
  assert.equal(imageTurn.queueId, "queue-1");
  assert.equal(imageTurn.queueState, "dispatched");
  imageTurn.queueState = "waiting";
  assert.equal(bindQueuedDispatch(turns, "queue-1", "inspect", 1), imageTurn);
  assert.equal(imageTurn.queueState, "dispatched");
  assert.equal(turns.length, 1);
});

test("a late queue acknowledgement never demotes an already dispatched turn", () => {
  const turn: LocalUserTurn = { sessionId: "session-a", message: local, expectedTurnTotal: 2, queueState: "dispatched" };
  markLocalTurnQueued(turn, "queue-late");
  assert.equal(turn.queueId, "queue-late");
  assert.equal(turn.queueState, "dispatched");
});

test("cancelling an earlier queued turn rebases every later local turn", () => {
  const first: LocalUserTurn = { sessionId: "session-a", message: local, expectedTurnTotal: 2, queueId: "a", queueState: "waiting" };
  const second: LocalUserTurn = { sessionId: "session-a", message: { role: "user", content: "second" }, expectedTurnTotal: 3, queueId: "b", queueState: "waiting" };
  const third: LocalUserTurn = { sessionId: "session-a", message: { role: "user", content: "third" }, expectedTurnTotal: 4, queueId: "c", queueState: "waiting" };
  assert.deepEqual(removeLocalTurnAndRebase([first, second, third], first), [second, third]);
  assert.equal(second.expectedTurnTotal, 2);
  assert.equal(third.expectedTurnTotal, 3);
});

test("an observer image placeholder is confirmed by its authoritative turn position", () => {
  const placeholder: LocalUserTurn = {
    sessionId: "session-a",
    message: { role: "user", content: "请查看附加的 1 张图片" },
    expectedTurnTotal: 2,
    queueId: "queue-image",
    confirmByPosition: true,
  };
  const authoritative: PiMessage[] = [
    previous,
    { role: "user", content: [{ type: "text", text: "请查看这些图片。" }, { type: "image", data: "persisted", mimeType: "image/png" }] },
  ];
  assert.equal(transcriptConfirmsLocalTurn(placeholder, authoritative, 2), true);
  assert.deepEqual(protectTranscriptWithLocalTurns([placeholder], authoritative, 2, 2).pendingTurns, []);
});

test("cache navigation never mistakes its own local overlay for persisted history", () => {
  const cache = new SessionViewCache();
  const source: SessionViewData = {
    session: { id: "session-a", sessionId: "session-a", name: "A", preview: "", cwd: "C:/", updatedAt: 1, messageCount: 1, active: true },
    state: { model: null, isStreaming: true },
    messages: [previous],
    messageTotal: 1,
    turnTotal: 1,
    messagesTruncated: false,
    isActive: true,
    isStreaming: true,
  };
  const cachedSource = cache.remember(source);
  const firstPaint = protectTranscriptWithLocalTurns([pending], cachedSource.messages, cachedSource.messageTotal, cachedSource.turnTotal);
  assert.deepEqual(firstPaint.messages, [previous, local]);
  assert.equal(firstPaint.turnTotal, 2);

  const returnedSource = cache.get("session-a")!;
  assert.equal(returnedSource.turnTotal, 1);
  assert.deepEqual(returnedSource.messages, [previous]);
  const returnedPaint = protectTranscriptWithLocalTurns(firstPaint.pendingTurns, returnedSource.messages, returnedSource.messageTotal, returnedSource.turnTotal);
  assert.deepEqual(returnedPaint.messages, [previous, local]);
  assert.deepEqual(returnedPaint.pendingTurns, [pending]);
});

test("a late prompt acknowledgement cannot reappend a local turn already confirmed by a view", async () => {
  const { appendLocalTurnOnce } = await import("../src/web/lib/local-user-turn");
  const localTurn: LocalUserTurn = { sessionId: "session-a", message: local, expectedTurnTotal: 2 };
  const firstPaint = appendLocalTurnOnce([previous], localTurn);
  assert.deepEqual(firstPaint, [previous, local]);

  // The authoritative view confirms and removes the local overlay before the
  // accepted-prompt HTTP acknowledgement reaches the browser.
  localTurn.renderedInTranscript = false;
  const authoritative = [previous, { role: "user" as const, content: "submitted just now" }];
  const pendingAfterView = protectTranscriptWithLocalTurns([localTurn], authoritative, 2, 2).pendingTurns;
  assert.deepEqual(pendingAfterView, []);
  assert.deepEqual(appendLocalTurnOnce(authoritative, pendingAfterView[0]), authoritative);
});
