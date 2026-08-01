import type { BootstrapData, ExtensionResource, GateMode, PackageResource, PromptImage, QueuedPrompt, ResourceResponse, SessionSummary, SessionViewData, SkillResource, ThinkingLevel } from "../shared/types";

const API_TIMEOUT_MS = 65_000;
// Pi acknowledges a prompt only after preflight. Auto-compaction runs in that
// preflight, and summarizing a long high-reasoning session can legitimately
// exceed the normal request budget.
const PROMPT_PREPARE_TIMEOUT_MS = 210_000;
const APPLICATION_RESTART_TIMEOUT_MS = 10 * 60_000;
const APPLICATION_HANDOFF_TIMEOUT_MS = 90_000;
let requestToken = "";

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const clientId = (() => {
  const key = "pi-chat.window-client.v1";
  const existing = window.sessionStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.sessionStorage.setItem(key, created);
  return created;
})();

function storeRequestToken(value: unknown): void {
  if (typeof value === "string" && value) requestToken = value;
}

async function recoverConnection(): Promise<void> {
  const deadline = Date.now() + APPLICATION_HANDOFF_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // Omit the possibly stale token. Bootstrap is the guarded same-origin
      // handshake that returns the current process token after a crash/restart.
      const response = await fetch("/api/bootstrap", {
        cache: "no-store",
        headers: { "x-pi-chat-client": clientId },
        signal: AbortSignal.timeout(3_000),
      });
      const value = await response.json().catch(() => ({})) as { requestToken?: string };
      storeRequestToken(value.requestToken);
      if (response.ok && value.requestToken) return;
    } catch {
      // Listener is unavailable or still starting.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 350));
  }
  throw new Error("无法重新连接 Pi Chat 服务，请通过桌面快捷方式重新打开");
}

async function waitForApplicationHandoff(previousToken = requestToken): Promise<void> {
  const deadline = Date.now() + APPLICATION_HANDOFF_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // Deliberately omit the expired token: bootstrap is the guarded handshake
      // that obtains the freshly started server's new in-memory token.
      const response = await fetch("/api/bootstrap", { cache: "no-store", signal: AbortSignal.timeout(3_000) });
      const value = await response.json() as { requestToken?: string };
      if (response.ok && value.requestToken && value.requestToken !== previousToken) {
        storeRequestToken(value.requestToken);
        return;
      }
    } catch {
      // The old listener is closing or the new listener has not bound yet.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error("Pi Chat 新服务启动超时，请通过桌面快捷方式重新打开");
}

async function request<T>(path: string, options?: RequestInit, timeoutMs = API_TIMEOUT_MS): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      signal: options?.signal || AbortSignal.timeout(timeoutMs),
    headers: {
      ...(options?.body ? { "content-type": "application/json" } : {}),
      ...(requestToken ? { "x-pi-chat-token": requestToken } : {}),
      "x-pi-chat-client": clientId,
      ...options?.headers,
      },
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      const seconds = Math.round(timeoutMs / 1_000);
      throw new Error(`Pi Chat 请求超时（${seconds} 秒）。Pi 可能正在压缩上下文或模型服务没有响应；请查看界面状态，必要时重启 Pi RPC 后再试。`);
    }
    throw cause;
  }
  const value = await response.json().catch(() => ({})) as T & { error?: string; requestToken?: string; code?: string };
  // A maintenance-state bootstrap may return 503 while still granting the
  // guarded startup token required to subscribe to lifecycle SSE.
  storeRequestToken(value.requestToken);
  if (!response.ok) throw new ApiRequestError(value.error || `请求失败：${response.status}`, response.status, value.code);
  return value;
}

export const api = {
  bootstrap: () => request<BootstrapData>("/api/bootstrap"),
  eventsUrl: () => `/api/events?token=${encodeURIComponent(requestToken)}&client=${encodeURIComponent(clientId)}`,
  renewPresence: () => request<{ present: true }>("/api/presence", { method: "POST" }, 10_000),
  takeSessionControl: (sessionId: string) => request<{ controlOwner: string; controlledByThisWindow: boolean }>(`/api/sessions/${sessionId}/control`, { method: "POST" }),
  restart: () => request<{ restarting: true }>("/api/restart", { method: "POST" }, APPLICATION_RESTART_TIMEOUT_MS),
  waitForApplicationHandoff,
  recoverConnection,
  closeWindow: () => request<{ shuttingDown: boolean; closeWindow: true; sessionId?: string; rested?: boolean; remainingWindows: number }>("/api/window/close", { method: "POST" }),
  shutdown: () => request<{ shuttingDown: true }>("/api/shutdown", { method: "POST" }),
  prompt: (message: string, images: PromptImage[] = [], sessionId = "", gateMode?: GateMode) => request<{ accepted: boolean; queued: boolean; extension?: boolean; command?: string; description?: string; isStreaming?: boolean; id?: string; queue?: QueuedPrompt[] }>("/api/chat/prompt", {
    method: "POST",
    body: JSON.stringify({ message, sessionId, gateMode, images: images.map(({ type, data, mimeType }) => ({ type, data, mimeType })) }),
  }, PROMPT_PREPARE_TIMEOUT_MS),
  pickLocalFiles: () => request<{ paths: string[] }>("/api/local-files/pick", { method: "POST" }),
  clipboardLocalFiles: () => request<{ paths: string[] }>("/api/local-files/clipboard", { method: "POST" }),
  pickWorkspace: () => request<{ cancelled: boolean; workspaceName?: string; data?: BootstrapData }>("/api/workspace/pick", { method: "POST" }),
  abort: (sessionId = "") => request<{ ok: boolean; isStreaming: boolean; queuePaused: boolean }>("/api/chat/abort", { method: "POST", body: JSON.stringify({ sessionId }) }),
  cancelQueued: (id: string, sessionId = "") => request<{ queue: QueuedPrompt[]; paused: boolean }>(`/api/chat/queue/${id}`, { method: "DELETE", body: JSON.stringify({ sessionId }) }),
  resumeQueue: (sessionId = "") => request<{ queue: QueuedPrompt[]; paused: boolean }>("/api/chat/queue/resume", { method: "POST", body: JSON.stringify({ sessionId }) }),
  compact: (customInstructions = "", sessionId = "") => request<{ result: Record<string, unknown> }>("/api/chat/compact", { method: "POST", body: JSON.stringify({ customInstructions, sessionId }) }, PROMPT_PREPARE_TIMEOUT_MS),
  newSession: () => request<SessionViewData>("/api/sessions/new", { method: "POST" }),
  viewSession: (id: string, turns?: number, options: { fast?: boolean; signal?: AbortSignal } = {}) => {
    const query = new URLSearchParams();
    if (turns) query.set("turns", String(turns));
    if (options.fast) query.set("fast", "1");
    const suffix = query.size ? `?${query}` : "";
    return request<SessionViewData>(`/api/sessions/${id}/view${suffix}`, { signal: options.signal });
  },
  markSessionViewed: (id: string) => request<{ viewing: string }>(`/api/sessions/${id}/viewing`, { method: "POST" }),
  clearSessionViewed: (sessionId: string) => request<{ viewing: string }>("/api/sessions/viewing/clear", { method: "POST", body: JSON.stringify({ sessionId }) }),
  activateSession: (id: string) => request<SessionViewData>(`/api/sessions/${id}/activate`, { method: "POST" }),
  sessions: (all = false) => request<{ sessions: SessionSummary[]; total: number }>(`/api/sessions${all ? "?all=1" : ""}`),
  releaseSession: (id: string) => request<{ released: true; sessionId: string; activeSessionIds: string[] }>(`/api/sessions/${id}/release`, { method: "POST" }),
  renameSession: (id: string, name: string) => request<BootstrapData>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteSession: (id: string) => request<BootstrapData>(`/api/sessions/${id}`, { method: "DELETE" }),
  setModel: (provider: string, modelId: string, sessionId = "") => request<{ model: BootstrapData["state"]["model"]; pending: boolean }>("/api/models/set", {
    method: "POST",
    body: JSON.stringify({ provider, modelId, sessionId }),
  }),
  setThinking: (level: ThinkingLevel, sessionId = "") => request<{ level: ThinkingLevel; pending: boolean }>("/api/thinking/set", {
    method: "POST",
    body: JSON.stringify({ level, sessionId }),
  }),
  skills: () => request<ResourceResponse<SkillResource>>("/api/resources/skills"),
  extensions: () => request<ResourceResponse<ExtensionResource>>("/api/resources/extensions"),
  packages: () => request<ResourceResponse<PackageResource>>("/api/resources/packages"),
  browseResource: (kind: "skills-root" | "extensions-root" | "packages-root" | "models-root") =>
    request<{ ok: true; path: string }>("/api/resources/browse", { method: "POST", body: JSON.stringify({ kind }) }),
  respondToExtension: (body: Record<string, unknown>) => request<{ ok: boolean }>("/api/extension-ui/respond", {
    method: "POST",
    body: JSON.stringify(body),
  }),
};
