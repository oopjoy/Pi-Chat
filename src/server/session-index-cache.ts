import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionSummary } from "../shared/types.js";

export interface SessionCacheEntry {
  mtimeMs: number;
  size: number;
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
  if (typeof entry.mtimeMs !== "number" || typeof entry.size !== "number") return false;
  if (summary === null) return true;
  if (!summary) return false;
  return typeof summary.id === "string"
    && typeof summary.sessionId === "string"
    && typeof summary.name === "string"
    && typeof summary.preview === "string"
    && typeof summary.cwd === "string"
    && typeof summary.updatedAt === "number"
    && (summary.lastUserPromptAt === undefined || typeof summary.lastUserPromptAt === "number")
    && typeof summary.messageCount === "number"
    && typeof summary.turnCount === "number";
}

export async function loadSessionCache(path: string): Promise<Map<string, SessionCacheEntry>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<SessionCacheFile>;
    // v3 positive entries remain valid. v4 additionally persists negative
    // results so unchanged empty/hidden/Subagent JSONL never need reparsing.
    if ((value.version !== 3 && value.version !== 4) || !value.entries || typeof value.entries !== "object") return new Map();
    return new Map(Object.entries(value.entries).filter((entry): entry is [string, SessionCacheEntry] => validEntry(entry[1])));
  } catch {
    return new Map();
  }
}

export async function saveSessionCache(path: string, entries: Map<string, SessionCacheEntry>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const data: SessionCacheFile = { version: 4, entries: Object.fromEntries(entries) };
  await writeFile(temporary, `${JSON.stringify(data)}\n`, "utf8");
  await rename(temporary, path);
}
