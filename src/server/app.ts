import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, normalize, resolve } from "node:path";
import { appendTerminalMessage, reconcilePersistedHistory } from "../shared/streaming-assistant.js";
import { compareSessionsByLastUserPrompt } from "../shared/session-order.js";
import type { ApplicationLifecycle, BootstrapData, BuildIdentity, ExtensionUiRequest, GateMode, HealthData, InitialPromptData, InitialPromptRequest, ModelInfo, PiMessage, PiState, PrimaryRuntimeReadiness, PromptImage, QueuedPrompt, SessionActivityState, SessionDirectorySummary, SessionRuntimeReadyData, SessionStats, SessionSummary, SessionViewData, SlashCommand, ThinkingLevel } from "../shared/types.js";
import { ApplicationBusyError, ApplicationLifecycleConflictError, ApplicationLifecycleCoordinator, lifecycleMessage } from "./application-lifecycle.js";
import { pickLocalFiles, pickWorkspaceFolder, readClipboardFiles, revealInExplorer } from "./file-picker.js";
import { type FileSnapshot, restoreSnapshots, snapshotFile } from "./file-transaction.js";
import { bodyJson, HttpRequestError, json, methodNotAllowed, MIME_TYPES, requestClientId, requestPageId, SECURITY_HEADERS } from "./http-transport.js";
import { ModelManager } from "./model-manager.js";
import { OperationAdmission, OperationAdmissionClosedError } from "./operation-admission.js";
import { ResourceManager } from "./resource-manager.js";
import { PiRpcClient, rpcData, type RpcEventSource } from "./rpc-client.js";
import { asCommands, asMessages, asModels, asSessionStats, asState, messageWindow, promptImages, RECENT_TURN_WINDOW_SIZE } from "./pi-data.js";
import { idForPath, readSessionMessages, SessionIndex, type SessionSettingsSnapshot, type SessionUsageSnapshot } from "./session-index.js";
import { RuntimeCapacityError, RuntimePool, type PendingTurnSettings, type SecondaryRuntime } from "./runtime-pool.js";
import { SessionControl, SessionControlConflictError } from "./session-control.js";
import { PromptScheduler, PROMPT_PREPARE_TIMEOUT_MS } from "./prompt-scheduler.js";
import { PrimaryRuntimeUnavailableError, type PrimaryRuntimeReadinessBridge } from "./primary-runtime-readiness.js";
import { SseHub } from "./sse-hub.js";
import { saveWorkspace } from "./workspace-state.js";
import { requestGuardError } from "./request-guard.js";
import { transitionRuntimeEvent, type RuntimeEventState } from "./runtime-event-transition.js";
import { handleBootstrapRoute } from "./routes/bootstrap.js";
import { handleSessionsReadRoute } from "./routes/sessions-read.js";
import { apiRouteAdmission } from "./api-route-admission.js";

export { messageWindow, promptImages, RECENT_TURN_WINDOW_SIZE } from "./pi-data.js";
export { PROMPT_PREPARE_TIMEOUT_MS } from "./prompt-scheduler.js";
export const TURN_WINDOW_INCREMENT = 10;
const MAX_TURN_WINDOW_SIZE = 10_000;
const DEFAULT_SESSION_LIST_SIZE = 30;
const DEFAULT_DIRECTORY_SESSION_LIST_SIZE = 15;
const DEFAULT_SECONDARY_RUNTIME_SWEEP_MS = 60 * 1_000;
const DEFAULT_GATE_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_LAST_WINDOW_SHUTDOWN_GRACE_MS = 10_000;
const DEFAULT_LAST_WINDOW_SHUTDOWN_POLL_MS = 500;
// Pi may emit agent_settled before the new JSONL user record is visible to a
// concurrent reader. Keep the draft's provisional sidebar summary only across
// this small bounded visibility window.
const DRAFT_PERSISTENCE_RETRY_DELAYS_MS = [40, 120, 300, 700];
const SESSION_ID_PATTERN = /^[a-f0-9]{20}$/;
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "new", description: "新建会话", source: "builtin" },
  { name: "compact", description: "压缩当前会话上下文，可附加指令", source: "builtin" },
  { name: "abort", description: "停止当前生成", source: "builtin" },
];

function gateModeFromCommand(message: string): GateMode | null {
  const command = /^\/gate\s+([^\s]+)\s*$/i.exec(message.trim())?.[1]?.toLowerCase();
  if (["strict", "on", "close", "closed", "enable"].includes(command || "")) return "strict";
  if (["open", "off", "allow", "disable"].includes(command || "")) return "open";
  return null;
}

function gateModeFromNotice(message: unknown): GateMode | null {
  const value = typeof message === "string" ? message : "";
  const match = /^Gate mode:\s*(strict|open)\b/im.exec(value);
  if (match) return match[1] as GateMode;
  return null;
}

/** Existing-session mutations must never infer a mutable Primary target. */
function requiredSessionId(body: Record<string, unknown>): string {
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new HttpRequestError(400, "sessionId 必须是有效的会话标识");
  }
  return sessionId;
}

export interface PreparedApplicationRestart {
  /**
   * Optional in-process promote. Production defers the real dist swap to
   * restart-handoff (after exit) so Windows can release file locks; tests may
   * still promote synchronously here.
   */
  promote(): Promise<void>;
  handoff(): void;
  discard(): Promise<void>;
}

export type ApplicationShutdownReason = "api-shutdown" | "last-window-close";

export interface PiChatAppOptions {
  rpc: PiRpcClient;
  createRpc?: (cwd: string) => PiRpcClient;
  sessions: SessionIndex;
  webRoot: string;
  cwd: string;
  resources: ResourceManager;
  modelManager?: ModelManager;
  devMiddleware?: (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
  secondaryRuntimeIdleMs?: number;
  /** Primary counts separately; default 4 Secondary Runtimes means 5 hot conversations total. */
  maxSecondaryRuntimes?: number;
  maxIdleSecondaryRuntimes?: number;
  secondaryRuntimeSweepMs?: number;
  controllerReleaseMs?: number;
  /** Foreground browser lease duration; separate from the SSE transport socket. */
  presenceTtlMs?: number;
  gateRequestTimeoutMs?: number;
  sseHeartbeatMs?: number;
  /** Quiescent grace after every browser/PWA window has explicitly left. */
  lastWindowShutdownGraceMs?: number;
  /** Busy-state polling interval while the last-window shutdown waits for work. */
  lastWindowShutdownPollMs?: number;
  now?: () => number;
  allowedHosts?: string[];
  requestToken?: string;
  /** Identity shared by this Node process and the Web bundle in its runtime dist. */
  buildIdentity?: BuildIdentity;
  /** Build a staged replacement; PiChatApp promotes it only after its second quiescence check. */
  applicationRestart?: () => Promise<PreparedApplicationRestart>;
  /** Gracefully terminate the entire Pi Chat service process after explicit user intent. */
  applicationShutdown?: (reason: ApplicationShutdownReason) => void;
  /** Index owns spawn/probe/retry; App only projects and gates capability use. */
  primaryRuntime?: PrimaryRuntimeReadinessBridge;
}

export class PiChatApp {
  private readonly sseHub = new SseHub();
  /** Same Map as SseHub; dual-session tests seed write stubs here. */
  private readonly sseClients: Map<ServerResponse, string>;
  private readonly scheduler: PromptScheduler;
  private readonly unsubscribe: () => void;
  private lastPrimaryState: PiState = { model: null, isStreaming: false };
  private closed = false;
  private currentCwd: string;
  /** Primary's true process cwd never follows mutable future-draft defaults. */
  private readonly primaryRuntimeCwd: string;
  private activeSessionId = "";
  private activeSessionPath: string | undefined;
  /** A Primary event is usable only after get_state bound this specific child to this Session. */
  private primaryRpcGeneration = 0;
  private primaryBoundSessionId = "";
  private readonly runtimePool: RuntimePool;
  /** Same Map instance as RuntimePool; kept for tests that inspect app.runtimes. */
  private readonly runtimes: Map<string, SecondaryRuntime>;
  private readonly sessionControl: SessionControl;
  /** Same Map instances as SessionControl; kept for dual-session presence tests. */
  private readonly sessionControllers: Map<string, string>;
  private readonly connectedClients: Map<string, number>;
  private readonly viewedSessionsByClient: Map<string, string>;
  private readonly pendingExtensionTimers = new Map<string, NodeJS.Timeout>();
  private readonly draftPersistenceRetryTimers = new Map<SecondaryRuntime, NodeJS.Timeout>();
  private readonly claimingExtensionRequests = new Set<string>();
  /** FIFO admission per Session prevents simultaneous prompt requests bypassing the queue. */
  private readonly promptAdmissionTails = new Map<string, Promise<void>>();
  private primaryFailed = false;
  private primaryRecovery: Promise<void> | null = null;
  private readonly primaryOperationAdmission = new OperationAdmission();
  private readonly now: () => number;
  private readonly gateRequestTimeoutMs: number;
  private readonly sseHeartbeatMs: number;
  private readonly secondaryRuntimeSweepTimer: NodeJS.Timeout;
  private readonly lastWindowShutdownGraceMs: number;
  private readonly lastWindowShutdownPollMs: number;
  private lastWindowShutdownTimer: NodeJS.Timeout | null = null;
  private lastWindowIdleSince: number | null = null;
  private autoShutdownRunning = false;
  /** Page-instance registry is separate from client identity used for control. */
  private readonly connectedPageClients = new Map<string, string>();
  private readonly requestToken: string;
  private readonly buildIdentity: BuildIdentity;
  private allowedHosts: string[];
  private readonly lifecycleCoordinator: ApplicationLifecycleCoordinator;
  /** A compaction changes the prompt structure; wait for a later completed turn before reporting occupancy again. */
  private readonly modelContextWindows = new Map<string, number>();
  /** Current model catalogue, retained so cold JSONL settings get a display name without waking Pi. */
  private readonly knownModels = new Map<string, ModelInfo>();
  private lastAvailableModels: ModelInfo[] = [];
  /** Best-effort local catalogue for the startup shell before Primary becomes ready. */
  private readonly startupModels: ModelInfo[];
  private lastPrimaryCommands: SlashCommand[] = [];
  private lastPrimaryStats: { sessionId: string; value: SessionStats } | undefined;
  /** Summary copied only from normal views/bootstrap; fast hot navigation never queries SessionIndex. */
  private primarySummarySnapshot: SessionSummary | undefined;
  /** Last persisted Primary branch; busy navigation never waits for a live JSONL read. */
  private lastPrimaryMessages: PiMessage[] = [];
  private lastPrimaryMessagesSessionId = "";
  /** Terminal SSE rows not yet confirmed by Primary JSONL. */
  private primaryPendingTerminalMessages: PiMessage[] = [];
  private primaryPendingTerminalSessionId = "";
  private readonly contextUsagePendingRefresh = new Set<string>();
  private readonly contextUsageRefreshTurn = new Set<string>();
  /** Fresh accepted prompts win over JSONL mtime while a Runtime is alive. */
  private readonly lastUserPromptAtBySession = new Map<string, number>();
  /** Preserve arrival order even when two local requests share one Date.now() millisecond. */
  private lastPromptOrderAt = 0;
  /** Authoritative mode of the bundled Gate extension in the Primary Runtime. */
  private primaryGateMode: GateMode = "strict";
  private readonly runEpoch = randomBytes(16).toString("base64url");
  private readonly runGenerationsBySession = new Map<string, number>();
  /** Session preference survives Runtime reclaim, but never outlives the Pi Chat process. */
  private readonly gateModesBySession = new Map<string, GateMode>();

  // Primary queue/runtime flags live on PromptScheduler; aliases keep route handlers stable.
  private get promptQueue() { return this.scheduler.primaryQueue; }
  private get running() { return this.scheduler.primaryRunning; }
  private set running(value: boolean) { this.scheduler.primaryRunning = value; }
  private get queuePaused() { return this.scheduler.primaryQueuePaused; }
  private set queuePaused(value: boolean) { this.scheduler.primaryQueuePaused = value; }
  private get dispatching() { return this.scheduler.primaryDispatching; }
  private set dispatching(value: boolean) { this.scheduler.primaryDispatching = value; }
  private get liveMessage() { return this.scheduler.primaryLiveMessage; }
  private set liveMessage(value: PiMessage | undefined) { this.scheduler.primaryLiveMessage = value; }
  private get toolStatus() { return this.scheduler.primaryToolStatus; }
  private set toolStatus(value: string) { this.scheduler.primaryToolStatus = value; }
  private get pendingTurnSettings() { return this.scheduler.primaryPendingTurnSettings; }
  private get pendingExtensionRequest() { return this.scheduler.primaryPendingExtensionRequest; }
  private set pendingExtensionRequest(value: ExtensionUiRequest | undefined) { this.scheduler.primaryPendingExtensionRequest = value; }

  constructor(private readonly options: PiChatAppOptions) {
    this.currentCwd = resolve(options.cwd);
    this.primaryRuntimeCwd = this.currentCwd;
    this.startupModels = this.readStartupModels();
    options.primaryRuntime?.subscribe((readiness) => {
      this.broadcast({ type: "pi_chat_primary_runtime_status", primaryRuntime: readiness });
    });
    this.sseClients = this.sseHub.clientMap;
    this.lifecycleCoordinator = new ApplicationLifecycleCoordinator(() => this.broadcastLifecycle());
    this.requestToken = options.requestToken || randomBytes(32).toString("base64url");
    this.buildIdentity = options.buildIdentity || { schemaVersion: 1, packageVersion: "unknown", revision: "unknown", fingerprint: "unknown", builtAt: "unknown" };
    // Bare loopback names are used only by in-process test apps. The production
    // entrypoint replaces them with one exact host:port after listen().
    this.allowedHosts = options.allowedHosts || ["127.0.0.1", "localhost", "::1"];
    this.now = options.now || Date.now;
    this.gateRequestTimeoutMs = Math.max(1, options.gateRequestTimeoutMs ?? DEFAULT_GATE_REQUEST_TIMEOUT_MS);
    this.sseHeartbeatMs = Math.max(10, options.sseHeartbeatMs ?? 20_000);
    this.lastWindowShutdownGraceMs = Math.max(0, options.lastWindowShutdownGraceMs ?? DEFAULT_LAST_WINDOW_SHUTDOWN_GRACE_MS);
    this.lastWindowShutdownPollMs = Math.max(10, options.lastWindowShutdownPollMs ?? DEFAULT_LAST_WINDOW_SHUTDOWN_POLL_MS);
    this.sessionControl = new SessionControl({
      controllerReleaseMs: options.controllerReleaseMs,
      presenceTtlMs: options.presenceTtlMs,
      now: this.now,
      onControlChanged: (sessionId) => this.broadcastControlState(sessionId),
    });
    this.sessionControllers = this.sessionControl.sessionControllers;
    this.connectedClients = this.sessionControl.connectedClients;
    this.viewedSessionsByClient = this.sessionControl.viewedSessionsByClient;
    this.scheduler = new PromptScheduler({
      isClosed: () => this.closed,
      isLifecycleIdle: () => this.applicationLifecycle === "idle",
      primaryRpc: () => this.options.rpc,
      activeSessionId: () => this.activeSessionId,
      ensurePrimaryRuntime: () => this.ensurePrimaryRuntime(),
      recoverRuntime: (runtime) => this.recoverRuntime(runtime),
      acquirePrimaryOperation: () => this.primaryOperationAdmission.acquire().release,
      acquireRuntimeOperation: (runtime) => this.runtimePool.acquireOperation(runtime),
      touchRuntime: (runtime) => this.runtimePool.touch(runtime),
      applyPendingTurnSettings: (rpc, pending) => this.applyPendingTurnSettings(rpc, pending),
      syncGateMode: (rpc, sessionId, mode) => this.syncGateMode(rpc, sessionId, mode),
      broadcast: (event) => this.broadcast(event),
      publishSessionActivity: (sessionId) => this.broadcastSessionActivity(sessionId),
      onPrimaryPromptAccepted: (sessionId, promptAt) => {
        this.recordUserPrompt(sessionId, promptAt);
        this.warmPrimaryMessageSnapshot();
        this.broadcast({ type: "pi_chat_sessions_changed", action: "created", sessionId });
      },
      onSecondaryPromptAccepted: (runtime, promptAt) => {
        this.recordUserPrompt(runtime.id, promptAt);
        this.warmRuntimeMessageSnapshot(runtime);
        // Keep draftSession until agent_settled confirms JSONL has the user turn.
        // Mark prompted so sessionSummaries can inject a sidebar row immediately —
        // SessionIndex only lists files after at least one message is on disk, which
        // for long answers used to mean "only after the whole reply finished".
        runtime.prompted = true;
        // Pi can finish an extremely short first turn before agent_settled is
        // observed here. Start bounded JSONL visibility confirmation at prompt
        // admission too, then settlement can simply accelerate the same path.
        void this.finalizePersistedDraftWhenVisible(runtime);
        this.broadcast({ type: "pi_chat_sessions_changed", action: "created", sessionId: runtime.id });
      },
    });
    this.runtimePool = new RuntimePool({
      now: this.now,
      maxSecondaryRuntimes: options.maxSecondaryRuntimes,
      maxIdleSecondaryRuntimes: options.maxIdleSecondaryRuntimes,
      secondaryRuntimeIdleMs: options.secondaryRuntimeIdleMs,
      createRpc: options.createRpc,
      // One Primary probe certifies the locally configured Pi entrypoint for
      // every Secondary. Existing healthy workers remain independent after a
      // later Primary failure; only new/recovered workers require readiness.
      assertPrimaryCompatible: () => {
        if (!this.options.primaryRuntime || this.primaryReadiness().status === "ready") return;
        throw new PrimaryRuntimeUnavailableError(this.primaryReadiness());
      },
      cwd: () => this.currentCwd,
      refreshSessions: async () => { await this.options.sessions.list(undefined, this.currentCwd); },
      pathForId: (id) => this.options.sessions.pathForId(id),
      summaryForId: (id) => this.options.sessions.summaryForId?.(id) || null,
      isClosed: () => this.closed,
      canSweep: () => this.applicationLifecycle === "idle" && this.activeMutationRequests === 0,
      isViewed: (sessionId) => this.sessionControl.isViewed(sessionId),
      onSecondaryEvent: (runtime, event, source) => this.handleSecondaryEvent(runtime, event, source),
      activeSessionIds: () => this.activeSessionIds(),
      broadcast: (event) => this.broadcast(event),
    });
    this.runtimes = this.runtimePool.runtimes;
    this.sseHub.onDisconnect((_response, clientId, info) => {
      // SseHub is the one canonical transport departure path. It covers both
      // request-close and server-initiated slow-client/write-error removal, so
      // SessionControl decrements this connection exactly once.
      this.clientDisconnected(clientId);
      // Transport diagnostics deliberately exclude client/session identity and
      // payloads. A dropped EventSource remains recoverable and must not alter
      // application lifecycle or Runtime ownership.
      const bytes = typeof info.pendingBytes === "number" ? `, pendingBytes=${info.pendingBytes}` : "";
      console.info(`[Pi Chat] SSE disconnected (reason=${info.reason}${bytes})`);
    });
    const sweepMs = Math.max(100, options.secondaryRuntimeSweepMs ?? DEFAULT_SECONDARY_RUNTIME_SWEEP_MS);
    this.secondaryRuntimeSweepTimer = setInterval(() => void this.runtimePool.sweep(), sweepMs);
    this.secondaryRuntimeSweepTimer.unref();
    this.unsubscribe = options.rpc.onEvent((event, source) => this.handleRpcEvent(event, source));
  }

  setAllowedHosts(allowedHosts: string[]): void {
    this.allowedHosts = [...allowedHosts];
  }

  private get applicationLifecycle(): ApplicationLifecycle { return this.lifecycleCoordinator.lifecycle; }
  private get activeMutationRequests(): number { return this.lifecycleCoordinator.activeMutations; }

  private lifecycleMessage(lifecycle = this.applicationLifecycle): string { return lifecycleMessage(lifecycle); }

  private broadcastLifecycle(): void {
    this.broadcast({ type: "pi_chat_application_lifecycle", lifecycle: this.applicationLifecycle });
  }

  private beginLifecycle(lifecycle: Exclude<ApplicationLifecycle, "idle">): void { this.lifecycleCoordinator.begin(lifecycle); }
  private endLifecycle(lifecycle: Exclude<ApplicationLifecycle, "idle">): void { this.lifecycleCoordinator.end(lifecycle); }
  /** Read custom configured models without waking Pi, so the fresh startup
   * shell can offer real choices before Primary's runtime inventory arrives. */
  private readStartupModels(): ModelInfo[] {
    if (!this.options.modelManager) return [];
    try {
      const raw = JSON.parse(readFileSync(this.options.modelManager.path, "utf8")) as { providers?: Record<string, { models?: unknown[] }> };
      const models: ModelInfo[] = [];
      for (const [provider, config] of Object.entries(raw.providers || {})) {
        for (const item of config?.models || []) {
          if (!item || typeof item !== "object") continue;
          const value = item as Record<string, unknown>;
          if (typeof value.id !== "string" || !value.id) continue;
          models.push({
            provider,
            id: value.id,
            name: typeof value.name === "string" && value.name ? value.name : value.id,
            reasoning: value.reasoning === true,
            input: value.imageInput === true ? ["text", "image"] : ["text"],
            contextWindow: typeof value.contextWindow === "number" ? value.contextWindow : undefined,
            custom: true,
          });
        }
      }
      return models;
    } catch {
      return [];
    }
  }

  private beginMutation(): () => void { return this.lifecycleCoordinator.beginMutation(); }

  private async beginPromptAdmission(sessionId: string): Promise<() => void> {
    const key = sessionId || "primary";
    const previous = this.promptAdmissionTails.get(key) || Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolveCurrent) => { releaseCurrent = resolveCurrent; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.promptAdmissionTails.set(key, tail);
    await previous.catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (this.promptAdmissionTails.get(key) === tail) this.promptAdmissionTails.delete(key);
    };
  }

  private async withLifecycle<T>(lifecycle: Exclude<ApplicationLifecycle, "idle">, action: string, operation: () => Promise<T>): Promise<T> {
    this.beginLifecycle(lifecycle);
    try {
      await this.verifyApplicationQuiescent(action);
      return await operation();
    } finally {
      this.endLifecycle(lifecycle);
    }
  }

  private busyConversationCount(): number {
    const primaryBusy = this.running || this.dispatching || this.queuePaused || this.promptQueue.length > 0 || Boolean(this.pendingExtensionRequest) || Boolean(this.primaryRecovery);
    return this.runtimePool.busyCount() + (primaryBusy ? 1 : 0);
  }

  private assertApplicationQuiescent(action: string): void {
    const busyCount = this.busyConversationCount();
    const transitioningCount = this.runtimePool.transitioningCount;
    if (busyCount || transitioningCount || this.activeMutationRequests) {
      throw new ApplicationBusyError(`仍有 ${busyCount + transitioningCount} 个对话正在执行、启动、停止、排队或等待确认，请处理完成后再${action}`);
    }
  }

  private async verifyApplicationQuiescent(action: string): Promise<void> {
    this.assertApplicationQuiescent(action);
    const primaryState = this.primaryReadReady()
      ? await this.options.rpc.send({ type: "get_state" })
      : null;
    const secondaryStates = await this.runtimePool.rpcStatesForQuiescence();
    if ([primaryState, ...secondaryStates].some((response) => response && asState(response).isStreaming)) {
      throw new ApplicationBusyError(`仍有对话正在执行，请完成后再${action}`);
    }
    this.assertApplicationQuiescent(action);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelLastWindowShutdown();
    clearInterval(this.secondaryRuntimeSweepTimer);
    for (const timer of this.draftPersistenceRetryTimers.values()) clearTimeout(timer);
    this.draftPersistenceRetryTimers.clear();
    this.unsubscribe();
    // Distinct Session workers can stop concurrently. Sequential forced-stop
    // windows made shutdown/restart scale by roughly three seconds per worker.
    await this.runtimePool.stopAll({ cleanupDrafts: true });
    // Closing the hub emits the canonical disconnect callbacks. Clear control
    // state afterwards so those callbacks cannot leave fresh release timers.
    this.sseHub.closeAll();
    this.sessionControl.clear();
    this.connectedPageClients.clear();
    this.scheduler.clearPrimary();
    for (const timer of this.pendingExtensionTimers.values()) clearTimeout(timer);
    this.pendingExtensionTimers.clear();
    this.claimingExtensionRequests.clear();
    this.promptAdmissionTails.clear();
  }

  private broadcast(event: Record<string, unknown>): void {
    this.sseHub.broadcast(event);
  }

  private broadcastRpcEvent(event: Record<string, unknown>, sessionId: string, runGeneration?: number): void {
    // Pi emits cumulative tool partialResult snapshots. The web client does not
    // render them; forwarding every snapshot creates quadratic SSE traffic and
    // can freeze Chromium's main thread during long or self-referential output.
    if (event.type === "tool_execution_update") return;
    this.broadcast({
      ...event,
      piChatSessionId: sessionId,
      piChatRunEpoch: this.runEpoch,
      ...(typeof runGeneration === "number" ? { piChatRunGeneration: runGeneration } : null),
    });
  }

  private broadcastControlState(sessionId: string): void {
    this.sseHub.broadcastEach((clientId) => ({
      type: "pi_chat_session_control_changed",
      sessionId,
      ...this.sessionControl.controlState(sessionId, clientId),
    }));
  }

  private publicQueue(queue = this.promptQueue): QueuedPrompt[] {
    return this.scheduler.publicQueue(queue);
  }

  private sessionActivity(sessionId: string): SessionActivityState {
    const runtime = this.runtimePool.get(sessionId);
    const primary = sessionId === this.activeSessionId && !runtime;
    const failed = primary ? this.primaryFailed : runtime?.failed === true || runtime?.rpc.isRunning?.() === false;
    const paused = primary ? this.queuePaused : runtime?.queuePaused === true;
    const running = primary
      ? this.running || Boolean(this.liveMessage)
      : runtime?.running === true || Boolean(runtime?.liveMessage);
    const dispatching = primary ? this.dispatching : runtime?.dispatching === true;
    const queued = primary ? this.promptQueue.length > 0 : (runtime?.promptQueue.length || 0) > 0;
    return {
      // `dispatching` also covers the post-settlement FIFO get_state barrier.
      // That barrier keeps restart/shutdown safe, but with no queued turn it is
      // not visible conversation work and must not leave a blue sidebar ring.
      execution: failed ? "failed" : paused ? "paused" : running ? "running" : queued ? (dispatching ? "dispatching" : "queued") : "idle",
      awaitingConfirmation: Boolean(this.pendingRequestForSession(sessionId)),
    };
  }

  /** One server-derived snapshot prevents Sidebar reconstruction from racing queue/RPC events. */
  private broadcastSessionActivity(sessionId = this.activeSessionId): void {
    if (!sessionId) return;
    const activity = this.sessionActivity(sessionId);
    this.broadcast({
      type: "pi_chat_session_status",
      piChatSessionId: sessionId,
      // Activity is derived from the same Pi turn as the event stream. Carry
      // its immutable lifecycle identity so a delayed "running" snapshot from
      // a completed turn cannot repaint the sidebar spinner after settlement.
      piChatRunEpoch: this.runEpoch,
      piChatRunGeneration: this.runGenerationsBySession.get(sessionId) || 0,
      activity,
      // Retained for existing streaming/cache consumers during the gradual migration.
      running: activity.execution === "running" || activity.execution === "dispatching",
    });
  }

  private broadcastQueue(sessionId = this.activeSessionId): void {
    const runtime = this.runtimePool.get(sessionId);
    if (runtime) this.scheduler.broadcastRuntimeQueue(runtime);
    else this.scheduler.broadcastPrimaryQueue();
  }

  private activeSessionIds(): string[] {
    const primaryActive = this.primaryReadReady();
    return [...(primaryActive ? [this.activeSessionId] : []), ...this.runtimePool.secondaryActiveIds()].filter((id): id is string => Boolean(id));
  }

  private controlState(sessionId: string, clientId = ""): { controlOwner?: string; controlledByThisWindow?: boolean } {
    return this.sessionControl.controlState(sessionId, clientId);
  }

  private setController(sessionId: string, clientId: string): void {
    this.sessionControl.setController(sessionId, clientId);
  }

  private assertNoForeignController(sessionId: string, clientId: string): void {
    this.sessionControl.assertNoForeignController(sessionId, clientId);
  }

  private requireSessionControl(sessionId: string, clientId: string): void {
    this.sessionControl.requireControl(sessionId, clientId);
  }

  private clientConnected(clientId: string, pageId = ""): void {
    if (pageId) this.connectedPageClients.set(pageId, clientId);
    this.cancelLastWindowShutdown();
    this.sessionControl.clientConnected(clientId);
  }

  private cancelLastWindowShutdown(): void {
    this.lastWindowIdleSince = null;
    if (this.lastWindowShutdownTimer) clearTimeout(this.lastWindowShutdownTimer);
    this.lastWindowShutdownTimer = null;
  }

  private openWindowCount(): number {
    return this.connectedPageClients.size;
  }

  private scheduleLastWindowShutdown(): void {
    if (this.closed || !this.options.applicationShutdown || this.openWindowCount() > 0 || this.lastWindowShutdownTimer || this.autoShutdownRunning) return;
    this.lastWindowShutdownTimer = setTimeout(() => {
      this.lastWindowShutdownTimer = null;
      void this.pollLastWindowShutdown();
    }, this.lastWindowShutdownPollMs);
    this.lastWindowShutdownTimer.unref();
  }

  private async pollLastWindowShutdown(): Promise<void> {
    if (this.closed || !this.options.applicationShutdown || this.openWindowCount() > 0) {
      this.cancelLastWindowShutdown();
      return;
    }
    if (this.applicationLifecycle !== "idle" || this.busyConversationCount() > 0 || this.runtimePool.transitioningCount > 0 || this.activeMutationRequests > 0) {
      this.lastWindowIdleSince = null;
      this.scheduleLastWindowShutdown();
      return;
    }
    const now = this.now();
    this.lastWindowIdleSince ??= now;
    const remaining = this.lastWindowShutdownGraceMs - (now - this.lastWindowIdleSince);
    if (remaining > 0) {
      this.lastWindowShutdownTimer = setTimeout(() => {
        this.lastWindowShutdownTimer = null;
        void this.pollLastWindowShutdown();
      }, Math.min(remaining, this.lastWindowShutdownPollMs));
      this.lastWindowShutdownTimer.unref();
      return;
    }

    this.autoShutdownRunning = true;
    let lifecycleStarted = false;
    try {
      this.beginLifecycle("shutting-down");
      lifecycleStarted = true;
      await this.verifyApplicationQuiescent("自动关闭 Pi Chat");
      if (this.openWindowCount() > 0) {
        this.endLifecycle("shutting-down");
        lifecycleStarted = false;
        this.cancelLastWindowShutdown();
        return;
      }
      this.broadcast({ type: "pi_chat_application_closing" });
      this.options.applicationShutdown("last-window-close");
    } catch (error) {
      if (lifecycleStarted) this.endLifecycle("shutting-down");
      this.lastWindowIdleSince = null;
      if (!(error instanceof ApplicationBusyError)) {
        console.error(`[Pi Chat] 自动关闭检查失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      this.autoShutdownRunning = false;
      if (this.applicationLifecycle === "idle" && this.openWindowCount() === 0) this.scheduleLastWindowShutdown();
    }
  }

  private releaseClient(clientId: string): string {
    for (const [pageId, owner] of this.connectedPageClients) {
      if (owner === clientId) this.connectedPageClients.delete(pageId);
    }
    return this.sessionControl.releaseClient(clientId);
  }

  private closeWindowClient(clientId: string, pageId: string): string {
    if (!pageId || this.connectedPageClients.get(pageId) !== clientId) return "";
    this.connectedPageClients.delete(pageId);
    const clientStillOpen = [...this.connectedPageClients.values()].some((owner) => owner === clientId);
    return clientStillOpen ? "" : this.sessionControl.closeWindow(clientId);
  }

  private async restSessionAfterWindowClose(sessionId: string): Promise<boolean> {
    if (!sessionId || this.sessionControl.isViewed(sessionId)) return false;
    if (sessionId === this.activeSessionId) {
      if (this.running || this.dispatching || this.promptQueue.length || this.pendingExtensionRequest) return false;
      const generation = await this.primaryOperationAdmission.closeAndDrain();
      if (generation === null) return false;
      if (this.sessionControl.isViewed(sessionId) || this.running || this.dispatching || this.promptQueue.length || this.pendingExtensionRequest) {
        this.primaryOperationAdmission.reopen(generation);
        return false;
      }
      try {
        await this.options.rpc.stop();
        this.primaryFailed = true;
        this.broadcast({ type: "pi_chat_active_session_changed", sessionId, activeSessionIds: this.activeSessionIds(), reclaimed: true, reason: "window-closed" });
        return true;
      } finally { this.primaryOperationAdmission.reopen(generation); }
    }
    const runtime = this.runtimePool.get(sessionId);
    if (!runtime || !this.runtimePool.canReclaim(runtime)) return false;
    return this.runtimePool.reclaim(sessionId, "idle");
  }

  private clientDisconnected(clientId: string): void {
    // An SSE connection is a re-connectable transport, not a service-lifetime
    // lease. Keep the page instance registered: only its matching pagehide
    // beacon may turn a network failure into an explicit close intent.
    this.sessionControl.clientDisconnected(clientId);
  }

  private markSessionViewed(clientId: string, sessionId: string): void {
    this.sessionControl.markViewed(clientId, sessionId);
  }

  private pendingRequestForSession(sessionId: string): ExtensionUiRequest | undefined {
    return sessionId === this.activeSessionId ? this.pendingExtensionRequest : this.runtimePool.get(sessionId)?.pendingExtensionRequest;
  }

  private trackPendingRequest(sessionId: string, request: ExtensionUiRequest): void {
    const previous = this.pendingExtensionTimers.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.pendingExtensionTimers.delete(sessionId);
      const current = this.pendingRequestForSession(sessionId);
      if (!current || current.id !== request.id) return;
      const runtime = this.runtimePool.get(sessionId);
      const targetRpc = runtime?.rpc || (sessionId === this.activeSessionId ? this.options.rpc : null);
      if (this.clearPendingRequest(sessionId, request.id) && targetRpc && targetRpc.isRunning?.() !== false) {
        try {
          targetRpc.sendRaw({ type: "extension_ui_response", id: request.id, cancelled: true });
          this.broadcast({ type: "pi_chat_extension_request_timeout", piChatSessionId: sessionId, id: request.id });
        } catch (error) {
          this.broadcast({ type: "pi_chat_process_error", piChatSessionId: sessionId, error: `权限确认超时清理失败：${error instanceof Error ? error.message : String(error)}` });
        }
      }
    }, this.gateRequestTimeoutMs);
    timer.unref();
    this.pendingExtensionTimers.set(sessionId, timer);
  }

  private clearPendingRequest(sessionId: string, requestId?: string): boolean {
    const current = this.pendingRequestForSession(sessionId);
    if (!current || (requestId && current.id !== requestId)) return false;
    const timer = this.pendingExtensionTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.pendingExtensionTimers.delete(sessionId);
    if (sessionId === this.activeSessionId) this.pendingExtensionRequest = undefined;
    else {
      const runtime = this.runtimePool.get(sessionId);
      if (runtime) {
        runtime.pendingExtensionRequest = undefined;
        runtime.extensionUiPending = false;
      }
    }
    this.broadcast({ type: "pi_chat_extension_request_resolved", piChatSessionId: sessionId, id: current.id });
    this.broadcastSessionActivity(sessionId);
    return true;
  }

  private runtimeEventState(sessionId: string, runtime?: SecondaryRuntime): RuntimeEventState {
    const primary = !runtime;
    return {
      runGeneration: this.runGenerationsBySession.get(sessionId) || 0,
      running: primary ? this.running : runtime.running,
      dispatching: primary ? this.dispatching : runtime.dispatching,
      failed: primary ? this.primaryFailed : runtime.failed === true,
      queuePaused: primary ? this.queuePaused : runtime.queuePaused,
      queueLength: primary ? this.promptQueue.length : runtime.promptQueue.length,
      liveMessage: primary ? this.liveMessage : runtime.liveMessage,
      toolStatus: primary ? this.toolStatus : runtime.toolStatus,
      pendingTerminalMessages: primary ? this.primaryPendingTerminalMessages : runtime.pendingTerminalMessages,
      pendingTerminalSessionId: primary ? this.primaryPendingTerminalSessionId : sessionId,
      ...(primary ? null : {
        extensionUiPending: runtime.extensionUiPending,
        preserveLiveMessageOnProcessError: true,
      }),
    };
  }

  private applyRuntimeEventTransition(sessionId: string, runtime: SecondaryRuntime | undefined, event: Record<string, unknown>) {
    const transition = transitionRuntimeEvent(sessionId, this.runtimeEventState(sessionId, runtime), event);
    const state = transition.state;
    const primary = !runtime;
    this.runGenerationsBySession.set(sessionId, state.runGeneration);
    if (primary) {
      this.running = state.running; this.dispatching = state.dispatching; this.primaryFailed = state.failed;
      this.queuePaused = state.queuePaused; this.liveMessage = state.liveMessage; this.toolStatus = state.toolStatus;
      this.primaryPendingTerminalMessages = state.pendingTerminalMessages;
      this.primaryPendingTerminalSessionId = state.pendingTerminalSessionId || "";
    } else {
      runtime.running = state.running; runtime.dispatching = state.dispatching; runtime.failed = state.failed;
      runtime.queuePaused = state.queuePaused; runtime.liveMessage = state.liveMessage; runtime.toolStatus = state.toolStatus;
      runtime.pendingTerminalMessages = state.pendingTerminalMessages;
      runtime.extensionUiPending = state.extensionUiPending === true;
    }
    for (const effect of transition.effects) {
      if (effect.type === "context-start") this.beginContextUsageRefreshTurn(sessionId);
      else if (effect.type === "context-pending") this.markContextUsagePendingRefresh(sessionId);
      else if (effect.type === "context-complete") this.completeContextUsageRefreshTurn(sessionId);
      else if (effect.type === "gate-mode") this.setGateMode(sessionId, effect.mode);
      else if (effect.type === "extension-request") {
        if (primary) this.pendingExtensionRequest = effect.request;
        else runtime.pendingExtensionRequest = effect.request;
        this.trackPendingRequest(sessionId, effect.request);
        this.broadcastSessionActivity(sessionId);
      } else if (effect.type === "clear-extension-request") this.clearPendingRequest(sessionId);
      else if (effect.type === "queue-changed") this.broadcastQueue(sessionId);
      // The legacy handlers emitted the RPC frame before `created`; keep that
      // externally visible order in the owner handler below.
      else if (effect.type === "session-status") this.broadcast({ type: "pi_chat_sessions_changed", action: "status", sessionId });
    }
    return transition;
  }

  private handleSecondaryEvent(runtime: SecondaryRuntime, event: Record<string, unknown>, source?: RpcEventSource): void {
    if (this.runtimePool.get(runtime.id) !== runtime) return;
    if (source && runtime.rpcGeneration && source.generation !== runtime.rpcGeneration) return;
    const type = String(event.type || "");
    this.runtimePool.touch(runtime);
    const transition = this.applyRuntimeEventTransition(runtime.id, runtime, event);
    this.broadcastRpcEvent(
      transition.broadcastEvent,
      runtime.id,
      transition.state.runGeneration,
    );
    if (transition.effects.some((effect) => effect.type === "session-created"))
      this.broadcast({ type: "pi_chat_sessions_changed", action: "created", sessionId: runtime.id });
    const settled = transition.effects.some((effect) => effect.type === "settled");
    if (settled) {
      void this.finalizePersistedDraftWhenVisible(runtime);
      setTimeout(() => this.warmRuntimeMessageSnapshot(runtime), 0);
      // Pi's RPC event schema has no run ID. Its JSONL stdout ordering is the
      // only usable ordering contract, so place a response barrier after the
      // terminal event before admitting another prompt. Frames preceding this
      // get_state response must be handled while this generation is still the
      // current one; a delayed old settled frame can therefore never clear the
      // following turn or dispatch its queue early.
      if (!runtime.dispatching) {
        runtime.dispatching = true;
        this.broadcastSessionActivity(runtime.id);
        void this.drainSecondaryAfterSettlement(runtime, runtime.rpcGeneration);
      }
    } else if (type === "agent_start") {
      this.broadcastSessionActivity(runtime.id);
    }
  }

  /**
   * Pi documents stdout events as a JSONL stream and emits agent_settled only
   * after the session-level run is done. The RPC event payload nevertheless
   * has no immutable run ID. A queued get_state response is therefore our
   * explicit FIFO drain barrier before this Session may begin another turn.
   */
  private async drainSecondaryAfterSettlement(runtime: SecondaryRuntime, sourceGeneration = runtime.rpcGeneration): Promise<void> {
    try {
      const state = asState(await runtime.rpc.send({ type: "get_state" }, 3_000));
      if (this.runtimePool.get(runtime.id) !== runtime || sourceGeneration !== runtime.rpcGeneration) return;
      runtime.lastState = state;
      runtime.running = state.isStreaming;
      runtime.dispatching = false;
      this.broadcastSessionActivity(runtime.id);
      if (!runtime.running) {
        void this.dispatchRuntimeNext(runtime);
        void this.runtimePool.sweep();
      }
    } catch (error) {
      if (this.runtimePool.get(runtime.id) !== runtime || sourceGeneration !== runtime.rpcGeneration) return;
      runtime.dispatching = false;
      runtime.failed = true;
      runtime.queuePaused = runtime.promptQueue.length > 0;
      this.broadcastQueue(runtime.id);
      this.broadcast({ type: "pi_chat_process_error", piChatSessionId: runtime.id, error: `Pi 结算同步失败：${error instanceof Error ? error.message : String(error)}` });
      this.broadcastSessionActivity(runtime.id);
    }
  }

  private async drainPrimaryAfterSettlement(sessionId: string, sourceGeneration = this.primaryRpcGeneration): Promise<void> {
    try {
      const state = asState(await this.options.rpc.send({ type: "get_state" }, 3_000));
      if (sessionId !== this.primaryBoundSessionId || sourceGeneration !== this.primaryRpcGeneration) return;
      this.lastPrimaryState = state;
      this.running = state.isStreaming;
      this.dispatching = false;
      this.broadcastSessionActivity(sessionId);
      if (!this.running) void this.dispatchNext();
    } catch (error) {
      if (sessionId !== this.primaryBoundSessionId || sourceGeneration !== this.primaryRpcGeneration) return;
      this.dispatching = false;
      this.primaryFailed = true;
      this.queuePaused = this.promptQueue.length > 0;
      this.broadcastQueue();
      this.broadcast({ type: "pi_chat_process_error", piChatSessionId: sessionId, error: `Pi 结算同步失败：${error instanceof Error ? error.message : String(error)}` });
      this.broadcastSessionActivity(sessionId);
    }
  }

  private async ensureRuntime(id: string): Promise<SecondaryRuntime> {
    const runtime = await this.runtimePool.ensure(id);
    if (!runtime.summarySnapshot) runtime.summarySnapshot = this.options.sessions.summaryForId?.(id) || undefined;
    const desiredGateMode = this.gateModesBySession.get(id);
    if (desiredGateMode && runtime.gateMode !== desiredGateMode) {
      await runtime.rpc.send({ type: "prompt", message: `/gate ${desiredGateMode}` }, PROMPT_PREPARE_TIMEOUT_MS);
      runtime.gateMode = desiredGateMode;
    }
    if (!runtime.messageSnapshot) this.warmRuntimeMessageSnapshot(runtime);
    return runtime;
  }

  private async recoverRuntime(runtime: SecondaryRuntime): Promise<void> {
    await this.runtimePool.recover(runtime);
    this.broadcastSessionActivity(runtime.id);
  }

  private acquireDraftRuntime(clientId = "", cwd = this.currentCwd): Promise<import("./runtime-pool.js").DraftRuntimeLease> {
    return this.runtimePool.acquireDraft(clientId, cwd);
  }

  /** A new draft may warm beside Primary startup, but no mutation is permitted
   * until the globally-owned compatibility probe succeeds. */
  private async waitForNewDraftPrimaryCompatibility(): Promise<void> {
    if (this.options.primaryRuntime) await this.options.primaryRuntime.waitUntilReady();
  }

  private async finalizePersistedDraft(runtime: SecondaryRuntime): Promise<boolean> {
    if (!await this.runtimePool.commitDraftIfPersisted(runtime)) return false;
    const retry = this.draftPersistenceRetryTimers.get(runtime);
    if (retry) {
      clearTimeout(retry);
      this.draftPersistenceRetryTimers.delete(runtime);
    }
    this.broadcast({ type: "pi_chat_sessions_changed", action: "created", sessionId: runtime.id });
    return true;
  }

  /**
   * `agent_settled` may arrive before the writer's just-created JSONL user row
   * is readable. A prompted draft otherwise retains its intentionally temporary
   * "新对话" summary forever. Retry only while this exact Runtime stays mapped;
   * the bounded timer never creates a second title authority.
   */
  private async finalizePersistedDraftWhenVisible(runtime: SecondaryRuntime, attempt = 0): Promise<void> {
    if (this.closed || this.runtimePool.get(runtime.id) !== runtime || !runtime.prompted || !runtime.draftSession) return;
    if (await this.finalizePersistedDraft(runtime)) return;
    const delay = DRAFT_PERSISTENCE_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    const existing = this.draftPersistenceRetryTimers.get(runtime);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      if (this.draftPersistenceRetryTimers.get(runtime) === timer)
        this.draftPersistenceRetryTimers.delete(runtime);
      void this.finalizePersistedDraftWhenVisible(runtime, attempt + 1);
    }, delay);
    timer.unref();
    this.draftPersistenceRetryTimers.set(runtime, timer);
  }

  /** A readiness-only capability projection: never wait for history, stats, or command discovery. */
  private runtimeReady(runtime: SecondaryRuntime): SessionRuntimeReadyData {
    return {
      sessionId: runtime.id,
      state: { ...(runtime.lastState || { model: null, isStreaming: runtime.running }), isStreaming: runtime.running },
      gateMode: runtime.gateMode,
    };
  }

  /**
   * Empty New drafts have no messages and no real session stats. Avoid a full
   * sessionView round-trip (get_messages / stats / commands) on every New click.
   */
  private async draftSessionView(runtime: SecondaryRuntime, clientId = ""): Promise<SessionViewData> {
    this.runtimePool.touch(runtime);
    const draft = runtime.draftSession;
    if (!draft) throw new Error("新会话草稿状态丢失");
    let model: ModelInfo | null = this.lastPrimaryState.model;
    let thinkingLevel = this.lastPrimaryState.thinkingLevel;
    try {
      const state = asState(await runtime.rpc.send({ type: "get_state" }, 3_000));
      model = state.model;
      thinkingLevel = state.thinkingLevel;
    } catch {
      // Reused draft may still answer; a slow get_state must not block New UX.
    }
    return {
      session: { ...draft, ...this.controlState(runtime.id, clientId) },
      state: { model, thinkingLevel, isStreaming: false, sessionFile: runtime.sessionPath, sessionId: draft.sessionId, messageCount: 0 },
      messages: [],
      messageTotal: 0,
      turnTotal: 0,
      visibleTurnCount: 0,
      messagesTruncated: false,
      isActive: true,
      runtimeStatus: "active",
      isStreaming: false,
      queue: [],
      queuePaused: false,
      toolStatus: "",
      gateMode: runtime.gateMode,
      pendingExtensionRequest: this.pendingRequestForSession(runtime.id),
      ...this.controlState(runtime.id, clientId),
    };
  }

  private handleRpcEvent(event: Record<string, unknown>, source?: RpcEventSource): void {
    const sourceGeneration = source?.generation || this.options.rpc.currentGeneration?.() || 0;
    if (!this.primaryBoundSessionId || (sourceGeneration && sourceGeneration !== this.primaryRpcGeneration)) return;
    const sessionId = this.primaryBoundSessionId;
    const type = String(event.type || "");
    const transition = this.applyRuntimeEventTransition(sessionId, undefined, event);
    this.broadcastRpcEvent(transition.broadcastEvent, sessionId, transition.state.runGeneration);
    if (transition.effects.some((effect) => effect.type === "session-created"))
      this.broadcast({ type: "pi_chat_sessions_changed", action: "created", sessionId });
    const settled = transition.effects.some((effect) => effect.type === "settled");
    if (settled) {
      setTimeout(() => this.warmPrimaryMessageSnapshot(), 0);
      if (!this.dispatching) {
        this.dispatching = true;
        this.broadcastSessionActivity(sessionId);
        void this.drainPrimaryAfterSettlement(sessionId, sourceGeneration);
      }
    } else if (type === "agent_start") this.broadcastSessionActivity(sessionId);
  }

  private primaryReadiness(): PrimaryRuntimeReadiness {
    return this.options.primaryRuntime?.snapshot() || { status: "ready", generation: 0 };
  }

  private primaryReadReady(): boolean {
    return this.primaryReadiness().status === "ready" && !this.primaryFailed && this.options.rpc.isRunning?.() !== false;
  }

  private async ensurePrimaryRuntime(): Promise<void> {
    if (this.options.primaryRuntime) await this.options.primaryRuntime.waitUntilReady();
    if (!this.primaryFailed && this.options.rpc.isRunning?.() !== false) return;
    if (this.primaryRecovery) return this.primaryRecovery;
    const desiredGateMode = this.primaryGateMode;
    const recovery = (async () => {
      try {
        // A cold service may still be completing its initial asynchronous
        // Primary spawn. If it won the race, consume that worker rather than
        // stopping/restarting it a second time.
        if (this.primaryFailed || this.options.rpc.isRunning?.() === false) {
          // A post-ready crash recovers only through the controller, which
          // restarts and repeats compatibility probing before PiChatApp sends.
          if (this.options.primaryRuntime) await this.options.primaryRuntime.recover(this.activeSessionPath, this.primaryRuntimeCwd);
          else await this.options.rpc.restart(this.activeSessionPath, this.primaryRuntimeCwd);
        }
        const state = asState(await this.options.rpc.send({ type: "get_state" }));
        this.lastPrimaryState = state;
        this.bindPrimaryIdentity(state);
        this.running = state.isStreaming;
        this.primaryFailed = false;
        this.toolStatus = "";
        if (desiredGateMode !== "strict") {
          await this.options.rpc.send({ type: "prompt", message: `/gate ${desiredGateMode}` }, PROMPT_PREPARE_TIMEOUT_MS);
        }
        this.primaryGateMode = desiredGateMode;
        this.broadcast({ type: "pi_chat_process_recovered", piChatSessionId: this.activeSessionId });
        this.broadcastSessionActivity(this.activeSessionId);
      } catch (error) {
        this.primaryFailed = true;
        if (error instanceof PrimaryRuntimeUnavailableError) throw error;
        throw new Error(`主 Pi RPC 恢复失败：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    this.primaryRecovery = recovery;
    try {
      await recovery;
    } finally {
      if (this.primaryRecovery === recovery) this.primaryRecovery = null;
    }
  }

  /** Bind event attribution only to the child generation that produced get_state. */
  private bindPrimaryIdentity(state: PiState): void {
    const sessionId = state.sessionFile ? idForPath(state.sessionFile) : state.sessionId || "";
    if (!sessionId) return;
    this.activeSessionId = sessionId;
    this.activeSessionPath = state.sessionFile || this.activeSessionPath;
    this.primaryBoundSessionId = sessionId;
    this.primaryRpcGeneration = this.options.rpc.currentGeneration?.() || 0;
  }

  /** Bind Primary's Session only after the readiness gate passed. */
  private async ensurePrimaryIdentity(): Promise<void> {
    if (this.activeSessionId) return;
    await this.ensurePrimaryRuntime();
    const state = asState(await this.options.rpc.send({ type: "get_state" }));
    this.lastPrimaryState = state;
    this.running = state.isStreaming;
    this.bindPrimaryIdentity(state);
  }

  private async extensionCommand(message: string, rpc = this.options.rpc): Promise<SlashCommand | null> {
    const match = /^\/([^\s/]+)/.exec(message);
    if (!match) return null;
    const response = await rpc.send({ type: "get_commands" });
    const command = asCommands(response).find((item) => item.name === match[1]);
    return command?.source === "extension" ? command : null;
  }

  private async applyPendingTurnSettings(rpc: PiRpcClient, pending: PendingTurnSettings): Promise<void> {
    if (pending.model) await rpc.send({ type: "set_model", provider: pending.model.provider, modelId: pending.model.modelId });
    if (pending.thinkingLevel) await rpc.send({ type: "set_thinking_level", level: pending.thinkingLevel });
    delete pending.model;
    delete pending.thinkingLevel;
  }

  /**
   * Busy Pi workers deliberately skip get_state so navigation and reconnect do
   * not queue behind a long turn. Keep that display snapshot aligned with an
   * accepted setting selection; otherwise a bootstrap/view would overwrite the
   * browser's optimistic Terra/high selection with the prior Sol/max snapshot.
   */
  private rememberPrimaryDisplaySettings(patch: Partial<Pick<PiState, "model" | "thinkingLevel">>): void {
    this.lastPrimaryState = { ...this.lastPrimaryState, ...patch, isStreaming: this.running || this.lastPrimaryState.isStreaming };
  }

  private rememberRuntimeDisplaySettings(runtime: SecondaryRuntime, patch: Partial<Pick<PiState, "model" | "thinkingLevel">>): void {
    runtime.lastState = {
      ...(runtime.lastState || { model: null, isStreaming: runtime.running }),
      ...patch,
      isStreaming: runtime.running || runtime.lastState?.isStreaming || false,
    };
  }

  private currentGateMode(sessionId: string): GateMode {
    if (!sessionId || sessionId === this.activeSessionId) return this.primaryGateMode;
    return this.runtimePool.get(sessionId)?.gateMode
      || this.gateModesBySession.get(sessionId)
      || "strict";
  }

  private async syncGateMode(rpc: PiRpcClient, sessionId: string, mode?: GateMode): Promise<void> {
    // Runtime metadata is authoritative for a live process. Replaying an
    // identical /gate command before every prompt adds a needless serialized
    // RPC round trip and can itself trigger extension work.
    if (!mode || mode === this.currentGateMode(sessionId)) return;
    await rpc.send({ type: "prompt", message: `/gate ${mode}` }, PROMPT_PREPARE_TIMEOUT_MS);
    this.setGateMode(sessionId, mode);
  }

  private nextUserPromptAt(): number {
    this.lastPromptOrderAt = Math.max(this.now(), this.lastPromptOrderAt + 1);
    return this.lastPromptOrderAt;
  }

  private setGateMode(sessionId: string, mode: GateMode): void {
    if (!sessionId) {
      this.primaryGateMode = mode;
      return;
    }
    if (sessionId === this.activeSessionId) this.primaryGateMode = mode;
    else {
      const runtime = this.runtimePool.get(sessionId);
      if (runtime) runtime.gateMode = mode;
    }
    this.gateModesBySession.set(sessionId, mode);
    this.broadcast({ type: "pi_chat_gate_mode_changed", mode, piChatSessionId: sessionId });
  }

  private recordUserPrompt(sessionId: string, promptAt = this.now()): void {
    if (!sessionId) return;
    // A queued older prompt may dispatch after a newer one was already accepted.
    // Never let that delayed dispatch move the Session backwards in the sidebar.
    const current = this.lastUserPromptAtBySession.get(sessionId) || 0;
    const next = Math.max(current, promptAt);
    this.lastUserPromptAtBySession.set(sessionId, next);
    const runtime = this.runtimePool.get(sessionId);
    if (runtime) runtime.lastUserPromptAt = Math.max(runtime.lastUserPromptAt || 0, next);
  }

  private noteUserPrompt(sessionId: string, promptAt = this.now()): void {
    this.recordUserPrompt(sessionId, promptAt);
    // The sidebar needs to move at admission/queue time, never when assistant
    // output later touches the JSONL.
    this.broadcast({ type: "pi_chat_sessions_changed", action: "prompted", sessionId });
  }

  private async sendPrompt(message: string, images: PromptImage[], promptAt = this.now(), gateMode?: GateMode): Promise<void> {
    await this.scheduler.sendPrimaryPrompt(message, images, promptAt, gateMode);
  }

  private warmRuntimeMessageSnapshot(runtime: SecondaryRuntime): void {
    if (typeof this.options.sessions.messagesForId !== "function") return;
    void this.options.sessions.messagesForId(runtime.id).then((messages) => {
      if (messages && this.runtimePool.get(runtime.id) === runtime) {
        const reconciled = reconcilePersistedHistory(messages, runtime.pendingTerminalMessages);
        runtime.messageSnapshot = messages;
        runtime.pendingTerminalMessages = reconciled.pending;
        runtime.summarySnapshot = this.options.sessions.summaryForId?.(runtime.id) || runtime.summarySnapshot;
      }
    }).catch(() => undefined);
  }

  private warmPrimaryMessageSnapshot(): void {
    const path = this.activeSessionPath;
    const sessionId = this.activeSessionId;
    if (!path || !sessionId) return;
    void readSessionMessages(path).then((messages) => {
      if (this.activeSessionPath === path && this.activeSessionId === sessionId) {
        const terminalTail = this.primaryPendingTerminalSessionId === sessionId ? this.primaryPendingTerminalMessages : [];
        const reconciled = reconcilePersistedHistory(messages, terminalTail);
        this.lastPrimaryMessages = messages;
        this.primaryPendingTerminalMessages = reconciled.pending;
        this.lastPrimaryMessagesSessionId = sessionId;
      }
    }).catch(() => undefined);
  }

  private async dispatchRuntimeNext(runtime: SecondaryRuntime): Promise<void> {
    await this.scheduler.dispatchRuntimeNext(runtime);
  }

  private async dispatchNext(): Promise<void> {
    await this.scheduler.dispatchPrimaryNext();
  }

  private sessionSummaries(sessions: BootstrapData["sessions"], clientId = ""): BootstrapData["sessions"] {
    // Empty drafts stay out of the sidebar. Prompted drafts that SessionIndex has
    // not yet scanned must still appear as soon as the first send is accepted.
    const listed = sessions.map((session) => {
      const runtime = this.runtimePool.get(session.id);
      const lastUserPromptAt = this.lastUserPromptAtBySession.get(session.id)
        ?? runtime?.lastUserPromptAt
        ?? session.lastUserPromptAt;
      return {
      ...session,
      ...(runtime?.cwd ? { cwd: runtime.cwd } : null),
      ...(lastUserPromptAt !== undefined ? { lastUserPromptAt } : null),
      writable: this.activeSessionIds().includes(session.id),
      running: (this.running && session.id === this.activeSessionId) || runtime?.running === true,
      queued: session.id === this.activeSessionId ? this.promptQueue.length > 0 : (runtime?.promptQueue.length || 0) > 0,
      pendingConfirmation: Boolean(this.pendingRequestForSession(session.id)),
      activity: this.sessionActivity(session.id),
      ...this.controlState(session.id, clientId),
    };
    });
    const known = new Set(listed.map((session) => session.id));
    for (const runtime of this.runtimePool.runtimes.values()) {
      if (known.has(runtime.id)) continue;
      if (!runtime.prompted && !runtime.running && !runtime.dispatching && !runtime.liveMessage) continue;
      const base = runtime.draftSession || {
        id: runtime.id,
        sessionId: runtime.id,
        name: "新会话",
        preview: "新会话",
        cwd: runtime.cwd,
        updatedAt: runtime.lastUsedAt,
        messageCount: 1,
        active: true,
      };
      listed.push({
        ...base,
        messageCount: Math.max(base.messageCount || 0, 1),
        updatedAt: Math.max(base.updatedAt || 0, runtime.lastUsedAt),
        lastUserPromptAt: this.lastUserPromptAtBySession.get(runtime.id) ?? runtime.lastUserPromptAt ?? base.lastUserPromptAt ?? base.updatedAt,
        active: true,
        writable: true,
        running: runtime.running || runtime.dispatching || Boolean(runtime.liveMessage),
        queued: runtime.promptQueue.length > 0,
        pendingConfirmation: Boolean(this.pendingRequestForSession(runtime.id)),
        activity: this.sessionActivity(runtime.id),
        ...this.controlState(runtime.id, clientId),
      });
      known.add(runtime.id);
    }
    return listed.sort(compareSessionsByLastUserPrompt);
  }

  private sidebarSessions(sessions: SessionSummary[], clientId: string, all = false): { sessions: SessionSummary[]; total: number; directories: SessionDirectorySummary[] } {
    const enriched = this.sessionSummaries(sessions, clientId);
    const groups = new Map<string, SessionSummary[]>();
    for (const session of enriched) {
      const key = session.cwd || "";
      const group = groups.get(key);
      if (group) group.push(session);
      else groups.set(key, [session]);
    }
    const directories = [...groups.entries()]
      .map(([cwd, group]) => ({ cwd, count: group.length, lastUserPromptAt: group[0]?.lastUserPromptAt ?? group[0]?.updatedAt ?? 0 }))
      .sort((left, right) => right.lastUserPromptAt - left.lastUserPromptAt);
    if (all) return { sessions: enriched, total: enriched.length, directories };
    const cwdKey = (cwd: string) => resolve(cwd || ".").toLowerCase();
    const current = [...groups.entries()].find(([cwd]) => cwdKey(cwd) === cwdKey(this.currentCwd))?.[1] || [];
    const selected = current.slice(0, DEFAULT_DIRECTORY_SESSION_LIST_SIZE);
    for (const directory of directories) {
      if (selected.length >= DEFAULT_SESSION_LIST_SIZE) break;
      if (cwdKey(directory.cwd) === cwdKey(this.currentCwd)) continue;
      selected.push(...(groups.get(directory.cwd) || []).slice(0, Math.min(DEFAULT_DIRECTORY_SESSION_LIST_SIZE, DEFAULT_SESSION_LIST_SIZE - selected.length)));
    }
    return { sessions: selected, total: enriched.length, directories };
  }

  private cachedSessionList(activePath?: string): Promise<SessionSummary[]> {
    const cached = (this.options.sessions as SessionIndex & { listCached?: (activePath?: string, cwd?: string) => Promise<SessionSummary[]> }).listCached;
    return cached ? cached.call(this.options.sessions, activePath) : this.options.sessions.list(activePath);
  }

  private async restartPrimaryRuntime(sessionFile?: string, cwd = this.primaryRuntimeCwd): Promise<void> {
    if (cwd !== this.primaryRuntimeCwd) throw new Error("Primary Runtime 工作目录不可在原进程上重绑定");
    const desiredGateMode = sessionFile ? this.gateModesBySession.get(this.activeSessionId) || this.primaryGateMode : "strict";
    if (this.options.primaryRuntime) await this.options.primaryRuntime.recover(sessionFile, cwd);
    else await this.options.rpc.restart(sessionFile, cwd);
    if (desiredGateMode !== "strict") {
      await this.options.rpc.send({ type: "prompt", message: `/gate ${desiredGateMode}` }, PROMPT_PREPARE_TIMEOUT_MS);
    }
    this.primaryGateMode = desiredGateMode;
  }

  private async reloadRpc(knownState?: PiState): Promise<void> {
    this.assertApplicationQuiescent("修改资源配置");
    const state = knownState || asState(await this.options.rpc.send({ type: "get_state" }));
    if (state.isStreaming) throw new Error("请先停止所有并行生成，再修改资源配置");
    await this.runtimePool.stopAll();
    await this.restartPrimaryRuntime(state.sessionFile);
    this.broadcast({ type: "pi_chat_reloaded" });  }

  private async applyResourceFileTransaction<T>(snapshots: FileSnapshot[], mutation: () => Promise<T>): Promise<T> {
    const state = asState(await this.options.rpc.send({ type: "get_state" }));
    if (state.isStreaming) throw new Error("请先停止所有并行生成，再修改资源配置");
    let changed = false;
    try {
      const result = await mutation();
      changed = true;
      await this.reloadRpc(state);
      return result;
    } catch (error) {
      if (!changed) throw error;
      const original = error instanceof Error ? error.message : String(error);
      try {
        await restoreSnapshots(snapshots);
        await this.restartPrimaryRuntime(state.sessionFile);
        this.broadcast({ type: "pi_chat_reloaded" });
      } catch (rollbackError) {
        throw new Error(`资源修改失败，自动恢复也失败：${original}；恢复错误：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      throw new Error(`资源修改失败，原配置已自动恢复：${original}`);
    }
  }

  /** Changes only the persisted default/index context for future drafts. Existing
   * Session paths and dedicated Runtime cwd values are immutable. */
  private async changeWorkspace(selected: string): Promise<{ workspaceName: string; data: BootstrapData }> {
    const selectedCwd = resolve(selected);
    if (!(await stat(selectedCwd)).isDirectory()) throw new Error("所选工作目录不存在或不是文件夹");
    await saveWorkspace(selectedCwd);
    if (selectedCwd.toLowerCase() !== this.currentCwd.toLowerCase()) {
      this.currentCwd = selectedCwd;
      this.broadcast({ type: "pi_chat_workspace_changed", cwd: selectedCwd });
    }
    return { workspaceName: basename(selectedCwd), data: await this.bootstrap() };
  }

  private async renameSession(id: string, name: string): Promise<BootstrapData> {
    await this.options.sessions.list(undefined, this.currentCwd);
    const isPrimary = id === this.activeSessionId;
    const draft = this.runtimePool.get(id)?.draftSession;
    if (draft) throw new Error("空白新对话会在发送第一条消息后保存，届时才能重命名");
    const path = this.options.sessions.pathForId(id);
    if (!isPrimary && !path) throw new Error("会话不存在");
    const existingRuntime = isPrimary ? null : this.runtimePool.get(id) || null;
    const wasOpen = isPrimary || Boolean(existingRuntime);
    const runtime = isPrimary ? null : existingRuntime || await this.ensureRuntime(id);
    const releaseRuntimeOperation = runtime
      ? this.runtimePool.acquireOperation(runtime)
      : this.primaryOperationAdmission.acquire().release;
    try {
      await (runtime?.rpc || this.options.rpc).send({ type: "set_session_name", name });
    } finally { releaseRuntimeOperation(); }
    // A Runtime created only to rename a cold Session is not retained. Its
    // dedicated process is safely reclaimed after its mutation lease releases.
    if (!wasOpen && runtime && !runtime.running) {
      await this.runtimePool.reclaim(id, "idle");
    }
    await this.options.sessions.list(this.activeSessionPath, this.currentCwd);
    const renamedSummary = this.options.sessions.summaryForId?.(id) || undefined;
    if (id === this.activeSessionId) this.primarySummarySnapshot = renamedSummary || this.primarySummarySnapshot;
    else if (existingRuntime) existingRuntime.summarySnapshot = renamedSummary || existingRuntime.summarySnapshot;
    this.broadcast({ type: "pi_chat_sessions_changed", action: "renamed", sessionId: id });
    return this.bootstrap();
  }

  private async deleteSession(id: string): Promise<BootstrapData> {
    await this.options.sessions.list(undefined, this.currentCwd);
    const isPrimary = id === this.activeSessionId;
    const state = isPrimary ? asState(await this.options.rpc.send({ type: "get_state" }, 12_000)) : null;
    // Prefer the live worker path. A brand-new Session may still be absent from
    // SessionIndex when the user deletes it from the sidebar or current view.
    const runtime = this.runtimePool.get(id);
    const path = isPrimary
      ? state?.sessionFile
      : runtime?.sessionPath || runtime?.draftSessionPath || this.options.sessions.pathForId(id);
    if (!isPrimary && !path && !runtime) throw new Error("会话不存在");
    if (isPrimary) {
      if (this.running || this.promptQueue.length || this.pendingExtensionRequest) throw new Error("请先停止当前生成、处理权限确认并清空队列，再删除此会话");
      const result = rpcData<{ cancelled: boolean }>(await this.options.rpc.send({ type: "new_session" }, 30_000));
      if (result.cancelled) throw new Error("扩展取消了新建会话，无法删除当前会话");
    } else if (runtime) {
      // releaseForDeletion owns admission close-and-drain; do not hold a normal
      // operation lease here or it would correctly block its own stop.
      if (runtime.running || runtime.promptQueue.length || runtime.extensionUiPending) throw new Error("请先停止该会话的生成、处理权限确认并清空队列，再删除对话");
      const released = await this.runtimePool.releaseForDeletion(id);
      if (!released) throw new Error("该会话正在执行其他操作，请稍后重试删除");
    }
    if (path && existsSync(path)) await unlink(path);
    this.lastUserPromptAtBySession.delete(id);
    this.gateModesBySession.delete(id);
    this.sessionControl.clearSession(id);
    await this.options.sessions.list(this.activeSessionPath, this.currentCwd);
    this.broadcast({ type: "pi_chat_sessions_changed", action: "deleted", sessionId: id });
    return this.bootstrap();
  }

  private async coldSessionView(id: string, session: SessionSummary, turnLimit: number, clientId: string): Promise<SessionViewData | null> {
    const snapshot = await this.options.sessions.snapshotForId?.(id);
    const messages = snapshot?.messages ?? await this.options.sessions.messagesForId(id);
    if (!messages) return null;
    const windowed = messageWindow(messages, turnLimit);
    const settings = snapshot?.settings || {};
    return {
      session: { ...session, active: false, writable: false, running: false, queued: false },
      // Never borrow Primary's active settings for history. Pi persists these
      // change events in each JSONL, so reading them keeps cold views truthful.
      state: {
        model: this.modelFromSessionSettings(settings),
        thinkingLevel: settings.thinkingLevel,
        isStreaming: false,
        isCompacting: false,
        sessionFile: undefined,
        sessionId: session.sessionId,
        sessionName: session.name,
        messageCount: session.messageCount,
      },
      messages: windowed.messages,
      messageTotal: windowed.total,
      turnTotal: windowed.turns,
      visibleTurnCount: windowed.visibleTurns,
      messagesTruncated: windowed.truncated,
      isActive: false,
      runtimeStatus: "view-only",
      isStreaming: false,
      // The target JSONL snapshot already includes usage. Cold first paint must
      // never wait on another index read or resource/settings disk probe.
      stats: snapshot?.usage ? this.offlineStatsFromUsage(id, snapshot.usage) : undefined,
      // Gate is a fixed Pi Chat system control. Startup self-heals its adapter;
      // a cold history read does not need to rediscover that resource on disk.
      gateAvailable: true,
      commands: [],
      viewSource: "cold-jsonl",
      pendingExtensionRequest: this.pendingRequestForSession(id),
      ...this.controlState(id, clientId),
    };
  }

  private hotMemoryView(id: string, turnLimit: number, clientId: string): SessionViewData | null {
    const runtime = id === this.activeSessionId ? null : this.runtimePool.get(id);
    const primary = id === this.activeSessionId && this.primaryReadReady();
    if (!runtime && !primary) return null;
    if (runtime) this.runtimePool.touch(runtime);
    const summary = primary
      ? this.primarySummarySnapshot || { id, sessionId: this.lastPrimaryState.sessionId || id, name: this.lastPrimaryState.sessionName || "当前对话", preview: "", cwd: this.currentCwd, updatedAt: this.now(), messageCount: this.lastPrimaryState.messageCount || 0, active: true }
      : runtime!.summarySnapshot || runtime!.draftSession;
    if (!summary) return null;
    const persisted = primary ? this.lastPrimaryMessagesSessionId === id ? this.lastPrimaryMessages : undefined : runtime!.messageSnapshot;
    const tail = primary ? this.primaryPendingTerminalSessionId === id ? this.primaryPendingTerminalMessages : [] : runtime!.pendingTerminalMessages;
    const messages = reconcilePersistedHistory(persisted || [], tail).messages;
    const windowed = messageWindow(messages, turnLimit);
    const state = primary ? this.lastPrimaryState : runtime!.lastState || { model: null, isStreaming: runtime!.running };
    const streaming = primary ? this.running || Boolean(this.liveMessage) : runtime!.running || runtime!.dispatching || Boolean(runtime!.liveMessage);
    return {
      session: { ...summary, active: true, writable: true, running: streaming, queued: primary ? this.promptQueue.length > 0 : runtime!.promptQueue.length > 0 },
      state: { ...state, isStreaming: streaming },
      messages: windowed.messages,
      messageTotal: windowed.total,
      turnTotal: windowed.turns,
      visibleTurnCount: windowed.visibleTurns,
      messagesTruncated: windowed.truncated,
      isActive: true,
      runtimeStatus: "active",
      isStreaming: streaming,
      liveMessage: primary ? this.liveMessage : runtime!.liveMessage,
      toolStatus: primary ? this.toolStatus : runtime!.toolStatus,
      stats: primary ? this.lastPrimaryStats?.sessionId === id ? this.lastPrimaryStats.value : undefined : runtime!.lastStats,
      queue: primary ? this.publicQueue() : this.publicQueue(runtime!.promptQueue),
      queuePaused: primary ? this.queuePaused : runtime!.queuePaused,
      commands: primary ? this.lastPrimaryCommands.length ? [...BUILTIN_COMMANDS, ...this.lastPrimaryCommands] : undefined : runtime!.commands?.length ? [...BUILTIN_COMMANDS, ...runtime!.commands] : undefined,
      gateMode: primary ? this.primaryGateMode : runtime!.gateMode,
      pendingExtensionRequest: this.pendingRequestForSession(id),
      historyPending: !persisted,
      reconcilePending: !persisted || tail.length > 0 || (primary
        ? this.lastPrimaryStats?.sessionId !== id
        : !runtime!.statsKnown || !runtime!.commandsKnown),
      viewSource: "hot-memory",
      ...this.controlState(id, clientId),
    };
  }

  private async sessionView(id: string, turnLimit = RECENT_TURN_WINDOW_SIZE, clientId = ""): Promise<SessionViewData | null> {
    const knownRuntime = this.runtimePool.get(id);
    const targetRuntimeBusy = id === this.activeSessionId
      ? this.running || Boolean(this.liveMessage)
      : Boolean(knownRuntime?.running || knownRuntime?.dispatching || knownRuntime?.liveMessage);
    // Cold history is a pure JSONL read. Avoid waking or querying the Primary RPC
    // and avoid rescanning every Session when the index already knows this ID.
    if (id !== this.activeSessionId && !knownRuntime) {
      const index = this.options.sessions as SessionIndex & { cachedSummaryForId?: (sessionId: string) => Promise<SessionSummary | null> };
      const knownSession = this.options.sessions.summaryForId?.(id)
        || await index.cachedSummaryForId?.(id);
      if (knownSession) return this.coldSessionView(id, knownSession, turnLimit, clientId);
    }
    // Browser /api/sessions/:id/view has a 65s client budget. Several default 30s
    // Pi RPC calls used to stack past that during compaction or long tool turns,
    // producing a late red "请求超时（65 秒）" even after compaction finished.
    const SHORT_RPC_MS = 4_000;
    const MESSAGES_RPC_MS = 6_000;
    const primaryAvailable = this.applicationLifecycle === "idle" && this.primaryReadReady();
    let state: PiState = this.lastPrimaryState;
    if (primaryAvailable && !(id !== this.activeSessionId && targetRuntimeBusy)) {
      // Skip get_state only when we already know which Primary Session is live.
      // A view that arrives before bootstrap (or after a restart) still needs one
      // short probe so activeSessionId/path are bound; otherwise we mis-route to cold.
      const canSkipStateProbe = (this.running || (id === this.activeSessionId && Boolean(this.liveMessage))) && Boolean(this.activeSessionId) && Boolean(this.activeSessionPath);
      if (canSkipStateProbe) {
        state = { ...this.lastPrimaryState, isStreaming: true };
      } else {
        try {
          state = asState(await this.options.rpc.send({ type: "get_state" }, SHORT_RPC_MS));
          this.lastPrimaryState = state;
          this.running = state.isStreaming;
          this.bindPrimaryIdentity(state);
        } catch {
          state = this.running
            ? { ...this.lastPrimaryState, isStreaming: true }
            : this.lastPrimaryState;
        }
      }
    } else {
      state = { model: null, isStreaming: false };
    }
    const secondaryRuntime = knownRuntime;
    const knownBusy = id === this.activeSessionId
      ? this.running || Boolean(this.liveMessage)
      : Boolean(secondaryRuntime?.running || secondaryRuntime?.dispatching || secondaryRuntime?.liveMessage);
    // A busy Runtime already has a known Session path/index entry. Do not rescan
    // every JSONL merely to switch back to it: streaming writes continuously
    // invalidate mtime and made this navigation visibly stall.
    const indexedSession = knownBusy ? this.options.sessions.summaryForId?.(id) || secondaryRuntime?.draftSession : null;
    const sessions = indexedSession
      ? this.sessionSummaries([indexedSession], clientId)
      : this.sessionSummaries(await this.options.sessions.list(this.activeSessionPath, this.currentCwd), clientId);
    // A fresh New view is valid even though it is deliberately absent from the
    // sidebar until its first user message is persisted.
    const session = sessions.find((item) => item.id === id) || secondaryRuntime?.draftSession;
    if (!session) return null;
    const secondaryReadable = this.applicationLifecycle === "idle" && secondaryRuntime && !secondaryRuntime.failed && secondaryRuntime.rpc.isRunning?.() !== false ? secondaryRuntime : null;
    const runtime = id === this.activeSessionId && primaryAvailable
      ? { rpc: this.options.rpc, running: this.running, liveMessage: this.liveMessage, toolStatus: this.toolStatus }
      : secondaryReadable;
    if (runtime) {
      if (id !== this.activeSessionId) this.runtimePool.touch(runtime as SecondaryRuntime);
      const busy = runtime.running || Boolean(runtime.liveMessage) || Boolean((runtime as SecondaryRuntime).dispatching);
      const sessionIndex = this.options.sessions as SessionIndex & {
        cachedSnapshotForId?: (sessionId: string) => import("./session-index.js").SessionFileSnapshot | null;
        snapshotForId?: (sessionId: string) => Promise<import("./session-index.js").SessionFileSnapshot | null>;
      };
      // For an already-open streaming Session, use the last parsed JSONL branch
      // immediately. The live assistant snapshot arrives separately over SSE.
      let snapshot = busy ? sessionIndex.cachedSnapshotForId?.(id) ?? null : null;
      if (!snapshot && !busy && sessionIndex.snapshotForId) snapshot = await sessionIndex.snapshotForId(id);
      const persistedRuntimeMessages = id === this.activeSessionId && this.lastPrimaryMessagesSessionId === id
        ? this.lastPrimaryMessages
        : secondaryRuntime?.messageSnapshot ?? null;
      const terminalTail = id === this.activeSessionId
        ? this.primaryPendingTerminalSessionId === id ? this.primaryPendingTerminalMessages : []
        : secondaryRuntime?.pendingTerminalMessages || [];
      let persistedMessages: PiMessage[] | null = snapshot?.messages
        ?? (busy ? persistedRuntimeMessages : (typeof this.options.sessions.messagesForId === "function"
          ? await this.options.sessions.messagesForId(id)
          : null));
      let messages: PiMessage[] | null = persistedMessages
        ? reconcilePersistedHistory(persistedMessages, terminalTail).messages
        : terminalTail.length ? reconcilePersistedHistory([], terminalTail).messages : null;
      if (!messages && !busy) {
        const path = (typeof this.options.sessions.pathForId === "function" ? this.options.sessions.pathForId(id) : null)
          || (runtime as SecondaryRuntime).sessionPath
          || (runtime as SecondaryRuntime).draftSessionPath;
        if (path) {
          try {
            persistedMessages = await readSessionMessages(path);
            messages = reconcilePersistedHistory(persistedMessages, terminalTail).messages;
          } catch { messages = null; }
        }
      }
      let stateResponse: Record<string, unknown> | null = null;
      let statsResponse: Record<string, unknown> | null = null;
      let commandsResponse: Record<string, unknown> | null = null;
      if (!busy) {
        try {
          const probes = await Promise.all([
            runtime.rpc.send({ type: "get_state" }, SHORT_RPC_MS).catch(() => null),
            runtime.rpc.send({ type: "get_session_stats" }, SHORT_RPC_MS).catch(() => null),
            runtime.rpc.send({ type: "get_commands" }, SHORT_RPC_MS).catch(() => null),
          ]);
          stateResponse = probes[0];
          statsResponse = probes[1];
          commandsResponse = probes[2];
        } catch {
          // Disk history + last known liveMessage still form a usable view.
        }
      }
      const rememberedState = id === this.activeSessionId
        ? this.lastPrimaryState
        : secondaryRuntime?.lastState || { model: null };
      const liveState = stateResponse ? asState(stateResponse) : {
        ...rememberedState,
        isStreaming: busy,
      } satisfies PiState;
      if (stateResponse && id === this.activeSessionId) {
        this.lastPrimaryState = liveState;
        this.running = liveState.isStreaming;
      } else if (stateResponse && secondaryRuntime) {
        secondaryRuntime.lastState = liveState;
        secondaryRuntime.running = liveState.isStreaming;
      }
      if (secondaryRuntime && commandsResponse) {
        secondaryRuntime.commands = asCommands(commandsResponse);
        secondaryRuntime.commandsKnown = true;
      }
      // Only hit get_messages when disk is empty. Never wait on a busy worker
      // when terminal SSE rows or a persisted snapshot already form a view.
      if (!messages && busy) messages = [];
      if (!messages) {
        try {
          persistedMessages = asMessages(await runtime.rpc.send({ type: "get_messages" }, busy ? 3_000 : MESSAGES_RPC_MS));
          messages = reconcilePersistedHistory(persistedMessages, terminalTail).messages;
        } catch (error) {
          throw error;
        }
      }
      if (!messages) throw new Error("无法读取会话消息");
      if (persistedMessages) {
        const reconciled = reconcilePersistedHistory(persistedMessages, terminalTail);
        if (id === this.activeSessionId) {
          this.lastPrimaryMessages = persistedMessages;
          this.lastPrimaryMessagesSessionId = id;
          this.primaryPendingTerminalMessages = reconciled.pending;
        } else if (secondaryRuntime) {
          secondaryRuntime.messageSnapshot = persistedMessages;
          secondaryRuntime.pendingTerminalMessages = reconciled.pending;
        }
        messages = reconciled.messages;
      }
      const windowed = messageWindow(messages, turnLimit);
      const stats = statsResponse
        ? await this.statsForSession(id, statsResponse)
        : busy
          ? (snapshot ? await this.offlineStatsForId(id, snapshot.usage) : undefined)
          : await this.offlineStatsForId(id, snapshot?.usage);
      const rememberedCommands = id === this.activeSessionId
        ? this.lastPrimaryCommands
        : secondaryRuntime?.commands;
      if (secondaryRuntime) {
        secondaryRuntime.summarySnapshot = session;
        secondaryRuntime.lastStats = stats;
        secondaryRuntime.statsKnown = Boolean(statsResponse) || secondaryRuntime.statsKnown;
      } else if (id === this.activeSessionId) this.primarySummarySnapshot = session;
      return {
        session,
        state: liveState,
        messages: windowed.messages,
        messageTotal: windowed.total,
        turnTotal: windowed.turns,
        visibleTurnCount: windowed.visibleTurns,
        messagesTruncated: windowed.truncated,
        isActive: true,
        runtimeStatus: "active",
        isStreaming: runtime.running || liveState.isStreaming,
        liveMessage: runtime.liveMessage,
        toolStatus: runtime.toolStatus,
        stats,
        queue: id === this.activeSessionId ? this.publicQueue() : this.publicQueue((runtime as SecondaryRuntime).promptQueue),
        queuePaused: id === this.activeSessionId ? this.queuePaused : (runtime as SecondaryRuntime).queuePaused,
        commands: commandsResponse
          ? [...BUILTIN_COMMANDS, ...asCommands(commandsResponse)]
          : rememberedCommands?.length
            ? [...BUILTIN_COMMANDS, ...rememberedCommands]
            : undefined,
        gateMode: id === this.activeSessionId ? this.primaryGateMode : (runtime as SecondaryRuntime).gateMode,
        pendingExtensionRequest: this.pendingRequestForSession(id),
        ...this.controlState(id, clientId),
      };
    }
    return this.coldSessionView(id, session, turnLimit, clientId);
  }

  /**
   * Token stats for a cold session, derived from its JSONL instead of waking
   * a Pi process. The context window comes from the model catalogue; when the
   * model is unknown the percentage stays unavailable rather than guessed.
   */
  private markContextUsagePendingRefresh(id: string): void {
    if (id) this.contextUsagePendingRefresh.add(id);
  }

  private beginContextUsageRefreshTurn(id: string): void {
    if (this.contextUsagePendingRefresh.has(id)) this.contextUsageRefreshTurn.add(id);
  }

  private completeContextUsageRefreshTurn(id: string): void {
    if (!this.contextUsageRefreshTurn.delete(id)) return;
    this.contextUsagePendingRefresh.delete(id);
  }

  private rememberModelContextWindows(models: ModelInfo[]): void {
    for (const model of models) {
      const key = `${model.provider}\u0000${model.id}`;
      this.knownModels.set(key, model);
      if (typeof model.contextWindow === "number" && model.contextWindow > 0) this.modelContextWindows.set(key, model.contextWindow);
    }
  }

  private modelFromSessionSettings(settings: SessionSettingsSnapshot): ModelInfo | null {
    if (!settings.provider || !settings.modelId) return null;
    return this.knownModels.get(`${settings.provider}\u0000${settings.modelId}`)
      // Keep the actual persisted identifier visible if a model was later removed
      // from the current catalogue; this is still more truthful than Primary's model.
      || { provider: settings.provider, id: settings.modelId, name: settings.modelId };
  }

  private offlineStatsFromUsage(id: string, usage: SessionUsageSnapshot): SessionStats {
    const stats: SessionStats = { tokens: usage.tokens };
    if (usage.context) {
      const contextWindow = this.modelContextWindows.get(`${usage.context.provider || ""}\u0000${usage.context.model || ""}`) || 0;
      if (!contextWindow) console.warn(`[Pi Chat] 冷会话上下文用量：未找到模型 ${usage.context.provider}/${usage.context.model} 的 contextWindow`);
      if (contextWindow > 0) {
        const pendingRefresh = this.contextUsagePendingRefresh.has(id);
        stats.contextUsage = pendingRefresh
          ? { tokens: null, contextWindow, percent: null }
          : { tokens: usage.context.tokens, contextWindow, percent: Math.min(100, (usage.context.tokens / contextWindow) * 100) };
        if (pendingRefresh) stats.contextUsagePendingRefresh = true;
      }
    }
    return stats;
  }

  private async offlineStatsForId(id: string, knownUsage?: SessionUsageSnapshot): Promise<SessionStats | undefined> {
    // Optional-chained: test doubles and older indexes may not implement usageForId.
    const usage = knownUsage ?? await Promise.resolve(this.options.sessions.usageForId?.(id)).catch(() => null);
    return usage ? this.offlineStatsFromUsage(id, usage) : undefined;
  }

  /** Prefer Pi's live counters, but use persisted usage whenever it omits occupancy. */
  private async statsForSession(id: string, response: Record<string, unknown>): Promise<SessionStats> {
    const live = asSessionStats(response);
    const fallback = await this.offlineStatsForId(id);
    const contextUsage = live.contextUsage || fallback?.contextUsage;
    return {
      ...live,
      ...(contextUsage ? { contextUsage } : {}),
      ...(fallback?.contextUsagePendingRefresh ? { contextUsagePendingRefresh: true } : {}),
    };
  }

  private async bootstrap(clientId = ""): Promise<BootstrapData> {
    if (this.applicationLifecycle !== "idle" && (this.primaryFailed || this.options.rpc.isRunning?.() === false)) {
      throw new ApplicationLifecycleConflictError(this.applicationLifecycle, this.lifecycleMessage());
    }
    // Bootstrap is a Session directory/read projection, not permission to make
    // the service wait for a stopped Primary. A healthy existing worker still
    // provides its current state, while a missing/crashed worker is recovered
    // only at the first real write (or an explicit activation).
    const primaryAvailable = this.primaryReadReady();
    let state = this.lastPrimaryState;
    if (primaryAvailable && !(this.running && this.activeSessionPath)) {
      try {
        state = asState(await this.options.rpc.send({ type: "get_state" }, this.activeSessionPath ? 4_000 : 12_000));
        this.lastPrimaryState = state;
        this.running = state.isStreaming;
        this.bindPrimaryIdentity(state);
      } catch (error) {
        if (!this.activeSessionPath) throw error;
        state = { ...this.lastPrimaryState, isStreaming: this.running };
      }
    } else if (this.running && this.activeSessionPath) state = { ...state, isStreaming: true };

    const busy = this.running || state.isStreaming;
    if (!this.lastAvailableModels.length && state.model) {
      this.rememberModelContextWindows([state.model]);
      this.lastAvailableModels = [state.model];
    }
    const diskMessages = this.activeSessionPath
      ? await readSessionMessages(this.activeSessionPath).catch(() => null)
      : null;
    let messages: PiMessage[] | null = null;
    const primaryTerminalTail = this.primaryPendingTerminalSessionId === this.activeSessionId ? this.primaryPendingTerminalMessages : [];
    if (diskMessages) {
      const reconciled = reconcilePersistedHistory(diskMessages, primaryTerminalTail);
      this.lastPrimaryMessages = diskMessages;
      this.primaryPendingTerminalMessages = reconciled.pending;
      this.lastPrimaryMessagesSessionId = this.activeSessionId;
      messages = reconciled.messages;
    } else if (this.lastPrimaryMessagesSessionId === this.activeSessionId) {
      messages = reconcilePersistedHistory(this.lastPrimaryMessages, primaryTerminalTail).messages;
    }
    // JSONL is authoritative enough for an immediately readable bootstrap.
    // An empty brand-new busy Session can render its live/optimistic message;
    // never hold the whole shell open waiting for get_messages.
    if (primaryAvailable && !messages && !busy) {
      const rpcMessages = asMessages(await this.options.rpc.send({ type: "get_messages" }, 12_000));
      const reconciled = reconcilePersistedHistory(rpcMessages, primaryTerminalTail);
      this.lastPrimaryMessages = rpcMessages;
      this.primaryPendingTerminalMessages = reconciled.pending;
      this.lastPrimaryMessagesSessionId = this.activeSessionId;
      messages = reconciled.messages;
    }

    if (primaryAvailable && !busy) {
      const [modelsResponse, commandsResponse, statsResponse] = await Promise.all([
        this.options.rpc.send({ type: "get_available_models" }, 8_000).catch(() => null),
        this.options.rpc.send({ type: "get_commands" }, 8_000).catch(() => null),
        this.options.rpc.send({ type: "get_session_stats" }, 8_000).catch(() => null),
      ]);
      if (modelsResponse) {
        const models = this.options.modelManager ? await this.options.modelManager.annotate(asModels(modelsResponse)) : asModels(modelsResponse);
        this.rememberModelContextWindows(models);
        this.lastAvailableModels = models;
      }
      if (commandsResponse) this.lastPrimaryCommands = asCommands(commandsResponse);
      if (statsResponse) this.lastPrimaryStats = { sessionId: this.activeSessionId, value: await this.statsForSession(this.activeSessionId, statsResponse) };
    }
    const availableModels = this.lastAvailableModels.length
      ? this.lastAvailableModels
      : this.startupModels;
    const windowedMessages = messageWindow(messages || []);
    const sidebar = this.sidebarSessions(await this.cachedSessionList(state.sessionFile), clientId);
    this.primarySummarySnapshot = sidebar.sessions.find((session) => session.id === this.activeSessionId) || this.primarySummarySnapshot;
    return {
      buildIdentity: this.buildIdentity,
      state,
      messages: windowedMessages.messages,
      messageTotal: windowedMessages.total,
      turnTotal: windowedMessages.turns,
      visibleTurnCount: windowedMessages.visibleTurns,
      messagesTruncated: windowedMessages.truncated,
      activeSessionId: this.activeSessionId,
      activeSessionIds: this.activeSessionIds(),
      liveMessage: this.liveMessage,
      toolStatus: this.toolStatus,
      stats: this.lastPrimaryStats?.sessionId === this.activeSessionId
        ? this.lastPrimaryStats.value
        : await this.offlineStatsForId(this.activeSessionId),
      models: availableModels,
      commands: [...BUILTIN_COMMANDS, ...this.lastPrimaryCommands],
      queue: this.publicQueue(),
      queuePaused: this.queuePaused,
      pendingExtensionRequest: this.pendingRequestForSession(this.activeSessionId),
      gateMode: this.primaryGateMode,
      ...this.controlState(this.activeSessionId, clientId),
      workspaceCwd: this.currentCwd,
      sessions: sidebar.sessions,
      sessionDirectories: sidebar.directories,
      sessionsTotal: sidebar.total,
      applicationLifecycle: this.applicationLifecycle,
      primaryRuntime: this.primaryReadiness(),
    };
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const requestError = requestGuardError(request, { allowedHosts: this.allowedHosts, token: this.requestToken });
      if (requestError) return json(response, 403, { error: requestError });
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        await this.handleApi(request, response, url);
        return;
      }
      if (this.options.devMiddleware) {
        this.options.devMiddleware(request, response, () => {
          if (!response.writableEnded) json(response, 404, { error: "Not found" });
        });
        return;
      }
      await this.serveStatic(request, response, url.pathname);
    } catch (error) {
      if (error instanceof ApplicationLifecycleConflictError) {
        response.setHeader("retry-after", "2");
        const isBootstrap = new URL(request.url || "/", "http://127.0.0.1").pathname === "/api/bootstrap";
        return json(response, 503, { error: error.message, code: "APPLICATION_LIFECYCLE_BLOCKED", lifecycle: error.lifecycle, retryable: true, ...(isBootstrap ? { requestToken: this.requestToken } : {}) });
      }
      if (error instanceof ApplicationBusyError) return json(response, 409, { error: error.message, code: "APPLICATION_BUSY" });
      if (error instanceof PrimaryRuntimeUnavailableError) return json(response, 503, { error: error.message, code: "PRIMARY_RUNTIME_UNAVAILABLE", primaryRuntime: error.readiness });
      if (error instanceof SessionControlConflictError || error instanceof RuntimeCapacityError || error instanceof OperationAdmissionClosedError) return json(response, 409, { error: error.message });
      if (error instanceof HttpRequestError) return json(response, error.status, { error: error.message });
      if (response.headersSent) {
        response.end();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      json(response, 500, { error: message });
    }
  }

  private async handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    // Parsing/identity validation deliberately precedes the lifecycle lease. A
    // malformed or stale browser request is not an admitted mutation and cannot
    // briefly prevent explicit restart/shutdown from reaching quiescence.
    const admission = apiRouteAdmission(request, url);
    if (admission.bodyBeforeMutationLease) {
      const body = await bodyJson(request, admission.bodyLimit);
      if (admission.validateSessionId) requiredSessionId(body);
      const releaseMutation = this.beginMutation();
      try {
        await this.handleApiCore(request, response, url, body);
      } finally {
        releaseMutation();
      }
      return;
    }
    const releaseMutation = admission.ordinaryMutation ? this.beginMutation() : null;
    try {
      await this.handleApiCore(request, response, url);
    } finally {
      releaseMutation?.();
    }
  }

  private async listSessionsRoute(input: {
    clientId: string;
    all: boolean;
    cwd: string;
    offset: number;
    limit: number;
  }): Promise<unknown> {
    const page = (sidebar: ReturnType<PiChatApp["sidebarSessions"]>) => {
      if (!input.cwd) return { sessions: sidebar.sessions, total: sidebar.total, directories: sidebar.directories };
      const cwdKey = (cwd: string) => resolve(cwd || ".").toLowerCase();
      const key = cwdKey(input.cwd);
      return {
        sessions: sidebar.sessions.filter((session) => cwdKey(session.cwd) === key).slice(input.offset, input.offset + input.limit),
        total: sidebar.directories.find((directory) => cwdKey(directory.cwd) === key)?.count || 0,
        directories: sidebar.directories,
      };
    };
    if (this.applicationLifecycle !== "idle") {
      const result = page(this.sidebarSessions(await this.cachedSessionList(this.activeSessionPath), input.clientId, input.all || Boolean(input.cwd)));
      return { ...result, applicationLifecycle: this.applicationLifecycle };
    }
    // Reading the Session index must not wait for a stopped Primary Runtime.
    let state = this.lastPrimaryState;
    if (this.primaryReadReady() && !this.running) {
      try {
        state = asState(await this.options.rpc.send({ type: "get_state" }, 4_000));
        this.lastPrimaryState = state;
        this.activeSessionPath = state.sessionFile || this.activeSessionPath;
      } catch {
        // Keep lastPrimaryState/path so secondary draft injection still works.
      }
    }
    const result = page(this.sidebarSessions(await this.cachedSessionList(this.activeSessionPath || state.sessionFile), input.clientId, input.all || Boolean(input.cwd)));
    return { ...result, applicationLifecycle: this.applicationLifecycle };
  }

  private async sessionViewRoute(input: { sessionId: string; clientId: string; turns: number; fast: boolean }): Promise<SessionViewData | null> {
    // Reading a cold history is deliberately view-only; no Runtime is created.
    return input.fast
      ? this.hotMemoryView(input.sessionId, input.turns, input.clientId)
      : this.sessionView(input.sessionId, input.turns, input.clientId);
  }

  private async handleApiCore(request: IncomingMessage, response: ServerResponse, url: URL, preparedBody?: Record<string, unknown>): Promise<void> {
    const clientId = requestClientId(request);
    if (await handleBootstrapRoute({
      lifecycle: () => this.applicationLifecycle,
      assertBootstrapAllowed: () => {
        if (this.applicationLifecycle !== "idle")
          throw new ApplicationLifecycleConflictError(this.applicationLifecycle, this.lifecycleMessage());
      },
      requestToken: () => this.requestToken,
      buildIdentity: () => this.buildIdentity,
      openWindowCount: () => this.openWindowCount(),
      cancelLastWindowShutdown: () => this.cancelLastWindowShutdown(),
      scheduleLastWindowShutdown: () => this.scheduleLastWindowShutdown(),
      bootstrap: (id) => this.bootstrap(id),
    }, request, response, url, clientId)) return;
    if (await handleSessionsReadRoute({
      listSessions: (input) => this.listSessionsRoute(input),
      sessionView: (input) => this.sessionViewRoute(input),
    }, request, response, url, clientId, {
      recentTurns: RECENT_TURN_WINDOW_SIZE,
      maxTurns: MAX_TURN_WINDOW_SIZE,
      turnIncrement: TURN_WINDOW_INCREMENT,
      directoryLimit: DEFAULT_DIRECTORY_SESSION_LIST_SIZE,
    })) return;

    if (url.pathname === "/api/events") {
      if (request.method !== "GET") return methodNotAllowed(response);
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      response.write(`event: ready\ndata: ${JSON.stringify({ ok: true, lifecycle: this.applicationLifecycle, piChatRunEpoch: this.runEpoch })}\n\n`);
      const pageId = requestPageId(request) || clientId;
      this.sseHub.add(response, clientId);
      this.clientConnected(clientId, pageId);
      const timer = setInterval(() => this.sseHub.heartbeat(response), this.sseHeartbeatMs);
      request.once("close", () => {
        clearInterval(timer);
        // The hub emits exactly one disconnect notification. If a slow-client
        // protection already removed this response, remove() is a harmless no-op.
        this.sseHub.remove(response);
      });
      return;
    }

    if (url.pathname === "/api/presence") {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (!clientId) return json(response, 400, { error: "浏览器窗口标识无效" });
      const body = await bodyJson(request);
      if (body.foreground === false) {
        if (!this.sessionControl.noteClientBackground(clientId)) {
          return json(response, 409, { error: "事件连接已断开，正在重新连接" });
        }
        json(response, 200, { present: false });
        return;
      }
      if (!this.sessionControl.noteClientPresence(clientId)) {
        return json(response, 409, { error: "事件连接已断开，正在重新连接" });
      }
      json(response, 200, { present: true });
      return;
    }

    if (url.pathname === "/api/window/close") {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (!clientId) return json(response, 400, { error: "缺少窗口标识，无法安全关闭" });
      if (this.applicationLifecycle !== "idle") throw new ApplicationLifecycleConflictError(this.applicationLifecycle, this.lifecycleMessage());
      const pageId = requestPageId(request) || clientId;
      const viewedSessionId = this.closeWindowClient(clientId, pageId);
      const otherWindowCount = this.openWindowCount();
      // A Prompt may already hold an admission lease while its request body is
      // still arriving. Do not stop any Runtime until all admitted mutations finish.
      const rested = otherWindowCount > 0 && this.activeMutationRequests === 0 && this.runtimePool.startingCount === 0
        ? await this.restSessionAfterWindowClose(viewedSessionId)
        : false;
      if (otherWindowCount === 0) this.scheduleLastWindowShutdown();
      json(response, 200, {
        shuttingDown: false,
        closeWindow: true,
        sessionId: viewedSessionId || undefined,
        rested,
        remainingWindows: otherWindowCount,
        ...(otherWindowCount === 0 && this.options.applicationShutdown ? { autoShutdownPending: true } : {}),
      });
      return;
    }

    if (url.pathname === "/api/restart" || url.pathname === "/api/shutdown") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const shuttingDown = url.pathname === "/api/shutdown";
      const lifecycle = shuttingDown ? "shutting-down" : "restarting";
      if (shuttingDown && !this.options.applicationShutdown) return json(response, 501, { error: "当前启动方式不支持从网页关闭 Pi Chat；请关闭服务进程。" });
      if (!shuttingDown && !this.options.applicationRestart) return json(response, 501, { error: "当前启动方式不支持应用更新并重启；请在 Pi Chat 项目目录运行 npm run build 后重启服务。" });
      this.beginLifecycle(lifecycle);
      try {
        await this.verifyApplicationQuiescent(shuttingDown ? "关闭 Pi Chat" : "应用更新并重启");
        if (shuttingDown) {
          this.broadcast({ type: "pi_chat_application_closing" });
          json(response, 202, { shuttingDown: true });
          this.options.applicationShutdown?.("api-shutdown");
          return;
        }
        const prepared = await this.options.applicationRestart!();
        try {
          // Defense in depth: no request admitted after the barrier may have made
          // the application busy, but internal runtime work must also be quiescent.
          await this.verifyApplicationQuiescent("完成重启");
          // Promotion is still reversible on failure and happens before the HTTP
          // response. The irreversible process handoff begins only after 202.
          await prepared.promote();
        } catch (error) {
          await prepared.discard();
          throw error;
        }
        json(response, 202, { restarting: true });
        prepared.handoff();
        return;
      } catch (error) {
        this.endLifecycle(lifecycle);
        throw error;
      }
    }

    if (url.pathname === "/api/chat/prompt") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || await bodyJson(request, 45_000_000);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      const requestedSessionId = requiredSessionId(body);
      const requestedGateMode: GateMode | undefined = body.gateMode === "strict" || body.gateMode === "open" ? body.gateMode : undefined;
      const images = promptImages(body.images);
      if (!message && !images.length) return json(response, 400, { error: "消息或图片不能为空" });
      const promptAt = this.nextUserPromptAt();
      const admittedSessionId = requestedSessionId;
      const releasePromptAdmission = await this.beginPromptAdmission(admittedSessionId);
      let releaseRuntimeAdmission: (() => void) | null = null;
      try {
      this.requireSessionControl(requestedSessionId, clientId);
      // Before creating a *new* Secondary, bind Primary identity through the
      // readiness gate. An already-owned Secondary remains usable even if the
      // independent Primary startup subsequently fails.
      const existingSecondary = this.runtimePool.get(requestedSessionId) || null;
      // Production readiness must bind the primary before allocating a worker;
      // legacy in-process test hosts have no startup controller and retain the
      // historical lazy identity behavior for their minimal RPC doubles.
      if (!this.activeSessionId && !existingSecondary) await this.ensurePrimaryIdentity();
      // A browser tab can outlive a Pi Chat restart. Restore its requested Session on demand
      // instead of rejecting the prompt because the old in-memory worker map was lost.
      const requestedIsPrimary = requestedSessionId === this.activeSessionId;
      if (!requestedIsPrimary && !this.activeSessionIds().includes(requestedSessionId)) await this.ensureRuntime(requestedSessionId);
      const secondaryRuntime = !requestedIsPrimary ? this.runtimePool.get(requestedSessionId) || null : null;
      if (secondaryRuntime) {
        releaseRuntimeAdmission = this.runtimePool.acquireOperation(secondaryRuntime);
        this.runtimePool.touch(secondaryRuntime);
        if (secondaryRuntime.failed || secondaryRuntime.rpc.isRunning?.() === false) await this.recoverRuntime(secondaryRuntime);
      } else {
        releaseRuntimeAdmission = this.primaryOperationAdmission.acquire().release;
        await this.ensurePrimaryRuntime();
      }
      const targetRpc = secondaryRuntime?.rpc || this.options.rpc;
      const extensionCommand = message ? await this.extensionCommand(message, targetRpc) : null;
      if (extensionCommand) {
        if (images.length) return json(response, 400, { error: "Extension 指令不能同时附加图片" });
        await targetRpc.send({ type: "prompt", message }, PROMPT_PREPARE_TIMEOUT_MS);
        const requestedGateMode = extensionCommand.name === "gate" ? gateModeFromCommand(message) : null;
        if (requestedGateMode) this.setGateMode(secondaryRuntime?.id || this.activeSessionId, requestedGateMode);
        this.noteUserPrompt(secondaryRuntime?.id || this.activeSessionId, promptAt);
        const state = asState(await targetRpc.send({ type: "get_state" }));
        if (secondaryRuntime) {
          secondaryRuntime.running = state.isStreaming;
          secondaryRuntime.prompted = true;
          await this.finalizePersistedDraft(secondaryRuntime);
          this.broadcast({ type: "pi_chat_sessions_changed", action: "created", sessionId: secondaryRuntime.id });
        } else this.running = state.isStreaming;
        json(response, 202, { accepted: true, queued: false, extension: true, command: extensionCommand.name, description: extensionCommand.description, isStreaming: state.isStreaming });
        return;
      }
      if (secondaryRuntime) {
        if (this.scheduler.runtimeBusyForQueue(secondaryRuntime)) {
          const enqueueError = this.scheduler.assertCanEnqueue(secondaryRuntime.promptQueue, images);
          if (enqueueError) return json(response, 409, { error: enqueueError });
          const queued = this.scheduler.enqueueRuntime(secondaryRuntime, message, images, promptAt, requestedGateMode);
          this.noteUserPrompt(secondaryRuntime.id, promptAt);
          return json(response, 202, { accepted: true, queued: true, id: queued.id, queue: this.publicQueue(secondaryRuntime.promptQueue) });
        }
        const generation = secondaryRuntime.abortGeneration;
        try {
          await this.applyPendingTurnSettings(secondaryRuntime.rpc, secondaryRuntime.pendingTurnSettings);
          if (generation !== secondaryRuntime.abortGeneration || this.applicationLifecycle !== "idle") throw new Error("消息发送已取消");
          await this.syncGateMode(secondaryRuntime.rpc, secondaryRuntime.id, requestedGateMode);
          secondaryRuntime.running = true;
          this.broadcastSessionActivity(secondaryRuntime.id);
          await secondaryRuntime.rpc.send({ type: "prompt", message: message || "请查看这些图片。", ...(images.length ? { images } : {}) }, PROMPT_PREPARE_TIMEOUT_MS);
          this.scheduler.notifySecondaryPromptAccepted(secondaryRuntime, promptAt);
          json(response, 202, { accepted: true, queued: false });
        } catch (error) {
          secondaryRuntime.running = false;
          this.broadcastSessionActivity(secondaryRuntime.id);
          throw error;
        }
        return;
      }
      if (this.scheduler.primaryBusyForQueue()) {
        const enqueueError = this.scheduler.assertCanEnqueue(this.promptQueue, images);
        if (enqueueError) return json(response, 409, { error: enqueueError });
        const queued = this.scheduler.enqueuePrimary(message, images, promptAt, requestedGateMode);
        this.noteUserPrompt(this.activeSessionId, promptAt);
        json(response, 202, { accepted: true, queued: true, id: queued.id, queue: this.publicQueue() });
        return;
      }
      await this.sendPrompt(message, images, promptAt, requestedGateMode);
      json(response, 202, { accepted: true, queued: false });
      return;
      } finally {
        releaseRuntimeAdmission?.();
        releasePromptAdmission();
      }
    }

    const queueCancelMatch = /^\/api\/chat\/queue\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (queueCancelMatch) {
      if (request.method !== "DELETE") return methodNotAllowed(response);
      const body = preparedBody || await bodyJson(request);
      const sessionId = requiredSessionId(body);
      this.requireSessionControl(sessionId, clientId);
      const runtime = this.runtimePool.get(sessionId);
      if (!runtime && sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话尚未恢复运行，请刷新页面后重试" });
      if (runtime) this.runtimePool.touch(runtime);
      const queue = runtime?.promptQueue || this.promptQueue;
      const index = queue.findIndex((item) => item.id === queueCancelMatch[1]);
      if (index < 0) return json(response, 404, { error: "队列消息不存在或已经开始执行" });
      queue.splice(index, 1);
      if (runtime) {
        if (!queue.length) runtime.queuePaused = false;
      } else if (!queue.length) this.queuePaused = false;
      this.broadcastQueue(sessionId);
      json(response, 200, { queue: this.publicQueue(queue), paused: runtime?.queuePaused ?? this.queuePaused });
      return;
    }

    if (url.pathname === "/api/chat/queue/resume") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || await bodyJson(request);
      const sessionId = requiredSessionId(body);
      this.requireSessionControl(sessionId, clientId);
      const runtime = this.runtimePool.get(sessionId);
      if (!runtime && sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话尚未恢复运行，请刷新页面后重试" });
      if (runtime) {
        this.runtimePool.touch(runtime);
        if (runtime.failed || runtime.rpc.isRunning?.() === false) await this.recoverRuntime(runtime);
        runtime.queuePaused = false;
        this.broadcastQueue(sessionId);
        void this.dispatchRuntimeNext(runtime);
        return json(response, 200, { queue: this.publicQueue(runtime.promptQueue), paused: false });
      }
      this.queuePaused = false;
      this.broadcastQueue();
      void this.dispatchNext();
      json(response, 200, { queue: this.publicQueue(), paused: false });
      return;
    }

    if (url.pathname === "/api/local-files/pick") {
      if (request.method !== "POST") return methodNotAllowed(response);
      json(response, 200, { paths: await pickLocalFiles() });
      return;
    }

    if (url.pathname === "/api/local-files/clipboard") {
      if (request.method !== "POST") return methodNotAllowed(response);
      json(response, 200, { paths: await readClipboardFiles() });
      return;
    }

    if (url.pathname === "/api/workspace/draft-pick") {
      if (request.method !== "POST") return methodNotAllowed(response);
      // This selects the cwd for a local, not-yet-materialized draft only. It
      // does not touch Primary or any existing Runtime, so concurrent Sessions
      // remain safe and uninterrupted.
      const selected = await pickWorkspaceFolder(this.currentCwd);
      if (!selected) return json(response, 200, { cancelled: true });
      if (!(await stat(resolve(selected))).isDirectory()) return json(response, 400, { error: "所选工作目录不存在或不是文件夹" });
      json(response, 200, { cancelled: false, cwd: resolve(selected) });
      return;
    }

    if (url.pathname === "/api/workspace/pick") {
      if (request.method !== "POST") return methodNotAllowed(response);
      // Default-directory selection is not a Runtime operation: existing
      // Sessions continue on their immutable process cwd even while busy.
      const selected = await pickWorkspaceFolder(this.currentCwd);
      if (!selected) return json(response, 200, { cancelled: true });
      const result = await this.changeWorkspace(selected);
      json(response, 200, { cancelled: false, ...result });
      return;
    }

    // Local/automation path only (scripts, future local CLI). The browser UI
    // uses the per-draft picker and never changes this global default directly.
    // Not a remote-access surface; the service itself is loopback-only.
    if (url.pathname === "/api/workspace/set") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      const selected = typeof body.path === "string" ? body.path.trim() : "";
      if (!selected) return json(response, 400, { error: "path 必填" });
      const result = await this.changeWorkspace(selected);
      json(response, 200, { cancelled: false, ...result });
      return;
    }

    if (url.pathname === "/api/chat/compact") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || await bodyJson(request);
      const sessionId = requiredSessionId(body);
      this.requireSessionControl(sessionId, clientId);
      const secondaryRuntime = this.runtimePool.get(sessionId) || null;
      let releaseRuntimeOperation: (() => void) | null = null;
      try {
        if (secondaryRuntime) {
          releaseRuntimeOperation = this.runtimePool.acquireOperation(secondaryRuntime);
          if (secondaryRuntime.failed || secondaryRuntime.rpc.isRunning?.() === false) await this.recoverRuntime(secondaryRuntime);
        } else {
          releaseRuntimeOperation = this.primaryOperationAdmission.acquire().release;
          await this.ensurePrimaryRuntime();
        }
        if ((!secondaryRuntime && (this.running || this.promptQueue.length)) || secondaryRuntime?.running) return json(response, 409, { error: "请先停止该会话的生成并清空队列" });
        if (!secondaryRuntime && sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话尚未启用" });
        const customInstructions = typeof body.customInstructions === "string" ? body.customInstructions.trim() : "";
        const result = rpcData<Record<string, unknown>>(await (secondaryRuntime?.rpc || this.options.rpc).send({ type: "compact", ...(customInstructions ? { customInstructions } : {}) }, PROMPT_PREPARE_TIMEOUT_MS));
        json(response, 200, { result });
        return;
      } finally { releaseRuntimeOperation?.(); }
    }

    if (url.pathname === "/api/chat/abort") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || await bodyJson(request);
      const sessionId = requiredSessionId(body);
      this.requireSessionControl(sessionId, clientId);
      const runtime = this.runtimePool.get(sessionId);
      if (runtime) {
        const releaseRuntimeOperation = this.runtimePool.acquireOperation(runtime);
        try {
        this.runtimePool.touch(runtime);
        runtime.abortGeneration += 1;
        if (runtime.failed || runtime.rpc.isRunning?.() === false) return json(response, 200, { ok: true, isStreaming: false, queuePaused: runtime.queuePaused });
        if (runtime.promptQueue.length || runtime.dispatching) runtime.queuePaused = true;
        await runtime.rpc.send({ type: "abort" }, 5_000);
        // Abort itself is enough; a long get_state after abort was a common freeze.
        // Prefer a short probe, then fall back to "stopped" and let agent_settled finish.
        let isStreaming = false;
        try {
          const state = asState(await runtime.rpc.send({ type: "get_state" }, 2_000));
          isStreaming = state.isStreaming;
        } catch {
          isStreaming = false;
        }
        runtime.running = isStreaming;
        this.broadcastQueue(sessionId);
        this.broadcastSessionActivity(sessionId);
        return json(response, 200, { ok: true, isStreaming, queuePaused: runtime.queuePaused });
        } finally { releaseRuntimeOperation(); }
      }
      if (sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话不是活动运行会话" });
      const releasePrimaryOperation = this.primaryOperationAdmission.acquire().release;
      try {
      if (this.primaryFailed || this.options.rpc.isRunning?.() === false) return json(response, 200, { ok: true, isStreaming: false, queuePaused: this.queuePaused });
      this.scheduler.primaryAbortGeneration += 1;
      if (this.promptQueue.length || this.dispatching) this.queuePaused = true;
      await this.options.rpc.send({ type: "abort" }, 5_000);
      this.broadcastQueue();
      let isStreaming = false;
      try {
        const state = asState(await this.options.rpc.send({ type: "get_state" }, 2_000));
        isStreaming = state.isStreaming;
      } catch {
        isStreaming = false;
      }
      this.running = isStreaming;
      this.broadcastSessionActivity(sessionId);
      json(response, 200, { ok: true, isStreaming, queuePaused: this.queuePaused });
      return;
      } finally { releasePrimaryOperation(); }
    }

    const manageSessionMatch = /^\/api\/sessions\/([a-f0-9]{20})$/.exec(url.pathname);
    if (manageSessionMatch) {
      if (request.method === "PATCH") {
        this.requireSessionControl(manageSessionMatch[1], clientId);
        const body = await bodyJson(request);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) return json(response, 400, { error: "名称必须为 1 到 120 个有效字符" });
        json(response, 200, await this.renameSession(manageSessionMatch[1], name));
        return;
      }
      if (request.method === "DELETE") {
        this.requireSessionControl(manageSessionMatch[1], clientId);
        json(response, 200, await this.deleteSession(manageSessionMatch[1]));
        return;
      }
      return methodNotAllowed(response);
    }

    if (url.pathname === "/api/sessions/viewing/clear") {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (!clientId) return json(response, 400, { error: "浏览器窗口标识无效" });
      const body = await bodyJson(request);
      const expectedSessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!/^[a-f0-9]{20}$/.test(expectedSessionId)) return json(response, 400, { error: "待清除的会话标识无效" });
      const viewing = this.sessionControl.clearViewed(clientId, expectedSessionId);
      if (!viewing) {
        const runtime = this.runtimePool.get(expectedSessionId);
        if (runtime && this.runtimePool.canReclaim(runtime)) void this.runtimePool.sweep();
      }
      json(response, 200, { viewing });
      return;
    }

    const viewingMatch = /^\/api\/sessions\/([a-f0-9]{20})\/viewing$/.exec(url.pathname);
    if (viewingMatch) {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (!clientId) return json(response, 400, { error: "浏览器窗口标识无效" });
      const id = viewingMatch[1];
      const runtime = this.runtimePool.get(id);
      // A running Runtime is authoritative. Avoid a full SessionIndex scan after
      // every hot navigation just to prove a worker we already own exists.
      const indexed = !runtime && id !== this.activeSessionId
        ? this.options.sessions.summaryForId?.(id) || (await this.options.sessions.list(undefined, this.currentCwd)).find((session) => session.id === id)
        : true;
      if (!indexed && !runtime && id !== this.activeSessionId) return json(response, 404, { error: "会话不存在" });
      this.markSessionViewed(clientId, id);
      if (runtime) this.runtimePool.touch(runtime);
      json(response, 200, { viewing: id });
      return;
    }

    const controlMatch = /^\/api\/sessions\/([a-f0-9]{20})\/control$/.exec(url.pathname);
    if (controlMatch) {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (!clientId) return json(response, 400, { error: "浏览器窗口标识无效" });
      const summaries = await this.options.sessions.list(undefined, this.currentCwd);
      if (!summaries.some((session) => session.id === controlMatch[1]) && !this.runtimePool.has(controlMatch[1])) return json(response, 404, { error: "会话不存在" });
      this.setController(controlMatch[1], clientId);
      json(response, 200, this.controlState(controlMatch[1], clientId));
      return;
    }

    const warmMatch = /^\/api\/sessions\/([a-f0-9]{20})\/warm$/.exec(url.pathname);
    if (warmMatch) {
      if (request.method !== "POST") return methodNotAllowed(response);
      const id = warmMatch[1];
      const existing = this.runtimePool.get(id) || null;
      // A Primary may still own this session after service startup. Bind that
      // identity before allocating any cold Secondary so one JSONL never gains
      // two live Pi writers.
      if (!existing && !this.activeSessionId) await this.ensurePrimaryIdentity();
      // Warm is a Session-local capability upgrade. It deliberately performs
      // no full sessionView probes; a cold JSONL pane remains immediately
      // readable even if spawning fails or capacity is exhausted.
      if (id === this.activeSessionId) {
        await this.ensurePrimaryRuntime();
        return json(response, 200, {
          sessionId: id,
          state: { ...this.lastPrimaryState, isStreaming: this.running },
          gateMode: this.primaryGateMode,
        } satisfies SessionRuntimeReadyData);
      }
      const runtime = existing || await this.ensureRuntime(id);
      json(response, 200, this.runtimeReady(runtime));
      return;
    }

    const activateMatch = /^\/api\/sessions\/([a-f0-9]{20})\/activate$/.exec(url.pathname);
    if (activateMatch) {
      if (request.method !== "POST") return methodNotAllowed(response);
      const id = activateMatch[1];
      // An already-owned Secondary remains independently usable when Primary
      // startup has failed. Only a new/unknown target must bind Primary first,
      // preventing a cold Primary JSONL from being opened twice.
      const existingSecondary = this.runtimePool.get(id) || null;
      if (!existingSecondary) await this.ensurePrimaryIdentity();
      if (id === this.activeSessionId) await this.ensurePrimaryRuntime();
      else if (!existingSecondary) await this.ensureRuntime(id);
      const view = await this.sessionView(id, RECENT_TURN_WINDOW_SIZE, clientId);
      if (!view) return json(response, 404, { error: "会话不存在" });
      json(response, 200, view);
      return;
    }

    if (url.pathname === "/api/sessions/new") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || await bodyJson(request);
      const requestedCwd = typeof body.cwd === "string" && body.cwd.trim() ? resolve(body.cwd) : this.currentCwd;
      if (!(await stat(requestedCwd)).isDirectory()) return json(response, 400, { error: "新对话工作目录不存在或不是文件夹" });
      const initial = body.initial && typeof body.initial === "object" && !Array.isArray(body.initial)
        ? body.initial as InitialPromptRequest
        : null;
      const initialMessage = typeof initial?.message === "string" ? initial.message.trim() : "";
      const initialImages = initial ? promptImages(initial.images) : [];
      const initialGateMode: GateMode | undefined = initial?.gateMode === "strict" || initial?.gateMode === "open"
        ? initial.gateMode
        : undefined;
      if (initial?.gateMode !== undefined && !initialGateMode) return json(response, 400, { error: "无效的 Gate 模式" });
      if (initial?.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(initial.thinkingLevel)) return json(response, 400, { error: "无效的 Thinking 强度" });
      if (initial?.model !== undefined && (!initial.model || typeof initial.model.provider !== "string" || !initial.model.provider || typeof initial.model.modelId !== "string" || !initial.model.modelId)) return json(response, 400, { error: "新对话模型配置无效" });
      if (initial && !initialMessage && !initialImages.length) return json(response, 400, { error: "消息或图片不能为空" });
      if (this.options.primaryRuntime?.snapshot().status === "failed") {
        throw new PrimaryRuntimeUnavailableError(this.options.primaryRuntime.snapshot());
      }
      const draftLease = await this.acquireDraftRuntime(clientId, requestedCwd);
      try {
        // Spawn and Primary compatibility are intentionally overlapped. The
        // draft remains unprompted until the common compatibility proof joins.
        await this.waitForNewDraftPrimaryCompatibility();
        // The lease spans creation, preferences, Gate and prompt admission: an
        // empty draft cannot be reclaimed between these parts of one first turn.
        this.markSessionViewed(clientId, draftLease.runtime.id);
        if (!initial) {
          const view = await this.draftSessionView(draftLease.runtime, clientId);
          json(response, 200, view);
          return;
        }
        const runtime = draftLease.runtime;
        // Use the same per-Session prompt FIFO as ordinary /chat/prompt. The
        // runtime lease protects reclamation; this admission prevents a caller
        // that learns the newly allocated ID from interleaving another prompt
        // between first-turn setup commands and the user instruction.
        const releasePromptAdmission = await this.beginPromptAdmission(runtime.id);
        try {
          this.requireSessionControl(runtime.id, clientId);
          const promptAt = this.nextUserPromptAt();
          if (initial.model && typeof initial.model.provider === "string" && typeof initial.model.modelId === "string") {
            const model = rpcData<ModelInfo>(await runtime.rpc.send({ type: "set_model", provider: initial.model.provider, modelId: initial.model.modelId }));
            runtime.lastState = { ...(runtime.lastState || { model: null, isStreaming: false }), model };
          }
          if (initial.thinkingLevel && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(initial.thinkingLevel)) {
            await runtime.rpc.send({ type: "set_thinking_level", level: initial.thinkingLevel });
            runtime.lastState = { ...(runtime.lastState || { model: null, isStreaming: false }), thinkingLevel: initial.thinkingLevel };
          }
          const extensionCommand = initialMessage ? await this.extensionCommand(initialMessage, runtime.rpc) : null;
          if (extensionCommand && initialImages.length) return json(response, 400, { error: "Extension 指令不能同时附加图片" });
          await this.syncGateMode(runtime.rpc, runtime.id, initialGateMode);
          runtime.running = true;
          this.broadcastSessionActivity(runtime.id);
          try {
            await runtime.rpc.send({ type: "prompt", message: initialMessage || "请查看这些图片。", ...(initialImages.length ? { images: initialImages } : {}) }, PROMPT_PREPARE_TIMEOUT_MS);
            if (extensionCommand) {
              // Extension commands can complete synchronously without an
              // agent_start event. Refresh only their minimal state so the
              // Runtime never remains falsely marked running, then commit the
              // draft using the same semantics as ordinary extension commands.
              const state = asState(await runtime.rpc.send({ type: "get_state" }));
              runtime.lastState = state;
              runtime.running = state.isStreaming;
              runtime.prompted = true;
              this.noteUserPrompt(runtime.id, promptAt);
              await this.finalizePersistedDraft(runtime);
            } else {
              this.scheduler.notifySecondaryPromptAccepted(runtime, promptAt);
            }
          } catch (error) {
            runtime.running = false;
            this.broadcastSessionActivity(runtime.id);
            throw error;
          }
          json(response, 202, {
            ...this.runtimeReady(runtime),
            session: { ...(runtime.draftSession || { id: runtime.id, sessionId: runtime.lastState?.sessionId || runtime.id, name: "新对话", preview: "新对话", cwd: runtime.cwd, updatedAt: this.now(), messageCount: 1, active: true }), active: true },
            accepted: true,
            queued: false,
            ...(extensionCommand ? { extension: true, command: extensionCommand.name, description: extensionCommand.description, isStreaming: runtime.running } : null),
          } satisfies InitialPromptData);
        } finally {
          releasePromptAdmission();
        }
      } catch (error) {
        if (draftLease.created && error instanceof PrimaryRuntimeUnavailableError) {
          // releaseForDeletion drains Runtime admission; release this route's
          // handoff lease first or cleanup would wait on itself indefinitely.
          draftLease.release();
          await this.runtimePool.discardDraft(draftLease.runtime).catch(() => undefined);
        }
        throw error;
      } finally {
        draftLease.release();
      }
      return;
    }

    const customModelMatch = /^\/api\/models\/([A-Za-z0-9._-]{1,80})\/([^/]{1,200})$/.exec(url.pathname);
    if (customModelMatch) {
      if (!this.options.modelManager) return json(response, 501, { error: "模型管理不可用" });
      const provider = decodeURIComponent(customModelMatch[1]);
      const modelId = decodeURIComponent(customModelMatch[2]);
      if (request.method === "GET") {
        json(response, 200, { model: await this.options.modelManager.getCustomConfig(provider, modelId) });
        return;
      }
      if (request.method === "PUT") {
        const result = await this.withLifecycle("resources-reloading", "更新模型配置", async () => {
          const body = await bodyJson(request);
          const state = asState(await this.options.rpc.send({ type: "get_state" }));
          const wasActive = state.model?.provider === provider && state.model?.id === modelId;
          const snapshot = await snapshotFile(this.options.modelManager!.path);
          const updated = await this.applyResourceFileTransaction([snapshot], () => this.options.modelManager!.update(provider, modelId, body));
          // A rename invalidates the session's model reference; reselect the new
          // key so the UI never points at a model that no longer exists.
          if (wasActive && (updated.provider !== provider || updated.id !== modelId)) {
            try {
              await this.options.rpc.send({ type: "set_model", provider: updated.provider, modelId: updated.id });
            } catch {
              // The renamed model may be unreachable (auth/network); the user can
              // reselect it from the refreshed model list.
            }
          }
          return this.bootstrap();
        });
        json(response, 200, result);
        return;
      }
      return methodNotAllowed(response);
    }

    if (url.pathname === "/api/models") {
      if (!this.options.modelManager) return json(response, 501, { error: "模型管理不可用" });
      if (request.method !== "POST" && request.method !== "DELETE") return methodNotAllowed(response);
      const result = await this.withLifecycle("resources-reloading", "更新模型配置", async () => {
        const body = await bodyJson(request);
        const snapshot = await snapshotFile(this.options.modelManager!.path);
        if (request.method === "POST") {
          await this.applyResourceFileTransaction([snapshot], () => this.options.modelManager!.add(body));
        } else {
          const state = asState(await this.options.rpc.send({ type: "get_state" }));
          if (state.model?.provider === body.provider && state.model?.id === body.modelId) throw new Error("请先切换到其他模型，再删除当前模型");
          await this.applyResourceFileTransaction([snapshot], () => this.options.modelManager!.remove(body.provider, body.modelId));
        }
        return this.bootstrap();
      });
      json(response, 200, result);
      return;
    }

    if (url.pathname === "/api/models/set") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || await bodyJson(request);
      const provider = typeof body.provider === "string" ? body.provider : "";
      const modelId = typeof body.modelId === "string" ? body.modelId : "";
      const sessionId = requiredSessionId(body);
      // Model selection does not claim control, but an observing window must not
      // silently overwrite settings owned by another active controller.
      this.assertNoForeignController(sessionId, clientId);
      const secondaryRuntime = this.runtimePool.get(sessionId) || null;
      if (!provider || !modelId) return json(response, 400, { error: "provider 和 modelId 必填" });
      if (!secondaryRuntime && sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话尚未启用" });
      if (secondaryRuntime) {
        return this.runtimePool.withOperation(secondaryRuntime, async () => {
          if (secondaryRuntime.failed || secondaryRuntime.rpc.isRunning?.() === false) await this.recoverRuntime(secondaryRuntime);
          const targetRpc = secondaryRuntime.rpc;
          if (secondaryRuntime.running) {
            const model = asModels(await targetRpc.send({ type: "get_available_models" })).find((item) => item.provider === provider && item.id === modelId);
            if (!model) return json(response, 404, { error: "所选模型不可用" });
            secondaryRuntime.pendingTurnSettings.model = { provider, modelId };
            this.rememberRuntimeDisplaySettings(secondaryRuntime, { model });
            return json(response, 200, { model, pending: true });
          }
          const model = rpcData<ModelInfo>(await targetRpc.send({ type: "set_model", provider, modelId }));
          this.rememberRuntimeDisplaySettings(secondaryRuntime, { model });
          return json(response, 200, { model, pending: false });
        });
      }
      const releasePrimaryOperation = this.primaryOperationAdmission.acquire().release;
      try {
        await this.ensurePrimaryRuntime();
        const targetRunning = this.running;
        if (targetRunning) {
          const model = asModels(await this.options.rpc.send({ type: "get_available_models" })).find((item) => item.provider === provider && item.id === modelId);
          if (!model) return json(response, 404, { error: "所选模型不可用" });
          this.pendingTurnSettings.model = { provider, modelId };
          this.rememberPrimaryDisplaySettings({ model });
          return json(response, 200, { model, pending: true });
        }
        const model = rpcData<ModelInfo>(await this.options.rpc.send({ type: "set_model", provider, modelId }));
        this.rememberPrimaryDisplaySettings({ model });
        return json(response, 200, { model, pending: false });
      } finally { releasePrimaryOperation(); }
    }

    if (url.pathname === "/api/thinking/set") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || await bodyJson(request);
      const allowed: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      const level = typeof body.level === "string" && allowed.includes(body.level as ThinkingLevel) ? body.level as ThinkingLevel : null;
      const sessionId = requiredSessionId(body);
      // Thinking level does not claim control, but an observing window must not
      // silently overwrite settings owned by another active controller.
      this.assertNoForeignController(sessionId, clientId);
      const secondaryRuntime = this.runtimePool.get(sessionId) || null;
      if (!level) return json(response, 400, { error: "无效的 Thinking 强度" });
      if (!secondaryRuntime && sessionId !== this.activeSessionId) return json(response, 409, { error: "该会话尚未启用" });
      if (secondaryRuntime) {
        return this.runtimePool.withOperation(secondaryRuntime, async () => {
          if (secondaryRuntime.failed || secondaryRuntime.rpc.isRunning?.() === false) await this.recoverRuntime(secondaryRuntime);
          if (secondaryRuntime.running) {
            secondaryRuntime.pendingTurnSettings.thinkingLevel = level;
            this.rememberRuntimeDisplaySettings(secondaryRuntime, { thinkingLevel: level });
            return json(response, 200, { level, pending: true });
          }
          await secondaryRuntime.rpc.send({ type: "set_thinking_level", level });
          const state = asState(await secondaryRuntime.rpc.send({ type: "get_state" }));
          secondaryRuntime.lastState = state;
          secondaryRuntime.running = state.isStreaming;
          return json(response, 200, { level: state.thinkingLevel, pending: false });
        });
      }
      const releasePrimaryOperation = this.primaryOperationAdmission.acquire().release;
      try {
        await this.ensurePrimaryRuntime();
        if (this.running) {
          this.pendingTurnSettings.thinkingLevel = level;
          this.rememberPrimaryDisplaySettings({ thinkingLevel: level });
          return json(response, 200, { level, pending: true });
        }
        await this.options.rpc.send({ type: "set_thinking_level", level });
        const state = asState(await this.options.rpc.send({ type: "get_state" }));
        this.lastPrimaryState = state;
        this.running = state.isStreaming;
        return json(response, 200, { level: state.thinkingLevel, pending: false });
      } finally { releasePrimaryOperation(); }
    }

    if (url.pathname === "/api/resources/browse") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      const kind = typeof body.kind === "string" ? body.kind : "";
      if (!["skills-root", "extensions-root", "packages-root", "models-root"].includes(kind)) {
        return json(response, 400, { error: "kind 无效" });
      }
      const path = this.options.resources.resolveBrowsePath(kind as "skills-root" | "extensions-root" | "packages-root" | "models-root");
      await revealInExplorer(path);
      json(response, 200, { ok: true, path });
      return;
    }

    if (url.pathname === "/api/resources/skills") {
      if (request.method !== "GET") return methodNotAllowed(response);
      const result = await this.options.resources.listSkills(this.currentCwd);
      return json(response, 200, { ...result, resources: result.resources.filter((item) => item.enabled) });
    }

    if (url.pathname === "/api/resources/extensions") {
      if (request.method !== "GET") return methodNotAllowed(response);
      const result = await this.options.resources.listExtensions(this.currentCwd);
      return json(response, 200, { ...result, resources: result.resources.filter((item) => item.enabled) });
    }

    if (url.pathname === "/api/resources/packages") {
      if (request.method !== "GET") return methodNotAllowed(response);
      const result = await this.options.resources.listPackages(this.currentCwd);
      return json(response, 200, { ...result, resources: result.resources.filter((item) => item.enabled) });
    }

    if (url.pathname === "/api/extension-ui/respond") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || await bodyJson(request);
      if (typeof body.id !== "string") return json(response, 400, { error: "id 必填" });
      const sessionId = requiredSessionId(body);
      this.requireSessionControl(sessionId, clientId);
      const runtime = this.runtimePool.get(sessionId);
      const targetRpc = runtime?.rpc || (sessionId === this.activeSessionId ? this.options.rpc : null);
      if (!targetRpc) return json(response, 409, { error: "Extension 对应的会话已经关闭" });
      // Claim synchronously so two windows cannot answer the same request. Keep
      // the authoritative pending state until sendRaw succeeds; a transport
      // failure must leave the dialog retryable.
      const claimKey = `${sessionId}\u0000${body.id}`;
      const pending = this.pendingRequestForSession(sessionId);
      if (!pending || pending.id !== body.id || this.claimingExtensionRequests.has(claimKey)) return json(response, 409, { error: "该确认已在另一窗口处理，或已失效" });
      this.claimingExtensionRequests.add(claimKey);
      let releaseRuntimeOperation: (() => void) | null = null;
      try {
        releaseRuntimeOperation = runtime
          ? this.runtimePool.acquireOperation(runtime)
          : this.primaryOperationAdmission.acquire().release;
        const command: Record<string, unknown> = { type: "extension_ui_response", id: body.id };
        if (body.cancelled === true) command.cancelled = true;
        else if (typeof body.confirmed === "boolean") command.confirmed = body.confirmed;
        else if (typeof body.value === "string") command.value = body.value;
        else command.cancelled = true;
        targetRpc.sendRaw(command);
        this.clearPendingRequest(sessionId, body.id);
        json(response, 200, { ok: true });
      } finally {
        releaseRuntimeOperation?.();
        this.claimingExtensionRequests.delete(claimKey);
      }
      return;
    }

    json(response, 404, { error: "API not found" });
  }

  private async serveStatic(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    const root = resolve(this.options.webRoot);
    const requestPath = pathname === "/" ? "index.html" : normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
    let filePath = resolve(root, requestPath);
    if (!filePath.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`) && filePath !== root) {
      return json(response, 403, { error: "Forbidden" });
    }
    if (!existsSync(filePath) || !(await stat(filePath)).isFile()) {
      const acceptsHtml = String(request.headers.accept || "").includes("text/html");
      const looksLikeAsset = Boolean(extname(requestPath));
      if (!acceptsHtml || looksLikeAsset) return json(response, 404, { error: "Not found" });
      filePath = join(root, "index.html");
    }
    if (!existsSync(filePath)) return json(response, 404, { error: "前端尚未构建，请先运行 npm run build" });
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
      "cache-control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    createReadStream(filePath).pipe(response);
  }
}
