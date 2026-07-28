import assert from "node:assert/strict";
import test from "node:test";
import { appendTerminalMessage, mergeMessageHistory, reconcilePersistedHistory } from "../src/shared/streaming-assistant";
import { assistantMessage, lifecycleFromEvent, parseEventData, userMessage } from "../src/web/lib/pi-events";

test("Pi event helpers normalize lifecycle and message payloads", () => {
  assert.equal(lifecycleFromEvent({ lifecycle: "resources-reloading" }), "resources-reloading");
  assert.equal(lifecycleFromEvent({ lifecycle: "unknown" }), "idle");
  assert.deepEqual(parseEventData({ data: '{"type":"ready"}' } as MessageEvent<string>), { type: "ready" });
  assert.equal(assistantMessage({ message: { role: "user", content: "no" } }), null);
  assert.deepEqual(assistantMessage({ message: { role: "assistant", content: "yes" } }), { role: "assistant", content: "yes" });
});

test("thinking stream events immediately classify a transient text snapshot as private thinking", () => {
  const message = assistantMessage({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "先分析问题。" }] },
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "先分析问题。" },
  });
  assert.deepEqual(message, { role: "assistant", content: [{ type: "thinking", thinking: "先分析问题。" }] });
  assert.deepEqual(assistantMessage({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "这是用户可见的答案。" }] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "这是用户可见的答案。" },
  }), { role: "assistant", content: [{ type: "text", text: "这是用户可见的答案。" }] });
});

test("user message helper preserves text-only and image content shapes", () => {
  const text = userMessage("hello", []);
  assert.equal(text.role, "user");
  assert.equal(text.content, "hello");
  const image = userMessage("look", [{ type: "image", data: "AA==", mimeType: "image/png" }]);
  assert.ok(Array.isArray(image.content));
  assert.deepEqual((image.content as Array<Record<string, unknown>>).map((part) => part.type), ["text", "image"]);
});

test("same-millisecond terminal messages remain distinct unless their content matches", () => {
  const first = { role: "assistant", content: "first", timestamp: 100 };
  const second = { role: "assistant", content: "second", timestamp: 100 };
  assert.deepEqual(appendTerminalMessage([first], second), [first, second]);
  assert.deepEqual(mergeMessageHistory([first], [first, second]), [first, second]);
});

test("adjacent legacy messages without timestamps are deduplicated conservatively", () => {
  const legacy = { role: "user", content: "same" };
  assert.deepEqual(appendTerminalMessage([legacy], { ...legacy }), [{ ...legacy }]);
  assert.deepEqual(appendTerminalMessage([legacy, { role: "assistant", content: "answer" }], { ...legacy }), [legacy, { role: "assistant", content: "answer" }, legacy]);
});

test("disjoint runtime and disk snapshots merge chronologically in either arrival order", () => {
  const oldHistory = [
    { role: "user", content: "old question", timestamp: 10 },
    { role: "assistant", content: "old answer", timestamp: 20 },
  ];
  const newHistory = [
    { role: "user", content: "new question", timestamp: 30 },
    { role: "assistant", content: "new answer", timestamp: 40 },
  ];
  const expected = [...oldHistory, ...newHistory];
  assert.deepEqual(mergeMessageHistory(oldHistory, newHistory), expected);
  assert.deepEqual(mergeMessageHistory(newHistory, oldHistory), expected);
});

test("string and single text-block forms deduplicate across Runtime and JSONL", () => {
  const runtime = [{ role: "user", content: "hello", timestamp: 10 }];
  const disk = [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 10 }];
  assert.equal(mergeMessageHistory(runtime, disk).length, 1);
  assert.equal(mergeMessageHistory(disk, runtime).length, 1);
});

test("legacy disjoint disk history remains before a timestamp-free Runtime tail", () => {
  const runtimeTail = [{ role: "assistant", content: "new answer" }];
  const diskBase = [{ role: "user", content: "old question" }, { role: "assistant", content: "old answer" }];
  assert.deepEqual(mergeMessageHistory(runtimeTail, diskBase, "incoming-first"), [...diskBase, ...runtimeTail]);
});

test("equal-timestamp disjoint segments honor the caller's explicit base direction", () => {
  const diskBase = [{ role: "assistant", content: "previous answer", timestamp: 100 }];
  const runtimeTail = [{ role: "user", content: "new question", timestamp: 100 }];
  assert.deepEqual(mergeMessageHistory(runtimeTail, diskBase, "incoming-first"), [...diskBase, ...runtimeTail]);
  assert.deepEqual(mergeMessageHistory(diskBase, runtimeTail), [...diskBase, ...runtimeTail]);
});

test("authoritative persisted history retains only explicit unconfirmed terminals", () => {
  const persisted = [
    { role: "user", content: "question", timestamp: 1 },
    { role: "assistant", content: "answer", timestamp: 2 },
  ];
  const terminal = { role: "assistant", content: "just finished", timestamp: 3 };
  const reconciled = reconcilePersistedHistory(persisted, [terminal]);
  assert.deepEqual(reconciled.messages, [...persisted, terminal]);
  assert.deepEqual(reconciled.pending, [terminal]);

  const confirmed = reconcilePersistedHistory([...persisted, terminal], reconciled.pending);
  assert.deepEqual(confirmed.messages, [...persisted, terminal]);
  assert.deepEqual(confirmed.pending, []);
});

test("message identity tolerates metadata records without content", () => {
  const metadata = { role: "compactionSummary", summary: "summary", timestamp: 10 };
  assert.doesNotThrow(() => reconcilePersistedHistory([metadata], [metadata]));
  assert.deepEqual(reconcilePersistedHistory([metadata], [metadata]).pending, []);
  assert.equal(appendTerminalMessage([metadata], { ...metadata, summary: "different" }).length, 2);
});

test("authoritative branch advancement drops an absent abandoned terminal", () => {
  const abandoned = { role: "assistant", content: "old branch", timestamp: 2 };
  const stalePrefix = [{ role: "user", content: "question", timestamp: 1 }];
  assert.deepEqual(reconcilePersistedHistory(stalePrefix, [abandoned]).pending, [abandoned]);

  const rewoundAndAdvanced = [
    { role: "user", content: "question", timestamp: 1 },
    { role: "assistant", content: "new branch", timestamp: 3 },
  ];
  assert.deepEqual(reconcilePersistedHistory(rewoundAndAdvanced, [abandoned]).pending, []);
  assert.deepEqual(reconcilePersistedHistory(rewoundAndAdvanced, [abandoned]).messages, rewoundAndAdvanced);
});
