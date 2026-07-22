import assert from "node:assert/strict";
import test from "node:test";
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
