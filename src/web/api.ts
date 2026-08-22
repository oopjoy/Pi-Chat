import type { ServerStateDiagnosticSnapshot } from "../shared/state-diagnostics";
import type { BackgroundSubagentSnapshot, BootstrapData, BootstrapHandshakeData, ExtensionResource, GateMode, InitialPromptData, ModelInfo, PackageResource, PromptDelivery, PromptImage, PromptSettingsSnapshot, QueuedPrompt, ResourceResponse, SessionCopyData, SessionDirectorySummary, SessionRuntimeReadyData, SessionSummary, SessionViewData, SkillResource, ThinkingLevel, WorkspaceFileData, WorkspaceRecentFilesData } from "../shared/types";
import { recordBrowserStateDiagnostic } from "./lib/state-diagnostics";

export type ExtensionResponseInput = {
  id: string;
  sessionId: string;
  cancelled?: boolean;
  confirmed?: boolean;
  value?: string;
};

const API_TIMEOUT_MS = 65_000;
// Pi acknowledges a prompt only after preflight. Auto-compaction runs in that
// preflight, and summarizing a long high-reasoning session can legitimately
// exceed the normal request budget.
const PROMPT_PREPARE_TIMEOUT_MS = 210_000;
const APPLICATION_RESTART_TIMEOUT_MS = 10 * 60_000;
const APPLICATION_HANDOFF_TIMEOUT_MS = 90_000;
let requestToken = "";
let handshakeInFlight: Promise<BootstrapHandshakeData> | null = null;
// A replacement Pi Chat process rotates its in-memory request token. Responses
// from the old process remain uncancelled, so token writes are generation-scoped.
let connectionGeneration = 0;

function incidentMessage(message: string, incidentId: unknown): string {
  return typeof incidentId === "string" && /^PC-[A-Z0-9_-]{8}$/.test(incidentId)
    ? `${message}（事件 ID：${incidentId}）`
    : message;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly incidentId?: string,
  ) {
    super(incidentMessage(message, incidentId));
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
const pageId = crypto.randomUUID();
// One ordering domain per concrete page. Every foreground/background mutation
// advances the same counter so out-of-order HTTP completion cannot reverse it.
let presenceRevision = 0;

function nextPresenceRevision(): number {
  presenceRevision += 1;
  return presenceRevision;
}

function storeRequestToken(value: unknown): void {
  if (typeof value === "string" && value) requestToken = value;
}

function acceptConnectionToken(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  // A successful reconnect is an authority boundary even when a transient
  // transport drop happens to return the same token. Old responses must never
  // regain token ownership after this point.
  connectionGeneration += 1;
  handshakeInFlight = null;
  requestToken = value;
  return true;
}

async function recoverConnection(): Promise<void> {
  const deadline = Date.now() + APPLICATION_HANDOFF_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // The fixed-shape handshake is the only tokenless browser API and returns
      // no Session or Runtime data while obtaining a replacement process token.
      const response = await fetch("/api/bootstrap/handshake", {
        cache: "no-store",
        headers: { "x-pi-chat-client": clientId, "x-pi-chat-page": pageId },
        signal: AbortSignal.timeout(3_000),
      });
      const value = await response.json().catch(() => ({})) as { requestToken?: string };
      if (response.ok && acceptConnectionToken(value.requestToken)) return;
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
      // Deliberately omit the expired token: the fixed-shape handshake obtains
      // the freshly started server's new in-memory token without loading state.
      const response = await fetch("/api/bootstrap/handshake", { cache: "no-store", signal: AbortSignal.timeout(3_000) });
      const value = await response.json() as { requestToken?: string };
      if (response.ok && value.requestToken && value.requestToken !== previousToken) {
        acceptConnectionToken(value.requestToken);
        return;
      }
    } catch {
      // The old listener is closing or the new listener has not bound yet.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error("Pi Chat 新服务启动超时，请通过桌面快捷方式重新打开");
}

async function request<T>(
  path: string,
  options?: RequestInit,
  timeoutMs = API_TIMEOUT_MS,
  acceptResponseToken = true,
  traceDiagnostic = true,
): Promise<T> {
  const requestGeneration = connectionGeneration;
  const diagnosticStartedAt = performance.now();
  const diagnosticRoute = new URL(path, "http://127.0.0.1").pathname;
  if (traceDiagnostic) recordBrowserStateDiagnostic("http", "request-start", {
    details: { method: options?.method || "GET", route: diagnosticRoute },
  });
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      signal: options?.signal || AbortSignal.timeout(timeoutMs),
    headers: {
      ...(options?.body ? { "content-type": "application/json" } : {}),
      ...(requestToken ? { "x-pi-chat-token": requestToken } : {}),
      "x-pi-chat-client": clientId,
      "x-pi-chat-page": pageId,
      ...options?.headers,
      },
    });
  } catch (cause) {
    if (traceDiagnostic) recordBrowserStateDiagnostic("http", "request-error", {
      details: {
        method: options?.method || "GET",
        route: diagnosticRoute,
        durationMs: Math.round(performance.now() - diagnosticStartedAt),
        errorType: cause instanceof Error ? cause.name : typeof cause,
      },
    });
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      const seconds = Math.round(timeoutMs / 1_000);
      throw new Error(`Pi Chat 请求超时（${seconds} 秒）。Pi 可能正在压缩上下文或模型服务没有响应；请查看界面状态，必要时重启 Pi RPC 后再试。`);
    }
    throw cause;
  }
  const value = await response.json().catch(() => ({})) as T & { error?: string; requestToken?: string; code?: string; incidentId?: string };
  // A maintenance-state bootstrap may return 503 while still granting the
  // guarded startup token required to subscribe to lifecycle SSE.
  if (acceptResponseToken && requestGeneration === connectionGeneration)
    storeRequestToken(value.requestToken);
  if (traceDiagnostic) recordBrowserStateDiagnostic("http", "request-end", {
    details: {
      method: options?.method || "GET",
      route: diagnosticRoute,
      status: response.status,
      durationMs: Math.round(performance.now() - diagnosticStartedAt),
    },
  });
  if (!response.ok)
    throw new ApiRequestError(
      value.error || `请求失败：${response.status}`,
      response.status,
      value.code,
      value.incidentId,
    );
  return value;
}

function handshake(): Promise<BootstrapHandshakeData> {
  if (handshakeInFlight) return handshakeInFlight;
  // The App applies handshake data only after its refresh/epoch authority check.
  // Do not let an old handshake response mutate the shared token by itself.
  const handshakeRequest = request<BootstrapHandshakeData>(
    "/api/bootstrap/handshake",
    undefined,
    API_TIMEOUT_MS,
    false,
  ).finally(() => {
    if (handshakeInFlight === handshakeRequest) handshakeInFlight = null;
  });
  handshakeInFlight = handshakeRequest;
  return handshakeRequest;
}

function acceptHandshake(handshake: BootstrapHandshakeData): void {
  storeRequestToken(handshake.requestToken);
}

function detachHandshake(): void {
  // A newer same-process UI refresh must not inherit the older refresh's
  // authority closure. This intentionally retains the current token/generation.
  handshakeInFlight = null;
}

function invalidateHandshake(): void {
  connectionGeneration += 1;
  requestToken = "";
  // Do not cancel the browser request. Forgetting its promise lets the new
  // process issue its own handshake, while generation guards reject its token.
  detachHandshake();
}

async function bootstrap(): Promise<BootstrapData> {
  const bootstrapGeneration = connectionGeneration;
  if (!requestToken) {
    const handshakeData = await handshake();
    if (bootstrapGeneration !== connectionGeneration) return bootstrap();
    acceptHandshake(handshakeData);
  }
  if (bootstrapGeneration !== connectionGeneration) return bootstrap();
  return request<BootstrapData>("/api/bootstrap");
}

export const api = {
  handshake,
  acceptHandshake,
  acceptConnectionToken,
  detachHandshake,
  invalidateHandshake,
  bootstrap,
  eventsUrl: () => `/api/events?token=${encodeURIComponent(requestToken)}&client=${encodeURIComponent(clientId)}&page=${encodeURIComponent(pageId)}&stream=delta-v1`,
  renewPresence: () => request<{ present: boolean }>("/api/presence", {
    method: "POST",
    body: JSON.stringify({ foreground: true, revision: nextPresenceRevision() }),
  }, 10_000),
  relinquishPresence: () => request<{ present: boolean }>("/api/presence", {
    method: "POST",
    body: JSON.stringify({ foreground: false, revision: nextPresenceRevision() }),
  }, 10_000),
  restart: () => request<{ restarting: true }>("/api/restart", { method: "POST" }, APPLICATION_RESTART_TIMEOUT_MS),
  waitForApplicationHandoff,
  recoverConnection,
  closeWindow: () => request<{ shuttingDown: boolean; closeWindow: true; sessionId?: string; rested?: boolean; remainingWindows: number; autoShutdownPending?: boolean }>("/api/window/close", { method: "POST" }),
  signalWindowClose: (foreground: boolean) => {
    if (!requestToken || typeof navigator.sendBeacon !== "function") return false;
    const query = new URLSearchParams({
      token: requestToken,
      client: clientId,
      page: pageId,
      foreground: foreground ? "1" : "0",
    });
    return navigator.sendBeacon(`/api/window/close?${query}`);
  },
  shutdown: () => request<{ shuttingDown: true }>("/api/shutdown", { method: "POST" }),
  stateDiagnosticSnapshot: () => request<ServerStateDiagnosticSnapshot>("/api/diagnostics/snapshot"),
  prompt: (message: string, images: PromptImage[] = [], sessionId: string, gateMode?: GateMode, delivery: PromptDelivery = "queue", settings?: PromptSettingsSnapshot) => request<{ accepted: boolean; queued: boolean; steered?: boolean; /** Pi received the JSONL command but its response timed out; final execution remains event-confirmed. */ deliveryUncertain?: boolean; extension?: boolean; command?: string; description?: string; isStreaming?: boolean; id?: string; queue?: QueuedPrompt[] }>("/api/chat/prompt", {
    method: "POST",
    body: JSON.stringify({
      message,
      sessionId,
      gateMode,
      delivery,
      images: images.map(({ type, data, mimeType }) => ({ type, data, mimeType })),
      ...(settings ? { settings } : null),
    }),
  }, PROMPT_PREPARE_TIMEOUT_MS),
  pickLocalFiles: () => request<{ paths: string[] }>("/api/local-files/pick", { method: "POST" }),
  clipboardLocalFiles: () => request<{ paths: string[] }>("/api/local-files/clipboard", { method: "POST" }),
  pickDraftWorkspace: () => request<{ cancelled: boolean; cwd?: string }>("/api/workspace/draft-pick", { method: "POST" }),
  pickWorkspace: () => request<{ cancelled: boolean; workspaceName?: string; cwd?: string; workspaceEpoch?: string; workspaceRevision?: number; data?: BootstrapData }>("/api/workspace/pick", { method: "POST" }),
  abort: (sessionId: string) => request<{ ok: boolean; abortPending?: boolean; isStreaming: boolean; queuePaused: boolean }>("/api/chat/abort", { method: "POST", body: JSON.stringify({ sessionId }) }),
  cancelQueued: (id: string, sessionId: string) => request<{ queue: QueuedPrompt[]; paused: boolean }>(`/api/chat/queue/${id}`, { method: "DELETE", body: JSON.stringify({ sessionId }) }),
  resumeQueue: (sessionId: string) => request<{ queue: QueuedPrompt[]; paused: boolean }>("/api/chat/queue/resume", { method: "POST", body: JSON.stringify({ sessionId }) }),
  compact: (customInstructions: string, sessionId: string) => request<{ result: Record<string, unknown> }>("/api/chat/compact", { method: "POST", body: JSON.stringify({ customInstructions, sessionId }) }, PROMPT_PREPARE_TIMEOUT_MS),
  newSession: (cwd?: string) => request<SessionViewData>("/api/sessions/new", { method: "POST", body: JSON.stringify(cwd ? { cwd } : {}) }),
  submitNewSession: (input: { cwd?: string; message: string; images: PromptImage[]; model?: ModelInfo | null; thinkingLevel?: ThinkingLevel; gateMode?: GateMode }) => request<InitialPromptData>("/api/sessions/new", {
    method: "POST",
    body: JSON.stringify({
      ...(input.cwd ? { cwd: input.cwd } : null),
      initial: {
        message: input.message,
        images: input.images.map(({ type, data, mimeType }) => ({ type, data, mimeType })),
        ...(input.model ? { model: { provider: input.model.provider, modelId: input.model.id } } : null),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : null),
        ...(input.gateMode ? { gateMode: input.gateMode } : null),
      },
    }),
  }, PROMPT_PREPARE_TIMEOUT_MS),
  // Cold persisted Sessions may need one whole-process retry after Pi's
  // startup get_state budget expires. Keep this request aligned with prompt
  // preparation so the browser does not abort while the safe retry is running.
  warmSession: (id: string) => request<SessionRuntimeReadyData>(
    `/api/sessions/${id}/warm`,
    { method: "POST" },
    PROMPT_PREPARE_TIMEOUT_MS,
  ),
  backgroundSubagents: (id: string, signal?: AbortSignal) =>
    request<BackgroundSubagentSnapshot>(`/api/sessions/${id}/background-subagents`, { signal }, API_TIMEOUT_MS, true, false),
  viewBackgroundSubagent: (
    parentId: string,
    childId: string,
    turns?: number,
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (turns) query.set("turns", String(turns));
    const suffix = query.size ? `?${query}` : "";
    return request<SessionViewData>(
      `/api/sessions/${parentId}/background-subagents/${childId}/view${suffix}`,
      { signal },
    );
  },
  workspaceFiles: (id: string, signal?: AbortSignal) =>
    request<WorkspaceRecentFilesData>(`/api/sessions/${id}/workspace/files`, { signal }),
  workspaceFile: (id: string, path: string, signal?: AbortSignal) =>
    request<WorkspaceFileData>(
      `/api/sessions/${id}/workspace/file?${new URLSearchParams({ path })}`,
      { signal },
    ),
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
  sessions: (
    all = false,
    includeIds: string[] = [],
    fresh = false,
  ) => {
    const query = new URLSearchParams();
    if (all) query.set("all", "1");
    if (fresh) query.set("fresh", "1");
    const included = [
      ...new Set(
        includeIds
          .map((id) => id.trim().toLowerCase())
          .filter((id) => /^[a-f0-9]{20}$/.test(id)),
      ),
    ].slice(0, 500);
    if (included.length) query.set("include", included.join(","));
    const suffix = query.size ? `?${query}` : "";
    return request<{
      sessions: SessionSummary[];
      total: number;
      directories?: SessionDirectorySummary[];
    }>(`/api/sessions${suffix}`);
  },
  /** Cumulative directory prefix: a recency reorder between clicks cannot skip rows. */
  directorySessions: (cwd: string, limit = 15) =>
    request<{
      sessions: SessionSummary[];
      total: number;
      directories?: SessionDirectorySummary[];
    }>(
      `/api/sessions?${new URLSearchParams({ cwd, offset: "0", limit: String(limit) })}`,
    ),
  cloneSession: (id: string) => request<SessionCopyData>(`/api/sessions/${id}/clone`, {
    method: "POST",
    body: JSON.stringify({}),
  }, PROMPT_PREPARE_TIMEOUT_MS),
  forkSession: (id: string, persistedMessageId: string) => request<SessionCopyData>(`/api/sessions/${id}/fork`, {
    method: "POST",
    body: JSON.stringify({ persistedMessageId }),
  }, PROMPT_PREPARE_TIMEOUT_MS),
  renameSession: (id: string, name: string) => request<{ id: string; name: string }>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteSession: (id: string) => request<BootstrapData>(`/api/sessions/${id}`, { method: "DELETE" }),
  setModel: (provider: string, modelId: string, sessionId: string) => request<{ model: BootstrapData["state"]["model"]; pending: boolean }>("/api/models/set", {
    method: "POST",
    body: JSON.stringify({ provider, modelId, sessionId }),
  }),
  setThinking: (level: ThinkingLevel, sessionId: string) => request<{ level: ThinkingLevel; pending: boolean }>("/api/thinking/set", {
    method: "POST",
    body: JSON.stringify({ level, sessionId }),
  }),
  skills: () => request<ResourceResponse<SkillResource>>("/api/resources/skills"),
  extensions: () => request<ResourceResponse<ExtensionResource>>("/api/resources/extensions"),
  packages: () => request<ResourceResponse<PackageResource>>("/api/resources/packages"),
  browseResource: (kind: "skills-root" | "extensions-root" | "packages-root" | "models-root") =>
    request<{ ok: true; path: string }>("/api/resources/browse", { method: "POST", body: JSON.stringify({ kind }) }),
  respondToExtension: (body: ExtensionResponseInput) => request<{ ok: boolean }>("/api/extension-ui/respond", {
    method: "POST",
    body: JSON.stringify(body),
  }),
};
