import type { IncomingMessage, ServerResponse } from "node:http";
import { bodyJson, json, methodNotAllowed } from "../http-transport.js";

export type WorkspaceOpenRouteHost = {
  openWorkspaceFile(input: { sessionId: string; path: string }): Promise<unknown | null>;
};

const ROUTE = /^\/api\/sessions\/([a-f0-9]{20})\/workspace\/open$/;

/** Explicit user intent to open one Session-allowlisted file in its default app. */
export async function handleWorkspaceOpenRoute(
  host: WorkspaceOpenRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  preparedBody?: Record<string, unknown>,
): Promise<boolean> {
  const match = ROUTE.exec(url.pathname);
  if (!match) return false;
  if (request.method !== "POST") {
    methodNotAllowed(response);
    return true;
  }
  const body = preparedBody || await bodyJson(request);
  const result = await host.openWorkspaceFile({
    sessionId: match[1]!,
    path: typeof body.path === "string" ? body.path : "",
  });
  if (!result) {
    json(response, 404, { error: "会话 Workspace 不可用" });
    return true;
  }
  json(response, 200, result);
  return true;
}
