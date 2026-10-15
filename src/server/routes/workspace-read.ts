import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { json, methodNotAllowed } from "../http-transport.js";

export type WorkspaceReadRouteHost = {
  workspaceRecentFiles(input: { sessionId: string }): Promise<unknown | null>;
  workspaceFile(input: { sessionId: string; path: string }): Promise<unknown | null>;
  workspaceImage(input: { sessionId: string; path: string }): Promise<{ target: string; contentType: string; size: number } | null>;
};

const ROUTE = /^\/api\/sessions\/([a-f0-9]{20})\/workspace\/(files|file|image)$/;

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
  if (match[2] === "image") {
    const image = await host.workspaceImage({ sessionId, path: url.searchParams.get("path") || "" });
    if (!image) {
      json(response, 404, { error: "会话 Workspace 不可用" });
      return true;
    }
    response.writeHead(200, {
      "content-type": image.contentType,
      "content-length": String(image.size),
      // Render-only bytes under the persisted-reply allowlist. nosniff keeps a
      // non-image payload from being reinterpreted as HTML in this origin.
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
    });
    await pipeline(createReadStream(image.target), response);
    return true;
  }
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
