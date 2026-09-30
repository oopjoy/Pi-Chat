import assert from "node:assert/strict";
import test from "node:test";
import { promptSettingsSnapshot, requiredSessionId } from "../../src/server/routes/request-validation";

test("request validation keeps Session and Prompt route identities strict", () => {
  assert.equal(requiredSessionId({ sessionId: "0123456789abcdef0123" }), "0123456789abcdef0123");
  assert.throws(() => requiredSessionId({ sessionId: "primary" }), /有效的会话标识/);
  assert.deepEqual(promptSettingsSnapshot({ settings: {
    model: { provider: "provider", modelId: "model", api: "responses" },
    thinkingLevel: "high",
  } }), {
    model: { provider: "provider", modelId: "model", api: "responses" },
    thinkingLevel: "high",
  });
});

test("request validation rejects malformed captured Prompt settings", () => {
  assert.throws(() => promptSettingsSnapshot({ settings: {} }), /不能为空/);
  assert.throws(() => promptSettingsSnapshot({ settings: { thinkingLevel: "invalid" } }), /Thinking/);
  assert.throws(() => promptSettingsSnapshot({ settings: { model: { provider: "", modelId: "model" } } }), /模型设置/);
});
