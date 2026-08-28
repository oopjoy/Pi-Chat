import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionSummary } from "../shared/types.js";

export interface SessionCacheEntry {
  /** File identity/version anchors; mtime+size alone are not sufficient. */
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  size: number;
  /** String form preserves Windows' 64-bit inode values across JSON. */
  dev: string;
  ino: string;
  /** Bounded first/middle/tail content fingerprint for same-stat rewrites. */
  fingerprint: string;
  /** Null is a durable negative result for empty/hidden/Subagent JSONL files. */
  summary: Omit<SessionSummary, "active"> | null;
}

interface SessionCacheFile {
  version: number;
  entries: Record<string, SessionCacheEntry>;
}

function validEntry(value: unknown): value is SessionCacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SessionCacheEntry>;
  const summary = entry.summary as Partial<SessionSummary> | null | undefined;
  if (
    typeof entry.mtimeMs !== "number"
    || !Number.isFinite(entry.mtimeMs)
    || typeof entry.ctimeMs !== "number"
    || !Number.isFinite(entry.ctimeMs)
    || typeof entry.birthtimeMs !== "number"
    || !Number.isFinite(entry.birthtimeMs)
    || typeof entry.size !== "number"
    || !Number.isSafeInteger(entry.size)
    || entry.size < 0
    || typeof entry.dev !== "string"
    || !/^\d+$/.test(entry.dev)
    || typeof entry.ino !== "string"
    || !/^\d+$/.test(entry.ino)
    || typeof entry.fingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(entry.fingerprint)
  ) return false;
  if (summary === null) return true;
  if (!summary) return false;
  return typeof summary.id === "string"
    && typeof summary.sessionId === "string"
    && typeof summary.name === "string"
    && typeof summary.preview === "string"
    && typeof summary.cwd === "string"
    && typeof summary.updatedAt === "number"
    && Number.isFinite(summary.updatedAt)
    && (summary.lastUserPromptAt === undefined || (typeof summary.lastUserPromptAt === "number" && Number.isFinite(summary.lastUserPromptAt)))
    && typeof summary.messageCount === "number"
    && Number.isSafeInteger(summary.messageCount)
    && summary.messageCount >= 0
    && typeof summary.turnCount === "number"
    && Number.isSafeInteger(summary.turnCount)
    && summary.turnCount >= 0;
}

export async function loadSessionCache(path: string): Promise<Map<string, SessionCacheEntry>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<SessionCacheFile>;
    // v5 adds filesystem identity and content fingerprint anchors. Older cache
    // entries are intentionally discarded once so a restart cannot trust the
    // historical mtime+size-only key.
    if (value.version !== 5 || !value.entries || typeof value.entries !== "object") return new Map();
    return new Map(Object.entries(value.entries).filter((entry): entry is [string, SessionCacheEntry] => validEntry(entry[1])));
  } catch {
    return new Map();
  }
}

export async function saveSessionCache(path: string, entries: Map<string, SessionCacheEntry>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const data: SessionCacheFile = { version: 5, entries: Object.fromEntries(entries) };
  await writeFile(temporary, `${JSON.stringify(data)}\n`, "utf8");
  await rename(temporary, path);
}
