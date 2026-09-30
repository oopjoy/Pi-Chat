import type { IncomingMessage, ServerResponse } from "node:http";
import { bodyJson, json, methodNotAllowed, requestClientId, requestPageId } from "../http-transport.js";

export interface WindowControlRouteHost {
  assertIdle(): void;
  isConnectedWindowPage(clientId: string, pageId: string): boolean;
  noteClientPresence(clientId: string, pageId: string, revision: number, foreground: boolean): boolean;
  isClientPresent(clientId: string): boolean;
  closeWindowClient(clientId: string, pageId: string): string;
  openWindowCount(): number;
  activeMutationRequests(): number;
  runtimeStartingCount(): number;
  restSessionAfterWindowClose(sessionId: string): Promise<boolean>;
  scheduleLastWindowShutdown(): void;
  lastWindowAutoShutdownEnabled(): boolean;
  applicationShutdownAvailable(): boolean;
}

export async function handleWindowControlRoute(
  host: WindowControlRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const clientId = requestClientId(request);
  if (url.pathname === "/api/presence") {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const pageId = requestPageId(request);
    if (!clientId || !pageId) {
      json(response, 400, { error: "浏览器页面标识无效" });
      return true;
    }
    const body = await bodyJson(request);
    if (typeof body.foreground !== "boolean") {
      json(response, 400, { error: "浏览器前台状态无效" });
      return true;
    }
    const revision = body.revision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
      json(response, 400, { error: "浏览器前台状态序号无效" });
      return true;
    }
    if (!host.isConnectedWindowPage(clientId, pageId)) {
      json(response, 409, { error: "当前页面的事件连接已断开，正在重新连接" });
      return true;
    }
    if (!host.noteClientPresence(clientId, pageId, revision, body.foreground)) {
      json(response, 409, { error: "事件连接已断开，正在重新连接" });
      return true;
    }
    json(response, 200, { present: host.isClientPresent(clientId) });
    return true;
  }

  if (url.pathname !== "/api/window/close") return false;
  if (request.method !== "POST") {
    methodNotAllowed(response);
    return true;
  }
  if (!clientId) {
    json(response, 400, { error: "缺少窗口标识，无法安全关闭" });
    return true;
  }
  host.assertIdle();
  const pageId = requestPageId(request) || clientId;
  const foregroundCloseIntent =
    url.searchParams.get("foreground") === "1" && host.isClientPresent(clientId);
  const viewedSessionId = host.closeWindowClient(clientId, pageId);
  const remainingWindows = host.openWindowCount();
  const rested =
    remainingWindows > 0
    && host.activeMutationRequests() === 0
    && host.runtimeStartingCount() === 0
    ? await host.restSessionAfterWindowClose(viewedSessionId)
    : false;
  if (remainingWindows === 0 && foregroundCloseIntent) host.scheduleLastWindowShutdown();
  json(response, 200, {
    shuttingDown: false,
    closeWindow: true,
    sessionId: viewedSessionId || undefined,
    rested,
    remainingWindows,
    ...(remainingWindows === 0
      && foregroundCloseIntent
      && host.lastWindowAutoShutdownEnabled()
      && host.applicationShutdownAvailable()
      ? { autoShutdownPending: true }
      : null),
  });
  return true;
}
