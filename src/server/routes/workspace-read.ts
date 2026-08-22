import type { IncomingMessage, ServerResponse } from "node:http";
import { json, methodNotAllowed } from "../http-transport.js";

export type WorkspaceReadRouteHost = {
  workspaceRecentFiles(input: { sessionId: string }): Promise<unknown | null>;
  workspaceFile(input: { sessionId: string; path: string }): Promise<unknown | null>;
};

const ROUTE = /^\/api\/sessions\/([a-f0-9]{20})\/workspace\/(files|file)$/;

/** Read-only, Session-addressed workspace inspection. It never starts a Runtime. */
export async function handleWorkspaceReadRoute(
  host: WorkspaceReadRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const match = ROUTE.exec(url.pathname);
  if (!match) return false;
  if (request.method !== "GET") {
    methodNotAllowed(response);
    return true;
  }
  const sessionId = match[1]!;
  const result = match[2] === "files"
    ? await host.workspaceRecentFiles({ sessionId })
    : await host.workspaceFile({ sessionId, path: url.searchParams.get("path") || "" });
  if (!result) {
    json(response, 404, { error: "会话 Workspace 不可用" });
    return true;
  }
  json(response, 200, result);
  return true;
}
