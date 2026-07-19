import type { BootstrapData, CustomModelInput, PluginResource, PromptImage, QueuedPrompt, ResourceResponse, SessionSummary, SessionViewData, SkillResource, ThinkingLevel } from "../shared/types";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options?.body ? { "content-type": "application/json" } : {}),
      ...options?.headers,
    },
  });
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error || `请求失败：${response.status}`);
  return value;
}

export const api = {
  bootstrap: () => request<BootstrapData>("/api/bootstrap"),
  prompt: (message: string, images: PromptImage[] = [], sessionId = "") => request<{ accepted: boolean; queued: boolean; extension?: boolean; command?: string; description?: string; isStreaming?: boolean; id?: string; queue?: QueuedPrompt[] }>("/api/chat/prompt", {
    method: "POST",
    body: JSON.stringify({ message, sessionId, images: images.map(({ type, data, mimeType }) => ({ type, data, mimeType })) }),
  }),
  pickLocalFiles: () => request<{ paths: string[] }>("/api/local-files/pick", { method: "POST" }),
  clipboardLocalFiles: () => request<{ paths: string[] }>("/api/local-files/clipboard", { method: "POST" }),
  pickWorkspace: () => request<{ cancelled: boolean; workspaceName?: string; data?: BootstrapData }>("/api/workspace/pick", { method: "POST" }),
  abort: () => request<{ ok: boolean; isStreaming: boolean; queuePaused: boolean }>("/api/chat/abort", { method: "POST" }),
  cancelQueued: (id: string) => request<{ queue: QueuedPrompt[]; paused: boolean }>(`/api/chat/queue/${id}`, { method: "DELETE" }),
  resumeQueue: () => request<{ queue: QueuedPrompt[]; paused: boolean }>("/api/chat/queue/resume", { method: "POST" }),
  compact: (customInstructions = "") => request<{ result: Record<string, unknown> }>("/api/chat/compact", { method: "POST", body: JSON.stringify({ customInstructions }) }),
  newSession: () => request<BootstrapData>("/api/sessions/new", { method: "POST" }),
  viewSession: (id: string) => request<SessionViewData>(`/api/sessions/${id}/view`),
  switchSession: (id: string) => request<BootstrapData>(`/api/sessions/${id}/switch`, { method: "POST" }),
  sessions: () => request<{ sessions: SessionSummary[] }>("/api/sessions"),
  addModel: (model: CustomModelInput) => request<BootstrapData>("/api/models", { method: "POST", body: JSON.stringify(model) }),
  removeModel: (provider: string, modelId: string) => request<BootstrapData>("/api/models", { method: "DELETE", body: JSON.stringify({ provider, modelId }) }),
  setModel: (provider: string, modelId: string) => request<{ model: BootstrapData["state"]["model"] }>("/api/models/set", {
    method: "POST",
    body: JSON.stringify({ provider, modelId }),
  }),
  setThinking: (level: ThinkingLevel) => request<{ level: ThinkingLevel }>("/api/thinking/set", {
    method: "POST",
    body: JSON.stringify({ level }),
  }),
  skills: () => request<ResourceResponse<SkillResource>>("/api/resources/skills"),
  installSkill: (sourcePath: string) => request<ResourceResponse<SkillResource>>("/api/resources/skills", { method: "POST", body: JSON.stringify({ sourcePath }) }),
  toggleSkill: (id: string, enabled: boolean) => request<ResourceResponse<SkillResource>>("/api/resources/skills", { method: "PATCH", body: JSON.stringify({ id, enabled }) }),
  removeSkill: (id: string) => request<ResourceResponse<SkillResource>>("/api/resources/skills", { method: "DELETE", body: JSON.stringify({ id }) }),
  plugins: () => request<ResourceResponse<PluginResource>>("/api/resources/plugins"),
  installPlugin: (source: string) => request<ResourceResponse<PluginResource>>("/api/resources/plugins", { method: "POST", body: JSON.stringify({ source }) }),
  togglePlugin: (id: string, enabled: boolean) => request<ResourceResponse<PluginResource>>("/api/resources/plugins", { method: "PATCH", body: JSON.stringify({ id, enabled }) }),
  removePlugin: (id: string) => request<ResourceResponse<PluginResource>>("/api/resources/plugins", { method: "DELETE", body: JSON.stringify({ id }) }),
  respondToExtension: (body: Record<string, unknown>) => request<{ ok: boolean }>("/api/extension-ui/respond", {
    method: "POST",
    body: JSON.stringify(body),
  }),
};
