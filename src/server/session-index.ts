import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, realpathSync, type Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { LOCAL_COORDINATION_ROLE, type PiMessage, type PromptImage, type SessionSummary, type ThinkingLevel } from "../shared/types.js";
import { compareSessionsByLastUserPrompt } from "../shared/session-order.js";
import { loadSessionCache, saveSessionCache, type SessionCacheEntry } from "./session-index-cache.js";
import { MAX_SESSION_SNAPSHOT_BYTES, SessionProjection, sessionFileFingerprint } from "./session-projection.js";
import { promptImages } from "./pi-data.js";

interface SessionHeader {
  type?: string;
  id?: string;
  cwd?: string;
  /** Pi writes this on sessions created by fork/clone. */
  parentSession?: string;
}

export type SessionFileVersion = Pick<SessionCacheEntry, "mtimeMs" | "ctimeMs" | "birthtimeMs" | "size" | "dev" | "ino" | "fingerprint">;

export function sessionFileVersion(fileStat: Stats, fingerprint: string): SessionFileVersion {
  return {
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs,
    birthtimeMs: fileStat.birthtimeMs,
    size: fileStat.size,
    // Node exposes these as Numbers by default, but Windows can report inode
    // values beyond MAX_SAFE_INTEGER. Persist decimal strings so JSON round
    // trips do not silently change the identity anchor.
    dev: String(fileStat.dev),
    ino: String(fileStat.ino),
    fingerprint,
  };
}

function isValidCachedSessionPath(root: string, path: string, id: string): boolean {
  try {
    const normalized = resolve(path);
    const rootReal = realpathSync(resolve(root));
    const targetReal = realpathSync(normalized);
    const withinRoot = relative(rootReal, targetReal);
    const fileStat = lstatSync(normalized);
    return fileStat.isFile()
      && extname(normalized).toLowerCase() === ".jsonl"
      && !isAbsolute(withinRoot)
      && withinRoot !== ".."
      && !withinRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && idForPath(normalized) === id;
  } catch {
    return false;
  }
}

function sameSessionFileVersion(
  cached: Partial<SessionFileVersion> | undefined,
  current: SessionFileVersion,
): boolean {
  return Boolean(
    cached
    && cached.mtimeMs === current.mtimeMs
    && cached.ctimeMs === current.ctimeMs
    && cached.birthtimeMs === current.birthtimeMs
    && cached.size === current.size
    && cached.dev === current.dev
    && cached.ino === current.ino
    && cached.fingerprint === current.fingerprint,
  );
}

interface SessionEntry {
  type?: string;
  customType?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string | number;
  cwd?: string;
  /** Present on a durable child session created from another session. */
  parentSession?: string;
  name?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  /** Pi's local custom records are not ordinary Runtime messages. */
  details?: {
    bodyText?: unknown;
    from?: { name?: unknown };
  };
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

const DERIVED_SESSION_SUFFIX = "（Fork）";

/** Keep copied/forked sessions distinguishable after a restart and cache hit. */
function derivedSessionDisplayName(name: string): string {
  if (name.endsWith(DERIVED_SESSION_SUFFIX)) return name;
  const baseLimit = Math.max(1, 120 - DERIVED_SESSION_SUFFIX.length);
  return `${cleanPreview(name, baseLimit)}${DERIVED_SESSION_SUFFIX}`;
}

/**
 * Intercom deliveries are persisted as Pi `custom_message` records, so
 * they cannot be sent back to Pi as chat turns. Keeping this strict whitelist
 * visible in the read-only transcript preserves their ordering boundary: a
 * following tool process must not look like it displaced the delivery.
 */
function localCoordinationMessage(entry: SessionEntry): PiMessage | null {
  if (entry.type !== "custom_message" || entry.customType !== "intercom_message") return null;
  const body = typeof entry.details?.bodyText === "string" ? entry.details.bodyText.trim() : "";
  if (!body) return null;
  const sender = typeof entry.details?.from?.name === "string" ? entry.details.from.name.trim() : "";
  return {
    role: LOCAL_COORDINATION_ROLE,
    content: body,
    localCoordination: sender ? { source: sender } : {},
  };
}

function persistedProjectionIdentity(entry: SessionEntry, messageIndex = 0): Pick<PiMessage, "piChatPersistedMessageId"> | Record<string, never> {
  if (typeof entry.id !== "string" || !entry.id || entry.id.length > 400) return {};
  return { piChatPersistedMessageId: `${entry.id}:${messageIndex}` };
}

function timestampFromEntry(entry: SessionEntry): number | undefined {
  const messageTime = entry.message?.timestamp;
  if (typeof messageTime === "number" && Number.isFinite(messageTime)) return messageTime;
  if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) return entry.timestamp;
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
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
      // Pi reserves run-N directories for nested Subagent sessions. They are
      // never ordinary sidebar conversations, so do not enumerate/stat/parse
      // their JSONL children during every global inventory refresh.
      if (entry.isDirectory()) {
        if (!/^run-\d+$/i.test(entry.name)) queue.push(path);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".jsonl") files.push(path);
    }
  }
  return files;
}

async function scanSessionEntries(path: string, retain: (entry: SessionEntry) => SessionEntry | null = (entry) => entry): Promise<SessionEntry[]> {
  const entries: SessionEntry[] = [];
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const retained = retain(JSON.parse(line) as SessionEntry);
        if (retained) entries.push(retained);
      } catch {
        // Ignore an incomplete trailing line while Pi is writing the session.
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return entries;
}

function sessionEntriesFromContent(content: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line) as SessionEntry); }
    catch { /* Ignore an incomplete trailing line while Pi is writing. */ }
  }
  return entries;
}

async function readSessionEntries(path: string): Promise<SessionEntry[]> {
  const fileStat = await stat(path);
  if (fileStat.size > MAX_SESSION_SNAPSHOT_BYTES)
    throw new Error(`Session JSONL 超过 ${Math.round(MAX_SESSION_SNAPSHOT_BYTES / (1024 * 1024))} MB，无法一次载入`);
  return scanSessionEntries(path);
}

/** Sidebar scans retain branch identity and compact user facts, never full replies/tool payloads. */
function outlineSessionEntry(entry: SessionEntry): SessionEntry | null {
  if (entry.type === "session") {
    return {
      type: entry.type,
      id: entry.id,
      cwd: entry.cwd,
      ...(typeof entry.parentSession === "string" ? { parentSession: entry.parentSession } : null),
    };
  }
  if (entry.type === "session_info") return { type: entry.type, name: entry.name };
  if (entry.type !== "message") return entry.id || entry.parentId
    ? { type: entry.type, id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp }
    : null;
  const role = entry.message?.role;
  return {
    type: entry.type,
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    message: role === "user"
      ? { role, content: cleanPreview(textFromContent(entry.message?.content), 90), timestamp: entry.message?.timestamp }
      : { role: role || "unknown", timestamp: entry.message?.timestamp },
  };
}

async function readSessionOutline(path: string): Promise<SessionEntry[]> {
  return scanSessionEntries(path, outlineSessionEntry);
}

/** Follow Pi's current parent chain, excluding file-global session metadata as a leaf. */
function activeSessionBranch(entries: SessionEntry[]): SessionEntry[] {
  // Older/handwritten Pi JSONL uses append-only message records without parent
  // links. It has no branch graph, so its whole conversation remains current.
  const conversation = entries.filter((entry) => entry.type !== "session" && entry.type !== "session_info");
  if (!conversation.some((entry) => Boolean(entry.parentId))) return conversation;

  const byId = new Map(entries.flatMap((entry) => entry.id ? [[entry.id, entry] as const] : []));
  const branch: SessionEntry[] = [];
  let current = [...conversation].reverse().find((entry) => Boolean(entry.id));
  const visited = new Set<string>();
  while (current?.id && !visited.has(current.id)) {
    visited.add(current.id);
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  // A malformed trailing entry without an ID cannot safely identify a fork;
  // preserve legacy linear readability rather than silently emptying history.
  return branch.length ? branch.reverse() : conversation;
}

async function readSessionBranch(path: string): Promise<SessionEntry[]> {
  return activeSessionBranch(await readSessionEntries(path));
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
export interface SessionSettingsSnapshot {
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface SessionFileSnapshot {
  messages: PiMessage[];
  usage: SessionUsageSnapshot;
  /** Last model/thinking selections recorded by Pi on the active JSONL branch. */
  settings: SessionSettingsSnapshot;
}

/** Parse one already-selected active branch into messages, usage, and settings. */
function sessionSnapshotFromBranch(branch: SessionEntry[]): SessionFileSnapshot {
  const messages: PiMessage[] = [];
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let context: SessionUsageSnapshot["context"] = null;
  let lastAssistantModel: { provider?: string; modelId?: string } = {};
  const settings: SessionSettingsSnapshot = {};
  let activeThinkingLevel: ThinkingLevel | undefined;
  for (const entry of branch) {
    const coordination = localCoordinationMessage(entry);
    if (coordination) {
      const timestamp = timestampFromEntry(entry);
      messages.push({
        ...coordination,
        ...persistedProjectionIdentity(entry),
        ...(Number.isFinite(timestamp) ? { timestamp } : {}),
      });
      continue;
    }
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
      settings.provider = entry.provider;
      settings.modelId = entry.modelId;
      continue;
    }
    if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
      settings.thinkingLevel = entry.thinkingLevel as ThinkingLevel;
      activeThinkingLevel = settings.thinkingLevel;
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const timestamp = typeof entry.message.timestamp === "number"
      ? entry.message.timestamp
      : typeof entry.timestamp === "number"
        ? entry.timestamp
        : typeof entry.timestamp === "string"
          ? Date.parse(entry.timestamp)
          : undefined;
    const {
      piChatLiveMessageId: _untrustedLiveMessageId,
      piChatPersistedMessageId: _untrustedPersistedMessageId,
      ...persistedMessage
    } = entry.message;
    const message = persistedMessage as unknown as Record<string, unknown>;
    messages.push({
      ...persistedMessage,
      ...persistedProjectionIdentity(entry),
      ...(Number.isFinite(timestamp) ? { timestamp } : {}),
      ...(message.role === "assistant" && activeThinkingLevel ? { thinkingLevel: activeThinkingLevel } : {}),
    });
    if (message.role !== "assistant" || message.stopReason === "error") continue;
    if (typeof message.provider === "string") lastAssistantModel.provider = message.provider;
    if (typeof message.model === "string") lastAssistantModel.modelId = message.model;
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
  // Older Pi session files may omit model_change; the last successful reply
  // still carries the model that actually produced it.
  if (!settings.provider) settings.provider = lastAssistantModel.provider || context?.provider;
  if (!settings.modelId) settings.modelId = lastAssistantModel.modelId || context?.model;
  return { messages, usage: { tokens, context }, settings };
}

/** Parse the active JSONL branch once for messages, usage, and last-used settings. */
export async function readSessionSnapshot(path: string): Promise<SessionFileSnapshot> {
  return sessionSnapshotFromBranch(await readSessionBranch(path));
}

export function readSessionSnapshotContent(content: string): SessionFileSnapshot {
  return sessionSnapshotFromBranch(activeSessionBranch(sessionEntriesFromContent(content)));
}

export async function readSessionMessages(path: string): Promise<PiMessage[]> {
  return (await readSessionSnapshot(path)).messages;
}

export async function readSessionUsage(path: string): Promise<SessionUsageSnapshot> {
  return (await readSessionSnapshot(path)).usage;
}

function isSubagentSession(path: string, name: string): boolean {
  // Pi has used both nested run-N/session.jsonl children and newer top-level
  // generated names such as subagent-planner-40b9af6d-1. They are process
  // details, not user conversations, so the main sidebar excludes both forms.
  // Derived user Fork names add a trailing suffix after the session name; strip
  // that presentation-only suffix before applying the generated-name check.
  const baseName = name.endsWith(DERIVED_SESSION_SUFFIX)
    ? name.slice(0, -DERIVED_SESSION_SUFFIX.length)
    : name;
  const nestedChild = /(?:^|[\\/])run-\d+(?:[\\/]|$)/i.test(path) && /^subagent-/i.test(baseName);
  const generatedSubagentName = /^subagent-[a-z0-9_-]+-[a-f0-9]{6,}-\d+$/i.test(baseName);
  return nestedChild || generatedSubagentName;
}

function sessionSummaryFromEntries(
  path: string,
  modifiedAt: number,
  entries: SessionEntry[],
  options: { includeSubagents?: boolean; displayName?: string } = {},
): Omit<SessionSummary, "active"> | null {
  const header = entries.find((entry): entry is SessionEntry & SessionHeader => entry.type === "session" && typeof entry.id === "string");
  // Session naming is file-global metadata. Conversation summary facts below
  // deliberately use only the active parent chain, matching rendered history.
  const name = cleanPreview([...entries].reverse().find((entry) => entry.type === "session_info")?.name || "", 120);
  const branch = activeSessionBranch(entries);
  let preview = "";
  let messageCount = 0;
  let turnCount = 0;
  let lastUserPromptAt: number | undefined;
  let hasUserPrompt = false;

  for (const entry of branch) {
    if (entry.type !== "message" || !entry.message) continue;
    messageCount += 1;
    if (entry.message.role !== "user") continue;
    turnCount += 1;
    hasUserPrompt = true;
    const timestamp = timestampFromEntry(entry);
    // Pi writes the user instruction once, then may append many assistant
    // snapshots/tool events. Keep this independent from file mtime so live
    // streams never reshuffle the sidebar.
    lastUserPromptAt = timestamp;
    if (!preview) preview = cleanPreview(textFromContent(entry.message.content));
  }

  if (!header?.id) return null;
  // A Pi process creates an empty JSONL before the user actually starts a conversation.
  // Those draft files belong to the composer, not to the persisted sidebar history.
  if (messageCount === 0) return null;
  const baseDisplayName = cleanPreview(options.displayName || name || preview || "新会话", 120);
  const isDerivedSession = !options.displayName
    && typeof header.parentSession === "string"
    && header.parentSession.trim().length > 0;
  const displayName = isDerivedSession
    ? derivedSessionDisplayName(baseDisplayName)
    : baseDisplayName;
  if (!options.includeSubagents && isSubagentSession(path, baseDisplayName)) return null;
  return {
    id: idForPath(path),
    sessionId: header.id,
    name: displayName,
    preview: preview || displayName,
    cwd: header.cwd || "",
    updatedAt: modifiedAt,
    lastUserPromptAt: hasUserPrompt ? (lastUserPromptAt ?? modifiedAt) : modifiedAt,
    messageCount,
    turnCount,
  };
}

async function parseSession(
  path: string,
  modifiedAt: number,
  options: { includeSubagents?: boolean; displayName?: string } = {},
): Promise<Omit<SessionSummary, "active"> | null> {
  return sessionSummaryFromEntries(path, modifiedAt, await readSessionOutline(path), options);
}

export function parseSessionContent(
  path: string,
  content: string,
  modifiedAt: number,
  options: { includeSubagents?: boolean; displayName?: string } = {},
): Omit<SessionSummary, "active"> | null {
  return sessionSummaryFromEntries(path, modifiedAt, sessionEntriesFromContent(content), options);
}

export class SessionIndex {
  readonly root: string;
  readonly cachePath: string;
  private cache: Map<string, SessionCacheEntry> | null = null;
  private pathsById = new Map<string, string>();
  private refreshPromise: Promise<SessionSummary[]> | null = null;
  /** One physical inventory; active/workspace variants are pure projections. */
  private latestList: { sessions: SessionSummary[]; refreshedAt: number } | null = null;
  private readonly statFile: (path: string) => Promise<Stats>;
  private readonly parseFile: typeof parseSession;
  private readonly incrementalProjectionEnabled: boolean;
  private readonly outlineProjections = new Map<string, SessionProjection<SessionEntry>>();
  private readonly snapshotCache = new Map<string, SessionFileVersion & {
    snapshot: SessionFileSnapshot;
    summary: Omit<SessionSummary, "active"> | null;
    bytes: number;
    projection: SessionProjection<SessionEntry>;
  }>();
  private snapshotCacheBytes = 0;
  private readonly snapshotCacheMaxEntries = 32;
  private readonly snapshotCacheMaxBytes = 64 * 1024 * 1024;
  private readonly snapshotReads = new Map<string, Promise<SessionFileSnapshot | null>>();

  constructor(
    root?: string,
    cachePath?: string,
    statFile: (path: string) => Promise<Stats> = stat,
    parseFile: typeof parseSession = parseSession,
  ) {
    this.root = root || process.env.PI_CODING_AGENT_SESSION_DIR || join(homedir(), ".pi", "agent", "sessions");
    this.cachePath = cachePath || (root ? join(this.root, ".pi-chat-session-index.json") : join(homedir(), ".pi", "agent", "pi-chat-session-index.json"));
    this.statFile = statFile;
    this.parseFile = parseFile;
    this.incrementalProjectionEnabled = parseFile === parseSession;
  }

  private async projectSummary(path: string, fileStat: Stats): Promise<Omit<SessionSummary, "active"> | null> {
    if (!this.incrementalProjectionEnabled) return this.parseFile(path, fileStat.mtimeMs);
    return (await this.projectSummaryWithVersion(path, fileStat)).summary;
  }

  private async projectSummaryWithVersion(path: string, fileStat: Stats): Promise<{
    version: SessionFileVersion;
    summary: Omit<SessionSummary, "active"> | null;
  }> {
    if (!this.incrementalProjectionEnabled) {
      const fingerprint = await sessionFileFingerprint(path);
      return {
        version: sessionFileVersion(fileStat, fingerprint),
        summary: await this.parseFile(path, fileStat.mtimeMs),
      };
    }
    // A selected Session may already own the richer transcript projection. Reuse
    // it instead of creating a second physical reader after a process restart
    // restored only persisted summary metadata.
    for (const [id, cached] of this.snapshotCache) {
      if (resolve(this.pathsById.get(id) || "") !== path) continue;
      // A large file may have grown beyond the cold snapshot budget. Do not
      // route the sidebar inventory through that full-message projection.
      if (fileStat.size > MAX_SESSION_SNAPSHOT_BYTES) continue;
      const result = await cached.projection.reconcile(fileStat);
      return {
        version: sessionFileVersion(result.stats, result.fingerprint),
        summary: sessionSummaryFromEntries(path, result.stats.mtimeMs, [...result.entries]),
      };
    }
    let projection = this.outlineProjections.get(path);
    if (!projection) {
      projection = new SessionProjection(path, {
        retain: (value) => outlineSessionEntry(value as SessionEntry),
      });
      this.outlineProjections.set(path, projection);
    }
    const result = await projection.reconcile(fileStat);
    return {
      version: sessionFileVersion(result.stats, result.fingerprint),
      summary: sessionSummaryFromEntries(path, result.stats.mtimeMs, [...result.entries]),
    };
  }

  private projectList(
    sessions: readonly SessionSummary[],
    activePath?: string,
    cwd?: string,
  ): SessionSummary[] {
    const active = activePath ? resolve(activePath).toLowerCase() : "";
    const workspace = cwd ? resolve(cwd).toLowerCase() : "";
    return sessions.flatMap((session) => {
      if (workspace && resolve(session.cwd || "").toLowerCase() !== workspace) return [];
      const path = this.pathsById.get(session.id);
      return [{
        ...session,
        active: Boolean(path && resolve(path).toLowerCase() === active),
      }];
    });
  }

  snapshot(activePath?: string, cwd?: string): SessionSummary[] | null {
    if (!this.latestList) return null;
    return this.projectList(this.latestList.sessions, activePath, cwd);
  }

  /** Return the latest complete snapshot immediately and refresh it periodically in the background. */
  async listCached(activePath?: string, cwd?: string, maxAgeMs = 5_000): Promise<SessionSummary[]> {
    const snapshot = this.snapshot(activePath, cwd);
    if (!snapshot) return this.list(activePath, cwd);
    if (this.latestList && Date.now() - this.latestList.refreshedAt >= maxAgeMs) {
      void this.list(activePath, cwd).catch(() => undefined);
    }
    return snapshot;
  }

  async list(activePath?: string, cwd?: string): Promise<SessionSummary[]> {
    // Every caller needs the same physical inventory. Active path and workspace
    // only change the returned projection, so bootstrap/sidebar/view requests
    // must share one scan instead of serially rescanning the same JSONL tree.
    if (!this.refreshPromise) this.refreshPromise = this.refresh();
    const refresh = this.refreshPromise;
    try {
      const sessions = await refresh;
      this.latestList = { sessions, refreshedAt: Date.now() };
      return this.projectList(sessions, activePath, cwd);
    } finally {
      if (this.refreshPromise === refresh) this.refreshPromise = null;
    }
  }

  private async refresh(): Promise<SessionSummary[]> {
    if (!this.cache) this.cache = await loadSessionCache(this.cachePath);
    const cache = this.cache;
    if (!cache) throw new Error("Session index cache failed to initialize");
    const files = await listJsonlFiles(this.root);
    const livePaths = new Set(files.map((path) => resolve(path)));
    for (const path of this.outlineProjections.keys()) {
      if (!livePaths.has(path)) this.outlineProjections.delete(path);
    }
    for (const [id, cached] of this.snapshotCache) {
      const path = this.pathsById.get(id);
      if (!path || !livePaths.has(resolve(path))) {
        this.snapshotCacheBytes -= cached.bytes;
        this.snapshotCache.delete(id);
      }
    }
    const summaries: SessionSummary[] = [];
    const nextPathsById = new Map<string, string>();
    let cacheChanged = false;
    const refreshResults: Array<{
      normalized: string;
      version?: SessionFileVersion;
      summary?: Omit<SessionSummary, "active"> | null;
      missing?: boolean;
    }> = new Array(files.length);
    const workerCount = Math.min(4, files.length);
    let nextFileIndex = 0;
    const inspectFile = async (): Promise<void> => {
      while (true) {
        const index = nextFileIndex++;
        if (index >= files.length) return;
        const path = files[index];
        const normalized = resolve(path);
        let fileStat;
        try {
          fileStat = await this.statFile(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          // Another request may delete a Session after enumeration but before
          // stat(). Drop stale metadata and continue refreshing the remaining files.
          refreshResults[index] = { normalized, missing: true };
          continue;
        }
        const cached = cache.get(normalized);
        let projected: { version: SessionFileVersion; summary: Omit<SessionSummary, "active"> | null };
        try {
          if (!this.incrementalProjectionEnabled) {
            const fingerprint = await sessionFileFingerprint(normalized);
            const version = sessionFileVersion(fileStat, fingerprint);
            projected = {
              version,
              summary: sameSessionFileVersion(cached, version)
                ? cached?.summary ?? null
                : await this.projectSummary(normalized, fileStat),
            };
          } else {
            projected = await this.projectSummaryWithVersion(normalized, fileStat);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          refreshResults[index] = { normalized, missing: true };
          continue;
        }
        const summary = projected.summary && isSubagentSession(normalized, projected.summary.name)
          ? null
          : projected.summary;
        refreshResults[index] = { normalized, version: projected.version, summary };
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => inspectFile()));

    for (const result of refreshResults) {
      if (!result) continue;
      if (result.missing) {
        if (cache.delete(result.normalized)) cacheChanged = true;
        continue;
      }
      const cached = cache.get(result.normalized);
      const cachedSummaryHidden = Boolean(
        cached?.summary && isSubagentSession(result.normalized, cached.summary.name),
      );
      if (
        result.version && (
          !sameSessionFileVersion(cached, result.version)
          || cachedSummaryHidden
          || (cached?.summary === null) !== (result.summary === null)
        )
      ) {
        cache.set(result.normalized, { ...result.version, summary: result.summary ?? null });
        cacheChanged = true;
      }
      // Null is a durable negative cache entry. Unchanged empty drafts,
      // generated Subagent histories, and malformed/non-session JSONL are
      // statted and fingerprinted but never reparsed on subsequent inventory
      // refreshes.
      if (!result.summary) continue;
      nextPathsById.set(result.summary.id, result.normalized);
      summaries.push({ ...result.summary, active: false });
    }

    for (const cachedPath of this.cache.keys()) {
      if (!livePaths.has(cachedPath)) {
        this.cache.delete(cachedPath);
        cacheChanged = true;
      }
    }
    if (cacheChanged) await saveSessionCache(this.cachePath, this.cache);
    // Publish one complete mapping. Clearing the live map before a recursive
    // scan made known cold Sessions temporarily look unknown, forcing their
    // target view behind the serialized global inventory refresh.
    this.pathsById = nextPathsById;
    return summaries.sort(compareSessionsByLastUserPrompt);
  }

  pathForId(id: string): string | null {
    return this.pathsById.get(id) ?? null;
  }

  summaryForId(id: string): SessionSummary | null {
    const path = this.pathForId(id);
    const cached = path ? this.cache?.get(resolve(path)) : undefined;
    if (path && cached?.summary && isSubagentSession(path, cached.summary.name)) return null;
    return cached?.summary ? { ...cached.summary, active: false } : null;
  }

  /**
   * Restore one target from the persisted metadata cache without recursively
   * enumerating every Session directory. This is the cold-start counterpart to
   * summaryForId(): remembered history may become readable while bootstrap's
   * full inventory refresh continues independently.
   */
  async cachedSummaryForId(id: string): Promise<SessionSummary | null> {
    // Even an already-known ID must pass the target-only stat/fingerprint gate.
    // Returning summaryForId() directly would reintroduce the same-size rewrite
    // bug after the first inventory scan. This path never enumerates the tree.
    if (!this.cache) this.cache = await loadSessionCache(this.cachePath);
    for (const [path, entry] of this.cache) {
      if (!entry.summary || entry.summary.id !== id) continue;
      const normalized = resolve(path);
      if (!isValidCachedSessionPath(this.root, normalized, id)) {
        this.cache.delete(path);
        this.pathsById.delete(id);
        await saveSessionCache(this.cachePath, this.cache);
        return null;
      }
      let fileStat: Stats;
      try { fileStat = await this.statFile(normalized); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.cache.delete(path);
        this.pathsById.delete(id);
        await saveSessionCache(this.cachePath, this.cache);
        return null;
      }
      let fingerprint: string;
      try {
        fingerprint = await sessionFileFingerprint(normalized);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.cache.delete(path);
        this.pathsById.delete(id);
        await saveSessionCache(this.cachePath, this.cache);
        return null;
      }
      const currentVersion = sessionFileVersion(fileStat, fingerprint);
      let summary = entry.summary;
      if (isSubagentSession(normalized, summary.name)) {
        this.cache.delete(path);
        this.pathsById.delete(id);
        await saveSessionCache(this.cachePath, this.cache);
        return null;
      }
      if (!sameSessionFileVersion(entry, currentVersion)) {
        const refreshed = await this.projectSummary(normalized, fileStat);
        this.cache.set(normalized, { ...currentVersion, summary: refreshed });
        if (normalized !== path) this.cache.delete(path);
        await saveSessionCache(this.cachePath, this.cache);
        if (!refreshed || refreshed.id !== id) {
          this.pathsById.delete(id);
          return null;
        }
        summary = refreshed;
      }
      this.pathsById.set(id, normalized);
      return { ...summary, active: false };
    }
    return null;
  }

  /**
   * Return the last parsed snapshot without statting/re-reading a JSONL. A busy
   * Runtime may append on every token; navigation can use this stale-but-valid
   * history with the live SSE draft, then reconcile at agent_settled.
   */
  cachedSnapshotForId(id: string): SessionFileSnapshot | null {
    return this.snapshotCache.get(id)?.snapshot ?? null;
  }

  async snapshotForId(id: string): Promise<SessionFileSnapshot | null> {
    let path = this.pathForId(id);
    if (!path) {
      // A cold caller may know only the stable Session ID restored from the
      // persisted metadata cache. Resolve the path without validating it twice;
      // the open projection below is the single authoritative target read.
      if (!this.cache) this.cache = await loadSessionCache(this.cachePath);
      let removedInvalidPath = false;
      for (const [candidatePath, entry] of this.cache) {
        if (entry.summary?.id !== id) continue;
        const normalized = resolve(candidatePath);
        if (!isValidCachedSessionPath(this.root, normalized, id)) {
          this.cache.delete(candidatePath);
          removedInvalidPath = true;
          continue;
        }
        path = normalized;
        break;
      }
      if (removedInvalidPath) await saveSessionCache(this.cachePath, this.cache);
    }
    if (!path) return null;
    const inFlight = this.snapshotReads.get(id);
    if (inFlight) return inFlight;
    const read = (async () => {
      const cached = this.snapshotCache.get(id);
      const projection = cached?.projection || new SessionProjection<SessionEntry>(path, {
        retain: (value) => value as SessionEntry,
        maxSourceBytes: MAX_SESSION_SNAPSHOT_BYTES,
      });
      let projected;
      try {
        // SessionProjection opens the file once and returns the authoritative
        // stat and bounded content fingerprint from that same handle.
        projected = await projection.reconcile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (cached) this.snapshotCacheBytes = Math.max(0, this.snapshotCacheBytes - cached.bytes);
        this.snapshotCache.delete(id);
        this.pathsById.delete(id);
        if (this.cache?.delete(path)) await saveSessionCache(this.cachePath, this.cache);
        return null;
      }
      const currentVersion = sessionFileVersion(projected.stats, projected.fingerprint);
      if (cached && sameSessionFileVersion(cached, currentVersion)) return cached.snapshot;
      const branchEntries = [...projected.entries];
      const snapshot = sessionSnapshotFromBranch(activeSessionBranch(branchEntries));
      // A snapshot read already has the validated file version and complete
      // outline entries. Refresh the in-memory summary from those same entries
      // so callers can consume summary + snapshot without a second JSONL read.
      const summary = sessionSummaryFromEntries(path, projected.stats.mtimeMs, branchEntries);
      const metadataCached = this.cache?.get(path);
      if (this.cache && (!metadataCached || !sameSessionFileVersion(metadataCached, currentVersion))) {
        this.cache.set(path, { ...currentVersion, summary });
        await saveSessionCache(this.cachePath, this.cache);
      }
      if (summary) this.pathsById.set(summary.id, path);
      // The source file size is a conservative cache weight and is already
      // available from the projection. Re-serializing every parsed message
      // doubled the CPU work on the first open of a large cold conversation.
      const bytes = projected.observedBytes;
      const previous = this.snapshotCache.get(id);
      if (previous) this.snapshotCacheBytes -= previous.bytes;
      this.snapshotCache.delete(id);
      this.snapshotCache.set(id, {
        ...currentVersion,
        snapshot,
        summary,
        bytes,
        projection,
      });
      this.snapshotCacheBytes += bytes;
      while (this.snapshotCache.size > this.snapshotCacheMaxEntries || this.snapshotCacheBytes > this.snapshotCacheMaxBytes) {
        const oldest = this.snapshotCache.keys().next().value;
        if (!oldest) break;
        const evicted = this.snapshotCache.get(oldest);
        if (evicted) this.snapshotCacheBytes -= evicted.bytes;
        this.snapshotCache.delete(oldest);
      }
      return snapshot;
    })();
    this.snapshotReads.set(id, read);
    try { return await read; }
    finally { if (this.snapshotReads.get(id) === read) this.snapshotReads.delete(id); }
  }

  /** Read one target's validated snapshot and its summary from the same projection. */
  async snapshotAndSummaryForId(id: string): Promise<{ snapshot: SessionFileSnapshot; summary: SessionSummary } | null> {
    const snapshot = await this.snapshotForId(id);
    if (!snapshot) return null;
    // The summary is retained beside the snapshot only after both were derived
    // from the same SessionProjection branch and file version.
    const summary = this.snapshotCache.get(id)?.summary;
    return summary ? { snapshot, summary: { ...summary, active: false } } : null;
  }

  /** Resolve one browser-visible persisted User message back to Pi's active-branch entry. */
  async forkTargetForId(
    id: string,
    persistedMessageId: string,
  ): Promise<{ entryId: string; text: string; images: PromptImage[] } | null> {
    const match = /^(.{1,400}):0$/.exec(persistedMessageId);
    if (!match) return null;
    await this.snapshotForId(id);
    const cached = this.snapshotCache.get(id);
    if (!cached) return null;
    const branch = activeSessionBranch([...cached.projection.entries]);
    const entry = branch.find((candidate) => candidate.id === match[1]);
    if (entry?.type !== "message" || entry.message?.role !== "user") return null;
    const text = textFromContent(entry.message.content);
    let images: PromptImage[];
    try {
      images = promptImages(
        Array.isArray(entry.message.content)
          ? entry.message.content.filter((block) => block.type === "image")
          : [],
      );
    } catch {
      return null;
    }
    return text.trim() || images.length ? { entryId: match[1], text, images } : null;
  }

  async messagesForId(id: string): Promise<PiMessage[] | null> {
    return (await this.snapshotForId(id))?.messages ?? null;
  }

  async usageForId(id: string): Promise<SessionUsageSnapshot | null> {
    return (await this.snapshotForId(id))?.usage ?? null;
  }
}

export { cleanPreview, idForPath, parseSession, textFromContent };
