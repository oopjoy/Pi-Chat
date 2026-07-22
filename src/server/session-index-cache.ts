import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionSummary } from "../shared/types.js";

export interface SessionCacheEntry {
  mtimeMs: number;
  size: number;
  summary: Omit<SessionSummary, "active">;
}

interface SessionCacheFile {
  version: 1;
  entries: Record<string, SessionCacheEntry>;
}

function validEntry(value: unknown): value is SessionCacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SessionCacheEntry>;
  const summary = entry.summary as Partial<SessionSummary> | undefined;
  if (!summary) return false;
  return typeof entry.mtimeMs === "number"
    && typeof entry.size === "number"
    && typeof summary.id === "string"
    && typeof summary.sessionId === "string"
    && typeof summary.name === "string"
    && typeof summary.preview === "string"
    && typeof summary.cwd === "string"
    && typeof summary.updatedAt === "number"
    && typeof summary.messageCount === "number"
    && typeof summary.turnCount === "number";
}

export async function loadSessionCache(path: string): Promise<Map<string, SessionCacheEntry>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<SessionCacheFile>;
    if (value.version !== 1 || !value.entries || typeof value.entries !== "object") return new Map();
    return new Map(Object.entries(value.entries).filter((entry): entry is [string, SessionCacheEntry] => validEntry(entry[1])));
  } catch {
    return new Map();
  }
}

export async function saveSessionCache(path: string, entries: Map<string, SessionCacheEntry>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const data: SessionCacheFile = { version: 1, entries: Object.fromEntries(entries) };
  await writeFile(temporary, `${JSON.stringify(data)}\n`, "utf8");
  await rename(temporary, path);
}
