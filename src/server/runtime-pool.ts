import { unlink } from "node:fs/promises";
import type { ExtensionUiRequest, GateMode, PiMessage, PiState, PromptImage, SessionSummary, SlashCommand, ThinkingLevel } from "../shared/types.js";
import { asMessages, asState } from "./pi-data.js";
import { idForPath, readSessionMessages } from "./session-index.js";
import { OperationAdmission } from "./operation-admission.js";
import type { PiRpcClient } from "./rpc-client.js";

const DEFAULT_SECONDARY_RUNTIME_IDLE_MS = 40 * 60 * 1_000;
/** Primary + four Secondary workers = five hot conversations total. */
const DEFAULT_MAX_SECONDARY_RUNTIMES = 4;
const DEFAULT_MAX_IDLE_SECONDARY_RUNTIMES = 4;

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
  /** Gate mode selected for this turn; replayed immediately before dispatch. */
  gateMode?: GateMode;
}

export interface DraftRuntimeLease {
  runtime: SecondaryRuntime;
  release(): void;
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
  /** Last responsive state/command snapshot; navigation never waits on a busy Pi worker for these. */
  lastState?: PiState;
  commands?: SlashCommand[];
  /** Last complete persisted message branch, warmed outside the busy navigation path. */
  messageSnapshot?: PiMessage[];
  /** Terminal SSE rows not yet confirmed by the persisted JSONL branch. */
  pendingTerminalMessages: PiMessage[];
  /** Awaited per-runtime mutations keep capacity reclamation from stopping this worker. */
  operationLeases: number;
  /** Atomically blocks new operations while rest/reclaim drains existing work. */
  operationAdmission: OperationAdmission;
  /** Incremented by abort to cancel dispatch preflight before prompt is sent. */
  abortGeneration: number;
  lastUsedAt: number;
  unsubscribe: () => void;
  pendingTurnSettings: PendingTurnSettings;
  pendingExtensionRequest?: ExtensionUiRequest;
  /** Authoritative in-memory mode of this Runtime's bundled Gate extension. */
  gateMode: GateMode;
  /** A crashed worker remains addressable while one bounded restart is in flight. */
  failed?: boolean;
  recovery?: Promise<void>;
  /** File allocated by Pi for an as-yet empty draft. It is not indexed until a prompt is sent. */
  draftSession?: SessionSummary;
  /** Empty drafts may be reused only by the browser window that created them. */
  draftOwnerClientId?: string;
  /** True once the first prompt (or extension command) was accepted for this draft. */
  prompted?: boolean;
  /** Last accepted user instruction; sidebar order must not follow streamed output. */
  lastUserPromptAt?: number;
  /** Pi's JSONL path, available even before SessionIndex first observes the Session. */
  sessionPath?: string;
  draftSessionPath?: string;
}

export type RuntimeReclaimReason = "idle" | "capacity" | "manual";
export class RuntimeCapacityError extends Error {}

export interface RuntimePoolOptions {
  now: () => number;
  /** Hard Secondary worker cap; Primary is owned by PiChatApp and counts separately. */
  maxSecondaryRuntimes?: number;
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
  private readonly maxSecondaryRuntimes: number;
  private readonly maxIdleSecondaryRuntimes: number;
  private readonly secondaryRuntimeIdleMs: number;

  constructor(private readonly options: RuntimePoolOptions) {
    this.maxSecondaryRuntimes = Math.max(0, Math.floor(options.maxSecondaryRuntimes ?? DEFAULT_MAX_SECONDARY_RUNTIMES));
    this.maxIdleSecondaryRuntimes = Math.min(this.maxSecondaryRuntimes, Math.max(0, Math.floor(options.maxIdleSecondaryRuntimes ?? DEFAULT_MAX_IDLE_SECONDARY_RUNTIMES)));
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

  acquireOperation(runtime: SecondaryRuntime): () => void {
    const lease = runtime.operationAdmission.acquire();
    runtime.operationLeases += 1;
    this.touch(runtime);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      runtime.operationLeases = Math.max(0, runtime.operationLeases - 1);
      lease.release();
      this.touch(runtime);
    };
  }

  async withOperation<T>(runtime: SecondaryRuntime, operation: () => Promise<T>): Promise<T> {
    const release = this.acquireOperation(runtime);
    try { return await operation(); }
    finally { release(); }
  }

  /** Testable primitive shared by reclaim paths: close admission, drain, recheck, then stop. */
  async stopReclaimable(runtime: SecondaryRuntime, reason: RuntimeReclaimReason = "idle"): Promise<boolean> {
    const generation = await runtime.operationAdmission.closeAndDrain();
    if (generation === null) return false;
    const manuallyReleasable = reason !== "manual" || (!runtime.failed && runtime.rpc.isRunning?.() !== false);
    // Admission is intentionally closed above, so do not call public
    // canReclaim() here: that guard is for competing callers and would reject
    // this stop owner itself. Recheck every other reclaim invariant instead.
    const retainsEmptyDraft = Boolean(runtime.draftSession && this.options.isViewed?.(runtime.id));
    if (this.runtimes.get(runtime.id) !== runtime || !manuallyReleasable || !this.isIdle(runtime) || retainsEmptyDraft) {
      runtime.operationAdmission.reopen(generation);
      return false;
    }
    try {
      await runtime.rpc.stop();
      return true;
    } catch (error) {
      runtime.operationAdmission.reopen(generation);
      throw error;
    }
  }

  isIdle(runtime: SecondaryRuntime): boolean {
    return !runtime.running && !runtime.dispatching && runtime.operationLeases === 0 && !runtime.queuePaused && runtime.promptQueue.length === 0 && !runtime.extensionUiPending && !runtime.recovery;
  }

  /**
   * Saved history can fall back to JSONL when reclaimed. A live empty draft
   * has no indexed fallback, so keep it until its window leaves or disconnects.
   */
  canReclaim(runtime: SecondaryRuntime): boolean {
    // Once reclaim closes admission, its single stop owner must finish or reopen
    // before another capacity path can consider this Runtime again.
    return !runtime.operationAdmission.isClosed
      && this.isIdle(runtime)
      && !(runtime.draftSession && this.options.isViewed?.(runtime.id));
  }

  canManuallyRelease(runtime: SecondaryRuntime): boolean {
    return !runtime.failed
      && runtime.rpc.isRunning?.() !== false
      && !runtime.operationAdmission.isClosed
      && this.canReclaim(runtime);
  }

  busyCount(): number {
    return [...this.runtimes.values()].filter((runtime) =>
      runtime.running || runtime.dispatching || runtime.operationLeases > 0 || runtime.queuePaused || runtime.promptQueue.length > 0 || runtime.extensionUiPending || Boolean(runtime.recovery)
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
    // All concurrent reclaim paths for one Runtime share the first stop owner.
    // In particular, a second sweep must never overwrite/delete the marker that
    // makes ensure() wait while the original RPC is still stopping.
    const alreadyStopping = this.runtimeStops.get(id);
    if (alreadyStopping) {
      await alreadyStopping;
      return this.runtimes.has(id) ? false : true;
    }
    const runtime = this.runtimes.get(id);
    if (!runtime || !this.canReclaim(runtime)) return false;
    const stopping = (async () => {
      const stopped = await this.stopReclaimable(runtime, reason);
      if (!stopped || this.runtimes.get(id) !== runtime) return false;
      this.runtimes.delete(id);
      runtime.unsubscribe();
      await this.cleanupEmptyDraft(runtime);
      this.options.broadcast({
        type: "pi_chat_active_session_changed",
        sessionId: id,
        activeSessionIds: this.options.activeSessionIds(),
        reclaimed: true,
        reason,
      });
      return true;
    })();
    const marker = stopping.then(() => undefined, () => undefined);
    this.runtimeStops.set(id, marker);
    try {
      return await stopping;
    } finally {
      // Do not erase a later lifecycle marker that this reclaim did not create.
      if (this.runtimeStops.get(id) === marker) this.runtimeStops.delete(id);
    }
  }

  private capacityError(): RuntimeCapacityError {
    return new RuntimeCapacityError(`已达到 ${this.maxSecondaryRuntimes + 1} 个热对话上限。请等待一个对话结束运行，或关闭受保护的空白新对话后重试`);
  }

  private async reclaimOldestAvailable(): Promise<boolean> {
    const candidates = [...this.runtimes.values()]
      .filter((runtime) => this.canReclaim(runtime))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    for (const runtime of candidates) {
      if (await this.reclaim(runtime.id, "capacity")) return true;
    }
    return false;
  }

  async makeRoomForSecondary(): Promise<void> {
    const idleCount = [...this.runtimes.values()].filter((runtime) => this.isIdle(runtime)).length;
    const reclaimable = [...this.runtimes.values()].filter((runtime) => this.canReclaim(runtime)).sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const idleExcess = Math.max(0, idleCount - this.maxIdleSecondaryRuntimes + 1);
    for (const runtime of reclaimable.slice(0, idleExcess)) await this.reclaim(runtime.id, "capacity");

    // withCapacity serializes all creation paths, so the map size plus the
    // worker about to be created is an authoritative hard-cap check.
    while (this.runtimes.size >= this.maxSecondaryRuntimes) {
      if (!await this.reclaimOldestAvailable()) throw this.capacityError();
    }
  }

  async sweep(): Promise<void> {
    if (this.options.isClosed() || !this.options.canSweep()) return;
    const now = this.options.now();
    const allIdle = [...this.runtimes.values()].filter((runtime) => this.isIdle(runtime));
    const reclaimable = allIdle.filter((runtime) => this.canReclaim(runtime)).sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const expired = reclaimable.filter((runtime) => now - runtime.lastUsedAt >= this.secondaryRuntimeIdleMs);
    const reclaim = new Map<string, RuntimeReclaimReason>(expired.map((runtime) => [runtime.id, "idle"]));
    const retainedIdleCount = allIdle.length - expired.length;
    const idleExcess = Math.max(0, retainedIdleCount - this.maxIdleSecondaryRuntimes);
    const retainedRuntimeCount = this.runtimes.size - expired.length;
    const hardCapExcess = Math.max(0, retainedRuntimeCount - this.maxSecondaryRuntimes);
    const excess = Math.max(idleExcess, hardCapExcess);
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
        operationLeases: 0,
        operationAdmission: new OperationAdmission(),
        abortGeneration: 0,
        running: false,
        queuePaused: false,
        dispatching: false,
        promptQueue: [],
        toolStatus: "",
        extensionUiPending: false,
        pendingTerminalMessages: [],
        lastUsedAt: this.options.now(),
        unsubscribe: () => {},
        pendingTurnSettings: {},
        gateMode: "strict",
      };
      runtime.unsubscribe = rpc.onEvent((event) => this.options.onSecondaryEvent(runtime, event));
      try {
        await rpc.start(["--session", path]);
        const state = asState(await rpc.send({ type: "get_state" }));
        runtime.lastState = state;
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
    const desiredGateMode = runtime.gateMode;
    const recovery = (async () => {
      try {
        await runtime.rpc.restart(runtime.sessionPath, this.options.cwd());
        const state = asState(await runtime.rpc.send({ type: "get_state" }));
        runtime.lastState = state;
        runtime.running = state.isStreaming;
        runtime.failed = false;
        runtime.toolStatus = "";
        if (desiredGateMode !== "strict") {
          await runtime.rpc.send({ type: "prompt", message: `/gate ${desiredGateMode}` });
        }
        runtime.gateMode = desiredGateMode;
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

  private currentReusableDraft(runtime: SecondaryRuntime, clientId: string): boolean {
    return this.runtimes.get(runtime.id) === runtime
      && Boolean(runtime.draftSession)
      && runtime.draftOwnerClientId === clientId
      && !runtime.failed
      && runtime.rpc.isRunning?.() !== false;
  }

  /**
   * Probe a draft under an operation lease. A successful empty probe transfers
   * that lease to the caller, so reclaim cannot stop it before the route marks
   * the browser's draft as viewed.
   */
  private async findReusableDraft(clientId: string): Promise<DraftRuntimeLease | undefined> {
    const candidates = [...this.runtimes.values()].filter((runtime) =>
      Boolean(runtime.draftSession)
      && runtime.draftOwnerClientId === clientId
      && this.isIdle(runtime)
      && !runtime.failed
      && runtime.rpc.isRunning?.() !== false
    );
    for (const runtime of candidates) {
      let release: (() => void) | undefined;
      try {
        release = this.acquireOperation(runtime);
      } catch {
        continue;
      }
      // Do not trust the marker alone: an Extension command can persist a turn
      // through a different response path.
      const hasMessages = await this.draftHasMessages(runtime);
      if (!this.currentReusableDraft(runtime, clientId)) {
        release();
        continue;
      }
      if (hasMessages === false) {
        this.touch(runtime);
        return { runtime, release };
      }
      if (hasMessages === true) {
        runtime.draftSession = undefined;
        runtime.draftSessionPath = undefined;
        runtime.draftOwnerClientId = undefined;
        this.options.broadcast({ type: "pi_chat_sessions_changed", action: "created", sessionId: runtime.id });
      }
      release();
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

  async acquireDraft(clientId = ""): Promise<DraftRuntimeLease> {
    if (!this.options.createRpc) throw new Error("当前服务未启用多会话运行");
    return this.withCapacity(async () => {
      const reusable = await this.findReusableDraft(clientId);
      if (reusable) {
        this.options.broadcast({
          type: "pi_chat_active_session_changed",
          sessionId: reusable.runtime.id,
          activeSessionIds: this.options.activeSessionIds(),
        });
        return reusable;
      }
      // Clean only this window's residual empty drafts. Never reclaim a busy draft
      // or one that already has a user message: the next New used to wipe the
      // previous conversation while it was still streaming or still unindexed.
      for (const draft of [...this.runtimes.values()].filter((runtime) => runtime.draftSession && runtime.draftOwnerClientId === clientId)) {
        if (!this.isIdle(draft)) continue;
        let release: (() => void) | undefined;
        try { release = this.acquireOperation(draft); }
        catch { continue; }
        const hasMessages = await this.draftHasMessages(draft);
        const stillAttached = this.runtimes.get(draft.id) === draft;
        release();
        if (!stillAttached) continue;
        if (hasMessages === true) {
          await this.commitDraftIfPersisted(draft);
          continue;
        }
        if (hasMessages === false) await this.reclaim(draft.id, "capacity");
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
        operationLeases: 0,
        operationAdmission: new OperationAdmission(),
        abortGeneration: 0,
        running: false,
        queuePaused: false,
        dispatching: false,
        promptQueue: [],
        toolStatus: "",
        extensionUiPending: false,
        pendingTerminalMessages: [],
        lastUsedAt: this.options.now(),
        unsubscribe: () => {},
        pendingTurnSettings: {},
        gateMode: "strict",
        draftOwnerClientId: clientId,
      };
      runtime.unsubscribe = rpc.onEvent((event) => this.options.onSecondaryEvent(runtime, event));
      try {
        await rpc.start();
        const state = asState(await rpc.send({ type: "get_state" }));
        runtime.lastState = state;
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
        // Protect the newly mapped empty draft through the same route handoff
        // window as a reused draft. It becomes view-pinned before release.
        const release = this.acquireOperation(runtime);
        this.options.broadcast({
          type: "pi_chat_active_session_changed",
          sessionId: runtime.id,
          activeSessionIds: this.options.activeSessionIds(),
        });
        return { runtime, release };
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
