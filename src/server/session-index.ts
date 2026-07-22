import { createHash } from "node:crypto";
import { createReadStream, existsSync, type Stats } from "node:fs";
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
  customType?: string;
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

async function readSessionBranch(path: string): Promise<SessionEntry[]> {
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
  return branch.reverse();
}

export interface SessionUsageSnapshot {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** Last successful assistant turn: the live context it consumed plus its model. */
  context: { tokens: number; provider?: string; model?: string } | null;
}

const usageNumber = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * Offline token accounting for cold (view-only) sessions. Mirrors Pi's
 * get_session_stats closely enough for the top bar: cumulative counters sum
 * every successful assistant turn; the context occupancy is the final turn's
 * input + cache reads/writes, which is what the next prompt would resend.
 */
export interface SessionFileSnapshot {
  messages: PiMessage[];
  usage: SessionUsageSnapshot;
}

/** Parse the active JSONL branch once for both conversation messages and usage. */
export async function readSessionSnapshot(path: string): Promise<SessionFileSnapshot> {
  const branch = await readSessionBranch(path);
  const messages: PiMessage[] = [];
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let context: SessionUsageSnapshot["context"] = null;
  for (const entry of branch) {
    if (entry.type !== "message" || !entry.message) continue;
    const timestamp = typeof entry.message.timestamp === "number"
      ? entry.message.timestamp
      : typeof entry.timestamp === "number"
        ? entry.timestamp
        : typeof entry.timestamp === "string"
          ? Date.parse(entry.timestamp)
          : undefined;
    messages.push({ ...entry.message, ...(Number.isFinite(timestamp) ? { timestamp } : {}) });
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role !== "assistant" || message.stopReason === "error") continue;
    const usage = message.usage;
    if (!usage || typeof usage !== "object") continue;
    const record = usage as Record<string, unknown>;
    const input = usageNumber(record.input);
    const output = usageNumber(record.output);
    const cacheRead = usageNumber(record.cacheRead);
    const cacheWrite = usageNumber(record.cacheWrite);
    if (!input && !output && !cacheRead && !cacheWrite) continue;
    tokens.input += input;
    tokens.output += output;
    tokens.cacheRead += cacheRead;
    tokens.cacheWrite += cacheWrite;
    context = {
      tokens: input + cacheRead + cacheWrite,
      provider: typeof message.provider === "string" ? message.provider : undefined,
      model: typeof message.model === "string" ? message.model : undefined,
    };
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return { messages, usage: { tokens, context } };
}

export async function readSessionMessages(path: string): Promise<PiMessage[]> {
  return (await readSessionSnapshot(path)).messages;
}

export async function readSessionUsage(path: string): Promise<SessionUsageSnapshot> {
  return (await readSessionSnapshot(path)).usage;
}

function isSubagentSession(path: string, name: string): boolean {
  // Pi stores child runs beneath the parent session directory and gives them a
  // generated `subagent-*` session name. They are process details, not user
  // conversations, so the main sidebar deliberately excludes them.
  return /(?:^|[\\/])run-\d+(?:[\\/]|$)/i.test(path) && /^subagent-/i.test(name);
}

async function parseSession(path: string, modifiedAt: number): Promise<Omit<SessionSummary, "active"> | null> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let header: SessionHeader | null = null;
  let name = "";
  let preview = "";
  let messageCount = 0;
  let turnCount = 0;

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
        if (entry.message?.role === "user") {
          turnCount += 1;
          if (!preview) preview = cleanPreview(textFromContent(entry.message.content));
        }
      }
    } catch {
      // Ignore an incomplete trailing line while Pi is writing the session.
    }
  }

  if (!header?.id) return null;
  // A Pi process creates an empty JSONL before the user actually starts a conversation.
  // Those draft files belong to the composer, not to the persisted sidebar history.
  if (messageCount === 0) return null;
  const displayName = name || preview || "新会话";
  if (isSubagentSession(path, displayName)) return null;
  return {
    id: idForPath(path),
    sessionId: header.id,
    name: displayName,
    preview: preview || displayName,
    cwd: header.cwd || "",
    updatedAt: modifiedAt,
    messageCount,
    turnCount,
  };
}

export class SessionIndex {
  readonly root: string;
  readonly cachePath: string;
  private cache: Map<string, SessionCacheEntry> | null = null;
  private pathsById = new Map<string, string>();
  private refreshPromise: Promise<SessionSummary[]> | null = null;
  private refreshKey = "";
  private readonly statFile: (path: string) => Promise<Stats>;
  private readonly snapshotCache = new Map<string, { mtimeMs: number; size: number; snapshot: SessionFileSnapshot }>();
  private readonly snapshotReads = new Map<string, Promise<SessionFileSnapshot | null>>();

  constructor(root?: string, cachePath?: string, statFile: (path: string) => Promise<Stats> = stat) {
    this.root = root || process.env.PI_CODING_AGENT_SESSION_DIR || join(homedir(), ".pi", "agent", "sessions");
    this.cachePath = cachePath || (root ? join(this.root, ".pi-chat-session-index.json") : join(homedir(), ".pi", "agent", "pi-chat-session-index.json"));
    this.statFile = statFile;
  }

  async list(activePath?: string, cwd?: string): Promise<SessionSummary[]> {
    // Bootstrap and sidebar refresh may arrive together.
    // Share identical scans and serialize different scans so pathsById/cache are
    // never mutated concurrently by callers released from the same await.
    const key = `${activePath ? resolve(activePath).toLowerCase() : ""}\0${cwd ? resolve(cwd).toLowerCase() : ""}`;
    while (this.refreshPromise) {
      if (this.refreshKey === key) return this.refreshPromise;
      await this.refreshPromise;
    }
    const refresh = this.refresh(activePath, cwd);
    this.refreshPromise = refresh;
    this.refreshKey = key;
    try {
      return await refresh;
    } finally {
      if (this.refreshPromise === refresh) {
        this.refreshPromise = null;
        this.refreshKey = "";
      }
    }
  }

  private async refresh(activePath?: string, cwd?: string): Promise<SessionSummary[]> {
    if (!this.cache) this.cache = await loadSessionCache(this.cachePath);
    const files = await listJsonlFiles(this.root);
    const livePaths = new Set(files.map((path) => resolve(path)));
    const normalizedActive = activePath ? resolve(activePath).toLowerCase() : "";
    const normalizedCwd = cwd ? resolve(cwd).toLowerCase() : "";
    const summaries: SessionSummary[] = [];
    let cacheChanged = false;
    this.pathsById.clear();

    for (const path of files) {
      const normalized = resolve(path);
      let fileStat;
      try {
        fileStat = await this.statFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Another request may delete a Session after enumeration but before
        // stat(). Drop stale metadata and continue refreshing the remaining files.
        if (this.cache.delete(normalized)) cacheChanged = true;
        continue;
      }
      const isActive = normalized.toLowerCase() === normalizedActive;
      let cached = this.cache.get(normalized);
      if (!cached || cached.mtimeMs !== fileStat.mtimeMs || cached.size !== fileStat.size) {
        const summary = await parseSession(normalized, fileStat.mtimeMs);
        if (!summary) {
          if (this.cache.delete(normalized)) cacheChanged = true;
          continue;
        }
        cached = { mtimeMs: fileStat.mtimeMs, size: fileStat.size, summary };
        this.cache.set(normalized, cached);
        cacheChanged = true;
      }
      if (cached.summary.messageCount === 0 || isSubagentSession(normalized, cached.summary.name)) {
        if (this.cache.delete(normalized)) cacheChanged = true;
        continue;
      }
      // Keep the global ID lookup complete even when this caller requests a
      // workspace-filtered sidebar. Runtime restore may target another cwd.
      this.pathsById.set(cached.summary.id, normalized);
      if (normalizedCwd && resolve(cached.summary.cwd || "").toLowerCase() !== normalizedCwd) continue;
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

  summaryForId(id: string): SessionSummary | null {
    const path = this.pathForId(id);
    const cached = path && this.cache?.get(resolve(path));
    return cached ? { ...cached.summary, active: false } : null;
  }

  async snapshotForId(id: string): Promise<SessionFileSnapshot | null> {
    const path = this.pathForId(id);
    if (!path) return null;
    const inFlight = this.snapshotReads.get(id);
    if (inFlight) return inFlight;
    const read = (async () => {
      let fileStat: Stats;
      try { fileStat = await this.statFile(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") this.snapshotCache.delete(id);
        else throw error;
        return null;
      }
      const cached = this.snapshotCache.get(id);
      if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) return cached.snapshot;
      const snapshot = await readSessionSnapshot(path);
      this.snapshotCache.set(id, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, snapshot });
      return snapshot;
    })();
    this.snapshotReads.set(id, read);
    try { return await read; }
    finally { if (this.snapshotReads.get(id) === read) this.snapshotReads.delete(id); }
  }

  async messagesForId(id: string): Promise<PiMessage[] | null> {
    return (await this.snapshotForId(id))?.messages ?? null;
  }

  async usageForId(id: string): Promise<SessionUsageSnapshot | null> {
    return (await this.snapshotForId(id))?.usage ?? null;
  }
}

export { cleanPreview, idForPath, parseSession, textFromContent };
