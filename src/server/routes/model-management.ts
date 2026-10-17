import type { IncomingMessage, ServerResponse } from "node:http";
import { bodyJson, json, methodNotAllowed } from "../http-transport.js";
import { requiredSessionId, THINKING_LEVELS } from "./request-validation.js";

export interface ModelManagementRouteHost {
  available(): boolean;
  providerService(): {
    add(body: Record<string, unknown>): Promise<unknown>;
    get(provider: string): Promise<unknown>;
    remove(provider: string): Promise<unknown>;
    update(provider: string, body: Record<string, unknown>): Promise<unknown>;
  };
  customModelService(): {
    add(body: Record<string, unknown>): Promise<unknown>;
    get(provider: string, modelId: string): Promise<unknown>;
    remove(provider: string, modelId: string): Promise<unknown>;
    update(provider: string, modelId: string, body: Record<string, unknown>): Promise<unknown>;
  };
  runtimeSettingsService(): {
    setModel(sessionId: string, provider: string, modelId: string): Promise<unknown>;
    setThinking(sessionId: string, level: string): Promise<unknown>;
  };
  beginPromptAdmission(sessionId: string): Promise<() => void>;
}

/** Model/provider routes only coordinate existing management services. */
export async function handleModelManagementRoute(
  host: ModelManagementRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  preparedBody?: Record<string, unknown>,
): Promise<boolean> {
  if (url.pathname === "/api/models/provider" && request.method === "POST") {
    if (!host.available()) { json(response, 501, { error: "模型管理不可用" }); return true; }
    const body = preparedBody || await bodyJson(request);
    json(response, 200, await host.providerService().add(body));
    return true;
  }
  const providerMatch = /^\/api\/models\/provider\/([A-Za-z0-9._-]{1,80})$/.exec(url.pathname);
  if (providerMatch) {
    if (!host.available()) { json(response, 501, { error: "模型管理不可用" }); return true; }
    const provider = decodeURIComponent(providerMatch[1]);
    const service = host.providerService();
    if (request.method === "GET") { json(response, 200, { provider: await service.get(provider) }); return true; }
    if (request.method === "DELETE") { json(response, 200, await service.remove(provider)); return true; }
    if (request.method === "PUT") {
      const body = preparedBody || await bodyJson(request);
      json(response, 200, await service.update(provider, body));
      return true;
    }
    methodNotAllowed(response);
    return true;
  }
  const modelMatch = /^\/api\/models\/([A-Za-z0-9._-]{1,80})\/([^/]{1,200})$/.exec(url.pathname);
  if (modelMatch) {
    if (!host.available()) { json(response, 501, { error: "模型管理不可用" }); return true; }
    const provider = decodeURIComponent(modelMatch[1]);
    const modelId = decodeURIComponent(modelMatch[2]);
    const service = host.customModelService();
    if (request.method === "GET") { json(response, 200, { model: await service.get(provider, modelId) }); return true; }
    if (request.method === "PUT") {
      const body = preparedBody || await bodyJson(request);
      json(response, 200, await service.update(provider, modelId, body));
      return true;
    }
    methodNotAllowed(response);
    return true;
  }
  if (url.pathname === "/api/models") {
    if (!host.available()) { json(response, 501, { error: "模型管理不可用" }); return true; }
    if (request.method !== "POST" && request.method !== "DELETE") { methodNotAllowed(response); return true; }
    const body = preparedBody || await bodyJson(request);
    const service = host.customModelService();
    const result = request.method === "POST"
      ? await service.add(body)
      : await service.remove(String(body.provider || ""), String(body.modelId || ""));
    json(response, 200, result);
    return true;
  }
  if (url.pathname === "/api/models/set") {
    if (request.method !== "POST") { methodNotAllowed(response); return true; }
    const body = preparedBody || await bodyJson(request);
    const provider = typeof body.provider === "string" ? body.provider : "";
    const modelId = typeof body.modelId === "string" ? body.modelId : "";
    const sessionId = requiredSessionId(body);
    if (!provider || !modelId) { json(response, 400, { error: "provider 和 modelId 必填" }); return true; }
    const release = await host.beginPromptAdmission(sessionId);
    try { json(response, 200, await host.runtimeSettingsService().setModel(sessionId, provider, modelId)); }
    finally { release(); }
    return true;
  }
  if (url.pathname === "/api/thinking/set") {
    if (request.method !== "POST") { methodNotAllowed(response); return true; }
    const body = preparedBody || await bodyJson(request);
    const level = typeof body.level === "string" ? body.level : "";
    const sessionId = requiredSessionId(body);
    if (!THINKING_LEVELS.includes(level as typeof THINKING_LEVELS[number])) { json(response, 400, { error: "无效的 Thinking 强度" }); return true; }
    const release = await host.beginPromptAdmission(sessionId);
    try { json(response, 200, await host.runtimeSettingsService().setThinking(sessionId, level)); }
    finally { release(); }
    return true;
  }
  return false;
}
