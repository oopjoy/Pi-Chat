import type { IncomingMessage, ServerResponse } from "node:http";
import type { BackgroundSubagentSnapshot } from "../../shared/types.js";
import { json, methodNotAllowed } from "../http-transport.js";
import { SubagentStatusUnavailableError } from "../subagent-status-provider.js";

export type SubagentsReadRouteHost = {
  backgroundSubagents(sessionId: string): Promise<BackgroundSubagentSnapshot | null>;
  backgroundSubagentView(input: {
    parentSessionId: string;
    childSessionId: string;
    clientId: string;
    turns: number;
  }): Promise<unknown | null>;
};

const SESSION_ID = "([a-f0-9]{20})";

/** Read-only package-status and verified child-history projection; neither acquires Runtime authority. */
export async function handleSubagentsReadRoute(
  host: SubagentsReadRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  clientId: string,
  options: {
    recentTurns: number;
    maxTurns: number;
    turnIncrement: number;
  },
): Promise<boolean> {
  const childMatch = new RegExp(
    `^/api/sessions/${SESSION_ID}/background-subagents/${SESSION_ID}/view$`,
  ).exec(url.pathname);
  if (childMatch) {
    if (request.method !== "GET") {
      methodNotAllowed(response);
      return true;
    }
    const rawTurns = url.searchParams.get("turns");
    const turns = rawTurns === null ? options.recentTurns : Number(rawTurns);
    if (
      !Number.isInteger(turns)
      || turns < options.recentTurns
      || turns > options.maxTurns
      || (turns - options.recentTurns) % options.turnIncrement !== 0
    ) {
      json(response, 400, {
        error: `turns 必须从 ${options.recentTurns} 开始，并每次增加 ${options.turnIncrement}`,
      });
      return true;
    }
    let view: unknown | null;
    try {
      view = await host.backgroundSubagentView({
        parentSessionId: childMatch[1],
        childSessionId: childMatch[2],
        clientId,
        turns,
      });
    } catch (error) {
      if (!(error instanceof SubagentStatusUnavailableError)) throw error;
      json(response, 503, {
        error: error.message,
        code: "SUBAGENT_STATUS_UNAVAILABLE",
      });
      return true;
    }
    if (!view) {
      json(response, 404, {
        error: "子代理对话不存在或尚未准备好",
        code: "SUBAGENT_VIEW_UNAVAILABLE",
      });
      return true;
    }
    json(response, 200, view);
    return true;
  }

  const match = new RegExp(
    `^/api/sessions/${SESSION_ID}/background-subagents$`,
  ).exec(url.pathname);
  if (!match) return false;
  if (request.method !== "GET") {
    methodNotAllowed(response);
    return true;
  }
  let snapshot: BackgroundSubagentSnapshot | null;
  try {
    snapshot = await host.backgroundSubagents(match[1]);
  } catch (error) {
    if (!(error instanceof SubagentStatusUnavailableError)) throw error;
    json(response, 503, {
      error: error.message,
      code: "SUBAGENT_STATUS_UNAVAILABLE",
    });
    return true;
  }
  if (!snapshot) {
    json(response, 404, { error: "会话不存在" });
    return true;
  }
  json(response, 200, snapshot);
  return true;
}
