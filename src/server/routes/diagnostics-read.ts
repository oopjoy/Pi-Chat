import type { IncomingMessage, ServerResponse } from "node:http";
import { json, methodNotAllowed, requestClientId, requestPageId } from "../http-transport.js";

export interface DiagnosticsReadRouteHost {
  isRegisteredWindowPage(clientId: string, pageId: string): boolean;
  checkpoint(): void;
  snapshot(): unknown;
}

export async function handleDiagnosticsReadRoute(
  host: DiagnosticsReadRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== "/api/diagnostics/snapshot") return false;
  if (request.method !== "GET") {
    methodNotAllowed(response);
    return true;
  }
  const clientId = requestClientId(request);
  const pageId = requestPageId(request);
  if (!clientId || !pageId) {
    json(response, 400, {
      error: "导出诊断需要浏览器窗口与页面标识",
      code: "DIAGNOSTIC_CLIENT_REQUIRED",
    });
    return true;
  }
  if (!host.isRegisteredWindowPage(clientId, pageId)) {
    json(response, 409, {
      error: "当前页面已关闭或尚未完成连接，无法导出诊断",
      code: "DIAGNOSTIC_PAGE_NOT_REGISTERED",
    });
    return true;
  }
  host.checkpoint();
  json(response, 200, host.snapshot());
  return true;
}
