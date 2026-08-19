import { unlink } from "node:fs/promises";
import type { ExtensionUiRequest, GateMode, ModelInfo, PiMessage, PiState, PromptImage, PromptSettingsSnapshot, SessionStats, SessionSummary, SlashCommand, ThinkingLevel } from "../shared/types.js";
import { asMessages, asState } from "./pi-data.js";
import { idForPath, readSessionMessages } from "./session-index.js";
import { OperationAdmission } from "./operation-admission.js";
import type { PiRpcClient, RpcEventSource } from "./rpc-client.js";

const DEFAULT_SECONDARY_RUNTIME_IDLE_MS = 40 * 60 * 1_000;
/** Primary + six Secondary workers = seven hot conversations total. */
export const DEFAULT_MAX_SECONDARY_RUNTIMES = 6;
export const DEFAULT_MAX_IDLE_SECONDARY_RUNTIMES = 6;

export interface PendingTurnSettings {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

/** Runtime-confirmed display facts produced while applying one prompt snapshot. */
export interface AppliedTurnSettings {
  model?: ModelInfo;
  thinkingLevel?: ThinkingLevel;
}

/** A later setting command failed after an earlier one already changed Pi. */
export class PartialTurnSettingsError extends Error {
  constructor(
    readonly applied: AppliedTurnSettings,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "PartialTurnSettingsError";
    this.cause = cause;
  }
}

export interface RuntimeQueuedPrompt {
  id: string;
  message: string;
  imageCount: number;
  createdAt: number;
  images: PromptImage[];
  /** Gate mode selected for this turn; replayed immediately before dispatch. */
  gateMode?: GateMode;
  /** Exact Model/Thinking selection captured when this prompt was admitted. */
  settings?: PromptSettingsSnapshot;
}

export interface DraftRuntimeLease {
  runtime: SecondaryRuntime;
  /** Only a freshly spawned empty draft is discarded if Primary readiness fails. */
  created: boolean;
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
  /** Metadata required to compose a zero-I/O hot-session view. */
  summarySnapshot?: SessionSummary;
  /** Last stats result, usable by hot-memory navigation without another RPC probe. */
  lastStats?: SessionStats;
  /** Distinguishes a known empty result from metadata not yet warmed. */
  commandsKnown?: boolean;
  statsKnown?: boolean;
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
  /** Actual child-process cwd. A dedicated Runtime never changes identity or cwd. */
  cwd: string;
  /** Current dedicated child source; stale pre-recovery events are ignored. */
  rpcGeneration: number;
  /** Startup footer status retained until this exact generation is published. */
  pendingFastMode?: { rpcGeneration: number; active: boolean };
  /** Generation whose Fast status has been adopted into the App projection. */
  fastModeGeneration?: number;
  draftSessionPath?: string;
  /** Coalesces an uncertain empty-draft probe; Pi RPC has no cancellation. */
  draftProbe?: Promise<boolean | null>;
}

export type RuntimeReclaimReason = "idle" | "capacity";
export class RuntimeCapacityError extends Error {}
/** A syntactically valid ID has no known persisted Session path. */
export class SessionNotFoundError extends Error {
  constructor() {
    super("会话不存在");
    this.name = "SessionNotFoundError";
  }
}

export interface RuntimePoolOptions {
  now: () => number;
  /** Hard Secondary worker cap; Primary is owned by PiChatApp and counts separately. */
  maxSecondaryRuntimes?: number;
  maxIdleSecondaryRuntimes?: number;
  secondaryRuntimeIdleMs?: number;
  createRpc?: (cwd: string) => PiRpcClient;
  cwd: () => string;
  /** Secondary workers share the verified Primary Pi implementation. This is a
   * global compatibility capability, not a per-session probe: start/recovery
   * still verifies that this individual Session RPC can answer get_state. */
  assertPrimaryCompatible?: () => void;
  /** Ensure SessionIndex knows current paths (list/refresh) before pathForId. */
  refreshSessions: () => Promise<void>;
  pathForId: (id: string) => string | null;
  summaryForId?: (id: string) => SessionSummary | null;
  isClosed: () => boolean;
  /** Sweep only while the application admits background maintenance. */
  canSweep: () => boolean;
  /** Live empty drafts have no indexed history fallback and cannot be reclaimed. */
  isViewed?: (sessionId: string) => boolean;
  onSecondaryEvent: (runtime: SecondaryRuntime, event: Record<string, unknown>, source?: RpcEventSource) => void;
  /** Host clears any Runtime-owned projections after every successful reclaim path. */
  onReclaimed?: (runtime: SecondaryRuntime, reason: RuntimeReclaimReason) => void;
  /** Host merges primary + secondary IDs for SSE payloads. */
  activeSessionIds: () => string[];
  broadcast: (event: Record<string, unknown>) => void;
}

/**
 * Owns dedicated Secondary Runtime maps, capacity mutex, reclaim, and drafts.
 * A Runtime owns exactly one Pi process for its entire lifetime; it is never
 * rebound to another Session.
 * Does not own HTTP, SSE client maps, primary RPC, or prompt dispatch policy.
 */
export class RuntimePool {
  /** Exposed for tests and PiChatApp routing that still read the map by reference. */
  readonly runtimes = new Map<string, SecondaryRuntime>();
  private readonly runtimeStarts = new Map<string, Promise<SecondaryRuntime>>();
  private readonly runtimeStops = new Map<string, Promise<void>>();
  private readonly draftStarts = new Map<string, Promise<DraftRuntimeLease>>();
  private runtimeCapacityTail: Promise<void> = Promise.resolve();
  /** Starts reserve capacity before spawning outside the short capacity lock. */
  private reservedStarts = 0;
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
  get reservedStartCount(): number { return this.reservedStarts; }

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
  async stopReclaimable(runtime: SecondaryRuntime): Promise<boolean> {
    const generation = await runtime.operationAdmission.closeAndDrain();
    if (generation === null) return false;
    // Admission is intentionally closed above, so do not call public
    // canReclaim() here: that guard is for competing callers and would reject
    // this stop owner itself. Recheck every other reclaim invariant instead.
    const retainsEmptyDraft = Boolean(runtime.draftSession && this.options.isViewed?.(runtime.id));
    if (this.runtimes.get(runtime.id) !== runtime || !this.isIdle(runtime) || retainsEmptyDraft) {
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
    return !runtime.running && !runtime.dispatching && !runtime.liveMessage && !runtime.toolStatus && runtime.operationLeases === 0 && !runtime.queuePaused && runtime.promptQueue.length === 0 && !runtime.extensionUiPending && !runtime.recovery;
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

  busyCount(): number {
    return [...this.runtimes.values()].filter((runtime) =>
      runtime.running || runtime.dispatching || Boolean(runtime.liveMessage) || Boolean(runtime.toolStatus) || runtime.operationLeases > 0 || runtime.queuePaused || runtime.promptQueue.length > 0 || runtime.extensionUiPending || Boolean(runtime.recovery)
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
      const stopped = await this.stopReclaimable(runtime);
      if (!stopped || this.runtimes.get(id) !== runtime) return false;
      this.runtimes.delete(id);
      runtime.unsubscribe();
      await this.cleanupEmptyDraft(runtime);
      this.options.onReclaimed?.(runtime, reason);
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

  private async reserveStart(beforeReserve?: () => void | Promise<void>): Promise<{
    commit(publish: () => void): Promise<void>;
    release(): Promise<void>;
  }> {
    await this.withCapacity(async () => {
      await this.makeRoomForSecondary();
      await beforeReserve?.();
      this.reservedStarts += 1;
    });
    let finished = false;
    const finish = async (publish?: () => void) => {
      if (finished) return;
      await this.withCapacity(async () => {
        if (finished) return;
        // Publish and consume the reservation in one short critical section.
        // Capacity can never count this Runtime as both live and reserved.
        publish?.();
        this.reservedStarts = Math.max(0, this.reservedStarts - 1);
        finished = true;
      });
    };
    return { commit: (publish) => finish(publish), release: () => finish() };
  }

  private capacityError(): RuntimeCapacityError {
    return new RuntimeCapacityError(`已达到 ${this.maxSecondaryRuntimes + 1} 个执行对话上限（含受保护的新对话），当前没有可关闭的空闲热对话。请等待任一对话完成后重试`);
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

    // Live workers plus starts already promised a slot are the authoritative
    // cap. The latter start outside this mutex, so independent cold Sessions
    // can spawn in parallel without exceeding capacity.
    while (this.runtimes.size + this.reservedStarts >= this.maxSecondaryRuntimes) {
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
    // Primary owns the one compatibility probe for this local Pi entrypoint.
    // Do not turn cold Session browsing into duplicate capability RPC traffic.
    this.options.assertPrimaryCompatible?.();
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
    const start = (async () => {
      // SessionIndex keeps a complete ID/path cache from the sidebar/view. A
      // known Session must not pay for a global JSONL scan merely to start its
      // own dedicated Runtime. Unknown/stale IDs still refresh once and fail
      // closed when the path cannot be recovered.
      let path = this.options.pathForId(id);
      let summary = this.options.summaryForId?.(id) || undefined;
      if (!path) {
        await this.options.refreshSessions();
        path = this.options.pathForId(id);
        summary = this.options.summaryForId?.(id) || undefined;
      }
      if (!path) throw new SessionNotFoundError();
      const runtimeCwd = summary?.cwd || this.options.cwd();
      const reservation = await this.reserveStart();
      const rpc = this.options.createRpc!(runtimeCwd);
      const runtime: SecondaryRuntime = {
        id,
        rpc,
        sessionPath: path,
        cwd: runtimeCwd,
        rpcGeneration: 0,
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
      rpc.setDiagnosticSessionId?.(id);
      runtime.unsubscribe = rpc.onEvent((event, source) => this.options.onSecondaryEvent(runtime, event, source));
      try {
        const startResult = await rpc.start(["--session", path]);
        runtime.rpcGeneration = rpc.currentGeneration?.() || 0;
        // Lightweight test/embedding RPC implementations predating the
        // readiness-return contract still return void. Production PiRpcClient
        // returns the successful probe so no duplicate query is needed.
        const state = asState(startResult || await rpc.send({ type: "get_state" }));
        runtime.lastState = state;
        runtime.running = state.isStreaming;
        runtime.summarySnapshot = summary;
        await reservation.commit(() => this.runtimes.set(id, runtime));
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
      } finally {
        await reservation.release();
      }
    })();
    this.runtimeStarts.set(id, start);
    try {
      return await start;
    } finally {
      if (this.runtimeStarts.get(id) === start) this.runtimeStarts.delete(id);
    }
  }

  async recover(runtime: SecondaryRuntime): Promise<void> {
    if (runtime.recovery) return runtime.recovery;
    // Existing healthy Secondary workers remain independent from later Primary
    // loss. A crashed worker is a fresh capability acquisition and therefore
    // requires the globally verified local Pi implementation again.
    this.options.assertPrimaryCompatible?.();
    if (!runtime.sessionPath) throw new Error("Pi RPC 已退出，且会话路径不可用");
    const desiredGateMode = runtime.gateMode;
    const recoveryAbortGeneration = runtime.abortGeneration;
    const recovery = (async () => {
      try {
        const restartResult = await runtime.rpc.restart(runtime.sessionPath, runtime.cwd);
        runtime.rpcGeneration = runtime.rpc.currentGeneration?.() || 0;
        const state = asState(restartResult || await runtime.rpc.send({ type: "get_state" }));
        runtime.lastState = state;
        runtime.running = state.isStreaming;
        runtime.failed = false;
        runtime.liveMessage = undefined;
        runtime.toolStatus = "";
        // A crash can leave a stale dispatch lock or paused queue behind, but
        // a newer abort owns queue pause authority. Never reopen that queue as
        // a side effect of completing an older recovery.
        runtime.dispatching = false;
        if (runtime.abortGeneration === recoveryAbortGeneration)
          runtime.queuePaused = false;
        else if (runtime.promptQueue.length) runtime.queuePaused = true;
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
    try { return asMessages(await runtime.rpc.send({ type: "get_messages" }, 300)).length > 0; }
    catch { return null; }
  }

  private probeDraftHasMessages(runtime: SecondaryRuntime): Promise<boolean | null> {
    if (runtime.draftProbe) return runtime.draftProbe;
    const probe = this.draftHasMessages(runtime);
    runtime.draftProbe = probe;
    void probe.finally(() => {
      if (runtime.draftProbe === probe) runtime.draftProbe = undefined;
    });
    return probe;
  }

  private currentReusableDraft(runtime: SecondaryRuntime, clientId: string, cwd: string): boolean {
    return this.runtimes.get(runtime.id) === runtime
      && Boolean(runtime.draftSession)
      && runtime.draftOwnerClientId === clientId
      && runtime.cwd === cwd
      && !runtime.failed
      && runtime.rpc.isRunning?.() !== false;
  }

  /**
   * Probe a draft under an operation lease. A successful empty probe transfers
   * that lease to the caller, so reclaim cannot stop it before the route marks
   * the browser's draft as viewed.
   */
  private async findReusableDraft(clientId: string, cwd: string, probes = new Map<SecondaryRuntime, Promise<boolean | null>>()): Promise<DraftRuntimeLease | undefined> {
    const candidates = [...this.runtimes.values()].filter((runtime) =>
      Boolean(runtime.draftSession)
      && runtime.draftOwnerClientId === clientId
      && runtime.cwd === cwd
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
      const hasMessages = await (probes.get(runtime) || (() => {
        const probe = this.probeDraftHasMessages(runtime);
        probes.set(runtime, probe);
        return probe;
      })());
      if (!this.currentReusableDraft(runtime, clientId, cwd)) {
        release();
        continue;
      }
      if (hasMessages === false) {
        this.touch(runtime);
        return { runtime, created: false, release };
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

  async acquireDraft(clientId = "", cwd = this.options.cwd()): Promise<DraftRuntimeLease> {
    if (!this.options.createRpc) throw new Error("当前服务未启用多会话运行");
    const key = `${clientId}\u0000${cwd}`;
    const existingStart = this.draftStarts.get(key);
    if (existingStart) return existingStart;
    const acquisition = (async () => {
      // A pre-existing healthy draft remains usable after a later Primary
      // compatibility failure. Probe before the new-capability check.
      const probes = new Map<SecondaryRuntime, Promise<boolean | null>>();
      const reusable = await this.findReusableDraft(clientId, cwd, probes);
      if (reusable) {
        this.options.broadcast({ type: "pi_chat_active_session_changed", sessionId: reusable.runtime.id, activeSessionIds: this.options.activeSessionIds() });
        return reusable;
      }
      // New drafts may spawn while the Primary's compatibility probe is still
      // running; PiChatApp joins that probe before it sends setup or a prompt.
      // A Primary that was already known failed is rejected by the route before
      // reaching here, while existing healthy drafts remain reusable.
      // Clean residual drafts outside the global capacity lock. A single probe
      // is shared per Runtime within this acquisition and times out quickly.
      for (const draft of [...this.runtimes.values()].filter((runtime) => runtime.draftSession && runtime.draftOwnerClientId === clientId && runtime.cwd === cwd)) {
        if (!this.isIdle(draft)) continue;
        let release: (() => void) | undefined;
        try { release = this.acquireOperation(draft); }
        catch { continue; }
        const hasMessages = await (probes.get(draft) || (() => {
          const probe = this.probeDraftHasMessages(draft);
          probes.set(draft, probe);
          return probe;
        })());
        const stillAttached = this.runtimes.get(draft.id) === draft;
        release();
        if (!stillAttached) continue;
        if (hasMessages === true) {
          await this.commitDraftIfPersisted(draft);
          continue;
        }
        if (hasMessages === false) await this.reclaim(draft.id, "capacity");
      }
      const reservation = await this.reserveStart(() => {
        const idleCount = [...this.runtimes.values()].filter((runtime) => this.isIdle(runtime)).length;
        if (idleCount >= this.maxIdleSecondaryRuntimes) {
          throw new RuntimeCapacityError(`已有 ${idleCount} 个窗口保留空白新对话，请先使用或关闭其中一个再新建`);
        }
      });
      const reservedRpc = this.options.createRpc!(cwd);
      const runtime: SecondaryRuntime = {
        id: "",
        rpc: reservedRpc,
        cwd,
        rpcGeneration: 0,
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
      runtime.unsubscribe = reservedRpc.onEvent((event, source) => this.options.onSecondaryEvent(runtime, event, source));
      try {
        const startResult = await reservedRpc.start();
        runtime.rpcGeneration = reservedRpc.currentGeneration?.() || 0;
        const state = asState(startResult || await reservedRpc.send({ type: "get_state" }));
        runtime.lastState = state;
        if (!state.sessionFile) throw new Error("Pi 未返回新会话文件");
        runtime.id = idForPath(state.sessionFile);
        reservedRpc.setDiagnosticSessionId?.(runtime.id);
        runtime.sessionPath = state.sessionFile;
        runtime.draftSessionPath = state.sessionFile;
        runtime.draftSession = {
          id: runtime.id,
          sessionId: state.sessionId || runtime.id,
          name: "新对话",
          preview: "尚未发送消息",
          cwd,
          updatedAt: this.options.now(),
          messageCount: 0,
          turnCount: 0,
          active: false,
        };
        await reservation.commit(() => this.runtimes.set(runtime.id, runtime));
        // Protect the newly mapped empty draft through the same route handoff
        // window as a reused draft. It becomes view-pinned before release.
        const release = this.acquireOperation(runtime);
        this.options.broadcast({
          type: "pi_chat_active_session_changed",
          sessionId: runtime.id,
          activeSessionIds: this.options.activeSessionIds(),
        });
        return { runtime, created: true, release };
      } catch (error) {
        runtime.unsubscribe();
        await reservedRpc.stop();
        throw error;
      } finally {
        await reservation.release();
      }
    })();
    this.draftStarts.set(key, acquisition);
    try {
      return await acquisition;
    } finally {
      if (this.draftStarts.get(key) === acquisition) this.draftStarts.delete(key);
    }
  }

  /** Discard an unprompted newly-created draft after its Primary readiness join fails. */
  async discardDraft(runtime: SecondaryRuntime): Promise<void> {
    if (!runtime.draftSession || runtime.prompted) return;
    const released = await this.releaseForDeletion(runtime.id);
    if (released) await this.cleanupEmptyDraft(released);
  }

  /** Stop every secondary without reclaim broadcasts (reload / workspace / app close). */
  async stopAll(options?: { cleanupDrafts?: boolean }): Promise<void> {
    await Promise.allSettled(this.runtimeStarts.values());
    await Promise.allSettled(this.runtimeStops.values());
    const runtimes = [...this.runtimes.values()];
    await Promise.allSettled(runtimes.map((runtime) => runtime.recovery).filter((recovery): recovery is Promise<void> => Boolean(recovery)));
    const results = await Promise.allSettled(runtimes.map((runtime) => runtime.rpc.stop()));
    let failure: unknown;
    for (let index = 0; index < runtimes.length; index += 1) {
      const runtime = runtimes[index];
      const result = results[index];
      if (result.status === "rejected") {
        failure ??= result.reason;
        continue;
      }
      if (this.runtimes.get(runtime.id) === runtime) this.runtimes.delete(runtime.id);
      runtime.unsubscribe();
      if (options?.cleanupDrafts) await this.cleanupEmptyDraft(runtime);
    }
    // A Runtime whose child exit was not proved remains owned and blocks a
    // replacement writer; lifecycle reload/restart must fail closed.
    if (failure) throw failure;
  }

  /**
   * Stop and detach an idle Runtime before deleting its JSONL. This is stricter
   * than a direct stop: admission is closed first so no prompt/rename/model
   * mutation can race the file removal. Visible empty drafts are intentionally
   * allowed here because the caller is explicitly deleting them.
   */
  async releaseForDeletion(id: string): Promise<SecondaryRuntime | undefined> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return undefined;
    const generation = await runtime.operationAdmission.closeAndDrain();
    if (generation === null) return undefined;
    if (this.runtimes.get(id) !== runtime || !this.isIdle(runtime)) {
      runtime.operationAdmission.reopen(generation);
      return undefined;
    }
    try {
      await runtime.rpc.stop();
      this.runtimes.delete(id);
      runtime.unsubscribe();
      return runtime;
    } catch (error) {
      runtime.operationAdmission.reopen(generation);
      throw error;
    }
  }

  /** Drop map entry after host already stopped the dedicated Runtime. */
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
