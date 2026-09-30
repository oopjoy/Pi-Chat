import assert from "node:assert/strict";
import test from "node:test";
import { parsePromptRouteInput } from "../../src/server/routes/prompt-input";

test("prompt route input parses immutable route, delivery, settings and images", () => {
  const input = parsePromptRouteInput({
    sessionId: "0123456789abcdef0123",
    message: "  hello  ",
    delivery: "steer",
    steerId: "12345678-1234-4123-8123-123456789abc",
    clientPromptOperationId: "12345678-1234-4123-8123-123456789abc",
    gateMode: "open",
    settings: { thinkingLevel: "high" },
    images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
  });
  assert.equal(input.message, "hello");
  assert.equal(input.sessionId, "0123456789abcdef0123");
  assert.equal(input.delivery, "steer");
  assert.equal(input.gateMode, "open");
  assert.equal(input.settings?.thinkingLevel, "high");
  assert.equal(input.images.length, 1);
});

test("prompt route input rejects invalid delivery and empty content", () => {
  assert.throws(
    () => parsePromptRouteInput({ sessionId: "0123456789abcdef0123", message: "hello", delivery: "invalid" }),
    /交付方式/,
  );
  assert.throws(
    () => parsePromptRouteInput({ sessionId: "0123456789abcdef0123", message: "" }),
    /消息或图片不能为空/,
  );
});
