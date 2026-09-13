import type { PiMessage } from "./types.js";

/** Last parenthesized status wins: an earlier one may describe a proxied hop. */
const HTTP_STATUS = /\(([0-9]{3})\)/g;
function lastHttpStatus(raw: string): string {
  let status = "";
  for (const match of raw.matchAll(HTTP_STATUS)) status = match[1] || status;
  return status;
}
/** One fixture's identifier; anchored, and only the identifier is ever echoed. */
const INCIDENT_ID = /^PC-[A-Z0-9_-]{8}$/;
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

/** Stable failure code used by state machines and diagnostics, not UI wording. */
export type PromptFailureKind =
  | "user-aborted"
  | "auth-unavailable"
  | "rate-limit"
  | "overloaded"
  | "timeout"
  | "transport"
  | "runtime-exit"
  | "model-unavailable"
  | "unknown";

/** Structured failure metadata carried alongside the redacted full detail. */
export interface PromptFailure {
  kind: PromptFailureKind;
  provider?: string;
  model?: string;
  api?: string;
  status?: number;
  retryAttempts?: number;
  retryExhausted?: boolean;
  requestId?: string;
  incidentId?: string;
  /** Complete provider/runtime detail after the boundary redaction policy. */
  message: string;
}

/** One user-visible explanation of a failed model or Runtime attempt. */
export interface AssistantErrorNotice {
  kind: FailureKind;
  title: string;
  detail: string;
  /** provider · model · api of the attempt, when Pi recorded the route. */
  route?: string;
  /** Stable machine-readable classification for state and test assertions. */
  failure: PromptFailure;
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

/**
 * Providers occasionally echo the credential they rejected. Error cards retain
 * the original text, so obvious secret shapes remain hidden before it renders.
 */
const SECRET_LIKE = [
  /\b(?:sk|rk|pk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];
/** Preserve line breaks and ordinary whitespace; strip only unsafe controls. */
const UNSAFE_ERROR_DISPLAY_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

export function redactSensitiveDetail(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_LIKE) redacted = redacted.replace(pattern, "[已隐藏]");
  return redacted;
}

/**
 * The transcript is the diagnostic record: preserve the provider's original
 * line structure and full body. Security redaction is deliberately the only
 * transformation; presentation handles large bodies with a user-controlled fold.
 */
export function visibleAssistantErrorDetail(raw: string): string {
  return redactSensitiveDetail(raw).replace(UNSAFE_ERROR_DISPLAY_CHARACTERS, "");
}

function safeFailureMetadata(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(UNSAFE_ERROR_DISPLAY_CHARACTERS, "").trim();
  return cleaned ? cleaned.slice(0, maximum) : undefined;
}

function parseFailureStatus(raw: string): number | undefined {
  const matches = [...raw.matchAll(HTTP_STATUS)];
  const value = matches.at(-1)?.[1];
  return value ? Number(value) : undefined;
}

function legacyFailureKind(raw: string): FailureKind {
  const status = lastHttpStatus(raw);
  const authority = /auth_unavailable|no auth available/i.test(raw);
  const overloaded = /overloaded|server_is_overloaded/i.test(raw);
  const aborted = /operation was aborted|request aborted/i.test(raw);
  const interrupted = /request_timeout|stream disconnected|stream error|stream terminated|terminated by|protocol_error|unexpected eof|tls handshake|connection error|connection reset|socket hang up|upstream connect error|econnreset|etimedout|econnrefused|fetch failed|network error/i.test(raw);
  const truncated = /stream ended before|ended before a terminal/i.test(raw);
  const runtimeGone = /RPC 已退出|Runtime 已退出|进程已退出|Runtime 不可用|启动超时/i.test(raw);
  if (aborted) return "aborted";
  if (authority) return "authority";
  if (overloaded) return "overloaded";
  if (status === "429") return "rate-limit";
  if (status === "401" || status === "403") return "credentials";
  if (runtimeGone) return "runtime-gone";
  if (interrupted || truncated) return "connection";
  if (status.startsWith("5")) return "server";
  return "unknown";
}

function promptFailureKind(raw: string, legacy: FailureKind, status?: number): PromptFailureKind {
  if (legacy === "aborted") return "user-aborted";
  if (legacy === "authority" || legacy === "credentials") return "auth-unavailable";
  if (legacy === "rate-limit") return "rate-limit";
  if (legacy === "overloaded") return "overloaded";
  if (legacy === "runtime-gone") return "runtime-exit";
  if (legacy === "connection") {
    return /timeout|timed out|etimedout/i.test(raw) ? "timeout" : "transport";
  }
  if (status === 408 || status === 504) return "timeout";
  return "unknown";
}

/** Normalize provider/runtime wording without making the wording authoritative. */
export function normalizePromptFailure(
  raw: string,
  metadata: {
    provider?: unknown;
    model?: unknown;
    api?: unknown;
    status?: unknown;
    retryAttempts?: unknown;
    requestId?: unknown;
    incidentId?: unknown;
    aborted?: boolean;
    runtimeExit?: boolean;
    modelUnavailable?: boolean;
  } = {},
): PromptFailure {
  const legacy = legacyFailureKind(raw);
  const status = typeof metadata.status === "number" && Number.isSafeInteger(metadata.status)
    ? metadata.status
    : parseFailureStatus(raw);
  const retryMatch = /retry failed after\s+(\d+)\s+attempts?/i.exec(raw);
  const retryAttempts = typeof metadata.retryAttempts === "number" && Number.isSafeInteger(metadata.retryAttempts)
    ? metadata.retryAttempts
    : retryMatch ? Number(retryMatch[1]) : undefined;
  let kind = promptFailureKind(raw, legacy, status);
  if (metadata.aborted) kind = "user-aborted";
  else if (metadata.runtimeExit) kind = "runtime-exit";
  else if (metadata.modelUnavailable) kind = "model-unavailable";
  const retryExhausted = retryAttempts !== undefined
    ? retryAttempts > 0 && /retry failed|retry exhausted|after\s+\d+\s+attempts?/i.test(raw)
    : /retry failed|retry exhausted/i.test(raw);
  return {
    kind,
    ...(safeFailureMetadata(metadata.provider, 200) ? { provider: safeFailureMetadata(metadata.provider, 200) } : null),
    ...(safeFailureMetadata(metadata.model, 400) ? { model: safeFailureMetadata(metadata.model, 400) } : null),
    ...(safeFailureMetadata(metadata.api, 120) ? { api: safeFailureMetadata(metadata.api, 120) } : null),
    ...(status !== undefined ? { status } : null),
    ...(retryAttempts !== undefined ? { retryAttempts } : null),
    ...(retryExhausted ? { retryExhausted: true } : null),
    ...(safeFailureMetadata(metadata.requestId, 200) ? { requestId: safeFailureMetadata(metadata.requestId, 200) } : null),
    ...(safeFailureMetadata(metadata.incidentId, 80) ? { incidentId: safeFailureMetadata(metadata.incidentId, 80) } : null),
    message: visibleAssistantErrorDetail(raw),
  };
}

/**
 * Classify one failure into a stable category while retaining the full provider
 * body. Categories stay provider-agnostic because Pi forwards upstream wording
 * verbatim, and because the same classifier serves persisted and Runtime-level
 * failures.
 */
export function classifyFailureReason(raw: string): AssistantErrorNotice {
  const status = lastHttpStatus(raw);
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
  return {
    kind,
    title: status ? `${category}（HTTP ${status}）` : category,
    detail: visibleAssistantErrorDetail(raw),
    failure: normalizePromptFailure(raw),
  };
}

/**
 * Classify an error carried by an assistant snapshot. A live `message_update`
 * may acquire the error text before its terminal `stopReason`, so it is rendered
 * immediately and continues through the same streaming projection as an answer.
 */
export function assistantErrorNotice(message: PiMessage): AssistantErrorNotice | null {
  if (message.role !== "assistant" || typeof message.errorMessage !== "string" || !message.errorMessage.trim()) return null;
  const notice = classifyFailureReason(message.errorMessage);
  const route = failureRoute(message.provider, message.model, message.api);
  const failure = normalizePromptFailure(message.errorMessage, {
    provider: message.provider,
    model: message.model,
    api: message.api,
  });
  return route ? { ...notice, route, failure } : { ...notice, failure };
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
  const rawDetail = rawText || "Pi 未能完成这次请求";
  const notice = classifyFailureReason(
    incident && !rawDetail.includes(incident)
      ? `${rawDetail}\n事件 ID：${incident}`
      : rawDetail,
  );
  return {
    ...notice,
    id: `${sessionId}:${incident || `${notice.kind}:${errorDetailIdentity(notice.detail)}`}`,
    sessionId,
    at,
  };
}

/** Stable, short identity for an unbounded visible error detail. */
function errorDetailIdentity(detail: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < detail.length; index += 1) {
    hash ^= detail.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${detail.length.toString(36)}-${(hash >>> 0).toString(36)}`;
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
