import assert from "node:assert/strict";
import test from "node:test";
import { appendTerminalMessage, mergeMessageHistory, reconcilePersistedHistory } from "../src/shared/streaming-assistant";
import { assistantMessage, canonicalMessageEndFromEvent, lifecycleFromEvent, parseEventData, userMessage } from "../src/web/lib/pi-events";

test("Pi event helpers normalize lifecycle and message payloads", () => {
  assert.equal(lifecycleFromEvent({ lifecycle: "resources-reloading" }), "resources-reloading");
  assert.equal(lifecycleFromEvent({ lifecycle: "unknown" }), "idle");
  assert.deepEqual(parseEventData({ data: '{"type":"ready"}' } as MessageEvent<string>), { type: "ready" });
  assert.equal(parseEventData({ data: '{' } as MessageEvent<string>), null);
  assert.equal(parseEventData({ data: '[]' } as MessageEvent<string>), null);
  assert.equal(assistantMessage({ message: { role: "user", content: "no" } }), null);
  assert.deepEqual(assistantMessage({ message: { role: "assistant", content: "yes" } }), { role: "assistant", content: "yes" });
});

test("canonical terminal decoder reconstructs a closed payload and provenance envelope", () => {
  const provenance = {
    piChatSessionId: "0123456789abcdefabcd",
    piChatRunEpoch: "run_epoch-1",
    piChatRunGeneration: 7,
  };
  assert.deepEqual(canonicalMessageEndFromEvent({
    type: "message_end",
    piChatEventSchema: 1,
    terminalKind: "assistant",
    ...provenance,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "answer", secret: "drop me" }],
      timestamp: 10,
      secret: "drop me",
    },
    requestToken: "drop me",
  }), {
    type: "message_end",
    piChatEventSchema: 1,
    terminalKind: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      timestamp: 10,
    },
    ...provenance,
  });
  assert.deepEqual(canonicalMessageEndFromEvent({
    type: "message_end",
    ...provenance,
    message: {
      role: "toolResult",
      content: "legacy",
      toolCallId: "call-1",
      toolName: "read",
    },
    secret: "drop me",
  }), {
    type: "message_end",
    piChatEventSchema: 1,
    terminalKind: "tool-result",
    message: {
      role: "toolResult",
      content: "legacy",
      toolCallId: "call-1",
      toolName: "read",
    },
    ...provenance,
  });
  for (const malformed of [
    {
      type: "message_end",
      piChatEventSchema: 1,
      terminalKind: "user-echo",
      ...provenance,
      message: { role: "assistant", content: "mismatch" },
    },
    { type: "message_end", ...provenance },
    {
      type: "message_end",
      ...provenance,
      message: { role: "toolResult", content: "bad", toolCallId: "call-1", toolName: "read", isError: "false" },
    },
    {
      type: "message_end",
      piChatEventSchema: 99,
      ...provenance,
      message: { role: "assistant", content: "future" },
    },
    {
      type: "message_end",
      ...provenance,
      message: { role: "evil", content: "unknown role" },
    },
    {
      type: "message_end",
      ...provenance,
      message: { role: "assistant", content: [{ type: "image", data: "x", mimeType: "image/png" }] },
    },
    {
      type: "message_end",
      ...provenance,
      piChatSessionId: "not-a-session",
      message: { role: "assistant", content: "bad session" },
    },
    {
      type: "message_end",
      ...provenance,
      piChatRunEpoch: "",
      message: { role: "assistant", content: "bad epoch" },
    },
    {
      type: "message_end",
      ...provenance,
      piChatRunGeneration: 7.5,
      message: { role: "assistant", content: "fractional generation" },
    },
    {
      type: "message_end",
      piChatSessionId: provenance.piChatSessionId,
      piChatRunEpoch: provenance.piChatRunEpoch,
      message: { role: "assistant", content: "missing generation" },
    },
  ]) assert.equal(canonicalMessageEndFromEvent(malformed), null);
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

test("a persisted terminal confirms an equivalent SSE lease despite timestamp drift", () => {
  const persisted = [
    { role: "user", content: "question", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 20 },
  ] as const;
  const terminal = { role: "assistant", content: "answer", timestamp: 21 } as const;
  const reconciled = reconcilePersistedHistory([...persisted], [terminal]);
  assert.deepEqual(reconciled.messages, persisted);
  assert.deepEqual(reconciled.pending, []);
});

test("a persisted terminal confirms an SSE lease when only Pi provider signatures differ", () => {
  const persisted = [
    { role: "user", content: "question", timestamp: 1 },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "checked the implementation",
          thinkingSignature: '{"id":"provider-reasoning"}',
        },
        {
          type: "text",
          text: "answer",
          textSignature: '{"v":1,"id":"provider-final"}',
        },
      ],
      timestamp: 2,
    },
  ] as const;
  const terminal = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "checked the implementation" },
      { type: "text", text: "answer" },
    ],
    timestamp: 2,
  } as const;
  const reconciled = reconcilePersistedHistory([...persisted], [terminal]);
  assert.deepEqual(reconciled.messages, persisted);
  assert.deepEqual(reconciled.pending, []);
});

test("provider-signature-insensitive terminal matching retains a distinct same-millisecond answer", () => {
  const persisted = [
    { role: "user", content: "question", timestamp: 1 },
    {
      role: "assistant",
      content: [{
        type: "text",
        text: "first answer",
        textSignature: '{"v":1,"id":"provider-final"}',
      }],
      timestamp: 2,
    },
  ] as const;
  const terminal = {
    role: "assistant",
    content: [{ type: "text", text: "second answer" }],
    timestamp: 2,
  } as const;
  const reconciled = reconcilePersistedHistory([...persisted], [terminal]);
  assert.deepEqual(reconciled.messages, [...persisted, terminal]);
  assert.deepEqual(reconciled.pending, [terminal]);
});

test("terminal lease matching never suppresses an older identical answer before a newer user turn", () => {
  const persisted = [
    { role: "user", content: "first question", timestamp: 1 },
    { role: "assistant", content: "same answer", timestamp: 2 },
    { role: "user", content: "second question", timestamp: 3 },
  ] as const;
  const terminal = { role: "assistant", content: "same answer", timestamp: 4 } as const;
  const reconciled = reconcilePersistedHistory([...persisted], [terminal]);
  assert.deepEqual(reconciled.messages, [...persisted, terminal]);
  assert.deepEqual(reconciled.pending, [terminal]);
});

test("adjacent duplicate assistant terminal leases collapse despite timestamp drift", () => {
  const terminal = { role: "assistant", content: "answer", timestamp: 3 } as const;
  const reconciled = reconcilePersistedHistory(
    [{ role: "user", content: "question", timestamp: 1 }],
    [{ role: "assistant", content: "answer", timestamp: 2 }, terminal],
  );
  assert.deepEqual(reconciled.messages, [
    { role: "user", content: "question", timestamp: 1 },
    terminal,
  ]);
  assert.deepEqual(reconciled.pending, [terminal]);
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
