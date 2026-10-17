import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

export const MAX_STAGED_DROPPED_FILE_BYTES = 64 * 1024 * 1024;
export const DROPPED_FILES_DIR_NAME = "pi-chat-dropped";

export function droppedFilesRoot(): string {
  return resolve(tmpdir(), DROPPED_FILES_DIR_NAME);
}

function comparablePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** True only for files under this process temp `pi-chat-dropped` tree, never the root itself. */
export function isManagedDroppedFilePath(targetPath: string): boolean {
  if (typeof targetPath !== "string" || !targetPath.trim()) return false;
  const root = comparablePath(droppedFilesRoot());
  const resolved = comparablePath(resolve(targetPath));
  const prefix = root.endsWith(sep) ? root : root + sep;
  return resolved.startsWith(prefix) && resolved.length > prefix.length;
}

export function safeDroppedFileName(name: string): string {
  const base = basename(name).replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim();
  if (!base || base === "." || base === "..") return "dropped.bin";
  return base.slice(0, 180);
}

export async function stageDroppedFileBytes(name: string, bytes: Buffer): Promise<string> {
  if (!bytes.length || bytes.length > MAX_STAGED_DROPPED_FILE_BYTES)
    throw new Error("拖入的文件为空或超过 64 MB");
  const directory = join(droppedFilesRoot(), randomUUID());
  await mkdir(directory, { recursive: true });
  const path = join(directory, safeDroppedFileName(name));
  await writeFile(path, bytes);
  return path;
}

export async function discardManagedDroppedFile(targetPath: string): Promise<void> {
  if (!isManagedDroppedFilePath(targetPath)) throw new Error("路径无效");
  const resolved = resolve(targetPath);
  let info;
  try { info = await lstat(resolved); }
  catch { return; }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("路径无效");
  await unlink(resolved);
  const parent = resolve(resolved, "..");
  if (isManagedDroppedFilePath(parent))
    await rm(parent, { recursive: true, force: true }).catch(() => undefined);
}
