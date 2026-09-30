import type { IncomingMessage, ServerResponse } from "node:http";
import { bodyJson, json, methodNotAllowed } from "../http-transport.js";

export interface SessionMutationsRouteHost {
  requireSessionControl(sessionId: string, clientId: string): void;
  beginPromptAdmission(sessionId: string): Promise<() => void>;
  renameSession(sessionId: string, name: string): Promise<unknown>;
  deleteSession(sessionId: string): Promise<unknown>;
  copySession(sessionId: string, mode: "clone" | "fork", persistedMessageId?: string): Promise<unknown>;
}

const SESSION_ID = /^[a-f0-9]{20}$/;

export async function handleSessionMutationsRoute(
  host: SessionMutationsRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  clientId: string,
  preparedBody?: Record<string, unknown>,
): Promise<boolean> {
  const copyMatch = /^\/api\/sessions\/([a-f0-9]{20})\/(clone|fork)$/.exec(url.pathname);
  if (copyMatch) {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const body = preparedBody || await bodyJson(request);
    const persistedMessageId = typeof body.persistedMessageId === "string"
      ? body.persistedMessageId
      : undefined;
    if (copyMatch[2] === "fork" && (!persistedMessageId || persistedMessageId.length > 403)) {
      json(response, 400, { error: "分叉消息标识无效" });
      return true;
    }
    json(response, 200, await host.copySession(
      copyMatch[1],
      copyMatch[2] as "clone" | "fork",
      persistedMessageId,
    ));
    return true;
  }

  const manageMatch = /^\/api\/sessions\/([a-f0-9]{20})$/.exec(url.pathname);
  if (!manageMatch || !SESSION_ID.test(manageMatch[1])) return false;
  if (request.method === "PATCH") {
    host.requireSessionControl(manageMatch[1], clientId);
    const body = preparedBody || await bodyJson(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
      json(response, 400, { error: "名称必须为 1 到 120 个有效字符" });
      return true;
    }
    const release = await host.beginPromptAdmission(manageMatch[1]);
    try {
      host.requireSessionControl(manageMatch[1], clientId);
      json(response, 200, await host.renameSession(manageMatch[1], name));
    } finally {
      release();
    }
    return true;
  }
  if (request.method === "DELETE") {
    host.requireSessionControl(manageMatch[1], clientId);
    const release = await host.beginPromptAdmission(manageMatch[1]);
    try {
      host.requireSessionControl(manageMatch[1], clientId);
      json(response, 200, await host.deleteSession(manageMatch[1]));
    } finally {
      release();
    }
    return true;
  }
  methodNotAllowed(response);
  return true;
}
