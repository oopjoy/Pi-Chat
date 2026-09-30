import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, resolve } from "node:path";
import { bodyJson, json, methodNotAllowed } from "../http-transport.js";
import type { BootstrapData } from "../../shared/types.js";

export interface WorkspaceControlRouteHost {
  currentCwd(): string;
  pickWorkspaceFolder(cwd: string): Promise<string | null>;
  changeWorkspace(path: string): Promise<Record<string, unknown>>;
  bootstrap(): Promise<BootstrapData>;
}

/** Workspace selection is a route transaction; persistence/bootstrap remain App-owned. */
export async function handleWorkspaceControlRoute(
  host: WorkspaceControlRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  preparedBody?: Record<string, unknown>,
): Promise<boolean> {
  if (url.pathname === "/api/workspace/pick") {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const selected = await host.pickWorkspaceFolder(host.currentCwd());
    if (!selected) {
      json(response, 200, { cancelled: true });
      return true;
    }
    await host.changeWorkspace(selected);
    const data = await host.bootstrap();
    json(response, 200, {
      cancelled: false,
      workspaceName: basename(data.workspaceCwd),
      cwd: data.workspaceCwd,
      workspaceEpoch: data.workspaceEpoch,
      workspaceRevision: data.workspaceRevision,
      data,
    });
    return true;
  }

  if (url.pathname === "/api/workspace/set") {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const body = preparedBody || await bodyJson(request);
    const selected = typeof body.path === "string" ? body.path.trim() : "";
    if (!selected) {
      json(response, 400, { error: "path 必填" });
      return true;
    }
    const result = await host.changeWorkspace(resolve(selected));
    json(response, 200, { cancelled: false, ...result });
    return true;
  }

  return false;
}
