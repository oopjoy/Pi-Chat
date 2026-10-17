import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { bodyJson, json, methodNotAllowed } from "../http-transport.js";
import { openWithDefaultApplication, parsePickerOutput } from "../file-picker.js";

const MAX_STAGED_DROPPED_FILE_BYTES = 64 * 1024 * 1024;

function safeDroppedFileName(name: string): string {
  const base = basename(name).replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim();
  if (!base || base === "." || base === "..") return "dropped.bin";
  return base.slice(0, 180);
}

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
  if (url.pathname === "/api/local-files/open") {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const body = await bodyJson(request);
    const path = typeof body.path === "string" ? body.path : "";
    if (parsePickerOutput(JSON.stringify([path]))[0] !== path) {
      json(response, 400, { error: "路径无效" });
      return true;
    }
    await openWithDefaultApplication(path);
    json(response, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/local-files/stage") {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const body = await bodyJson(request, 90 * 1024 * 1024);
    const name = typeof body.name === "string" ? body.name : "";
    const data = typeof body.data === "string" ? body.data : "";
    let bytes: Buffer;
    try { bytes = Buffer.from(data, "base64"); }
    catch {
      json(response, 400, { error: "文件内容无效" });
      return true;
    }
    if (!bytes.length || bytes.length > MAX_STAGED_DROPPED_FILE_BYTES) {
      json(response, 400, { error: "拖入的文件为空或超过 64 MB" });
      return true;
    }
    const directory = join(tmpdir(), "pi-chat-dropped", randomUUID());
    await mkdir(directory, { recursive: true });
    const path = join(directory, safeDroppedFileName(name));
    await writeFile(path, bytes);
    json(response, 200, { path });
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
