import type { IncomingMessage, ServerResponse } from "node:http";
import type { BackgroundSubagentSnapshot } from "../../shared/types.js";
import { json, methodNotAllowed } from "../http-transport.js";

export type SubagentsReadRouteHost = {
  backgroundSubagents(sessionId: string): Promise<BackgroundSubagentSnapshot | null>;
};

/** Read-only package-status projection; it never acquires Runtime or lifecycle authority. */
export async function handleSubagentsReadRoute(
  host: SubagentsReadRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const match = /^\/api\/sessions\/([a-f0-9]{20})\/background-subagents$/.exec(url.pathname);
  if (!match) return false;
  if (request.method !== "GET") {
    methodNotAllowed(response);
    return true;
  }
  const snapshot = await host.backgroundSubagents(match[1]);
  if (!snapshot) {
    json(response, 404, { error: "会话不存在" });
    return true;
  }
  json(response, 200, snapshot);
  return true;
}
