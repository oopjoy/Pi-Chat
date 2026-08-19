import assert from "node:assert/strict";
import test from "node:test";
import { LiveMessageIdentityRegistry } from "../src/server/live-message-identity";

function ids() {
  let value = 0;
  return () => `live-${++value}`;
}

function projectedId(event: Record<string, unknown>): string | undefined {
  return (event.message as { piChatLiveMessageId?: string } | undefined)?.piChatLiveMessageId;
}

test("one Runtime message lifecycle keeps one server-owned live identity", () => {
  const registry = new LiveMessageIdentityRegistry(ids());
  const start = registry.project("session-a", {
    type: "message_start",
    message: {
      role: "assistant",
      content: [],
      piChatLiveMessageId: "provider-spoof",
      piChatPersistedMessageId: "provider-spoof",
    },
  });
  const update = registry.project("session-a", {
    type: "message_update",
    message: { role: "assistant", content: "partial" },
  });
  const end = registry.project("session-a", {
    type: "message_end",
    message: { role: "assistant", content: "final" },
  });

  assert.equal(projectedId(start), "live-1");
  assert.equal(
    (start.message as { piChatPersistedMessageId?: unknown }).piChatPersistedMessageId,
    undefined,
    "provider payloads cannot claim persisted projection identity",
  );
  assert.equal(projectedId(update), "live-1");
  assert.equal(projectedId(end), "live-1");
  const next = registry.project("session-a", {
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  assert.equal(projectedId(next), "live-2");
});

test("live identities stay Session-scoped and settlement clears an orphan lifecycle", () => {
  const registry = new LiveMessageIdentityRegistry(ids());
  const firstA = registry.project("session-a", {
    type: "message_update",
    message: { role: "assistant", content: "A" },
  });
  const firstB = registry.project("session-b", {
    type: "message_update",
    message: { role: "assistant", content: "B" },
  });
  assert.equal(projectedId(firstA), "live-1");
  assert.equal(projectedId(firstB), "live-2");

  registry.project("session-a", { type: "agent_settled" });
  const resumedA = registry.project("session-a", {
    type: "message_update",
    message: { role: "assistant", content: "new A" },
  });
  const continuedB = registry.project("session-b", {
    type: "message_end",
    message: { role: "assistant", content: "final B" },
  });
  assert.equal(projectedId(resumedA), "live-3");
  assert.equal(projectedId(continuedB), "live-2");
});

test("delta-only assistant updates receive the active identity and projected role", () => {
  const registry = new LiveMessageIdentityRegistry(ids());
  const start = registry.project("session-a", {
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  const emptyObjectUpdate = registry.project("session-a", {
    type: "message_update",
    message: {},
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "A" },
  });
  const missingMessageUpdate = registry.project("session-a", {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "B" },
  });

  assert.equal(projectedId(start), "live-1");
  assert.equal(projectedId(emptyObjectUpdate), "live-1");
  assert.equal(projectedId(missingMessageUpdate), "live-1");
  assert.equal((emptyObjectUpdate.message as { role?: unknown }).role, "assistant");
  assert.deepEqual(missingMessageUpdate.message, {
    role: "assistant",
    content: [],
    piChatLiveMessageId: "live-1",
  });
});

test("terminal-only tool results receive independent live identities", () => {
  const registry = new LiveMessageIdentityRegistry(ids());
  const first = registry.project("session-a", {
    type: "message_end",
    message: { role: "toolResult", toolCallId: "call-1", content: "one" },
  });
  const second = registry.project("session-a", {
    type: "message_end",
    message: { role: "toolResult", toolCallId: "call-1", content: "two" },
  });
  assert.equal(projectedId(first), "live-1");
  assert.equal(projectedId(second), "live-2");
});
