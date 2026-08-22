import type { Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { PiMessage, WorkspaceFileData, WorkspaceRecentFilesData } from "../shared/types.js";
import { HttpRequestError } from "./http-transport.js";

const MAX_RECENT_FILES = 50;
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_RELATIVE_PATH_CHARS = 4_096;
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true });
const IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "venv",
  "__pycache__",
  "coverage",
  ".cache",
  ".pi-subagents",
]);

function sensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  const credentialStem = /(?:^|[._-])(?:token|api[._-]?key|private[._-]?key)(?:[._-]|$)/.test(lower);
  return credentialStem
    || lower === ".env"
    || lower.startsWith(".env.")
    || lower.includes("credential")
    || lower.includes("secret")
    || lower.includes("password")
    || lower.includes("passwd")
    || lower.includes("service-account")
    || lower.includes("service_account")
    || lower === "auth.json"
    || lower === "token.json"
    || lower === "id_rsa"
    || lower === "id_ed25519"
    || lower.endsWith(".pem")
    || lower.endsWith(".pfx")
    || lower.endsWith(".key");
}

function allowedName(name: string): boolean {
  return Boolean(name)
    && !name.startsWith(".")
    && !IGNORED_NAMES.has(name)
    && !sensitiveName(name)
    && !name.includes("\\")
    && !name.includes(":")
    && !/[\0-\x1f\x7f]/.test(name);
}

export function normalizeWorkspaceRelativePath(value: string): string {
  if (typeof value !== "string" || value.length > MAX_RELATIVE_PATH_CHARS)
    throw new HttpRequestError(400, "Workspace 路径无效");
  if (!value) throw new HttpRequestError(400, "文件路径不能为空");
  if (isAbsolute(value) || value.includes("\\") || value.startsWith("/"))
    throw new HttpRequestError(400, "Workspace 路径必须是相对路径");
  const parts = value.split("/");
  if (parts.some((part) => !allowedName(part) || part === "." || part === ".."))
    throw new HttpRequestError(400, "Workspace 路径无效");
  return parts.join("/");
}

function contained(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

async function workspaceTarget(cwd: string, relativePath: string): Promise<{ root: string; target: string; targetStat: Stats }> {
  let root: string;
  let target: string;
  let targetStat: Stats;
  try {
    root = await realpath(resolve(cwd));
    let cursor = root;
    for (const part of relativePath ? relativePath.split("/") : []) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink())
        throw new HttpRequestError(400, "Workspace 符号链接不可浏览");
    }
    target = await realpath(relativePath ? join(root, ...relativePath.split("/")) : root);
    targetStat = await lstat(target);
    if (targetStat.isSymbolicLink())
      throw new HttpRequestError(400, "Workspace 符号链接不可浏览");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new HttpRequestError(404, "Workspace 路径不存在");
    if (code === "EACCES" || code === "EPERM")
      throw new HttpRequestError(409, "Workspace 路径不可读");
    throw error;
  }
  if (!contained(root, target))
    throw new HttpRequestError(400, "Workspace 路径越界");
  return { root, target, targetStat };
}

async function assertStableTarget(cwd: string, relativePath: string, expectedTarget: string, expectedStat: Stats): Promise<void> {
  const current = await workspaceTarget(cwd, relativePath);
  if (current.target !== expectedTarget || !sameIdentity(current.targetStat, expectedStat))
    throw new HttpRequestError(409, "Workspace 路径在读取期间发生变化");
}

type MutationCall = { operation: "edit" | "write"; path: string };

function toolPathRelativeToWorkspace(cwd: string, rawPath: string): string | null {
  if (!rawPath || rawPath.length > MAX_RELATIVE_PATH_CHARS || /[\0-\x1f\x7f]/.test(rawPath)) return null;
  const workspace = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const candidate = rawPath.replace(/\\/g, "/");
  const caseInsensitive = /^[a-z]:\//i.test(workspace) || workspace.startsWith("//");
  const comparedWorkspace = caseInsensitive ? workspace.toLowerCase() : workspace;
  const comparedCandidate = caseInsensitive ? candidate.toLowerCase() : candidate;
  let relativePath = candidate;
  if (comparedCandidate.startsWith(`${comparedWorkspace}/`)) relativePath = candidate.slice(workspace.length + 1);
  else if (isAbsolute(rawPath) || candidate.startsWith("/") || /^[a-z]:\//i.test(candidate) || candidate.startsWith("//")) return null;
  try { return normalizeWorkspaceRelativePath(relativePath); }
  catch { return null; }
}

export function recentModifiedWorkspaceFiles(messages: PiMessage[], cwd: string): WorkspaceRecentFilesData {
  const calls = new Map<string, MutationCall>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const operation = block.name?.toLowerCase();
      if (block.type !== "toolCall" || !block.id || (operation !== "edit" && operation !== "write")) continue;
      const input = block.arguments;
      if (!input || typeof input !== "object" || typeof (input as Record<string, unknown>).path !== "string") continue;
      calls.set(block.id, { operation, path: (input as Record<string, string>).path });
    }
  }
  const files: WorkspaceRecentFilesData["files"] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const result = messages[index]!;
    if (result.role !== "toolResult" || result.isError || !result.toolCallId) continue;
    const call = calls.get(result.toolCallId);
    if (!call) continue;
    const path = toolPathRelativeToWorkspace(cwd, call.path);
    if (!path) continue;
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) continue;
    seen.add(key);
    if (files.length >= MAX_RECENT_FILES) {
      truncated = true;
      break;
    }
    files.push({
      path,
      name: basename(path),
      operation: call.operation,
      ...(typeof result.timestamp === "number" && Number.isFinite(result.timestamp) ? { modifiedAt: result.timestamp } : {}),
    });
  }
  return { files, truncated };
}

export async function readWorkspaceFile(cwd: string, rawPath: string): Promise<WorkspaceFileData> {
  const path = normalizeWorkspaceRelativePath(rawPath);
  const { target, targetStat } = await workspaceTarget(cwd, path);
  if (!targetStat.isFile()) throw new HttpRequestError(404, "Workspace 文件不存在");
  const bytesToRead = Math.min(targetStat.size, MAX_PREVIEW_BYTES + 4);
  const handle = await open(target, "r");
  let bytes: Buffer;
  try {
    if (!sameIdentity(await handle.stat(), targetStat))
      throw new HttpRequestError(409, "Workspace 文件在打开前发生变化");
    bytes = Buffer.alloc(bytesToRead);
    const result = await handle.read(bytes, 0, bytesToRead, 0);
    bytes = bytes.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
  await assertStableTarget(cwd, path, target, targetStat);
  let previewBytes = bytes.subarray(0, Math.min(bytes.length, MAX_PREVIEW_BYTES));
  const controlBytes = previewBytes.reduce((count, byte) => count + (byte < 9 || (byte > 13 && byte < 32) ? 1 : 0), 0);
  if (previewBytes.includes(0) || (previewBytes.length > 0 && controlBytes / previewBytes.length > 0.02))
    throw new HttpRequestError(409, "二进制文件暂不支持预览");
  let text = "";
  for (let trim = 0; trim <= 3; trim += 1) {
    try {
      previewBytes = previewBytes.subarray(0, previewBytes.length - trim);
      text = FATAL_UTF8.decode(previewBytes);
      break;
    } catch {
      if (targetStat.size <= MAX_PREVIEW_BYTES || trim === 3)
        throw new HttpRequestError(409, "文件不是有效的 UTF-8 文本");
      previewBytes = bytes.subarray(0, Math.min(bytes.length, MAX_PREVIEW_BYTES));
    }
  }
  return {
    path,
    name: basename(path),
    size: targetStat.size,
    text,
    truncated: targetStat.size > previewBytes.length,
    encodingLossy: false,
  };
}
