import type { PiMessage } from "./types.js";

/** Longest provider excerpt shown in the transcript; UI text stays bounded. */
export const ASSISTANT_ERROR_DETAIL_LIMIT = 240;

/** Last parenthesized status wins: an earlier one may describe a proxied hop. */
const HTTP_STATUS = /\(([0-9]{3})\)/g;
function lastHttpStatus(raw: string): string {
  let status = "";
  for (const match of raw.matchAll(HTTP_STATUS)) status = match[1] || status;
  return status;
}
/** One fixture's identifier; anchored, and only the identifier is ever echoed. */
const INCIDENT_ID = /^PC-[A-Z0-9_-]{8}$/;
const RETRY_ATTEMPTS = /Retry failed after ([0-9]+) attempts/i;

/** Stable category of a failure, independent of the provider's wording. */
export type FailureKind =
  | "aborted"
  | "authority"
  | "overloaded"
  | "rate-limit"
  | "credentials"
  | "runtime-gone"
  | "connection"
  | "server"
  | "unknown";

/** One bounded, user-visible explanation of a failed model or Runtime attempt. */
export interface AssistantErrorNotice {
  kind: FailureKind;
  title: string;
  detail: string;
  /** provider · model · api of the attempt, when Pi recorded the route. */
  route?: string;
}

/** One browser-local failure retained in the conversation body for its Session. */
/**
 * Failure scope for a turn that has no Session yet: a New draft's first message
 * can fail before the server has handed the client a Session id.
 */
export const DRAFT_FAILURE_SCOPE = "draft";

export interface LocalFailureNotice extends AssistantErrorNotice {
  /**
   * Identity for React keys and for the recorder's duplicate check. It carries
   * the failure's own content, not only its arrival time, so a redelivered frame
   * is recognized and two distinct failures are never collapsed into one.
   */
  id: string;
  /** Session the failure belongs to, or {@link DRAFT_FAILURE_SCOPE}. */
  sessionId: string;
  /** When the browser recorded it; shown so an older card is not misread as recent. */
  at: number;
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
/**
 * Providers occasionally echo the credential they rejected. The reason is kept
 * in the transcript, so obvious secret shapes are hidden before it renders.
 */
const SECRET_LIKE = [
  /\b(?:sk|rk|pk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];
export function redactSensitiveDetail(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_LIKE) redacted = redacted.replace(pattern, "[已隐藏]");
  return redacted;
}

export function boundedAssistantErrorDetail(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length <= ASSISTANT_ERROR_DETAIL_LIMIT) return collapsed;
  return `${collapsed.slice(0, ASSISTANT_ERROR_DETAIL_LIMIT - 1)}…`;
}

/**
 * Classify one failure into a stable category plus the bounded provider reason.
 * Categories stay provider-agnostic because Pi forwards the upstream body
 * verbatim and its wording differs per provider, and because the same classifier
 * serves both a persisted failed attempt and a Runtime-level failure that never
 * produced a message.
 */
export function classifyFailureReason(raw: string): AssistantErrorNotice {
  const status = lastHttpStatus(raw);
  const attempts = RETRY_ATTEMPTS.exec(raw)?.[1] || "";
  const authority = /auth_unavailable|no auth available/i.test(raw);
  const overloaded = /overloaded|server_is_overloaded/i.test(raw);
  const aborted = /operation was aborted|request aborted/i.test(raw);
  const interrupted = /request_timeout|stream disconnected|stream error|stream terminated|terminated by|protocol_error|unexpected eof|tls handshake|connection error|connection reset|socket hang up|upstream connect error|econnreset|etimedout|econnrefused|fetch failed|network error/i.test(raw);
  const truncated = /stream ended before|ended before a terminal/i.test(raw);
  const runtimeGone = /RPC 已退出|Runtime 已退出|进程已退出|Runtime 不可用|启动超时/i.test(raw);
  let kind: FailureKind = "unknown";
  let category = "模型调用失败";
  if (aborted) [kind, category] = ["aborted", "本次生成已中止"];
  else if (authority) [kind, category] = ["authority", "模型服务凭据不可用"];
  else if (overloaded) [kind, category] = ["overloaded", "模型服务暂时过载"];
  else if (status === "429") [kind, category] = ["rate-limit", "模型服务触发限流"];
  else if (status === "401" || status === "403") [kind, category] = ["credentials", "模型凭据被拒绝"];
  else if (runtimeGone) [kind, category] = ["runtime-gone", "Pi Runtime 已退出"];
  else if (interrupted || truncated) [kind, category] = ["connection", "与模型服务的连接中断"];
  else if (status.startsWith("5")) [kind, category] = ["server", "模型服务返回错误"];
  const reason = redactSensitiveDetail(attempts ? `已重试 ${attempts} 次仍未成功。${raw}` : raw);
  return {
    kind,
    title: status ? `${category}（HTTP ${status}）` : category,
    detail: boundedAssistantErrorDetail(reason),
  };
}

/** Classify the reason carried by a persisted failed assistant attempt. */
export function assistantErrorNotice(message: PiMessage): AssistantErrorNotice | null {
  if (!isAssistantErrorStop(message)) return null;
  const notice = classifyFailureReason((message.errorMessage || "").trim());
  const route = failureRoute(message.provider, message.model, message.api);
  return route ? { ...notice, route } : notice;
}

/**
 * The provider route a failed attempt actually used. A silent provider change is
 * the difference between "the proxy is out of capacity" and "the request went
 * somewhere else", so the transcript shows the recorded route instead of only the
 * model name the composer was asked for.
 */
export function failureRoute(provider?: string, model?: string, api?: string): string | undefined {
  const parts = [provider, model, api]
    .map((part) => (typeof part === "string" ? part.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 80) : ""))
    .filter(Boolean);
  return parts.length ? Array.from(new Set(parts)).join(" · ") : undefined;
}

/**
 * Build the persistent transcript entry for a Runtime-level failure.
 *
 * A failed model attempt reaches the browser as an assistant message and renders
 * from that message. Failures that never produce one (a dead RPC, a rejected
 * prompt) previously only flashed a five-second toast, so the user lost both the
 * reason and the fact that the turn had failed.
 */
export function localFailureNotice(
  sessionId: string,
  rawText: string,
  incidentId?: string,
  at = Date.now(),
): LocalFailureNotice {
  // Only a well-formed identifier is echoed, and only the identifier: a longer
  // string that merely contains one must not reach the rendered reason.
  const incident = incidentId && INCIDENT_ID.test(incidentId)
    ? incidentId.slice(0, 11)
    : (INCIDENT_ID.exec(rawText)?.[0] || "").slice(0, 11);
  const notice = classifyFailureReason(rawText.trim() || "Pi 未能完成这次请求");
  return {
    ...notice,
    id: `${sessionId}:${incident || `${notice.kind}:${notice.detail}`}`,
    sessionId,
    at,
    detail: incident ? `${notice.detail}（事件 ID：${incident}）` : notice.detail,
  };
}

/**
 * Decide whether a failure deserves a permanent transcript entry. A failed
 * upstream call or a dead Runtime does; a client-side validation rejection and a
 * user-requested abort do not, because the toast and the retained partial reply
 * already say what happened.
 */
export function isTranscriptWorthyFailure(rawText: string, status?: number, code?: string): boolean {
  if (code === "MODEL_UNAVAILABLE") return true;
  if (code === "RESULT_PENDING") return false;
  if (typeof status === "number" && status >= 500) return true;
  if (typeof status === "number" && status >= 400) return false;
  return classifyFailureReason(rawText).kind !== "aborted";
}

/**
 * A persisted failed attempt already renders from the transcript, so a local
 * entry describing the same failure would show it twice.
 */
export function withoutPersistedFailure(
  failures: readonly LocalFailureNotice[],
  messages: readonly PiMessage[],
  windowMs = 120_000,
): LocalFailureNotice[] {
  if (!failures.length) return [];
  const persisted = messages
    .filter((message) => isAssistantErrorStop(message))
    .map((message) => ({
      kind: classifyFailureReason((message.errorMessage || "").trim()).kind,
      timestamp:
        typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
          ? message.timestamp
          : undefined,
    }));
  if (!persisted.length) return [...failures];
  // Suppress only a likely duplicate: the same category of failure, close in
  // time. Proximity alone would hide a different failure that happened shortly
  // after a persisted one, which is exactly the reason this entry exists. A row
  // with no comparable time cannot prove proximity, so it suppresses nothing.
  return failures.filter((failure) => !persisted.some((entry) =>
    entry.kind === failure.kind
    && entry.timestamp !== undefined
    && Math.abs(entry.timestamp - failure.at) <= windowMs,
  ));
}
