import type { IncomingMessage, ServerResponse } from "node:http";
import { json, methodNotAllowed } from "../http-transport.js";

export type SessionsReadRouteHost = {
  listSessions(input: {
    clientId: string;
    all: boolean;
    fresh: boolean;
    includeIds: string[];
    directory: boolean;
    cwd: string;
    offset: number;
    limit: number;
  }): Promise<unknown>;
  sessionView(input: {
    sessionId: string;
    clientId: string;
    turns: number;
    fast: boolean;
  }): Promise<unknown | null>;
};

const SESSION_ID = "([a-f0-9]{20})";

/** Read-only Session HTTP parsing; history/Runtime ownership remains in PiChatApp. */
export async function handleSessionsReadRoute(
  host: SessionsReadRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  clientId: string,
  options: {
    recentTurns: number;
    maxTurns: number;
    turnIncrement: number;
    directoryLimit: number;
    maxDirectoryLimit: number;
  },
): Promise<boolean> {
  if (url.pathname === "/api/sessions") {
    if (request.method !== "GET") {
      methodNotAllowed(response);
      return true;
    }
    const all = url.searchParams.get("all") === "1";
    const fresh = url.searchParams.get("fresh") === "1";
    const includeIds = [
      ...new Set(
        url.searchParams
          .getAll("include")
          .flatMap((value) => value.split(","))
          .map((value) => value.trim().toLowerCase())
          .filter((value) => /^[a-f0-9]{20}$/.test(value)),
      ),
    ].slice(0, 500);
    const directory = url.searchParams.has("cwd");
    const cwd = url.searchParams.get("cwd") || "";
    const offset = Math.max(0, Number(url.searchParams.get("offset") || "0") || 0);
    const limit = Math.min(
      options.maxDirectoryLimit,
      Math.max(
        1,
        Number(url.searchParams.get("limit") || options.directoryLimit) ||
          options.directoryLimit,
      ),
    );
    json(
      response,
      200,
      await host.listSessions({
        clientId,
        all,
        fresh,
        includeIds,
        directory,
        cwd,
        offset,
        limit,
      }),
    );
    return true;
  }
  const match = new RegExp(`^/api/sessions/${SESSION_ID}/view$`).exec(url.pathname);
  if (!match) return false;
  if (request.method !== "GET") {
    methodNotAllowed(response);
    return true;
  }
  const rawTurns = url.searchParams.get("turns");
  const turns = rawTurns === null ? options.recentTurns : Number(rawTurns);
  if (!Number.isInteger(turns) || turns < options.recentTurns || turns > options.maxTurns || (turns - options.recentTurns) % options.turnIncrement !== 0) {
    json(response, 400, { error: `turns 必须从 ${options.recentTurns} 开始，并每次增加 ${options.turnIncrement}` });
    return true;
  }
  const fast = url.searchParams.get("fast") === "1";
  const view = await host.sessionView({ sessionId: match[1], clientId, turns, fast });
  if (!view) {
    json(response, fast ? 409 : 404, {
      error: fast ? "热会话视图不可用" : "会话不存在",
      ...(fast ? { code: "HOT_VIEW_UNAVAILABLE" } : null),
    });
    return true;
  }
  json(response, 200, view);
  return true;
}
