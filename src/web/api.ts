import type { BootstrapData, CustomModelInput, ExtensionResource, PackageResource, PromptImage, QueuedPrompt, ResourceResponse, SessionSummary, SessionViewData, SkillResource, ThinkingLevel } from "../shared/types";

const API_TIMEOUT_MS = 65_000;
// Pi acknowledges a prompt only after preflight. Auto-compaction runs in that
// preflight, and summarizing a long high-reasoning session can legitimately
// exceed the normal request budget.
const PROMPT_PREPARE_TIMEOUT_MS = 210_000;
const APPLICATION_RESTART_TIMEOUT_MS = 10 * 60_000;
const APPLICATION_HANDOFF_TIMEOUT_MS = 90_000;
let requestToken = "";
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
  const value = await response.json().catch(() => ({})) as T & { error?: string; requestToken?: string };
  // A maintenance-state bootstrap may return 503 while still granting the
  // guarded startup token required to subscribe to lifecycle SSE.
  storeRequestToken(value.requestToken);
  if (!response.ok) throw new Error(value.error || `请求失败：${response.status}`);
  return value;
}

export const api = {
  bootstrap: () => request<BootstrapData>("/api/bootstrap"),
  eventsUrl: () => `/api/events?token=${encodeURIComponent(requestToken)}&client=${encodeURIComponent(clientId)}`,
  takeSessionControl: (sessionId: string) => request<{ controlOwner: string; controlledByThisWindow: boolean }>(`/api/sessions/${sessionId}/control`, { method: "POST" }),
  restart: () => request<{ restarting: true }>("/api/restart", { method: "POST" }, APPLICATION_RESTART_TIMEOUT_MS),
  waitForApplicationHandoff,
  closeWindow: () => request<{ shuttingDown: boolean; closeWindow: true; sessionId?: string; rested?: boolean; remainingWindows: number }>("/api/window/close", { method: "POST" }),
  shutdown: () => request<{ shuttingDown: true }>("/api/shutdown", { method: "POST" }),
  prompt: (message: string, images: PromptImage[] = [], sessionId = "") => request<{ accepted: boolean; queued: boolean; extension?: boolean; command?: string; description?: string; isStreaming?: boolean; id?: string; queue?: QueuedPrompt[] }>("/api/chat/prompt", {
    method: "POST",
    body: JSON.stringify({ message, sessionId, images: images.map(({ type, data, mimeType }) => ({ type, data, mimeType })) }),
  }, PROMPT_PREPARE_TIMEOUT_MS),
  pickLocalFiles: () => request<{ paths: string[] }>("/api/local-files/pick", { method: "POST" }),
  clipboardLocalFiles: () => request<{ paths: string[] }>("/api/local-files/clipboard", { method: "POST" }),
  pickWorkspace: () => request<{ cancelled: boolean; workspaceName?: string; data?: BootstrapData }>("/api/workspace/pick", { method: "POST" }),
  abort: (sessionId = "") => request<{ ok: boolean; isStreaming: boolean; queuePaused: boolean }>("/api/chat/abort", { method: "POST", body: JSON.stringify({ sessionId }) }),
  cancelQueued: (id: string, sessionId = "") => request<{ queue: QueuedPrompt[]; paused: boolean }>(`/api/chat/queue/${id}`, { method: "DELETE", body: JSON.stringify({ sessionId }) }),
  resumeQueue: (sessionId = "") => request<{ queue: QueuedPrompt[]; paused: boolean }>("/api/chat/queue/resume", { method: "POST", body: JSON.stringify({ sessionId }) }),
  compact: (customInstructions = "", sessionId = "") => request<{ result: Record<string, unknown> }>("/api/chat/compact", { method: "POST", body: JSON.stringify({ customInstructions, sessionId }) }, PROMPT_PREPARE_TIMEOUT_MS),
  newSession: () => request<SessionViewData>("/api/sessions/new", { method: "POST" }),
  viewSession: (id: string, turns?: number) => request<SessionViewData>(`/api/sessions/${id}/view${turns ? `?turns=${turns}` : ""}`),
  markSessionViewed: (id: string) => request<{ viewing: string }>(`/api/sessions/${id}/viewing`, { method: "POST" }),
  activateSession: (id: string) => request<SessionViewData>(`/api/sessions/${id}/activate`, { method: "POST" }),
  sessions: () => request<{ sessions: SessionSummary[] }>("/api/sessions"),
  renameSession: (id: string, name: string) => request<BootstrapData>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteSession: (id: string) => request<BootstrapData>(`/api/sessions/${id}`, { method: "DELETE" }),
  customModel: (provider: string, modelId: string) => request<{ model: CustomModelInput }>(`/api/models/${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}`),
  addModel: (model: CustomModelInput) => request<BootstrapData>("/api/models", { method: "POST", body: JSON.stringify(model) }),
  updateModel: (provider: string, modelId: string, model: CustomModelInput) => request<BootstrapData>(`/api/models/${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}`, { method: "PUT", body: JSON.stringify(model) }),
  removeModel: (provider: string, modelId: string) => request<BootstrapData>("/api/models", { method: "DELETE", body: JSON.stringify({ provider, modelId }) }),
  setModel: (provider: string, modelId: string, sessionId = "") => request<{ model: BootstrapData["state"]["model"]; pending: boolean }>("/api/models/set", {
    method: "POST",
    body: JSON.stringify({ provider, modelId, sessionId }),
  }),
  setThinking: (level: ThinkingLevel, sessionId = "") => request<{ level: ThinkingLevel; pending: boolean }>("/api/thinking/set", {
    method: "POST",
    body: JSON.stringify({ level, sessionId }),
  }),
  skills: () => request<ResourceResponse<SkillResource>>("/api/resources/skills"),
  installSkill: (sourcePath: string) => request<ResourceResponse<SkillResource>>("/api/resources/skills", { method: "POST", body: JSON.stringify({ sourcePath }) }),
  toggleSkill: (id: string, enabled: boolean) => request<ResourceResponse<SkillResource>>("/api/resources/skills", { method: "PATCH", body: JSON.stringify({ id, enabled }) }),
  removeSkill: (id: string) => request<ResourceResponse<SkillResource>>("/api/resources/skills", { method: "DELETE", body: JSON.stringify({ id }) }),
  extensions: () => request<ResourceResponse<ExtensionResource>>("/api/resources/extensions"),
  toggleExtension: (id: string, enabled: boolean) => request<ResourceResponse<ExtensionResource>>("/api/resources/extensions", { method: "PATCH", body: JSON.stringify({ id, enabled }) }),
  removeExtension: (id: string) => request<ResourceResponse<ExtensionResource>>("/api/resources/extensions", { method: "DELETE", body: JSON.stringify({ id }) }),
  packages: () => request<ResourceResponse<PackageResource>>("/api/resources/packages"),
  installPackage: (source: string) => request<ResourceResponse<PackageResource>>("/api/resources/packages", { method: "POST", body: JSON.stringify({ source }) }),
  togglePackage: (id: string, enabled: boolean) => request<ResourceResponse<PackageResource>>("/api/resources/packages", { method: "PATCH", body: JSON.stringify({ id, enabled }) }),
  removePackage: (id: string) => request<ResourceResponse<PackageResource>>("/api/resources/packages", { method: "DELETE", body: JSON.stringify({ id }) }),
  respondToExtension: (body: Record<string, unknown>) => request<{ ok: boolean }>("/api/extension-ui/respond", {
    method: "POST",
    body: JSON.stringify(body),
  }),
};
