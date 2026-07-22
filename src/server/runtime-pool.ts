import { unlink } from "node:fs/promises";
import type { ExtensionUiRequest, PiMessage, PromptImage, SessionSummary, ThinkingLevel } from "../shared/types.js";
import { asMessages, asState } from "./pi-data.js";
import { idForPath, readSessionMessages } from "./session-index.js";
import type { PiRpcClient } from "./rpc-client.js";

const DEFAULT_SECONDARY_RUNTIME_IDLE_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_IDLE_SECONDARY_RUNTIMES = 3;

export interface PendingTurnSettings {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

export interface RuntimeQueuedPrompt {
  id: string;
  message: string;
  imageCount: number;
  createdAt: number;
  images: PromptImage[];
}

export interface SecondaryRuntime {
  id: string;
  rpc: PiRpcClient;
  running: boolean;
  queuePaused: boolean;
  dispatching: boolean;
  promptQueue: RuntimeQueuedPrompt[];
  liveMessage?: PiMessage;
  toolStatus: string;
  extensionUiPending: boolean;
  lastUsedAt: number;
  unsubscribe: () => void;
  pendingTurnSettings: PendingTurnSettings;
  pendingExtensionRequest?: ExtensionUiRequest;
  /** A crashed worker remains addressable while one bounded restart is in flight. */
  failed?: boolean;
  recovery?: Promise<void>;
  /** File allocated by Pi for an as-yet empty draft. It is not indexed until a prompt is sent. */
  draftSession?: SessionSummary;
  /** Empty drafts may be reused only by the browser window that created them. */
  draftOwnerClientId?: string;
  /** Pi's JSONL path, available even before SessionIndex first observes the Session. */
  sessionPath?: string;
  draftSessionPath?: string;
}

export type RuntimeReclaimReason = "idle" | "capacity";
export class RuntimeCapacityError extends Error {}

export interface RuntimePoolOptions {
  now: () => number;
  maxIdleSecondaryRuntimes?: number;
  secondaryRuntimeIdleMs?: number;
  createRpc?: (cwd: string) => PiRpcClient;
  cwd: () => string;
  /** Ensure SessionIndex knows current paths (list/refresh) before pathForId. */
  refreshSessions: () => Promise<void>;
  pathForId: (id: string) => string | null;
  isClosed: () => boolean;
  /** Sweep only while the application admits background maintenance. */
  canSweep: () => boolean;
  /** Live empty drafts have no indexed history fallback and cannot be reclaimed. */
  isViewed?: (sessionId: string) => boolean;
  onSecondaryEvent: (runtime: SecondaryRuntime, event: Record<string, unknown>) => void;
  /** Host merges primary + secondary IDs for SSE payloads. */
  activeSessionIds: () => string[];
  broadcast: (event: Record<string, unknown>) => void;
}

/**
 * Owns Secondary Runtime maps, capacity mutex, reclaim, and draft workers.
 * Does not own HTTP, SSE client maps, primary RPC, or prompt dispatch policy.
 */
export class RuntimePool {
  /** Exposed for tests and PiChatApp routing that still read the map by reference. */
  readonly runtimes = new Map<string, SecondaryRuntime>();
  private readonly runtimeStarts = new Map<string, Promise<SecondaryRuntime>>();
  private readonly runtimeStops = new Map<string, Promise<void>>();
  private runtimeCapacityTail: Promise<void> = Promise.resolve();
  private readonly maxIdleSecondaryRuntimes: number;
  private readonly secondaryRuntimeIdleMs: number;

  constructor(private readonly options: RuntimePoolOptions) {
    this.maxIdleSecondaryRuntimes = Math.max(0, Math.floor(options.maxIdleSecondaryRuntimes ?? DEFAULT_MAX_IDLE_SECONDARY_RUNTIMES));
    this.secondaryRuntimeIdleMs = Math.max(0, options.secondaryRuntimeIdleMs ?? DEFAULT_SECONDARY_RUNTIME_IDLE_MS);
  }

  get size(): number { return this.runtimes.size; }
  get startingCount(): number { return this.runtimeStarts.size; }
  get stoppingCount(): number { return this.runtimeStops.size; }
  get transitioningCount(): number { return this.runtimeStarts.size + this.runtimeStops.size; }

  get(id: string): SecondaryRuntime | undefined { return this.runtimes.get(id); }
  has(id: string): boolean { return this.runtimes.has(id); }
  values(): IterableIterator<SecondaryRuntime> { return this.runtimes.values(); }
  entries(): IterableIterator<[string, SecondaryRuntime]> { return this.runtimes.entries(); }

  touch(runtime: SecondaryRuntime): void {
    runtime.lastUsedAt = this.options.now();
  }

  isIdle(runtime: SecondaryRuntime): boolean {
    return !runtime.running && !runtime.dispatching && !runtime.queuePaused && runtime.promptQueue.length === 0 && !runtime.extensionUiPending && !runtime.recovery;
  }

  /**
   * Saved history can fall back to JSONL when reclaimed. A live empty draft
   * has no indexed fallback, so keep it until its window leaves or disconnects.
   */
  canReclaim(runtime: SecondaryRuntime): boolean {
    return this.isIdle(runtime) && !(runtime.draftSession && this.options.isViewed?.(runtime.id));
  }

  busyCount(): number {
    return [...this.runtimes.values()].filter((runtime) =>
      runtime.running || runtime.dispatching || runtime.queuePaused || runtime.promptQueue.length > 0 || runtime.extensionUiPending || Boolean(runtime.recovery)
    ).length;
  }

  secondaryActiveIds(): string[] {
    return [...this.runtimes.values()]
      .filter((runtime) => !runtime.failed && runtime.rpc.isRunning?.() !== false)
      .map((runtime) => runtime.id);
  }

  async withCapacity<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.runtimeCapacityTail;
    let release!: () => void;
    this.runtimeCapacityTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async cleanupEmptyDraft(runtime: SecondaryRuntime): Promise<void> {
    if (!runtime.draftSessionPath) return;
    let messages: PiMessage[];
    try {
      messages = await readSessionMessages(runtime.draftSessionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[Pi Chat] 无法确认草稿为空，保留文件：${runtime.draftSessionPath}`, error);
      }
      return;
    }
    if (messages.some((message) => message.role === "user")) return;
    await unlink(runtime.draftSessionPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async reclaim(id: string, reason: RuntimeReclaimReason): Promise<boolean> {
    const runtime = this.runtimes.get(id);
    if (!runtime || !this.canReclaim(runtime)) return false;
    this.runtimes.delete(id);
    runtime.unsubscribe();
    const stopping = runtime.rpc.stop();
    this.runtimeStops.set(id, stopping);
    try {
      await stopping;
    } finally {
      if (this.runtimeStops.get(id) === stopping) this.runtimeStops.delete(id);
    }
    await this.cleanupEmptyDraft(runtime);
    this.options.broadcast({
      type: "pi_chat_active_session_changed",
      sessionId: id,
      activeSessionIds: this.options.activeSessionIds(),
      reclaimed: true,
      reason,
    });
    return true;
  }

  async makeRoomForSecondary(): Promise<void> {
    const idleCount = [...this.runtimes.values()].filter((runtime) => this.isIdle(runtime)).length;
    const reclaimable = [...this.runtimes.values()].filter((runtime) => this.canReclaim(runtime)).sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const excess = Math.max(0, idleCount - this.maxIdleSecondaryRuntimes + 1);
    for (const runtime of reclaimable.slice(0, excess)) await this.reclaim(runtime.id, "capacity");
  }

  async sweep(): Promise<void> {
    if (this.options.isClosed() || !this.options.canSweep()) return;
    const now = this.options.now();
    const allIdle = [...this.runtimes.values()].filter((runtime) => this.isIdle(runtime));
    const reclaimable = allIdle.filter((runtime) => this.canReclaim(runtime)).sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const expired = reclaimable.filter((runtime) => now - runtime.lastUsedAt >= this.secondaryRuntimeIdleMs);
    const reclaim = new Map<string, RuntimeReclaimReason>(expired.map((runtime) => [runtime.id, "idle"]));
    const retainedIdleCount = allIdle.length - expired.length;
    const excess = Math.max(0, retainedIdleCount - this.maxIdleSecondaryRuntimes);
    for (const runtime of reclaimable.filter((runtime) => !reclaim.has(runtime.id)).slice(0, excess)) reclaim.set(runtime.id, "capacity");
    for (const [id, reason] of reclaim) await this.reclaim(id, reason);
  }

  async ensure(id: string): Promise<SecondaryRuntime> {
    const stopping = this.runtimeStops.get(id);
    if (stopping) {
      await stopping;
      return this.ensure(id);
    }
    const existing = this.runtimes.get(id);
    if (existing) {
      this.touch(existing);
      if (existing.failed || existing.rpc.isRunning?.() === false) await this.recover(existing);
      return existing;
    }
    const starting = this.runtimeStarts.get(id);
    if (starting) return starting;
    if (!this.options.createRpc) throw new Error("当前服务未启用多会话运行");
    const start = this.withCapacity(async () => {
      await this.options.refreshSessions();
      const path = this.options.pathForId(id);
      if (!path) throw new Error("会话不存在");
      await this.makeRoomForSecondary();
      const rpc = this.options.createRpc!(this.options.cwd());
      const runtime: SecondaryRuntime = {
        id,
        rpc,
        sessionPath: path,
        running: false,
        queuePaused: false,
        dispatching: false,
        promptQueue: [],
        toolStatus: "",
        extensionUiPending: false,
        lastUsedAt: this.options.now(),
        unsubscribe: () => {},
        pendingTurnSettings: {},
      };
      runtime.unsubscribe = rpc.onEvent((event) => this.options.onSecondaryEvent(runtime, event));
      try {
        await rpc.start(["--session", path]);
        const state = asState(await rpc.send({ type: "get_state" }));
        runtime.running = state.isStreaming;
        this.runtimes.set(id, runtime);
        this.options.broadcast({
          type: "pi_chat_active_session_changed",
          sessionId: id,
          activeSessionIds: this.options.activeSessionIds(),
        });
        return runtime;
      } catch (error) {
        runtime.unsubscribe();
        await rpc.stop();
        throw error;
      }
    });
    this.runtimeStarts.set(id, start);
    try {
      return await start;
    } finally {
      if (this.runtimeStarts.get(id) === start) this.runtimeStarts.delete(id);
    }
  }

  async recover(runtime: SecondaryRuntime): Promise<void> {
    if (runtime.recovery) return runtime.recovery;
    if (!runtime.sessionPath) throw new Error("Pi RPC 已退出，且会话路径不可用");
    const recovery = (async () => {
      try {
        await runtime.rpc.restart(runtime.sessionPath, this.options.cwd());
        const state = asState(await runtime.rpc.send({ type: "get_state" }));
        runtime.running = state.isStreaming;
        runtime.failed = false;
        runtime.toolStatus = "";
        this.options.broadcast({ type: "pi_chat_process_recovered", piChatSessionId: runtime.id });
      } catch (error) {
        runtime.failed = true;
        throw new Error(`Pi RPC 恢复失败：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    runtime.recovery = recovery;
    try {
      await recovery;
    } finally {
      if (runtime.recovery === recovery) runtime.recovery = undefined;
    }
  }

  private async draftHasMessages(runtime: SecondaryRuntime): Promise<boolean | null> {
    if (runtime.draftSessionPath) {
      try { return (await readSessionMessages(runtime.draftSessionPath)).length > 0; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      }
    }
    try { return asMessages(await runtime.rpc.send({ type: "get_messages" }, 3_000)).length > 0; }
    catch { return null; }
  }

  /** Reuse only this window's verified-empty draft. */
  private async findReusableDraft(clientId: string): Promise<SecondaryRuntime | undefined> {
    const candidates = [...this.runtimes.values()].filter((runtime) =>
      Boolean(runtime.draftSession)
      && runtime.draftOwnerClientId === clientId
      && this.isIdle(runtime)
      && !runtime.failed
      && runtime.rpc.isRunning?.() !== false
    );
    for (const runtime of candidates) {
      // Do not trust the marker alone: an Extension command can persist a turn
      // through a different response path.
      const hasMessages = await this.draftHasMessages(runtime);
      if (hasMessages === false) return runtime;
      if (hasMessages === true) {
        runtime.draftSession = undefined;
        runtime.draftSessionPath = undefined;
        runtime.draftOwnerClientId = undefined;
        this.options.broadcast({ type: "pi_chat_sessions_changed", action: "created", sessionId: runtime.id });
      }
    }
    return undefined;
  }

  async commitDraftIfPersisted(runtime: SecondaryRuntime): Promise<boolean> {
    if (!runtime.draftSession || await this.draftHasMessages(runtime) !== true) return false;
    runtime.draftSession = undefined;
    runtime.draftSessionPath = undefined;
    runtime.draftOwnerClientId = undefined;
    return true;
  }

  async createDraft(clientId = ""): Promise<SecondaryRuntime> {
    if (!this.options.createRpc) throw new Error("当前服务未启用多会话运行");
    return this.withCapacity(async () => {
      const reusable = await this.findReusableDraft(clientId);
      if (reusable) {
        this.touch(reusable);
        this.options.broadcast({
          type: "pi_chat_active_session_changed",
          sessionId: reusable.id,
          activeSessionIds: this.options.activeSessionIds(),
        });
        return reusable;
      }
      // Clean only this window's residual draft. Another live window owns an
      // independent composer and must never be silently redirected to ours.
      for (const draft of [...this.runtimes.values()].filter((runtime) => runtime.draftSession && runtime.draftOwnerClientId === clientId)) {
        await this.reclaim(draft.id, "capacity");
      }
      await this.makeRoomForSecondary();
      const idleCount = [...this.runtimes.values()].filter((runtime) => this.isIdle(runtime)).length;
      if (idleCount >= this.maxIdleSecondaryRuntimes) {
        throw new RuntimeCapacityError(`已有 ${idleCount} 个窗口保留空白新对话，请先使用或关闭其中一个再新建`);
      }
      const rpc = this.options.createRpc!(this.options.cwd());
      const runtime: SecondaryRuntime = {
        id: "",
        rpc,
        running: false,
        queuePaused: false,
        dispatching: false,
        promptQueue: [],
        toolStatus: "",
        extensionUiPending: false,
        lastUsedAt: this.options.now(),
        unsubscribe: () => {},
        pendingTurnSettings: {},
        draftOwnerClientId: clientId,
      };
      runtime.unsubscribe = rpc.onEvent((event) => this.options.onSecondaryEvent(runtime, event));
      try {
        await rpc.start();
        const state = asState(await rpc.send({ type: "get_state" }));
        if (!state.sessionFile) throw new Error("Pi 未返回新会话文件");
        runtime.id = idForPath(state.sessionFile);
        runtime.sessionPath = state.sessionFile;
        runtime.draftSessionPath = state.sessionFile;
        runtime.draftSession = {
          id: runtime.id,
          sessionId: state.sessionId || runtime.id,
          name: "新对话",
          preview: "尚未发送消息",
          cwd: this.options.cwd(),
          updatedAt: this.options.now(),
          messageCount: 0,
          turnCount: 0,
          active: false,
        };
        this.runtimes.set(runtime.id, runtime);
        this.options.broadcast({
          type: "pi_chat_active_session_changed",
          sessionId: runtime.id,
          activeSessionIds: this.options.activeSessionIds(),
        });
        return runtime;
      } catch (error) {
        runtime.unsubscribe();
        await rpc.stop();
        throw error;
      }
    });
  }

  /** Stop every secondary without reclaim broadcasts (reload / workspace / app close). */
  async stopAll(options?: { cleanupDrafts?: boolean }): Promise<void> {
    await Promise.allSettled(this.runtimeStarts.values());
    await Promise.allSettled(this.runtimeStops.values());
    const runtimes = [...this.runtimes.values()];
    await Promise.allSettled(runtimes.map((runtime) => runtime.recovery).filter((recovery): recovery is Promise<void> => Boolean(recovery)));
    this.runtimes.clear();
    for (const runtime of runtimes) runtime.unsubscribe();
    await Promise.allSettled(runtimes.map(async (runtime) => {
      await runtime.rpc.stop();
      if (options?.cleanupDrafts) await this.cleanupEmptyDraft(runtime);
    }));
  }

  /** Drop map entry after host already stopped the worker (rename / delete paths). */
  detach(id: string): SecondaryRuntime | undefined {
    const runtime = this.runtimes.get(id);
    if (runtime) this.runtimes.delete(id);
    return runtime;
  }

  async rpcStatesForQuiescence(): Promise<Array<Record<string, unknown> | null>> {
    return Promise.all([...this.runtimes.values()].map((runtime) =>
      runtime.failed || runtime.rpc.isRunning?.() === false
        ? Promise.resolve(null)
        : runtime.rpc.send({ type: "get_state" })
    ));
  }
}
