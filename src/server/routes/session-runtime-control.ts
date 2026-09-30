import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionRuntimeReadyData, SessionViewData } from "../../shared/types.js";
import { bodyJson, json, methodNotAllowed, requestClientId } from "../http-transport.js";

const SESSION_ID = /^[a-f0-9]{20}$/;

export interface SessionRuntimeControlHost {
  activeSessionId(): string;
  runtimeExists(sessionId: string): boolean;
  runtimeCanReclaim(sessionId: string): boolean;
  sweepRuntimes(): void;
  clearViewed(clientId: string, sessionId: string): string;
  knownSession(sessionId: string): Promise<boolean>;
  markViewed(clientId: string, sessionId: string): void;
  touchRuntime(sessionId: string): void;
  ensurePrimaryIdentity(): Promise<void>;
  ensurePrimaryRuntime(): Promise<void>;
  ensureSecondaryRuntime(sessionId: string): Promise<void>;
  primaryReady(sessionId: string): SessionRuntimeReadyData;
  secondaryReady(sessionId: string): SessionRuntimeReadyData;
  sessionView(sessionId: string, clientId: string): Promise<SessionViewData | null>;
  rethrowResultPending(error: unknown, operation: string, fence?: boolean): never;
}

export async function handleSessionRuntimeControlRoute(
  host: SessionRuntimeControlHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname === "/api/sessions/viewing/clear") {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const clientId = requestClientId(request);
    if (!clientId) {
      json(response, 400, { error: "浏览器窗口标识无效" });
      return true;
    }
    const body = await bodyJson(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!SESSION_ID.test(sessionId)) {
      json(response, 400, { error: "待清除的会话标识无效" });
      return true;
    }
    const viewing = host.clearViewed(clientId, sessionId);
    if (!viewing && host.runtimeCanReclaim(sessionId)) host.sweepRuntimes();
    json(response, 200, { viewing });
    return true;
  }

  const viewingMatch = /^\/api\/sessions\/([a-f0-9]{20})\/viewing$/.exec(url.pathname);
  if (viewingMatch) {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const clientId = requestClientId(request);
    if (!clientId) {
      json(response, 400, { error: "浏览器窗口标识无效" });
      return true;
    }
    const sessionId = viewingMatch[1];
    if (!host.runtimeExists(sessionId) && sessionId !== host.activeSessionId() && !await host.knownSession(sessionId)) {
      json(response, 404, { error: "会话不存在" });
      return true;
    }
    host.markViewed(clientId, sessionId);
    if (host.runtimeExists(sessionId)) host.touchRuntime(sessionId);
    json(response, 200, { viewing: sessionId });
    return true;
  }

  const warmMatch = /^\/api\/sessions\/([a-f0-9]{20})\/warm$/.exec(url.pathname);
  if (warmMatch) {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const sessionId = warmMatch[1];
    const exists = host.runtimeExists(sessionId);
    try {
      if (!exists && !host.activeSessionId()) await host.ensurePrimaryIdentity();
      if (sessionId === host.activeSessionId()) {
        await host.ensurePrimaryRuntime();
        json(response, 200, host.primaryReady(sessionId));
      } else {
        await host.ensureSecondaryRuntime(sessionId);
        json(response, 200, host.secondaryReady(sessionId));
      }
    } catch (error) {
      host.rethrowResultPending(error, "准备会话运行时", false);
    }
    return true;
  }

  const activateMatch = /^\/api\/sessions\/([a-f0-9]{20})\/activate$/.exec(url.pathname);
  if (activateMatch) {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const sessionId = activateMatch[1];
    const exists = host.runtimeExists(sessionId);
    try {
      if (!exists) await host.ensurePrimaryIdentity();
      if (sessionId === host.activeSessionId()) await host.ensurePrimaryRuntime();
      else if (!exists) await host.ensureSecondaryRuntime(sessionId);
    } catch (error) {
      host.rethrowResultPending(error, "激活会话", false);
    }
    const view = await host.sessionView(sessionId, requestClientId(request));
    if (!view) {
      json(response, 404, { error: "会话不存在" });
      return true;
    }
    json(response, 200, view);
    return true;
  }

  return false;
}
