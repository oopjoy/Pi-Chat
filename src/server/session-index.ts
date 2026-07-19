import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { PiMessage, SessionSummary } from "../shared/types.js";
import { loadSessionCache, saveSessionCache, type SessionCacheEntry } from "./session-index-cache.js";

interface SessionHeader {
  type?: string;
  id?: string;
  cwd?: string;
}

interface SessionEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string | number;
  name?: string;
  message?: PiMessage;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: string; text?: string } => Boolean(block && typeof block === "object"))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text || "")
    .join("\n");
}

function cleanPreview(value: string, limit = 90): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function idForPath(path: string): string {
  return createHash("sha256").update(resolve(path).toLowerCase()).digest("hex").slice(0, 20);
}

async function listJsonlFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const queue = [root];
  while (queue.length) {
    const directory = queue.pop() as string;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".jsonl") files.push(path);
    }
  }
  return files;
}

export async function readSessionMessages(path: string): Promise<PiMessage[]> {
  const entries: SessionEntry[] = [];
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as SessionEntry;
      if (entry.id) entries.push(entry);
    } catch {
      // Ignore an incomplete trailing line while Pi is writing the session.
    }
  }
  const byId = new Map(entries.map((entry) => [entry.id as string, entry]));
  const branch: SessionEntry[] = [];
  let current = entries.at(-1);
  const visited = new Set<string>();
  while (current?.id && !visited.has(current.id)) {
    visited.add(current.id);
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch.reverse().flatMap((entry) => {
    if (entry.type !== "message" || !entry.message) return [];
    const timestamp = typeof entry.message.timestamp === "number"
      ? entry.message.timestamp
      : typeof entry.timestamp === "number"
        ? entry.timestamp
        : typeof entry.timestamp === "string"
          ? Date.parse(entry.timestamp)
          : undefined;
    return [{ ...entry.message, ...(Number.isFinite(timestamp) ? { timestamp } : {}) }];
  });
}

async function parseSession(path: string, modifiedAt: number): Promise<Omit<SessionSummary, "active"> | null> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let header: SessionHeader | null = null;
  let name = "";
  let preview = "";
  let messageCount = 0;

  for await (const line of lines) {
    if (!header) {
      try {
        const candidate = JSON.parse(line) as SessionHeader;
        if (candidate.type === "session") header = candidate;
      } catch {
        return null;
      }
      continue;
    }
    if (!line.includes('"type":"message"') && !line.includes('"type":"session_info"')) continue;
    try {
      const entry = JSON.parse(line) as SessionEntry;
      if (entry.type === "session_info") name = cleanPreview(entry.name || "", 120);
      if (entry.type === "message") {
        messageCount += 1;
        if (!preview && entry.message?.role === "user") {
          preview = cleanPreview(textFromContent(entry.message.content));
        }
      }
    } catch {
      // Ignore an incomplete trailing line while Pi is writing the session.
    }
  }

  if (!header?.id) return null;
  const displayName = name || preview || "新会话";
  return {
    id: idForPath(path),
    sessionId: header.id,
    name: displayName,
    preview: preview || displayName,
    cwd: header.cwd || "",
    updatedAt: modifiedAt,
    messageCount,
  };
}

export class SessionIndex {
  readonly root: string;
  readonly cachePath: string;
  private cache: Map<string, SessionCacheEntry> | null = null;
  private pathsById = new Map<string, string>();

  constructor(root?: string, cachePath?: string) {
    this.root = root || process.env.PI_CODING_AGENT_SESSION_DIR || join(homedir(), ".pi", "agent", "sessions");
    this.cachePath = cachePath || (root ? join(this.root, ".pi-chat-session-index.json") : join(homedir(), ".pi", "agent", "pi-chat-session-index.json"));
  }

  async list(activePath?: string, cwd?: string): Promise<SessionSummary[]> {
    if (!this.cache) this.cache = await loadSessionCache(this.cachePath);
    const files = await listJsonlFiles(this.root);
    const livePaths = new Set(files.map((path) => resolve(path)));
    const normalizedActive = activePath ? resolve(activePath).toLowerCase() : "";
    const normalizedCwd = cwd ? resolve(cwd).toLowerCase() : "";
    const summaries: SessionSummary[] = [];
    let cacheChanged = false;
    this.pathsById.clear();

    for (const path of files) {
      const fileStat = await stat(path);
      const normalized = resolve(path);
      const isActive = normalized.toLowerCase() === normalizedActive;
      let cached = this.cache.get(normalized);
      if (!cached || cached.mtimeMs !== fileStat.mtimeMs || cached.size !== fileStat.size) {
        const summary = await parseSession(normalized, fileStat.mtimeMs);
        if (!summary) continue;
        cached = { mtimeMs: fileStat.mtimeMs, size: fileStat.size, summary };
        this.cache.set(normalized, cached);
        cacheChanged = true;
      }
      if (normalizedCwd && resolve(cached.summary.cwd || "").toLowerCase() !== normalizedCwd) continue;
      this.pathsById.set(cached.summary.id, normalized);
      summaries.push({ ...cached.summary, active: isActive });
    }

    for (const cachedPath of this.cache.keys()) {
      if (!livePaths.has(cachedPath)) {
        this.cache.delete(cachedPath);
        cacheChanged = true;
      }
    }
    if (cacheChanged) await saveSessionCache(this.cachePath, this.cache);
    return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  pathForId(id: string): string | null {
    return this.pathsById.get(id) ?? null;
  }

  async messagesForId(id: string): Promise<PiMessage[] | null> {
    const path = this.pathForId(id);
    return path ? readSessionMessages(path) : null;
  }
}

export { cleanPreview, idForPath, parseSession, textFromContent };
