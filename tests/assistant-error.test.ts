import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_ERROR_DETAIL_LIMIT,
  assistantErrorNotice,
  boundedAssistantErrorDetail,
  classifyFailureReason,
  failureRoute,
  isTranscriptWorthyFailure,
  isAssistantErrorStop,
  localFailureNotice,
  withoutPersistedFailure,
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

test("a Runtime failure that never produced a message keeps a transcript entry", () => {
  const notice = localFailureNotice(
    "aaaaaaaaaaaaaaaaaaaa",
    'OpenAI API error (503): {"message":"auth_unavailable: no auth available"}',
    "PC-HW9KS-JE",
    1_000,
  );
  assert.equal(notice.title, "模型服务凭据不可用（HTTP 503）");
  assert.match(notice.detail, /事件 ID：PC-HW9KS-JE/);
  assert.equal(notice.sessionId, "aaaaaaaaaaaaaaaaaaaa");
  assert.equal(notice.at, 1_000);
});

test("a dead Runtime process reports its own category", () => {
  assert.equal(localFailureNotice("s", "Pi RPC 已退出").title, "Pi Runtime 已退出");
  assert.equal(localFailureNotice("s", "Pi 未能完成这次请求").title, "模型调用失败");
  assert.equal(localFailureNotice("s", "fetch failed").title, "与模型服务的连接中断");
});

test("the same failure frame is recorded once and never grows unbounded", () => {
  const one = localFailureNotice("s", "boom", undefined, 5);
  const same = localFailureNotice("s", "boom", undefined, 5);
  assert.equal(one.id, same.id);
  assert.notEqual(one.id, localFailureNotice("s", "boom", undefined, 6).id);
});

test("a persisted failed attempt suppresses its duplicate local entry", () => {
  const failure = localFailureNotice("s", "OpenAI API error (503): auth_unavailable", undefined, 10_000);
  const persisted: PiMessage = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (503): auth_unavailable",
    timestamp: 11_000,
  };
  assert.deepEqual(withoutPersistedFailure([failure], [persisted]), []);

  // A different failure must not be hidden by any persisted one nearby.
  const runtimeExit = { ...failure, kind: "runtime-gone" as const, id: "s:2:runtime", title: "Pi Runtime 已退出" };
  assert.deepEqual(withoutPersistedFailure([runtimeExit], [persisted]), [runtimeExit]);

  // An unrelated failed attempt elsewhere in the transcript must not hide it.
  const unrelated: PiMessage = { ...persisted, timestamp: 900_000 };
  assert.deepEqual(withoutPersistedFailure([failure], [unrelated]), [failure]);
  assert.deepEqual(withoutPersistedFailure([failure], []), [failure]);
});

test("upstream and Runtime failures earn a transcript entry while validation does not", () => {
  // Upstream/Runtime failures: the reason must survive in the conversation.
  assert.equal(isTranscriptWorthyFailure("OpenAI API error (503): auth_unavailable"), true);
  assert.equal(isTranscriptWorthyFailure("boom", 503), true);
  assert.equal(isTranscriptWorthyFailure("Pi RPC 已退出"), true);
  assert.equal(isTranscriptWorthyFailure("fetch failed"), true);
  assert.equal(isTranscriptWorthyFailure("所选模型不可用", 400, "MODEL_UNAVAILABLE"), true);
  // Client-side rejections and user aborts stay transient.
  assert.equal(isTranscriptWorthyFailure("当前对话已不再运行，无法发送 Steer 消息", 409), false);
  assert.equal(isTranscriptWorthyFailure("This operation was aborted"), false);
  assert.equal(isTranscriptWorthyFailure("结果尚未确认", 409, "RESULT_PENDING"), false);
});

test("the classifier exposes a stable kind next to the provider wording", () => {
  assert.equal(classifyFailureReason("OpenAI API error (503): auth_unavailable").kind, "authority");
  assert.equal(classifyFailureReason("OpenAI API error (429): rate limited").kind, "rate-limit");
  assert.equal(classifyFailureReason("Pi RPC 已退出").kind, "runtime-gone");
  assert.equal(classifyFailureReason("This operation was aborted").kind, "aborted");
  assert.equal(classifyFailureReason("something else entirely").kind, "unknown");
});

test("a failed attempt shows the provider route it actually used", () => {
  // The route comes from Pi's own row, so a provider that differs from the
  // composer selection is visible in the transcript instead of being inferred.
  const notice = assistantErrorNotice({
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: 'OpenAI API error (503): {"message":"auth_unavailable: no auth available"}',
    provider: "cpa-proxy",
    model: "gpt-6-astra",
    api: "openai-responses",
    timestamp: 1,
  });
  assert.equal(notice?.route, "cpa-proxy · gpt-6-astra · openai-responses");

  // A retry on another provider records that other provider.
  const other = assistantErrorNotice({
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "upstream failed",
    provider: "codex",
    model: "gpt-6-astra",
    timestamp: 1,
  });
  assert.equal(other?.route, "codex · gpt-6-astra", "a different provider is named, not hidden");

  // No recorded route: the card simply omits the line.
  const bare = assistantErrorNotice({ role: "assistant", content: [], stopReason: "error", errorMessage: "boom", timestamp: 1 });
  assert.equal(bare?.route, undefined);
});

test("the route line is bounded and cannot smuggle control characters", () => {
  const route = failureRoute("cp\u0000a-proxy", "gpt-\u001f6-astra", "x".repeat(200));
  assert.equal(route, `cpa-proxy · gpt-6-astra · ${"x".repeat(80)}`);
  assert.equal(failureRoute(undefined, undefined, undefined), undefined);
  assert.equal(failureRoute("  ", "", undefined), undefined);
  // Duplicated identity is not repeated.
  assert.equal(failureRoute("p", "p", undefined), "p");
});
