import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type {
  BackgroundSubagentSnapshot,
  BackgroundSubagentStatus,
  BackgroundSubagentStep,
} from "../shared/types.js";
import { idForPath } from "./session-index.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RUN_STATES = new Set(["queued", "running", "complete", "failed", "paused", "stopped", "rejected"]);
const STEP_STATES = new Set(["pending", "running", "complete", "completed", "failed", "paused", "stopped", "rejected"]);
const MODES = new Set(["single", "parallel", "chain", "workflow"]);
const ACTIVITY_STATES = new Set(["active_long_running", "needs_attention"]);
export const MAX_ROOT_ENTRIES = 512;
export const MAX_STATUS_BYTES = 256 * 1024;
const MAX_STATUS_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const TERMINAL_VISIBLE_AGE_MS = 24 * 60 * 60 * 1_000;
const ALIAS_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_STEPS_PER_RUN = 512;
const MAX_VISIBLE_STEPS = 24;
const MAX_ALIAS_ENTRIES = 4_096;
const MAX_NAVIGATION_TARGETS = 4_096;
const STATUS_SCAN_CONCURRENCY = 24;
const CHILD_SESSION_SCAN_CONCURRENCY = 8;
const MAX_CHILD_SESSION_BYTES = 128 * 1024 * 1024;

export class SubagentStatusUnavailableError extends Error {
  constructor() {
    super("后台子代理状态暂时不可用");
    this.name = "SubagentStatusUnavailableError";
  }
}

const EMPTY: BackgroundSubagentSnapshot = {
  total: 0,
  activeCount: 0,
  attentionCount: 0,
  truncated: false,
  steps: [],
};

type JsonRecord = Record<string, unknown>;
type ParsedStep = {
  agent: string;
  label?: string;
  status: string;
  activityState?: string;
  startedAt: number;
  endedAt?: number;
  lastActivityAt: number;
  turnCount?: number;
  toolCount?: number;
  tool?: string;
  toolArgs?: string;
  sessionFile?: string;
};
type ParsedStatus = {
  runId: string;
  parentSessionPath: string;
  state: string;
  activityState?: string;
  startedAt: number;
  endedAt?: number;
  lastUpdate: number;
  steps: ParsedStep[];
};

type DirectoryEntry = Pick<Dirent, "name" | "isDirectory">;
type ReadHandle = Pick<FileHandle, "read">;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function safeTimestamp(value: unknown, now: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= now + MAX_FUTURE_SKEW_MS
    ? value as number
    : undefined;
}

function safeDuration(later: number, earlier: number): number {
  const value = later - earlier;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function boundedCount(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000
    ? value as number
    : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : undefined;
}

function optionalString(value: unknown, maximum: number): { ok: boolean; value?: string } {
  if (value === undefined || value === "") return { ok: true };
  return typeof value === "string" && value.length <= maximum
    ? { ok: true, value }
    : { ok: false };
}

function safeStepLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return label.length > 0 && label.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(label)
    ? label.replace(/[._:-]+/g, " ")
    : undefined;
}

function canonicalPath(path: string): string {
  const value = normalize(resolve(path));
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function parsedSessionPath(candidate: unknown): string | null {
  return typeof candidate === "string" && candidate.length <= 4_096 && isAbsolute(candidate)
    ? canonicalPath(candidate)
    : null;
}

function sanitizeScopeSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export type SubagentTempScopeOptions = {
  env?: NodeJS.ProcessEnv;
  getuid?: (() => number) | undefined;
  userInfo?: (() => { username?: string | null }) | undefined;
  homedir?: (() => string) | undefined;
  tempDir?: (() => string) | undefined;
};

export function resolveSubagentTempScopeId(options: SubagentTempScopeOptions = {}): string {
  const env = options.env ?? process.env;
  const getuid = Object.hasOwn(options, "getuid") ? options.getuid : process.getuid?.bind(process);
  if (typeof getuid === "function") return `uid-${getuid()}`;
  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = env[key];
    if (value) return `user-${sanitizeScopeSegment(value)}`;
  }
  const getUserInfo = Object.hasOwn(options, "userInfo") ? options.userInfo : userInfo;
  try {
    const username = getUserInfo?.().username;
    if (username) return `user-${sanitizeScopeSegment(username)}`;
  } catch { /* continue */ }
  const configuredHome = env.USERPROFILE ?? env.HOME;
  if (configuredHome) return `home-${sanitizeScopeSegment(configuredHome)}`;
  const getHome = Object.hasOwn(options, "homedir") ? options.homedir : homedir;
  try {
    const fallbackHome = getHome?.();
    if (fallbackHome) return `home-${sanitizeScopeSegment(fallbackHome)}`;
  } catch { /* continue */ }
  return "shared";
}

/** Package-compatible scope resolution, but production never reads its shared fallback. */
export function currentSubagentTempRoot(options: SubagentTempScopeOptions = {}): string | null {
  const scope = resolveSubagentTempScopeId(options);
  if (scope === "shared") return null;
  return join((options.tempDir ?? tmpdir)(), `pi-subagents-${scope}`);
}

function parseRecentTool(value: unknown): { tool?: string; args?: string } | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return {};
  const latest = record(value.at(-1));
  if (!latest) return null;
  const tool = optionalString(latest.tool, 64);
  const args = optionalString(latest.args, 20_000);
  return tool.ok && args.ok ? { tool: tool.value, args: args.value } : null;
}

function reservedAgent(agent: string): boolean {
  const value = agent.trim().toLowerCase();
  return value.startsWith("checkpoint:") || value.startsWith("expand:");
}

function parseStatus(value: unknown, directoryRunId: string, now: number): ParsedStatus | null {
  const input = record(value);
  if (!input) return null;
  const runId = boundedString(input.runId, 64);
  const state = boundedString(input.state, 24);
  const mode = boundedString(input.mode, 24);
  const startedAt = safeTimestamp(input.startedAt, now);
  const parentSessionPath = parsedSessionPath(input.sessionId);
  if (!runId || runId !== directoryRunId || !UUID.test(runId) || !state || !RUN_STATES.has(state)
    || !mode || !MODES.has(mode) || startedAt === undefined || !parentSessionPath) return null;
  const activityState = input.activityState === undefined ? undefined : boundedString(input.activityState, 32);
  if (activityState !== undefined && !ACTIVITY_STATES.has(activityState)) return null;
  const endedAt = input.endedAt === undefined ? undefined : safeTimestamp(input.endedAt, now);
  const lastUpdate = input.lastUpdate === undefined ? startedAt : safeTimestamp(input.lastUpdate, now);
  if ((input.endedAt !== undefined && endedAt === undefined) || lastUpdate === undefined
    || (endedAt !== undefined && endedAt < startedAt) || lastUpdate < startedAt) return null;
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > MAX_STEPS_PER_RUN) return null;

  const steps: ParsedStep[] = [];
  for (const raw of input.steps) {
    const step = record(raw);
    if (!step) return null;
    const agent = boundedString(step.agent, 80);
    const label = safeStepLabel(step.workflowKey) || safeStepLabel(step.label);
    const status = boundedString(step.status, 24);
    if (!agent || !status || !STEP_STATES.has(status)) return null;
    if (reservedAgent(agent)) continue;
    const stepActivity = step.activityState === undefined ? undefined : boundedString(step.activityState, 32);
    if (stepActivity !== undefined && !ACTIVITY_STATES.has(stepActivity)) return null;
    const stepStartedAt = step.startedAt === undefined ? startedAt : safeTimestamp(step.startedAt, now);
    const stepEndedAt = step.endedAt === undefined ? endedAt : safeTimestamp(step.endedAt, now);
    const lastActivityAt = step.lastActivityAt === undefined ? lastUpdate : safeTimestamp(step.lastActivityAt, now);
    if (stepStartedAt === undefined || lastActivityAt === undefined
      || (step.endedAt !== undefined && stepEndedAt === undefined)
      || (stepEndedAt !== undefined && stepEndedAt < stepStartedAt)
      || lastActivityAt < stepStartedAt) return null;
    const turnCount = step.turnCount === undefined ? undefined : boundedCount(step.turnCount);
    const toolCount = step.toolCount === undefined ? undefined : boundedCount(step.toolCount);
    if ((step.turnCount !== undefined && turnCount === undefined)
      || (step.toolCount !== undefined && toolCount === undefined)) return null;
    const recent = step.recentTools === undefined ? {} : parseRecentTool(step.recentTools);
    if (!recent) return null;
    const currentTool = optionalString(step.currentTool, 64);
    const currentToolArgs = optionalString(step.currentToolArgs, 20_000);
    if (!currentTool.ok || !currentToolArgs.ok) return null;
    const sessionFile = step.sessionFile === undefined
      ? undefined
      : parsedSessionPath(step.sessionFile) || undefined;
    steps.push({
      agent,
      label,
      status,
      activityState: stepActivity,
      startedAt: stepStartedAt,
      endedAt: stepEndedAt,
      lastActivityAt,
      turnCount,
      toolCount,
      tool: currentTool.value || recent.tool,
      toolArgs: currentToolArgs.value || recent.args,
      sessionFile,
    });
  }
  return { runId, parentSessionPath, state, activityState, startedAt, endedAt, lastUpdate, steps };
}

function projectedStatus(step: ParsedStep, parent: ParsedStatus): BackgroundSubagentStatus {
  // Activity is advisory and may remain in a persisted status record after a
  // step exits. A terminal step must never look live or require attention.
  if (step.status === "failed" || step.status === "rejected") return "failed";
  if (step.status === "stopped") return "cancelled";
  if (step.status === "complete" || step.status === "completed") return "complete";
  if (parent.state === "failed" || parent.state === "rejected") return "failed";
  if (parent.state === "stopped") return "cancelled";
  if (parent.state === "complete") return "complete";
  if (step.status === "pending") return "waiting";
  if (step.status === "paused" || step.activityState === "needs_attention") return "attention";
  if (parent.state === "paused" || parent.activityState === "needs_attention") return "attention";
  return "running";
}

function statusPriority(status: BackgroundSubagentStatus): number {
  switch (status) {
    case "attention": return 0;
    case "running": return 1;
    case "waiting": return 2;
    case "failed": return 3;
    case "cancelled": return 4;
    case "complete": return 5;
  }
}

function genericActivity(tool: string | undefined, args: string | undefined): string | undefined {
  if (!tool) return undefined;
  if (["read", "grep", "find", "ls"].includes(tool)) return "正在读取文件";
  if (["edit", "write"].includes(tool)) return "正在修改文件";
  if (tool === "bash") return args && /(?:^|\s)(?:test|tests|vitest|jest|playwright|pytest|tsc)(?:\s|$)/i.test(args)
    ? "正在运行测试"
    : "正在运行命令";
  if (tool === "contact_supervisor") return "正在等待协调";
  return undefined;
}

function roleLabel(agent: string): string {
  const normalized = agent.trim().toLowerCase();
  if (normalized === "reviewer") return "审阅子代理";
  if (normalized === "worker") return "实施子代理";
  if (normalized === "scout") return "调研子代理";
  if (normalized === "oracle") return "分析子代理";
  if (normalized === "delegate") return "执行子代理";
  return "子代理";
}

type StatusCacheEntry = {
  mtimeMs: number;
  size: number;
  dev: number;
  ino: number;
  parsed: ParsedStatus | null;
};

type StablePath = {
  path: string;
  real: string;
  dev: number;
  ino: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  uid: number;
  mode: number;
};

function insideRealRoot(rootReal: string, candidateReal: string): boolean {
  const child = relative(rootReal, candidateReal);
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
}

async function stablePath(
  path: string,
  kind: "directory" | "file",
  rootReal?: string,
  exactReal?: string,
  expectedUid?: number | null,
): Promise<StablePath | null> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return null;
    if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) return null;
    if (kind === "file" && stat.nlink !== 1) return null;
    if (expectedUid !== null && expectedUid !== undefined
      && (stat.uid !== expectedUid || (stat.mode & 0o022) !== 0)) return null;
    const resolvedReal = canonicalPath(await realpath(path));
    if (rootReal && !insideRealRoot(rootReal, resolvedReal)) return null;
    if (exactReal && resolvedReal !== canonicalPath(exactReal)) return null;
    return { path, real: resolvedReal, dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size, mtimeMs: stat.mtimeMs, uid: stat.uid, mode: stat.mode };
  } catch {
    return null;
  }
}

async function pathMissing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "");
  }
}

function sameStablePath(before: StablePath, after: StablePath | null): boolean {
  return Boolean(after && after.real === before.real && after.dev === before.dev && after.ino === before.ino
    && after.nlink === before.nlink && after.size === before.size && after.mtimeMs === before.mtimeMs
    && after.uid === before.uid && after.mode === before.mode);
}

type ChildSessionAnchors = { root: StablePath; child: StablePath };

async function childSessionAnchors(
  parentSessionPath: string,
  candidatePath: string,
  expectedUid: number | null,
): Promise<ChildSessionAnchors | null> {
  if (extname(parentSessionPath).toLowerCase() !== ".jsonl"
    || extname(candidatePath).toLowerCase() !== ".jsonl") return null;
  const childRootPath = parentSessionPath.slice(0, -extname(parentSessionPath).length);
  const childRelative = relative(childRootPath, candidatePath);
  if (!childRelative || childRelative.startsWith("..") || isAbsolute(childRelative)) return null;
  const segments = childRelative.split(/[\\/]+/);
  if (segments.length !== 3
    || !/^[A-Za-z0-9._-]{1,128}$/.test(segments[0] || "")
    || !/^run-\d+$/.test(segments[1] || "")
    || segments[2]?.toLowerCase() !== "session.jsonl") return null;
  const root = await stablePath(childRootPath, "directory", undefined, undefined, expectedUid);
  if (!root) return null;
  const child = await stablePath(candidatePath, "file", root.real, undefined, expectedUid);
  return child ? { root, child } : null;
}

async function readChildSessionBytes(
  anchors: ChildSessionAnchors,
  expectedUid: number | null,
): Promise<{ path: string; modifiedAt: number; content: string } | null> {
  const { root, child } = anchors;
  if (child.size > MAX_CHILD_SESSION_BYTES) return null;
  try {
    const handle = await open(child.path, constants.O_RDONLY);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()
        || opened.dev !== child.dev
        || opened.ino !== child.ino
        || opened.nlink !== 1
        || opened.nlink !== child.nlink
        || opened.size !== child.size
        || opened.mtimeMs !== child.mtimeMs
        || (expectedUid !== null
          && (opened.uid !== expectedUid || (opened.mode & 0o022) !== 0))) return null;
      const bytes = Buffer.allocUnsafe(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead <= 0) return null;
        offset += read.bytesRead;
      }
      const openedAfter = await handle.stat();
      if (openedAfter.dev !== opened.dev
        || openedAfter.ino !== opened.ino
        || openedAfter.nlink !== opened.nlink
        || openedAfter.size !== opened.size
        || openedAfter.mtimeMs !== opened.mtimeMs) return null;
      const rootAfter = await stablePath(root.path, "directory", undefined, undefined, expectedUid);
      const childAfter = await stablePath(child.path, "file", root.real, child.real, expectedUid);
      if (!sameStablePath(root, rootAfter) || !sameStablePath(child, childAfter)) return null;
      return { path: child.path, modifiedAt: child.mtimeMs, content: bytes.toString("utf8") };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function batches<T, R>(
  values: T[],
  concurrency: number,
  read: (value: T) => Promise<R>,
): Promise<R[]> {
  const output: R[] = [];
  for (let offset = 0; offset < values.length; offset += concurrency)
    output.push(...await Promise.all(values.slice(offset, offset + concurrency).map(read)));
  return output;
}

export async function collectBoundedDirectoryEntries(
  entries: AsyncIterable<DirectoryEntry>,
  maximum = MAX_ROOT_ENTRIES,
): Promise<DirectoryEntry[] | null> {
  const collected: DirectoryEntry[] = [];
  for await (const entry of entries) {
    if (collected.length >= maximum) return null;
    collected.push(entry);
  }
  return collected;
}

export async function readBoundedStatusBytes(
  handle: ReadHandle,
  maximum = MAX_STATUS_BYTES,
): Promise<Buffer | null> {
  const buffer = Buffer.allocUnsafe(maximum + 1);
  const { bytesRead } = await handle.read(buffer, 0, maximum + 1, 0);
  return bytesRead > maximum ? null : buffer.subarray(0, bytesRead);
}

async function safeReadStatus(
  anchors: { root: StablePath; asyncRoot: StablePath; run: StablePath; status: StablePath },
  directoryRunId: string,
  now: number,
  cached: StatusCacheEntry | undefined,
  expectedUid: number | null,
): Promise<StatusCacheEntry | null> {
  const { root, asyncRoot, run, status } = anchors;
  try {
    if (status.size < 2 || status.size > MAX_STATUS_BYTES) return null;
    if (status.mtimeMs < now - MAX_STATUS_AGE_MS || status.mtimeMs > now + MAX_FUTURE_SKEW_MS) return null;
    const verifyAnchors = async () => {
      const nextRoot = await stablePath(root.path, "directory", undefined, undefined, expectedUid);
      if (!sameStablePath(root, nextRoot)) return false;
      const nextAsync = await stablePath(asyncRoot.path, "directory", root.real, join(root.real, "async-subagent-runs"), expectedUid);
      if (!sameStablePath(asyncRoot, nextAsync)) return false;
      const nextRun = await stablePath(run.path, "directory", root.real, join(asyncRoot.real, directoryRunId), expectedUid);
      if (!sameStablePath(run, nextRun)) return false;
      const nextStatus = await stablePath(status.path, "file", root.real, join(run.real, "status.json"), expectedUid);
      return sameStablePath(status, nextStatus);
    };
    if (cached && cached.mtimeMs === status.mtimeMs && cached.size === status.size
      && cached.dev === status.dev && cached.ino === status.ino)
      return await verifyAnchors() ? cached : null;

    const handle = await open(status.path, constants.O_RDONLY);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== status.size || opened.dev !== status.dev || opened.ino !== status.ino
        || opened.mtimeMs !== status.mtimeMs
        || (expectedUid !== null && (opened.uid !== expectedUid || (opened.mode & 0o022) !== 0))) return null;
      const bytes = await readBoundedStatusBytes(handle);
      if (!bytes || !await verifyAnchors()) return null;
      let parsed: ParsedStatus | null = null;
      try { parsed = parseStatus(JSON.parse(bytes.toString("utf8")) as unknown, directoryRunId, now); }
      catch { parsed = null; }
      return { mtimeMs: status.mtimeMs, size: status.size, dev: status.dev, ino: status.ino, parsed };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

type Candidate = {
  aliasKey: string;
  role: string;
  label?: string;
  status: BackgroundSubagentStatus;
  elapsedMs: number;
  updateAgeMs: number;
  activity?: string;
  childSessionId?: string;
  childSessionPath?: string;
};
type AliasEntry = { alias: number; lastSeenAt: number };
type NavigationTarget = {
  parentSessionPath: string;
  childSessionPath: string;
  label: string;
  lastSeenAt: number;
};

function compareCandidate(a: Candidate, b: Candidate): number {
  return statusPriority(a.status) - statusPriority(b.status)
    || a.updateAgeMs - b.updateAgeMs
    || a.aliasKey.localeCompare(b.aliasKey);
}

export type SubagentStatusProviderOptions = {
  uid?: number | null;
  onFilesystemAccess?: () => void;
  onChildSessionValidation?: () => void;
  beforeChildSessionOpen?: () => Promise<void> | void;
};

/** Fail-closed provider for the package-owned, user-scoped async status directory. */
export class SubagentStatusProvider {
  private readonly aliases = new Map<string, AliasEntry>();
  private readonly statusCache = new Map<string, StatusCacheEntry>();
  private readonly navigationTargets = new Map<string, NavigationTarget>();
  private readonly scans = new Map<string, Promise<BackgroundSubagentSnapshot>>();
  private nextAlias = 1;
  private readonly expectedUid: number | null;

  constructor(
    private readonly tempRoot: string | null = currentSubagentTempRoot(),
    private readonly now: () => number = Date.now,
    private readonly providerOptions: SubagentStatusProviderOptions = {},
  ) {
    this.expectedUid = Object.hasOwn(providerOptions, "uid")
      ? providerOptions.uid ?? null
      : process.getuid?.() ?? null;
  }

  private aliasFor(key: string, now: number): number {
    const known = this.aliases.get(key);
    if (known) {
      known.lastSeenAt = now;
      return known.alias;
    }
    const alias = this.nextAlias++;
    this.aliases.set(key, { alias, lastSeenAt: now });
    return alias;
  }

  private pruneAliases(now: number): void {
    for (const [key, value] of this.aliases)
      if (safeDuration(now, value.lastSeenAt) > ALIAS_RETENTION_MS) this.aliases.delete(key);
    if (this.aliases.size > MAX_ALIAS_ENTRIES) {
      const oldest = [...this.aliases.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
      for (let index = 0; index < oldest.length - MAX_ALIAS_ENTRIES; index += 1)
        this.aliases.delete(oldest[index]![0]);
    }
    if (this.aliases.size === 0) this.nextAlias = 1;
  }

  private clearNavigationTargetsForParent(parentSessionPath: string): void {
    const prefix = `${canonicalPath(parentSessionPath)}\0`;
    for (const key of this.navigationTargets.keys())
      if (key.startsWith(prefix)) this.navigationTargets.delete(key);
  }

  private pruneNavigationTargets(now: number): void {
    for (const [key, target] of this.navigationTargets)
      if (safeDuration(now, target.lastSeenAt) > ALIAS_RETENTION_MS)
        this.navigationTargets.delete(key);
    if (this.navigationTargets.size <= MAX_NAVIGATION_TARGETS) return;
    const oldest = [...this.navigationTargets.entries()]
      .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
    for (let index = 0; index < oldest.length - MAX_NAVIGATION_TARGETS; index += 1)
      this.navigationTargets.delete(oldest[index]![0]);
  }

  async listForParentSession(parentSessionPath: string): Promise<BackgroundSubagentSnapshot> {
    const key = canonicalPath(parentSessionPath);
    const existing = this.scans.get(key);
    if (existing) return existing;
    const scan = this.scanForParentSession(parentSessionPath);
    this.scans.set(key, scan);
    try { return await scan; }
    finally { if (this.scans.get(key) === scan) this.scans.delete(key); }
  }

  async navigationTargetForParentSession(
    parentSessionPath: string,
    childSessionId: string,
  ): Promise<{ path: string; label: string; modifiedAt: number; content: string } | null> {
    if (!/^[a-f0-9]{20}$/.test(childSessionId)) return null;
    await this.listForParentSession(parentSessionPath);
    const key = `${canonicalPath(parentSessionPath)}\0${childSessionId}`;
    const target = this.navigationTargets.get(key);
    if (!target) return null;
    const anchors = await childSessionAnchors(
      target.parentSessionPath,
      target.childSessionPath,
      this.expectedUid,
    );
    if (anchors) await this.providerOptions.beforeChildSessionOpen?.();
    const read = anchors ? await readChildSessionBytes(anchors, this.expectedUid) : null;
    if (!read || idForPath(read.path) !== childSessionId) {
      this.navigationTargets.delete(key);
      return null;
    }
    return { ...read, label: target.label };
  }

  async knownChildSessionPath(childSessionId: string): Promise<string | null> {
    if (!/^[a-f0-9]{20}$/.test(childSessionId)) return null;
    let latest: NavigationTarget | undefined;
    for (const [key, target] of this.navigationTargets) {
      if (!key.endsWith(`\0${childSessionId}`)) continue;
      if (!latest || target.lastSeenAt > latest.lastSeenAt) latest = target;
    }
    if (!latest) return null;
    await this.listForParentSession(latest.parentSessionPath);
    const current = this.navigationTargets.get(
      `${canonicalPath(latest.parentSessionPath)}\0${childSessionId}`,
    );
    if (!current) return null;
    const anchors = await childSessionAnchors(
      current.parentSessionPath,
      current.childSessionPath,
      this.expectedUid,
    );
    return anchors?.child.path || null;
  }

  private async scanForParentSession(parentSessionPath: string): Promise<BackgroundSubagentSnapshot> {
    if (!this.tempRoot || !isAbsolute(parentSessionPath)) return EMPTY;
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) return EMPTY;
    this.providerOptions.onFilesystemAccess?.();
    const rootPath = resolve(this.tempRoot);
    const asyncPath = join(rootPath, "async-subagent-runs");
    const expectedSessionPath = canonicalPath(parentSessionPath);
    try {
      const root = await stablePath(rootPath, "directory", undefined, undefined, this.expectedUid);
      if (!root) {
        if (await pathMissing(rootPath)) {
          this.clearNavigationTargetsForParent(expectedSessionPath);
          return EMPTY;
        }
        throw new SubagentStatusUnavailableError();
      }
      const asyncRoot = await stablePath(asyncPath, "directory", root.real, join(root.real, "async-subagent-runs"), this.expectedUid);
      if (!asyncRoot) {
        if (await pathMissing(asyncPath)) {
          this.clearNavigationTargetsForParent(expectedSessionPath);
          return EMPTY;
        }
        throw new SubagentStatusUnavailableError();
      }
      const directory = await opendir(asyncPath);
      const entries = await collectBoundedDirectoryEntries(directory);
      if (!entries) {
        this.statusCache.clear();
        throw new SubagentStatusUnavailableError();
      }
      const best: Candidate[] = [];
      const observedStatusPaths = new Set<string>();
      let total = 0;
      let activeCount = 0;
      let attentionCount = 0;

      const runEntries = entries.filter((entry) => entry.isDirectory() && UUID.test(entry.name));
      const inspected = await batches(runEntries, STATUS_SCAN_CONCURRENCY, async (entry) => {
        const runPath = join(asyncPath, entry.name);
        const run = await stablePath(
          runPath,
          "directory",
          root.real,
          join(asyncRoot.real, entry.name),
          this.expectedUid,
        );
        if (!run) return null;
        const statusPath = join(runPath, "status.json");
        const status = await stablePath(
          statusPath,
          "file",
          root.real,
          join(run.real, "status.json"),
          this.expectedUid,
        );
        if (!status) return null;
        const cacheEntry = await safeReadStatus(
          { root, asyncRoot, run, status },
          entry.name,
          now,
          this.statusCache.get(statusPath),
          this.expectedUid,
        );
        return { statusPath, cacheEntry };
      });

      for (const inspectedRun of inspected) {
        if (!inspectedRun) continue;
        observedStatusPaths.add(inspectedRun.statusPath);
        if (inspectedRun.cacheEntry)
          this.statusCache.set(inspectedRun.statusPath, inspectedRun.cacheEntry);
        else this.statusCache.delete(inspectedRun.statusPath);
        const parsed = inspectedRun.cacheEntry?.parsed;
        if (!parsed || parsed.parentSessionPath !== expectedSessionPath) continue;

        for (const [index, step] of parsed.steps.entries()) {
          const statusValue = projectedStatus(step, parsed);
          const terminal = statusValue === "complete" || statusValue === "failed" || statusValue === "cancelled";
          const terminalAt = step.endedAt ?? parsed.endedAt ?? Math.max(step.lastActivityAt, parsed.lastUpdate);
          if (terminal && safeDuration(now, terminalAt) > TERMINAL_VISIBLE_AGE_MS) continue;
          total += 1;
          if (statusValue === "running") activeCount += 1;
          if (statusValue === "attention") attentionCount += 1;
          const end = step.endedAt ?? parsed.endedAt ?? (terminal ? terminalAt : now);
          const candidate: Candidate = {
            aliasKey: `${expectedSessionPath}\0${parsed.runId}:${index}`,
            role: roleLabel(step.agent),
            label: step.label,
            status: statusValue,
            elapsedMs: safeDuration(end, step.startedAt),
            updateAgeMs: safeDuration(now, step.lastActivityAt),
            activity: statusValue === "running" || statusValue === "attention"
              ? genericActivity(step.tool, step.toolArgs)
              : undefined,
            childSessionPath: step.sessionFile,
          };
          best.push(candidate);
          best.sort(compareCandidate);
          if (best.length > MAX_VISIBLE_STEPS) best.pop();
        }
      }

      for (const path of this.statusCache.keys())
        if (!observedStatusPaths.has(path)) this.statusCache.delete(path);
      const rootAfter = await stablePath(root.path, "directory", undefined, undefined, this.expectedUid);
      const asyncAfter = await stablePath(asyncRoot.path, "directory", root.real, join(root.real, "async-subagent-runs"), this.expectedUid);
      if (!sameStablePath(root, rootAfter) || !sameStablePath(asyncRoot, asyncAfter))
        throw new SubagentStatusUnavailableError();

      const verifiedCandidates = await batches(
        best,
        CHILD_SESSION_SCAN_CONCURRENCY,
        async (candidate): Promise<Candidate> => {
          if (!candidate.childSessionPath) return candidate;
          this.providerOptions.onChildSessionValidation?.();
          const anchors = await childSessionAnchors(
            parentSessionPath,
            candidate.childSessionPath,
            this.expectedUid,
          );
          return anchors
            ? {
                ...candidate,
                childSessionPath: anchors.child.path,
                childSessionId: idForPath(anchors.child.path),
              }
            : { ...candidate, childSessionPath: undefined, childSessionId: undefined };
        },
      );
      const observedNavigationKeys = new Set<string>();
      const steps: BackgroundSubagentStep[] = verifiedCandidates.map((candidate) => {
        const alias = this.aliasFor(candidate.aliasKey, now);
        const label = candidate.label || `${candidate.role} ${alias}`;
        if (candidate.childSessionId && candidate.childSessionPath) {
          const navigationKey = `${expectedSessionPath}\0${candidate.childSessionId}`;
          observedNavigationKeys.add(navigationKey);
          this.navigationTargets.set(navigationKey, {
            parentSessionPath: expectedSessionPath,
            childSessionPath: candidate.childSessionPath,
            label,
            lastSeenAt: now,
          });
        }
        return {
          key: `subagent-${alias}`,
          label,
          status: candidate.status,
          elapsedMs: candidate.elapsedMs,
          updateAgeMs: candidate.updateAgeMs,
          activity: candidate.activity,
          childSessionId: candidate.childSessionId,
        };
      });
      const navigationPrefix = `${expectedSessionPath}\0`;
      for (const key of this.navigationTargets.keys())
        if (key.startsWith(navigationPrefix) && !observedNavigationKeys.has(key))
          this.navigationTargets.delete(key);
      this.pruneAliases(now);
      this.pruneNavigationTargets(now);
      return { total, activeCount, attentionCount, truncated: total > steps.length, steps };
    } catch (error) {
      if (error instanceof SubagentStatusUnavailableError) throw error;
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")) {
        this.clearNavigationTargetsForParent(expectedSessionPath);
        return EMPTY;
      }
      throw new SubagentStatusUnavailableError();
    }
  }
}
