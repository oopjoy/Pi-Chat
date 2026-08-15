import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import type {
  BackgroundSubagentSnapshot,
  BackgroundSubagentStatus,
  BackgroundSubagentStep,
} from "../shared/types.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RUN_STATES = new Set(["queued", "running", "complete", "failed", "paused", "stopped", "rejected"]);
const STEP_STATES = new Set(["pending", "running", "complete", "completed", "failed", "paused", "stopped", "rejected"]);
const MODES = new Set(["single", "parallel", "chain", "workflow"]);
const ACTIVITY_STATES = new Set(["active_long_running", "needs_attention"]);
const MAX_ROOT_ENTRIES = 512;
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_STATUS_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_STEPS_PER_RUN = 64;
const MAX_TOTAL_STEPS = 128;
const MAX_VISIBLE_STEPS = 24;

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
  status: string;
  activityState?: string;
  startedAt: number;
  endedAt?: number;
  lastActivityAt: number;
  turnCount?: number;
  toolCount?: number;
  tool?: string;
  toolArgs?: string;
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

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedCount(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000
    ? value as number
    : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function canonicalPath(path: string): string {
  const value = normalize(resolve(path));
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function parsedSessionPath(candidate: unknown): string | null {
  return typeof candidate === "string"
    && candidate.length <= 4_096
    && isAbsolute(candidate)
    ? canonicalPath(candidate)
    : null;
}

function sanitizeScopeSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/** Mirror only the installed package's documented user-scoped temp-root convention. */
export function currentSubagentTempRoot(): string | null {
  try {
    if (typeof process.getuid === "function")
      return join(tmpdir(), `pi-subagents-uid-${process.getuid()}`);
    for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
      const value = process.env[key];
      if (value) return join(tmpdir(), `pi-subagents-user-${sanitizeScopeSegment(value)}`);
    }
    const username = userInfo().username;
    if (username) return join(tmpdir(), `pi-subagents-user-${sanitizeScopeSegment(username)}`);
  } catch {
    return null;
  }
  return null;
}

function parseRecentTool(value: unknown): { tool?: string; args?: string } | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  if (value.length === 0) return {};
  const latest = record(value.at(-1));
  if (!latest) return null;
  const tool = latest.tool === undefined ? undefined : boundedString(latest.tool, 64);
  const args = latest.args === undefined ? undefined : boundedString(latest.args, 20_000);
  if ((latest.tool !== undefined && tool === undefined) || (latest.args !== undefined && args === undefined))
    return null;
  return { tool, args };
}

function parseStatus(value: unknown, directoryRunId: string): ParsedStatus | null {
  const input = record(value);
  if (!input) return null;
  const runId = boundedString(input.runId, 64);
  const state = boundedString(input.state, 24);
  const mode = boundedString(input.mode, 24);
  const startedAt = finiteNumber(input.startedAt);
  const parentSessionPath = parsedSessionPath(input.sessionId);
  if (!runId || runId !== directoryRunId || !UUID.test(runId) || !state || !RUN_STATES.has(state)
    || !mode || !MODES.has(mode) || startedAt === undefined || !parentSessionPath) return null;
  const activityState = input.activityState === undefined
    ? undefined
    : boundedString(input.activityState, 32);
  if (activityState !== undefined && !ACTIVITY_STATES.has(activityState)) return null;
  const endedAt = input.endedAt === undefined ? undefined : finiteNumber(input.endedAt);
  const lastUpdate = input.lastUpdate === undefined ? startedAt : finiteNumber(input.lastUpdate);
  if ((input.endedAt !== undefined && endedAt === undefined) || lastUpdate === undefined) return null;
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > MAX_STEPS_PER_RUN)
    return null;

  const steps: ParsedStep[] = [];
  for (const raw of input.steps) {
    const step = record(raw);
    if (!step) return null;
    const agent = boundedString(step.agent, 80);
    const status = boundedString(step.status, 24);
    if (!agent || !status || !STEP_STATES.has(status)) return null;
    const stepActivity = step.activityState === undefined
      ? undefined
      : boundedString(step.activityState, 32);
    if (stepActivity !== undefined && !ACTIVITY_STATES.has(stepActivity)) return null;
    const stepStartedAt = step.startedAt === undefined ? startedAt : finiteNumber(step.startedAt);
    const stepEndedAt = step.endedAt === undefined ? endedAt : finiteNumber(step.endedAt);
    const lastActivityAt = step.lastActivityAt === undefined
      ? lastUpdate
      : finiteNumber(step.lastActivityAt);
    if (stepStartedAt === undefined || lastActivityAt === undefined
      || (step.endedAt !== undefined && stepEndedAt === undefined)) return null;
    const turnCount = step.turnCount === undefined ? undefined : boundedCount(step.turnCount);
    const toolCount = step.toolCount === undefined ? undefined : boundedCount(step.toolCount);
    if ((step.turnCount !== undefined && turnCount === undefined)
      || (step.toolCount !== undefined && toolCount === undefined)) return null;
    const recent = step.recentTools === undefined ? {} : parseRecentTool(step.recentTools);
    if (!recent) return null;
    const currentTool = step.currentTool === undefined ? undefined : boundedString(step.currentTool, 64);
    const currentToolArgs = step.currentToolArgs === undefined ? undefined : boundedString(step.currentToolArgs, 20_000);
    if ((step.currentTool !== undefined && currentTool === undefined)
      || (step.currentToolArgs !== undefined && currentToolArgs === undefined)) return null;
    steps.push({
      agent,
      status,
      activityState: stepActivity,
      startedAt: stepStartedAt,
      endedAt: stepEndedAt,
      lastActivityAt,
      turnCount,
      toolCount,
      tool: currentTool || recent.tool,
      toolArgs: currentToolArgs || recent.args,
    });
  }
  return { runId, parentSessionPath, state, activityState, startedAt, endedAt, lastUpdate, steps };
}

function projectedStatus(step: ParsedStep, parent: ParsedStatus): BackgroundSubagentStatus {
  if (step.status === "paused" || step.activityState === "needs_attention") return "attention";
  if (step.status === "failed" || step.status === "rejected") return "failed";
  if (step.status === "stopped") return "cancelled";
  if (step.status === "complete" || step.status === "completed") return "complete";
  if (parent.state === "paused" || parent.activityState === "needs_attention") return "attention";
  if (parent.state === "failed" || parent.state === "rejected") return "failed";
  if (parent.state === "stopped") return "cancelled";
  if (parent.state === "complete") return "complete";
  return "running";
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

async function safeReadStatus(
  path: string,
  directoryRunId: string,
  now: number,
  cached: StatusCacheEntry | undefined,
): Promise<StatusCacheEntry | null> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > MAX_STATUS_BYTES)
      return null;
    if (before.mtimeMs < now - MAX_STATUS_AGE_MS || before.mtimeMs > now + MAX_FUTURE_SKEW_MS)
      return null;
    if (cached && cached.mtimeMs === before.mtimeMs && cached.size === before.size
      && cached.dev === before.dev && cached.ino === before.ino) return cached;
    const handle = await open(path, constants.O_RDONLY);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino)
        return null;
      const text = await handle.readFile({ encoding: "utf8" });
      const after = await lstat(path);
      if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino
        || after.size !== opened.size || Buffer.byteLength(text, "utf8") > MAX_STATUS_BYTES) return null;
      let parsed: ParsedStatus | null = null;
      try { parsed = parseStatus(JSON.parse(text) as unknown, directoryRunId); }
      catch { parsed = null; }
      return { mtimeMs: after.mtimeMs, size: after.size, dev: after.dev, ino: after.ino, parsed };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Fail-closed provider for the package-owned, user-scoped async status directory. */
export class SubagentStatusProvider {
  private readonly aliases = new Map<string, number>();
  private readonly statusCache = new Map<string, StatusCacheEntry>();
  private nextAlias = 1;

  constructor(
    private readonly tempRoot: string | null = currentSubagentTempRoot(),
    private readonly now: () => number = Date.now,
  ) {}

  private aliasFor(key: string): number {
    const known = this.aliases.get(key);
    if (known) return known;
    const alias = this.nextAlias++;
    this.aliases.set(key, alias);
    return alias;
  }

  async listForParentSession(parentSessionPath: string): Promise<BackgroundSubagentSnapshot> {
    if (!this.tempRoot || !isAbsolute(parentSessionPath)) return EMPTY;
    const root = resolve(this.tempRoot);
    const asyncRoot = join(root, "async-subagent-runs");
    const now = this.now();
    try {
      const [rootStat, asyncStat] = await Promise.all([lstat(root), lstat(asyncRoot)]);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
        || !asyncStat.isDirectory() || asyncStat.isSymbolicLink()) return EMPTY;
      const entries = await readdir(asyncRoot, { withFileTypes: true });
      if (entries.length > MAX_ROOT_ENTRIES) return EMPTY;
      const runDirectories = entries.filter((entry) => entry.isDirectory() && UUID.test(entry.name));
      const expectedSessionPath = canonicalPath(parentSessionPath);
      const projected: Array<BackgroundSubagentStep & { order: number }> = [];
      const observedStatusPaths = new Set<string>();
      for (const entry of runDirectories) {
        const runDirectory = join(asyncRoot, entry.name);
        const runStat = await lstat(runDirectory).catch(() => null);
        if (!runStat?.isDirectory() || runStat.isSymbolicLink()) continue;
        const statusPath = join(runDirectory, "status.json");
        observedStatusPaths.add(statusPath);
        const cacheEntry = await safeReadStatus(statusPath, entry.name, now, this.statusCache.get(statusPath));
        const runAfter = await lstat(runDirectory).catch(() => null);
        const stableRunDirectory = runAfter?.isDirectory() && !runAfter.isSymbolicLink()
          && runAfter.dev === runStat.dev && runAfter.ino === runStat.ino;
        if (cacheEntry && stableRunDirectory) this.statusCache.set(statusPath, cacheEntry);
        else this.statusCache.delete(statusPath);
        const parsed = stableRunDirectory ? cacheEntry?.parsed : null;
        if (!parsed || parsed.parentSessionPath !== expectedSessionPath) continue;
        for (const [index, step] of parsed.steps.entries()) {
          if (projected.length >= MAX_TOTAL_STEPS) return EMPTY;
          const alias = this.aliasFor(`${parsed.runId}:${index}`);
          const status = projectedStatus(step, parsed);
          const end = step.endedAt ?? parsed.endedAt ?? now;
          projected.push({
            key: `subagent-${alias}`,
            label: `${roleLabel(step.agent)} ${alias}`,
            status,
            elapsedMs: Math.max(0, end - step.startedAt),
            updateAgeMs: Math.max(0, now - step.lastActivityAt),
            turnCount: step.turnCount,
            toolCount: step.toolCount,
            activity: status === "running" || status === "attention"
              ? genericActivity(step.tool, step.toolArgs)
              : undefined,
            order: alias,
          });
        }
      }
      for (const path of this.statusCache.keys()) {
        if (!observedStatusPaths.has(path)) this.statusCache.delete(path);
      }
      projected.sort((a, b) => {
        const priority = (status: BackgroundSubagentStatus) => status === "attention" ? 0 : status === "running" ? 1 : 2;
        return priority(a.status) - priority(b.status) || a.updateAgeMs - b.updateAgeMs || a.order - b.order;
      });
      const total = projected.length;
      const steps = projected.slice(0, MAX_VISIBLE_STEPS).map(({ order: _order, ...step }) => step);
      return {
        total,
        activeCount: projected.filter((step) => step.status === "running").length,
        attentionCount: projected.filter((step) => step.status === "attention").length,
        truncated: total > steps.length,
        steps,
      };
    } catch {
      return EMPTY;
    }
  }
}
