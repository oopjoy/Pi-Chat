import type { PiMessage } from "./types.js";

/** Longest provider excerpt shown in the transcript; UI text stays bounded. */
export const ASSISTANT_ERROR_DETAIL_LIMIT = 240;

const HTTP_STATUS = /\(([0-9]{3})\)/;
const RETRY_ATTEMPTS = /Retry failed after ([0-9]+) attempts/i;

/** One bounded, user-visible explanation of a settled failed model attempt. */
export interface AssistantErrorNotice {
  title: string;
  detail: string;
}

/**
 * Pi stores a failed attempt as an assistant message whose `stopReason` is
 * `error` and whose content is usually empty, so a transcript that renders only
 * content shows an unexplained stop. This predicate identifies the attempts that
 * carry a provider reason worth showing.
 */
export function isAssistantErrorStop(message: PiMessage): boolean {
  return message.role === "assistant"
    && message.stopReason === "error"
    && typeof message.errorMessage === "string"
    && message.errorMessage.trim().length > 0;
}

/** Collapse provider text to one bounded line so no untrusted body can bloat the view. */
export function boundedAssistantErrorDetail(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length <= ASSISTANT_ERROR_DETAIL_LIMIT) return collapsed;
  return `${collapsed.slice(0, ASSISTANT_ERROR_DETAIL_LIMIT - 1)}…`;
}

/**
 * Classify one failed attempt into a stable category plus the bounded provider
 * reason. Categories stay provider-agnostic because Pi forwards the upstream
 * body verbatim and its wording differs per provider.
 */
export function assistantErrorNotice(message: PiMessage): AssistantErrorNotice | null {
  if (!isAssistantErrorStop(message)) return null;
  const raw = (message.errorMessage || "").trim();
  const status = HTTP_STATUS.exec(raw)?.[1] || "";
  const attempts = RETRY_ATTEMPTS.exec(raw)?.[1] || "";
  const authority = /auth_unavailable|no auth available/i.test(raw);
  const overloaded = /overloaded|server_is_overloaded/i.test(raw);
  const aborted = /operation was aborted|terminated|request aborted/i.test(raw);
  const interrupted = /request_timeout|stream disconnected|stream error|protocol_error|unexpected eof|tls handshake|connection error|connection reset|socket hang up|upstream connect error|econnreset|etimedout/i.test(raw);
  const truncated = /stream ended before|ended before a terminal/i.test(raw);
  let category = "模型调用失败";
  if (aborted) category = "本次生成已中止";
  else if (authority) category = "模型服务凭据不可用";
  else if (overloaded) category = "模型服务暂时过载";
  else if (status === "429") category = "模型服务触发限流";
  else if (status === "401" || status === "403") category = "模型凭据被拒绝";
  else if (interrupted || truncated) category = "与模型服务的连接中断";
  else if (status.startsWith("5")) category = "模型服务返回错误";
  const reason = attempts ? `已重试 ${attempts} 次仍未成功。${raw}` : raw;
  return {
    title: status ? `${category}（HTTP ${status}）` : category,
    detail: boundedAssistantErrorDetail(reason),
  };
}
