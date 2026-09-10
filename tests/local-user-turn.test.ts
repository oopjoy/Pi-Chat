import assert from "node:assert/strict";
import test from "node:test";
import { appendLocalTurnOnce, appendPendingUserMessage, bindQueuedAdmission, bindQueuedDispatch, consumeLocalSteeringTurn, diagnoseVisibleUserTurnDuplicates, markLocalTurnQueued, nextLocalTurnTotal, promoteTurnsAbsentFromQueue, protectTranscriptWithLocalTurns, queuedPromptFromLocalTurn, removeLocalTurnAndRebase, removePendingSteeringTurns, transcriptConfirmsLocalTurn, transcriptTurnTotal, type LocalUserTurn } from "../src/web/lib/local-user-turn";
import { SessionViewCache } from "../src/web/lib/session-view-cache";
import type { PiMessage, SessionViewData } from "../src/shared/types";

const previous: PiMessage = { role: "user", content: "earlier" };
const local: PiMessage = { role: "user", content: "submitted just now" };
const pending: LocalUserTurn = { sessionId: "session-a", message: local, expectedTurnTotal: 2 };

test("diagnoseVisibleUserTurnDuplicates classifies local plus persisted duplicates without retaining content", () => {
  const message: PiMessage = { role: "user", content: "same prompt", timestamp: 1000 };
  const persisted = { ...message, piChatPersistedMessageId: "persisted-1" };
  const turn: LocalUserTurn = { sessionId: "session", message, expectedTurnTotal: 1 };
  const result = diagnoseVisibleUserTurnDuplicates([message, persisted], [turn]);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "local-and-persisted");
  assert.equal(result[0].persistedCount, 1);
  assert.match(result[0].contentHash, /^[a-f0-9]{8}$/);
  assert.equal("content" in result[0], false);
});

test("the pending overlay is suppressed by the latest persisted echo", () => {
  const pending: PiMessage = { role: "user", content: "same prompt", timestamp: 42 };
  const persisted = { ...pending, piChatPersistedMessageId: "persisted-1" };
  assert.deepEqual(appendPendingUserMessage([previous, persisted], pending), [previous, persisted]);
});

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

test("transcript protection does not append a local turn already present by identity", () => {
  const dispatched: LocalUserTurn = {
    ...pending,
    queueState: "dispatched",
  };
  const alreadyPaintedEarlier: PiMessage = { role: "user", content: "different earlier" };
  const protectedTranscript = protectTranscriptWithLocalTurns(
    [{ ...dispatched, expectedTurnTotal: 3 }],
    [alreadyPaintedEarlier, local],
    2,
    4,
  );
  assert.deepEqual(protectedTranscript.messages, [alreadyPaintedEarlier, local]);
  const protectedTurn = protectedTranscript.pendingTurns[0];
  assert.ok(protectedTurn);
  assert.equal(protectedTurn.renderedInTranscript, true);
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

test("a persisted user row confirms a local turn even when its window watermark is stale", () => {
  const persisted = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "submitted just now" }],
    timestamp: 99,
    piChatPersistedMessageId: "entry-2:0",
  };
  const timedPending = { ...pending, message: { ...pending.message, timestamp: 98 } };
  const protectedTranscript = protectTranscriptWithLocalTurns(
    [timedPending],
    [persisted],
    1,
    1,
  );
  assert.equal(protectedTranscript.pendingTurns.length, 0);
  assert.deepEqual(protectedTranscript.messages, [persisted]);
});

test("a late acknowledgement does not append an equivalent persisted user row", () => {
  const persisted = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "submitted just now" }],
    timestamp: 99,
    piChatPersistedMessageId: "entry-2:0",
  };
  const turn = { ...pending };
  assert.deepEqual(
    appendLocalTurnOnce([previous, persisted], turn),
    [previous, persisted],
  );
});

test("two distinct identical prompts remain two user turns", () => {
  const first = { ...pending, expectedTurnTotal: 2 };
  const second: LocalUserTurn = {
    sessionId: "session-a",
    message: { role: "user", content: "submitted just now", timestamp: 43 },
    expectedTurnTotal: 3,
  };
  const persisted = [
    { role: "user" as const, content: [{ type: "text" as const, text: "submitted just now" }], timestamp: 42, piChatPersistedMessageId: "entry-2:0" },
    { role: "user" as const, content: [{ type: "text" as const, text: "submitted just now" }], timestamp: 44, piChatPersistedMessageId: "entry-3:0" },
  ];
  const protectedTranscript = protectTranscriptWithLocalTurns(
    [first, second],
    persisted,
    2,
    3,
  );
  assert.equal(protectedTranscript.pendingTurns.length, 0);
  assert.equal(protectedTranscript.messages.length, 2);
  assert.equal(appendLocalTurnOnce([persisted[0]], second).length, 2);
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

test("native steering stays hidden until Pi consumes it and clears safely before consumption", () => {
  const steering: LocalUserTurn = {
    sessionId: "session-a",
    message: { role: "user", content: "redirect now" },
    expectedTurnTotal: 2,
    queueState: "waiting",
    revealOnMessageStart: true,
  };
  assert.deepEqual(
    protectTranscriptWithLocalTurns([steering], [previous], 1, 1).messages,
    [previous],
  );
  assert.equal(
    consumeLocalSteeringTurn(
      [steering],
      { role: "user", content: "redirect now" },
    ),
    steering,
  );
  assert.equal(steering.queueState, "dispatched");
  const sameTextDifferentSteer: LocalUserTurn = {
    sessionId: "session-a",
    message: { role: "user", content: "redirect now" },
    expectedTurnTotal: 3,
    queueId: "steer-2",
    queueState: "waiting",
    revealOnMessageStart: true,
  };
  assert.equal(
    consumeLocalSteeringTurn(
      [steering, sameTextDifferentSteer],
      { role: "user", content: "provider-normalized" },
      "steer-2",
    ),
    sameTextDifferentSteer,
    "the server-provided steer ID must win over text matching",
  );
  assert.deepEqual(
    protectTranscriptWithLocalTurns([steering], [previous], 1, 1).messages,
    [previous, steering.message],
  );

  const unconsumed: LocalUserTurn = {
    sessionId: "session-a",
    message: { role: "user", content: "never consumed" },
    expectedTurnTotal: 3,
    queueState: "waiting",
    revealOnMessageStart: true,
  };
  assert.deepEqual(removePendingSteeringTurns([steering, unconsumed]), [steering]);

  const imageOnly: LocalUserTurn = {
    sessionId: "session-a",
    message: {
      role: "user",
      content: [{ type: "image", data: "local", mimeType: "image/png" }],
    },
    expectedTurnTotal: 3,
    queueState: "waiting",
    revealOnMessageStart: true,
  };
  assert.equal(
    consumeLocalSteeringTurn([imageOnly], {
      role: "user",
      content: [
        { type: "text", text: "请查看这些图片。" },
        { type: "image", data: "local", mimeType: "image/png" },
      ],
    }),
    imageOnly,
  );
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

test("waiting local turns have a stable synthetic queue projection while authority is missing", () => {
  const turn: LocalUserTurn = {
    sessionId: "session-a",
    message: {
      role: "user",
      content: [
        { type: "text", text: "inspect these" },
        { type: "image", data: "AA==", mimeType: "image/png" },
      ],
      timestamp: 42,
    },
    expectedTurnTotal: 2,
    queueId: "queue-fallback",
    queueState: "waiting",
  };
  assert.deepEqual(queuedPromptFromLocalTurn(turn), {
    id: "queue-fallback",
    message: "inspect these",
    imageCount: 1,
    createdAt: 42,
  });
  assert.equal(
    queuedPromptFromLocalTurn({ ...turn, queueState: "dispatched" }),
    undefined,
  );
});

test("an authoritative empty queue promotes a waiting ordinary turn even after idle", () => {
  const turn: LocalUserTurn = {
    sessionId: "session-a",
    message: local,
    expectedTurnTotal: 2,
    queueId: "queue-authoritative-empty",
    queueState: "waiting",
  };
  assert.deepEqual(
    promoteTurnsAbsentFromQueue([turn], new Set<string>(), false, true),
    [turn],
  );
  assert.equal(turn.queueState, "dispatched");

  const retrying: LocalUserTurn = {
    ...turn,
    queueState: "waiting",
    queueRetryPending: true,
  };
  assert.deepEqual(
    promoteTurnsAbsentFromQueue([retrying], new Set<string>(), false, true),
    [],
  );
  assert.equal(retrying.queueState, "waiting");

  const steering: LocalUserTurn = {
    ...turn,
    queueState: "waiting",
    queueRetryPending: false,
    revealOnMessageStart: true,
  };
  assert.deepEqual(
    promoteTurnsAbsentFromQueue([steering], new Set<string>(), false, true),
    [],
  );
  assert.equal(steering.queueState, "waiting");

  const first: LocalUserTurn = {
    ...turn,
    queueId: "queue-first",
    queueState: "waiting",
  };
  const second: LocalUserTurn = {
    ...turn,
    message: { role: "user", content: "second" },
    queueId: "queue-second",
    queueState: "waiting",
  };
  assert.deepEqual(
    promoteTurnsAbsentFromQueue(
      [first, second],
      new Set(["queue-second"]),
      false,
      true,
    ),
    [first],
  );
  assert.equal(first.queueState, "dispatched");
  assert.equal(second.queueState, "waiting");
});

test("an inflated non-truncated turn watermark cannot delete an absent local turn", () => {
  const stale = protectTranscriptWithLocalTurns(
    [{ ...pending, expectedTurnTotal: 2, queueState: "dispatched" }],
    [previous],
    1,
    10,
    false,
  );
  assert.equal(stale.pendingTurns.length, 1);
  assert.deepEqual(stale.messages, [previous, local]);

  const waiting = protectTranscriptWithLocalTurns(
    [{ ...pending, expectedTurnTotal: 2, queueId: "queue-live", queueState: "waiting" }],
    [previous],
    1,
    10,
    false,
    new Set(["queue-live"]),
  );
  assert.equal(waiting.pendingTurns.length, 1);
  assert.deepEqual(waiting.messages, [previous]);

  const retrying = protectTranscriptWithLocalTurns(
    [{ ...pending, expectedTurnTotal: 2, queueId: "queue-retry", queueState: "waiting", queueRetryPending: true }],
    [previous],
    1,
    10,
    false,
    new Set<string>(),
  );
  assert.equal(retrying.pendingTurns.length, 1);
  assert.deepEqual(retrying.messages, [previous]);
});

test("a view after a missed queue dispatch reveals a local turn no longer in Pi's queue", async () => {
  const turn: LocalUserTurn = {
    sessionId: "session-a",
    message: local,
    expectedTurnTotal: 2,
    queueId: "queue-1",
    queueState: "waiting",
  };
  promoteTurnsAbsentFromQueue([turn], new Set<string>(), true);
  assert.equal(turn.queueState, "dispatched");

  const stillQueued: LocalUserTurn = { ...turn, queueState: "waiting", queueId: "queue-2" };
  promoteTurnsAbsentFromQueue([stillQueued], new Set(["queue-2"]), true);
  assert.equal(stillQueued.queueState, "waiting");

  const retrying: LocalUserTurn = {
    ...turn,
    queueState: "waiting",
    queueId: "queue-error",
    queueRetryPending: true,
  };
  promoteTurnsAbsentFromQueue([retrying], new Set<string>(), true);
  assert.equal(retrying.queueState, "waiting");

  const unknownQueue: LocalUserTurn = {
    ...turn,
    queueState: "waiting",
    queueId: "queue-unknown",
  };
  promoteTurnsAbsentFromQueue([unknownQueue], undefined, true);
  assert.equal(unknownQueue.queueState, "waiting");
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

const repeatedPrompt = "继续";

function persistedUser(text: string, timestamp: number, identity: string): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
    piChatPersistedMessageId: identity,
  };
}

test("a persisted echo after the local baseline confirms a repeated prompt without a duplicate row", () => {
  const window = [
    persistedUser(repeatedPrompt, 1_000, "entry-1:0"),
    { role: "assistant" as const, content: "first" },
    persistedUser(repeatedPrompt, 9_000, "entry-2:0"),
  ];
  const turn: LocalUserTurn = {
    sessionId: "session-a",
    message: { role: "user", content: repeatedPrompt, timestamp: 9_000 },
    expectedTurnTotal: 2,
    baselineTurnTotal: 1,
  };
  assert.equal(transcriptConfirmsLocalTurn(turn, window, 2), true);
  const protectedTranscript = protectTranscriptWithLocalTurns([turn], window, 3, 2);
  assert.deepEqual(protectedTranscript.pendingTurns, []);
  assert.deepEqual(protectedTranscript.messages, window);
});

test("a repeated prompt cannot confirm two local turns from one persisted row", () => {
  const window = [
    persistedUser(repeatedPrompt, 1_000, "entry-1:0"),
    { role: "assistant" as const, content: "first" },
    persistedUser(repeatedPrompt, 9_000, "entry-2:0"),
  ];
  const first: LocalUserTurn = {
    sessionId: "session-a",
    message: { role: "user", content: repeatedPrompt, timestamp: 9_000 },
    expectedTurnTotal: 2,
    baselineTurnTotal: 1,
  };
  const second: LocalUserTurn = {
    sessionId: "session-a",
    message: { role: "user", content: repeatedPrompt, timestamp: 9_400 },
    expectedTurnTotal: 3,
    baselineTurnTotal: 2,
  };
  const protectedTranscript = protectTranscriptWithLocalTurns([first, second], window, 3, 2);
  assert.deepEqual(protectedTranscript.pendingTurns, [second]);
  assert.equal(protectedTranscript.messages.filter((message) => message.role === "user").length, 3);
});

test("a persisted row at or before the local baseline never confirms a new turn", () => {
  const window = [
    persistedUser(repeatedPrompt, 1_000, "entry-1:0"),
    { role: "assistant" as const, content: "first" },
  ];
  const turn: LocalUserTurn = {
    sessionId: "session-a",
    message: { role: "user", content: repeatedPrompt, timestamp: 9_000 },
    expectedTurnTotal: 2,
    baselineTurnTotal: 1,
  };
  // The same payload was already persisted once, but no row appeared after the
  // baseline, so the older row must not confirm the pending repeat.
  assert.equal(transcriptConfirmsLocalTurn(turn, window, 1), false);
  const protectedTranscript = protectTranscriptWithLocalTurns([turn], window, 2, 1);
  assert.deepEqual(protectedTranscript.pendingTurns, [turn]);
  assert.deepEqual(protectedTranscript.messages, [...window, turn.message]);
});

test("an image prompt confirms by position after its baseline advanced", () => {
  const window = [
    persistedUser("older", 1_000, "entry-1:0"),
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "请查看这些图片。" }, { type: "image" as const, data: "AA==", mimeType: "image/png" }],
      timestamp: 9_000,
      piChatPersistedMessageId: "entry-2:0",
    },
  ];
  const turn: LocalUserTurn = {
    sessionId: "session-a",
    message: {
      role: "user",
      content: [{ type: "text", text: "inspect" }, { type: "image", data: "AA==", mimeType: "image/png" }],
      timestamp: 8_900,
    },
    expectedTurnTotal: 2,
    baselineTurnTotal: 1,
    confirmByPosition: true,
  };
  assert.equal(transcriptConfirmsLocalTurn(turn, window, 2), true);
  assert.deepEqual(protectTranscriptWithLocalTurns([turn], window, 2, 2).pendingTurns, []);
});

test("a persisted echo that arrives after the overlay suppresses the immediate overlay", () => {
  const overlay: PiMessage = { role: "user", content: "same prompt", timestamp: 42 };
  const persisted = { ...overlay, timestamp: 55, piChatPersistedMessageId: "entry-9:0" };
  assert.deepEqual(appendPendingUserMessage([previous, persisted], overlay), [previous, persisted]);
});

test("a later identical submission keeps its own overlay above an older persisted echo", () => {
  const firstPersisted = { role: "user" as const, content: "same prompt", timestamp: 42, piChatPersistedMessageId: "entry-9:0" };
  const secondOverlay: PiMessage = { role: "user", content: "same prompt", timestamp: 99 };
  assert.deepEqual(
    appendPendingUserMessage([previous, firstPersisted], secondOverlay),
    [previous, firstPersisted, secondOverlay],
  );
});

test("duplicate diagnostics separate legit repeats from a local overlay row", () => {
  const older = persistedUser(repeatedPrompt, 1_000, "entry-1:0");
  const newer = persistedUser(repeatedPrompt, 9_000, "entry-2:0");
  const turn: LocalUserTurn = {
    sessionId: "session-a",
    message: { role: "user", content: repeatedPrompt, timestamp: 9_000 },
    expectedTurnTotal: 2,
    baselineTurnTotal: 1,
  };
  const repeats = diagnoseVisibleUserTurnDuplicates([older, newer], [turn], 2);
  assert.equal(repeats.length, 1);
  assert.equal(repeats[0].kind, "same-content");
  assert.equal(repeats[0].pairCount, 1);
  assert.equal(repeats[0].persistedCount, 2);
  assert.equal(repeats[0].localRowCount, 0);
  assert.equal(repeats[0].adjacent, true);

  const overlay = turn.message;
  const withOverlay = diagnoseVisibleUserTurnDuplicates([older, newer, overlay], [turn], 2);
  assert.equal(withOverlay.length, 1);
  assert.equal(withOverlay[0].kind, "local-and-persisted");
  assert.equal(withOverlay[0].localRowCount, 1);
  assert.equal(withOverlay[0].persistedCount, 2);
  assert.equal(withOverlay[0].persistedAfterBaselineCount, 1);
  assert.equal(withOverlay[0].adjacent, true);
});

test("the recorded duplicate incident replay resolves every re-sent prompt", () => {
  // Observed live: the pane showed the 10-turn authoritative window plus one
  // extra bubble per still-pending local turn (duplicateCount 14 with
  // localTurnCount 4), because this Session re-sends identical instructions and
  // the speculative ordinal had drifted ahead of the Session turn count.
  const reSent = ".pi-subagents/artifacts/ 和 dist-local 这些确实可以清理";
  const window = [
    persistedUser(reSent, 1_000, "entry-247:0"),
    persistedUser(reSent, 1_100, "entry-248:0"),
    persistedUser(reSent, 1_200, "entry-249:0"),
    persistedUser(reSent, 1_300, "entry-250:0"),
    persistedUser(reSent, 1_400, "entry-251:0"),
    persistedUser("我刚刚git clone了 deepseek harness 这个项目", 1_500, "entry-252:0"),
    persistedUser("你保持git里的dsh，帮我把本机其他的dsh清理一下", 1_600, "entry-253:0"),
    persistedUser("你查看一下，这里又出现了2条一样的用户消息", 1_700, "entry-254:0"),
    persistedUser("你现在导出诊断不可以查到吗", 1_800, "entry-255:0"),
    persistedUser("pi-chat-state-diagnostic-2026-09-10T05-47-45-456Z.json 好像只有最近5分钟的", 1_900, "entry-256:0"),
  ];
  const pending: LocalUserTurn[] = [
    { message: "你保持git里的dsh，帮我把本机其他的dsh清理一下", expected: 253, baseline: 252 },
    { message: "你查看一下，这里又出现了2条一样的用户消息", expected: 254, baseline: 253 },
    { message: "你现在导出诊断不可以查到吗", expected: 255, baseline: 254 },
    { message: "pi-chat-state-diagnostic-2026-09-10T05-47-45-456Z.json 好像只有最近5分钟的", expected: 256, baseline: 255 },
  ].map((entry, index) => ({
    sessionId: "session-a",
    message: { role: "user" as const, content: entry.message, timestamp: 2_000 + index },
    expectedTurnTotal: entry.expected,
    baselineTurnTotal: entry.baseline,
  }));

  const protectedTranscript = protectTranscriptWithLocalTurns(pending, window, 20, 256);
  assert.deepEqual(protectedTranscript.pendingTurns, []);
  assert.equal(
    protectedTranscript.messages.filter((message) => message.role === "user").length,
    10,
    "every persisted echo replaces its local bubble instead of adding a duplicate",
  );

  // A re-sent payload cannot confirm more local turns than it has persisted rows.
  const reSentPending: LocalUserTurn[] = [
    { message: reSent, expected: 255, baseline: 250 },
    { message: reSent, expected: 256, baseline: 250 },
  ].map((entry, index) => ({
    sessionId: "session-a",
    message: { role: "user" as const, content: entry.message, timestamp: 3_000 + index },
    expectedTurnTotal: entry.expected,
    baselineTurnTotal: entry.baseline,
  }));
  const reSentResult = protectTranscriptWithLocalTurns(reSentPending, window, 22, 256);
  assert.deepEqual(reSentResult.pendingTurns, [reSentPending[1]]);
  assert.equal(
    reSentResult.messages.filter((message) => message.role === "user").length,
    11,
    "only the row count the Session actually persisted decides confirmation",
  );
});
