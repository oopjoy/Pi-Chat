import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { idForPath } from "../session-index.js";

export interface SessionDeletePathHost {
  sessionRoot(): string;
  indexedPath(sessionId: string): string | null;
}

/** Validate the only path that a destructive Session delete may unlink. */
export async function validateSessionDeletePath(
  host: SessionDeletePathHost,
  path: string,
  sessionId: string,
): Promise<string> {
  if (!isAbsolute(path)) throw new Error("会话文件路径必须是绝对路径");
  const normalized = resolve(path);
  const indexed = host.indexedPath(sessionId);
  if (indexed && resolve(indexed) !== normalized)
    throw new Error("会话文件路径与索引不一致，已拒绝删除");
  const fileStat = await lstat(normalized);
  if (!fileStat.isFile()) throw new Error("会话文件不是普通文件，已拒绝删除");
  const [rootReal, targetReal] = await Promise.all([
    realpath(host.sessionRoot()),
    realpath(normalized),
  ]);
  const withinRoot = relative(rootReal, targetReal);
  if (
    withinRoot === ".."
    || withinRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) throw new Error("会话文件不在 Session 目录内，已拒绝删除");
  if (idForPath(normalized) !== sessionId)
    throw new Error("会话文件身份不一致，已拒绝删除");
  return normalized;
}
