import assert from "node:assert/strict";
import test from "node:test";
import type { PiMessage } from "../src/shared/types";
import { groupConversation } from "../src/web/lib/conversation-process";
import { protectTranscriptWithLocalTurns, type LocalUserTurn } from "../src/web/lib/local-user-turn";

function fixture() {
  const previous: PiMessage[] = [
    { role: "user", content: "previous request", timestamp: 100, piChatPersistedMessageId: "u1:0" },
    { role: "assistant", timestamp: 200, piChatPersistedMessageId: "a1:0", content: [{ type: "thinking", thinking: "PREVIOUS_EARLY_THINKING" }, { type: "toolCall", id: "old-read", name: "read", arguments: {} }] },
    { role: "toolResult", timestamp: 250, piChatPersistedMessageId: "t1:0", toolCallId: "old-read", toolName: "read", content: "old read done" },
    { role: "assistant", timestamp: 600, piChatPersistedMessageId: "a2:0", content: [{ type: "thinking", thinking: "PREVIOUS_LATE_THINKING" }, { type: "toolCall", id: "old-test", name: "bash", arguments: {} }] },
    { role: "toolResult", timestamp: 700, piChatPersistedMessageId: "t2:0", toolCallId: "old-test", toolName: "bash", content: "old test done" },
    { role: "assistant", timestamp: 800, piChatPersistedMessageId: "a3:0", content: [{ type: "thinking", thinking: "PREVIOUS_FINAL_THINKING" }, { type: "text", text: "PREVIOUS_FINAL_ANSWER" }] },
  ];
  const nextProcess: PiMessage[] = [
    { role: "assistant", timestamp: 900, piChatLiveMessageId: "live-next", content: [{ type: "thinking", thinking: "NEXT_REQUEST_THINKING" }, { type: "toolCall", id: "new-read", name: "read", arguments: {} }] },
    { role: "toolResult", timestamp: 950, piChatLiveMessageId: "live-next-result", toolCallId: "new-read", toolName: "read", content: "new read done" },
  ];
  const message: PiMessage = { role: "user", timestamp: 300, content: [{ type: "text", text: "NEXT_REQUEST" }, { type: "image", mimeType: "image/png", data: "fixture-image" }] };
  const turn: LocalUserTurn = { sessionId: "fixture", message, queueId: "queue-next", queueState: "dispatched", expectedTurnTotal: 2, baselineTurnTotal: 1, confirmByPosition: true };
  return { previous, nextProcess, message, turn };
}

test("a queued user cannot split the previous persisted process and final answer by submission time", () => {
  const f = fixture();
  const incoming = [...f.previous, ...f.nextProcess];
  const original = [...incoming];
  const result = protectTranscriptWithLocalTurns([f.turn], incoming, incoming.length, 1);
  assert.deepEqual(result.messages, [...f.previous, f.message, ...f.nextProcess]);
  assert.deepEqual(incoming, original, "the authoritative history is not rewritten");
  assert.equal(f.message.timestamp, 300, "submission time is display metadata, not a turn ordering clock");
  const items = groupConversation(result.messages);
  assert.deepEqual(items.map(item => item.kind), ["message", "process", "message", "message", "process"]);
  assert.equal(items[2].kind === "message" && items[2].message.piChatPersistedMessageId, "a3:0");
  assert.equal(items[3].kind === "message" && items[3].message, f.message);
  assert.equal(items[1].kind === "process" && items[1].entries.filter(entry => entry.kind === "tool").length, 2);
  assert.equal(items[4].kind === "process" && items[4].entries.filter(entry => entry.kind === "tool").length, 1);
  assert.ok(items[1].kind === "process" && items[1].entries.some(entry => entry.kind === "thinking" && entry.text === "PREVIOUS_LATE_THINKING"));
  assert.ok(items[4].kind === "process" && items[4].entries.some(entry => entry.kind === "thinking" && entry.text === "NEXT_REQUEST_THINKING"));
});

test("a tool call begun before submission and completed after it stays in one previous-turn process", () => {
  const f = fixture();
  f.previous[2].timestamp = 350; // The queued User was submitted while old-read was executing.
  const result = protectTranscriptWithLocalTurns([f.turn], [...f.previous, ...f.nextProcess], 8, 1);
  const processes = groupConversation(result.messages).filter(item => item.kind === "process");
  assert.equal(processes.length, 2);
  const oldTools = processes[0].entries.filter(entry => entry.kind === "tool");
  assert.equal(oldTools.length, 2, "call/result halves must not become duplicate tools in different groups");
  assert.ok(oldTools.every(entry => entry.completed));
  assert.ok(oldTools.some(entry => entry.id === "old-read" && entry.result === "old read done"));
});

test("a pending queued turn without any new assistant output stays after the persisted final answer", () => {
  const f = fixture();
  const result = protectTranscriptWithLocalTurns([f.turn], f.previous, f.previous.length, 1);
  assert.deepEqual(result.messages, [...f.previous, f.message]);
});

test("authoritative prefix order wins even when its clocks are nonmonotonic", () => {
  const f = fixture();
  f.previous[1].timestamp = 2000;
  f.previous[5].timestamp = 1;
  const result = protectTranscriptWithLocalTurns([f.turn], [...f.previous, ...f.nextProcess], 8, 1);
  assert.deepEqual(result.messages, [...f.previous, f.message, ...f.nextProcess]);
});

test("server-rehydrated pending turns use the same persisted-history boundary without a queue ID", () => {
  const f = fixture();
  delete f.turn.queueId;
  f.turn.serverPromptId = "server-prompt";
  f.turn.pendingPromptId = "pending-prompt";
  const result = protectTranscriptWithLocalTurns([f.turn], [...f.previous, ...f.nextProcess], 8, 1);
  assert.deepEqual(result.messages, [...f.previous, f.message, ...f.nextProcess]);
});

test("confirmation and a reload keep the same process grouping without a duplicate user", () => {
  const f = fixture();
  const projected = protectTranscriptWithLocalTurns([f.turn], [...f.previous, ...f.nextProcess], 8, 1);
  const before = groupConversation(projected.messages);
  const persistedUser: PiMessage = { ...f.message, timestamp: 850, piChatPersistedMessageId: "u2:0" };
  const authoritative = [...f.previous, persistedUser, ...f.nextProcess];
  const confirmed = protectTranscriptWithLocalTurns([f.turn], authoritative, authoritative.length, 2);
  assert.equal(confirmed.messages, authoritative);
  assert.deepEqual(confirmed.pendingTurns, []);
  const after = groupConversation(confirmed.messages, { previousItems: before });
  assert.deepEqual(after.map(item => item.kind), before.map(item => item.kind));
  assert.deepEqual(after.filter(item => item.kind === "process").map(item => item.key), before.filter(item => item.kind === "process").map(item => item.key));
  assert.deepEqual(protectTranscriptWithLocalTurns([], authoritative, authoritative.length, 2).messages, authoritative);
});

test("waiting queue items still do not enter the transcript and legacy identity-less tails still reconcile", () => {
  const f = fixture();
  f.turn.queueState = "waiting";
  assert.deepEqual(protectTranscriptWithLocalTurns([f.turn], f.previous, f.previous.length, 1).messages, f.previous);
  const local: PiMessage = { role: "user", content: "legacy next", timestamp: 300 };
  const rows: PiMessage[] = [{ role: "user", content: "old", timestamp: 100 }, { role: "assistant", content: "old answer", timestamp: 200 }, { role: "assistant", content: "new answer", timestamp: 400 }];
  const result = protectTranscriptWithLocalTurns([{ sessionId: "legacy", message: local, expectedTurnTotal: 2 }], rows, 4, 2);
  assert.deepEqual(result.messages, [rows[0], rows[1], local, rows[2]]);
});
