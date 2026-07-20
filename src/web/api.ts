import type { BootstrapData, CustomModelInput, ExtensionResource, PackageResource, PromptImage, QueuedPrompt, ResourceResponse, SessionSummary, SessionViewData, SkillResource, ThinkingLevel } from "../shared/types";

const API_TIMEOUT_MS = 65_000;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      signal: options?.signal || AbortSignal.timeout(API_TIMEOUT_MS),
    headers: {
      ...(options?.body ? { "content-type": "application/json" } : {}),
      ...options?.headers,
      },
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "TimeoutError") throw new Error("Pi Chat 请求超时（65 秒）。服务或 Pi RPC 可能正在重启；请稍后重试。 ");
    throw cause;
  }
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error || `请求失败：${response.status}`);
  return value;
}

export const api = {
  bootstrap: () => request<BootstrapData>("/api/bootstrap"),
  restart: () => request<BootstrapData>("/api/restart", { method: "POST" }),
  prompt: (message: string, images: PromptImage[] = [], sessionId = "") => request<{ accepted: boolean; queued: boolean; extension?: boolean; command?: string; description?: string; isStreaming?: boolean; id?: string; queue?: QueuedPrompt[] }>("/api/chat/prompt", {
    method: "POST",
    body: JSON.stringify({ message, sessionId, images: images.map(({ type, data, mimeType }) => ({ type, data, mimeType })) }),
  }),
  pickLocalFiles: () => request<{ paths: string[] }>("/api/local-files/pick", { method: "POST" }),
  clipboardLocalFiles: () => request<{ paths: string[] }>("/api/local-files/clipboard", { method: "POST" }),
  pickWorkspace: () => request<{ cancelled: boolean; workspaceName?: string; data?: BootstrapData }>("/api/workspace/pick", { method: "POST" }),
  abort: (sessionId = "") => request<{ ok: boolean; isStreaming: boolean; queuePaused: boolean }>("/api/chat/abort", { method: "POST", body: JSON.stringify({ sessionId }) }),
  cancelQueued: (id: string, sessionId = "") => request<{ queue: QueuedPrompt[]; paused: boolean }>(`/api/chat/queue/${id}`, { method: "DELETE", body: JSON.stringify({ sessionId }) }),
  resumeQueue: (sessionId = "") => request<{ queue: QueuedPrompt[]; paused: boolean }>("/api/chat/queue/resume", { method: "POST", body: JSON.stringify({ sessionId }) }),
  compact: (customInstructions = "", sessionId = "") => request<{ result: Record<string, unknown> }>("/api/chat/compact", { method: "POST", body: JSON.stringify({ customInstructions, sessionId }) }),
  newSession: () => request<BootstrapData>("/api/sessions/new", { method: "POST" }),
  viewSession: (id: string) => request<SessionViewData>(`/api/sessions/${id}/view`),
  switchSession: (id: string) => request<BootstrapData>(`/api/sessions/${id}/switch`, { method: "POST" }),
  sessions: () => request<{ sessions: SessionSummary[] }>("/api/sessions"),
  renameSession: (id: string, name: string) => request<BootstrapData>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteSession: (id: string) => request<BootstrapData>(`/api/sessions/${id}`, { method: "DELETE" }),
  customModel: (provider: string, modelId: string) => request<{ model: CustomModelInput }>(`/api/models/${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}`),
  addModel: (model: CustomModelInput) => request<BootstrapData>("/api/models", { method: "POST", body: JSON.stringify(model) }),
  removeModel: (provider: string, modelId: string) => request<BootstrapData>("/api/models", { method: "DELETE", body: JSON.stringify({ provider, modelId }) }),
  setModel: (provider: string, modelId: string, sessionId = "") => request<{ model: BootstrapData["state"]["model"] }>("/api/models/set", {
    method: "POST",
    body: JSON.stringify({ provider, modelId, sessionId }),
  }),
  setThinking: (level: ThinkingLevel, sessionId = "") => request<{ level: ThinkingLevel }>("/api/thinking/set", {
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
