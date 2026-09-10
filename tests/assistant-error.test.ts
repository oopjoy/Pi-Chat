import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_ERROR_DETAIL_LIMIT,
  assistantErrorNotice,
  boundedAssistantErrorDetail,
  isAssistantErrorStop,
} from "../src/shared/assistant-error";
import type { PiMessage } from "../src/shared/types";

function failedAttempt(errorMessage: string, stopReason = "error"): PiMessage {
  return { role: "assistant", content: [], stopReason, errorMessage };
}

test("a settled failed attempt is recognized while ordinary replies are not", () => {
  assert.equal(isAssistantErrorStop(failedAttempt("boom")), true);
  assert.equal(isAssistantErrorStop({ role: "assistant", content: "answer" }), false);
  assert.equal(isAssistantErrorStop({ role: "assistant", content: "", stopReason: "error" }), false);
  assert.equal(isAssistantErrorStop({ role: "assistant", content: "", stopReason: "stop", errorMessage: " " }), false);
});

test("a provider auth failure reports the category and the bounded reason", () => {
  const notice = assistantErrorNotice(failedAttempt(
    'OpenAI API error (503): {"message":"auth_unavailable: no auth available (providers=codex, model=gpt-6-astra)","type":"server_error"}',
  ));
  assert.ok(notice);
  assert.equal(notice.title, "模型服务凭据不可用（HTTP 503）");
  assert.match(notice.detail, /auth_unavailable/);
});

test("retry exhaustion, overload, timeout, and abort keep distinct titles", () => {
  assert.equal(
    assistantErrorNotice(failedAttempt(
      'Error: Retry failed after 3 attempts: OpenAI API error (503): {"message": "auth_unavailable: no auth available"',
    ))?.title,
    "模型服务凭据不可用（HTTP 503）",
  );
  assert.match(
    assistantErrorNotice(failedAttempt("OpenAI API error (503): server_is_overloaded"))?.title || "",
    /模型服务暂时过载/,
  );
  assert.match(
    assistantErrorNotice(failedAttempt("Error Code request_timeout: stream error: stream disconnected before completion"))?.title || "",
    /连接中断/,
  );
  assert.match(
    assistantErrorNotice(failedAttempt("This operation was aborted"))?.title || "",
    /已中止/,
  );
  assert.match(
    assistantErrorNotice(failedAttempt("something entirely unexpected"))?.title || "",
    /模型调用失败/,
  );
});

test("retry exhaustion is stated in the detail instead of being dropped", () => {
  const notice = assistantErrorNotice(failedAttempt(
    'Retry failed after 3 attempts: OpenAI API error (429): {"message":"rate limited"}',
  ));
  assert.ok(notice);
  assert.equal(notice.title, "模型服务触发限流（HTTP 429）");
  assert.match(notice.detail, /已重试 3 次仍未成功/);
});

test("the rendered detail is collapsed and bounded", () => {
  const notice = assistantErrorNotice(failedAttempt(`first line\n\n${"x".repeat(5_000)}`));
  assert.ok(notice);
  assert.equal(notice.detail.length <= ASSISTANT_ERROR_DETAIL_LIMIT, true);
  assert.doesNotMatch(notice.detail, /\n/);
  assert.equal(boundedAssistantErrorDetail("  a\n b  "), "a b");
});
