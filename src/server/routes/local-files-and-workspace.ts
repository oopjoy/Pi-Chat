import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import type { DroppedFileStore } from "../dropped-files.js";
import { bodyJson, HttpRequestError, json, methodNotAllowed } from "../http-transport.js";
import { localPathKinds, openLocalAttachment, openWorkspaceDirectory, parsePickerOutput } from "../file-picker.js";

export interface LocalFilesWorkspaceRouteHost {
  attachmentStore?: DroppedFileStore;
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

function attachmentPaths(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.paths) || body.paths.length > 2048
    || body.paths.some((path) => typeof path !== "string" || path.length > 32768
      || parsePickerOutput(JSON.stringify([path]))[0] !== path))
    throw new HttpRequestError(400, "附件路径列表无效");
  return [...new Set(body.paths as string[])];
}
function leaseIdentity(body: Record<string, unknown>): { owner: string; revision: number } {
  if (typeof body.owner !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.owner)
    || !Number.isSafeInteger(body.revision) || Number(body.revision) < 1)
    throw new HttpRequestError(400, "附件草稿租约无效");
  return { owner: body.owner, revision: Number(body.revision) };
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
  if (url.pathname === "/api/local-files/pick-folder") {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const path = await host.pickWorkspaceFolder(host.currentCwd());
    if (!path) { json(response, 200, { paths: [] }); return true; }
    // Attachment paths remain drive-local. This picker does not change cwd.
    if (parsePickerOutput(JSON.stringify([path]))[0] !== path || !(await stat(path)).isDirectory()) {
      json(response, 400, { error: "所选附件不是有效的本地文件夹" });
      return true;
    }
    json(response, 200, { paths: [path] });
    return true;
  }
  if (url.pathname === "/api/local-files/kinds") {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return true;
    }
    const body = await bodyJson(request);
    const paths = Array.isArray(body.paths)
      ? body.paths.filter((item: unknown): item is string => typeof item === "string").slice(0, 32)
      : [];
    json(response, 200, { kinds: await localPathKinds(paths) });
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
    await openLocalAttachment(path);
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
    try {
      if (!host.attachmentStore) throw new Error("当前服务未配置附件存储");
      const owner = typeof body.owner === "string" ? body.owner : "";
      json(response, 200, { path: await host.attachmentStore.stage(name, bytes, owner) });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : "无法保存拖入的文件" });
    }
    return true;
  }
  if (url.pathname === "/api/local-files/stage/discard") {
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
    try {
      if (!host.attachmentStore) throw new Error("当前服务未配置附件存储");
      const { owner, revision } = leaseIdentity(body);
      await host.attachmentStore.discard(path, owner, revision);
      json(response, 200, { ok: true });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : "无法清理临时文件" });
    }
    return true;
  }
  if (url.pathname === "/api/local-files/prepare") {
    if (request.method !== "POST") { methodNotAllowed(response); return true; }
    const paths = attachmentPaths(await bodyJson(request));
    // Ordinary user-owned files are not cache entries. Managed payloads must
    // be retained successfully before the browser can enter the send pipeline.
    await host.attachmentStore?.retain(paths);
    json(response, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/local-files/lease") {
    if (request.method !== "POST") { methodNotAllowed(response); return true; }
    const body = await bodyJson(request);
    const paths = attachmentPaths(body);
    const { owner, revision } = leaseIdentity(body);
    const missing = await host.attachmentStore?.lease(paths, owner, revision, body.active !== false) || [];
    json(response, 200, { missing });
    return true;
  }
  if (url.pathname === "/api/local-files/storage/open") {
    if (request.method !== "POST") { methodNotAllowed(response); return true; }
    if (!host.attachmentStore) { json(response, 501, { error: "当前服务未配置附件存储" }); return true; }
    await host.attachmentStore.ensureDirectory();
    await openWorkspaceDirectory(host.attachmentStore.root);
    json(response, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/local-files/storage") {
    if (request.method !== "GET" && request.method !== "POST") { methodNotAllowed(response); return true; }
    if (!host.attachmentStore) { json(response, 501, { error: "当前服务未配置附件存储" }); return true; }
    json(response, 200, await host.attachmentStore.maintain(request.method === "POST"));
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
