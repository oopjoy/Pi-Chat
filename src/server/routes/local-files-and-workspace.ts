import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { bodyJson, json, methodNotAllowed } from "../http-transport.js";

export interface LocalFilesWorkspaceRouteHost {
  pickLocalFiles(): Promise<string[]>;
  readClipboardFiles(files: Array<{ name: string; size: number }>): Promise<string[]>;
  pickWorkspaceFolder(cwd: string): Promise<string | null>;
  currentCwd(): string;
}

function clipboardFiles(body: Record<string, unknown>): Array<{ name: string; size: number }> {
  return Array.isArray(body.files)
    ? body.files.filter((item: unknown): item is { name: string; size: number } => Boolean(
        item
        && typeof item === "object"
        && typeof (item as { name?: unknown }).name === "string"
        && Number.isSafeInteger((item as { size?: unknown }).size)
        && (item as { size: number }).size >= 0,
      )).slice(0, 10)
    : [];
}

export async function handleLocalFilesWorkspaceRoute(
  host: LocalFilesWorkspaceRouteHost,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname === "/api/local-files/pick") {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    json(response, 200, { paths: await host.pickLocalFiles() });
    return true;
  }
  if (url.pathname === "/api/local-files/clipboard") {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const body = await bodyJson(request);
    json(response, 200, { paths: await host.readClipboardFiles(clipboardFiles(body)) });
    return true;
  }
  if (url.pathname === "/api/workspace/draft-pick") {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const selected = await host.pickWorkspaceFolder(host.currentCwd());
    if (!selected) {
      json(response, 200, { cancelled: true });
      return true;
    }
    if (!(await stat(resolve(selected))).isDirectory()) {
      json(response, 400, { error: "所选工作目录不存在或不是文件夹" });
      return true;
    }
    json(response, 200, { cancelled: false, cwd: resolve(selected) });
    return true;
  }
  return false;
}
