import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, normalize, resolve } from "node:path";
import {
  appendTerminalMessage,
  reconcilePersistedHistory,
} from "../shared/streaming-assistant.js";
import { compareSessionsByLastUserPrompt } from "../shared/session-order.js";
import { MAX_PROMPT_IMAGES_ENCODED_BYTES } from "../shared/rpc-contracts.js";
import type { PromptEvidenceFactKind } from "../shared/prompt-evidence.js";
import { decodeCanonicalMessageEndPayload } from "../shared/runtime-events.js";
import { shouldRetainStateDiagnosticEvent } from "../shared/state-diagnostics.js";
import type {
  ApplicationLifecycle,
  BackgroundSubagentSnapshot,
  BootstrapData,
  BuildIdentity,
  ExtensionUiRequest,
  GateMode,
  HealthData,
  InitialPromptData,
  InitialPromptRequest,
  ModelInfo,
  PiMessage,
  PiState,
  PrimaryRuntimeReadiness,
  PromptDelivery,
  PromptImage,
  PromptSettingsSnapshot,
  QueuedPrompt,
  SessionActivityState,
  SessionDirectorySummary,
  SessionRuntimeReadyData,
  SessionStats,
  SessionSummary,
  SessionViewData,
  SlashCommand,
  ThinkingLevel,
} from "../shared/types.js";
import {
  ApplicationBusyError,
  ApplicationLifecycleConflictError,
  ApplicationLifecycleCoordinator,
  lifecycleMessage,
} from "./application-lifecycle.js";
import {
  pickLocalFiles,
  pickWorkspaceFolder,
  readClipboardFiles,
  revealInExplorer,
} from "./file-picker.js";
import {
  type FileSnapshot,
  restoreSnapshots,
  snapshotFile,
} from "./file-transaction.js";
import {
  bodyJson,
  HttpRequestError,
  json,
  methodNotAllowed,
  MIME_TYPES,
  requestClientId,
  requestPageId,
  SECURITY_HEADERS,
} from "./http-transport.js";
import { ModelManager } from "./model-manager.js";
import {
  OperationAdmission,
  OperationAdmissionClosedError,
} from "./operation-admission.js";
import { ResourceManager } from "./resource-manager.js";
import {
  incidentErrorCode,
  incidentReference,
  recordIncident,
  type IncidentControlState,
  type IncidentDiagnostics,
  type IncidentFields,
  type IncidentOperation,
} from "./incident-diagnostics.js";
import {
  PiRpcClient,
  RpcFrameTooLargeError,
  RpcRequestTimeoutError,
  rpcData,
  type RpcEventSource,
  type RpcRequestObservation,
} from "./rpc-client.js";
import {
  asCommands,
  asMessages,
  asModels,
  asSessionStats,
  asState,
  messageWindow,
  promptImages,
  RECENT_TURN_WINDOW_SIZE,
} from "./pi-data.js";
import {
  idForPath,
  parseSessionContent,
  readSessionMessages,
  readSessionSnapshotContent,
  SessionIndex,
  type SessionFileSnapshot,
  type SessionSettingsSnapshot,
  type SessionUsageSnapshot,
} from "./session-index.js";
import {
  PartialTurnSettingsError,
  RuntimeCapacityError,
  RuntimePool,
  SessionNotFoundError,
  type AppliedTurnSettings,
  type PendingTurnSettings,
  type SecondaryRuntime,
} from "./runtime-pool.js";
import {
  SessionControl,
  SessionControlConflictError,
} from "./session-control.js";
import {
  PromptScheduler,
  PROMPT_PREPARE_TIMEOUT_MS,
  type PromptAcceptance,
} from "./prompt-scheduler.js";
import {
  PrimaryRuntimeReadinessController,
  PrimaryRuntimeUnavailableError,
  type PrimaryRuntimeAdoptionContext,
  type PrimaryRuntimeReadinessBridge,
} from "./primary-runtime-readiness.js";
import { SseHub } from "./sse-hub.js";
import { PromptEvidenceLedger } from "./prompt-evidence-ledger.js";
import { StateDiagnosticsRecorder } from "./state-diagnostics.js";
import { ServerStreamDiagnosticsAggregator } from "./stream-observability.js";
import { saveWorkspace } from "./workspace-state.js";
import { requestGuardError } from "./request-guard.js";
import {
  fastModeStatusFromExtensionEvent,
  transitionRuntimeEvent,
  type RuntimeEventState,
} from "./runtime-event-transition.js";
import { handleBootstrapRoute } from "./routes/bootstrap.js";
import { handleSessionsReadRoute } from "./routes/sessions-read.js";
import { handleSubagentsReadRoute } from "./routes/subagents-read.js";
import { SubagentStatusProvider } from "./subagent-status-provider.js";
import { apiRouteAdmission, PROMPT_BODY_LIMIT } from "./api-route-admission.js";

export {
  messageWindow,
  promptImages,
  RECENT_TURN_WINDOW_SIZE,
} from "./pi-data.js";
export { PROMPT_PREPARE_TIMEOUT_MS } from "./prompt-scheduler.js";
export const TURN_WINDOW_INCREMENT = 10;
const MAX_TURN_WINDOW_SIZE = 10_000;
const DEFAULT_SESSION_LIST_SIZE = 30;
const DEFAULT_DIRECTORY_SESSION_LIST_SIZE = 15;
/** Directory pagination returns a cumulative prefix so recency reordering cannot skip rows. */
const MAX_DIRECTORY_SESSION_LIST_SIZE = 5_000;
const DEFAULT_SECONDARY_RUNTIME_SWEEP_MS = 60 * 1_000;
const DEFAULT_GATE_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_LAST_WINDOW_SHUTDOWN_GRACE_MS = 10_000;
const DEFAULT_LAST_WINDOW_SHUTDOWN_POLL_MS = 500;
// A handshake is early enough to protect an F5 replacement from the old page's
// close beacon, but it is not proof that a renderer survived to open SSE.
const DEFAULT_HANDSHAKE_PAGE_TIMEOUT_MS = 30_000;
// `agent_settled` is followed by a FIFO state barrier. Like cold startup, a
// fully configured Pi Runtime can take longer than a few seconds to answer it.
const SETTLEMENT_STATE_TIMEOUT_MS = 60_000;
/** Bounded native steering backlog: Pi's queue, admissions, snapshots, and hidden local turns all grow with every accepted Steer. */
const MAX_NATIVE_STEERING = 20;
const MAX_NATIVE_STEERING_IMAGE_CHARS = MAX_PROMPT_IMAGES_ENCODED_BYTES;
// Pi may emit agent_settled before the new JSONL user record is visible to a
// concurrent reader. Keep the draft's provisional sidebar summary only across
// this small bounded visibility window.
const DRAFT_PERSISTENCE_RETRY_DELAYS_MS = [40, 120, 300, 700];
const SESSION_ID_PATTERN = /^[a-f0-9]{20}$/;
const PROMPT_TRACE_EVIDENCE: Readonly<Partial<Record<string, PromptEvidenceFactKind>>> = {
  admitted: "admitted",
  queued: "queued",
  cancelled: "cancelled",
  dispatch: "dispatch",
  requeued: "requeued",
  "delivery-uncertain": "delivery-uncertain",
  "agent-start": "agent-start",
  settled: "settled",
  "settlement-barrier": "settlement-barrier",
  "process-failed": "process-failed",
};
const PROMPT_RPC_EVIDENCE: Readonly<Record<RpcRequestObservation["outcome"], PromptEvidenceFactKind>> = {
  allocated: "rpc-allocated",
  written: "rpc-written",
  "response-success": "rpc-response-success",
  "response-error": "rpc-response-error",
  "not-written": "rpc-not-written",
  "written-outcome-unknown": "rpc-written-outcome-unknown",
  "process-rejected": "rpc-process-rejected",
};
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "new", description: "新建会话", source: "builtin" },
  {
    name: "compact",
    description: "压缩当前会话上下文，可附加指令",
    source: "builtin",
  },
  { name: "abort", description: "停止当前生成", source: "builtin" },
];

function gateModeFromCommand(message: string): GateMode | null {
  const command = /^\/gate\s+([^\s]+)\s*$/i
    .exec(message.trim())?.[1]
    ?.toLowerCase();
  if (["strict", "on", "close", "closed", "enable"].includes(command || ""))
    return "strict";
  if (["open", "off", "allow", "disable"].includes(command || ""))
    return "open";
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

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Parse the immutable next-turn selection attached to one ordinary prompt. */
function promptSettingsSnapshot(body: Record<string, unknown>): PromptSettingsSnapshot | undefined {
  if (body.settings === undefined) return undefined;
  if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings))
    throw new HttpRequestError(400, "消息设置格式无效");
  const raw = body.settings as Record<string, unknown>;
  const rawModel = raw.model;
  let model: PromptSettingsSnapshot["model"];
  if (rawModel !== undefined) {
    if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel))
      throw new HttpRequestError(400, "模型设置格式无效");
    const candidate = rawModel as Record<string, unknown>;
    const provider = typeof candidate.provider === "string" ? candidate.provider.trim() : "";
    const modelId = typeof candidate.modelId === "string" ? candidate.modelId.trim() : "";
    if (
      !provider ||
      !modelId ||
      provider.length > 80 ||
      modelId.length > 200 ||
      /[\u0000-\u001f]/.test(provider) ||
      /[\u0000-\u001f]/.test(modelId)
    )
      throw new HttpRequestError(400, "模型设置无效");
    model = { provider, modelId };
  }
  const thinkingLevel =
    typeof raw.thinkingLevel === "string" &&
    THINKING_LEVELS.includes(raw.thinkingLevel as ThinkingLevel)
      ? (raw.thinkingLevel as ThinkingLevel)
      : undefined;
  if (raw.thinkingLevel !== undefined && !thinkingLevel)
    throw new HttpRequestError(400, "无效的 Thinking 强度");
  if (!model && !thinkingLevel)
    throw new HttpRequestError(400, "消息设置不能为空");
  return {
    ...(model ? { model } : null),
    ...(thinkingLevel ? { thinkingLevel } : null),
  };
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
  devMiddleware?: (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => void;
  secondaryRuntimeIdleMs?: number;
  /** Primary counts separately; default 6 Secondary Runtimes means 7 hot conversations total. */
  maxSecondaryRuntimes?: number;
  maxIdleSecondaryRuntimes?: number;
  secondaryRuntimeSweepMs?: number;
  controllerReleaseMs?: number;
  /** Foreground browser lease duration; separate from the SSE transport socket. */
  presenceTtlMs?: number;
  gateRequestTimeoutMs?: number;
  sseHeartbeatMs?: number;
  /** Private benchmark seam; ordinary production leaves the SseHub default intact. */
  sseSnapshotIntervalMs?: number;
  /**
   * Opt-in legacy behavior that stops the service after the final foreground
   * window closes. Disabled by default so browser crashes, test windows, and
   * ordinary window closure cannot take down the local service.
   */
  lastWindowAutoShutdownEnabled?: boolean;
  /** Quiescent grace after every browser/PWA window has explicitly left. */
  lastWindowShutdownGraceMs?: number;
  /** Busy-state polling interval while the last-window shutdown waits for work. */
  lastWindowShutdownPollMs?: number;
  /** Time a handshake-only page can defer last-window shutdown before SSE confirms it. */
  handshakePageTimeoutMs?: number;
  now?: () => number;
  allowedHosts?: string[];
  requestToken?: string;
  /** Identity shared by this Node process and the Web bundle in its runtime dist. */
  buildIdentity?: BuildIdentity;
  /** Process-wide incident identity shared with RPC and the private JSONL sink. */
  runEpoch?: string;
  diagnostics?: IncidentDiagnostics;
  /** Build a staged replacement; PiChatApp promotes it only after its second quiescence check. */
  applicationRestart?: () => Promise<PreparedApplicationRestart>;
  /** Gracefully terminate the entire Pi Chat service process after explicit user intent. */
  applicationShutdown?: (reason: ApplicationShutdownReason) => void;
  /** Index owns spawn/probe/retry; App only projects and gates capability use. */
  primaryRuntime?: PrimaryRuntimeReadinessBridge;
  /** Test seam for the native directory picker; production uses pickWorkspaceFolder. */
  pickWorkspaceFolder?: (initialPath?: string) => Promise<string | null>;
}

/** Per-worker native steering snapshot with Pi's queue contents and verified dequeues. */
interface NativeSteeringSnapshot {
  /** RPC worker generation this snapshot belongs to. */
  generation: number;
  /** Messages still queued inside Pi (from the latest queue_update). */
  messages: string[];
  /**
   * Messages Pi dequeued (queue_update shrank) whose consuming user
   * message_start is expected next. Pi removes a steering message BEFORE it
   * forwards the message_start, so a matching dequeue verifies consumption.
   */
  dequeued: string[];
}

/** Accepted native steers waiting for Pi consumption, scoped to one worker generation. */
interface NativeSteeringAdmissions {
  generation: number;
  items: Array<{ message: string; promptAt: number; imageChars: number }>;
}

interface ActivePromptDiagnostic {
  promptId: string;
  rpcGeneration: number;
}

class NativeSteeringResetError extends Error {
  readonly droppedCount: number;

  constructor(cause: unknown, droppedCount: number) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "NativeSteeringResetError";
    this.droppedCount = droppedCount;
  }
}

export class PiChatApp {
  private readonly sseHub: SseHub;
  private readonly promptEvidence: PromptEvidenceLedger;
  private readonly stateDiagnostics: StateDiagnosticsRecorder;
  private readonly streamDiagnostics: ServerStreamDiagnosticsAggregator;
  /** Same Map as SseHub; dual-session tests seed write stubs here. */
  private readonly sseClients: Map<ServerResponse, string>;
  private readonly scheduler: PromptScheduler;
  private readonly unsubscribe: () => void;
  private lastPrimaryState: PiState = { model: null, isStreaming: false };
  private closed = false;
  private currentCwd: string;
  /** Monotonic workspace default version, scoped by this.runEpoch across a handoff. */
  private workspaceRevision = 0;
  /** Primary's true process cwd never follows mutable future-draft defaults. */
  private readonly primaryRuntimeCwd: string;
  private readonly subagentStatuses = new SubagentStatusProvider();
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
  private readonly draftPersistenceRetryTimers = new Map<
    SecondaryRuntime,
    NodeJS.Timeout
  >();
  private readonly claimingExtensionRequests = new Set<string>();
  /** FIFO admission per Session prevents simultaneous prompt requests bypassing the queue. */
  private readonly promptAdmissionTails = new Map<string, Promise<void>>();
  /** Observation-only prompt correlation; never consulted for scheduling or Runtime state. */
  private readonly activePromptDiagnostics = new Map<string, ActivePromptDiagnostic>();
  /** Serializes default-workspace commits after native pickers return. */
  private workspaceCommitTail: Promise<void> = Promise.resolve();
  private primaryFailed = false;
  private primaryRecovery: Promise<void> | null = null;
  private readonly primaryOperationAdmission = new OperationAdmission();
  private readonly now: () => number;
  private readonly gateRequestTimeoutMs: number;
  private readonly sseHeartbeatMs: number;
  private readonly secondaryRuntimeSweepTimer: NodeJS.Timeout;
  private readonly lastWindowAutoShutdownEnabled: boolean;
  private readonly lastWindowShutdownGraceMs: number;
  private readonly lastWindowShutdownPollMs: number;
  private readonly handshakePageTimeoutMs: number;
  private lastWindowShutdownTimer: NodeJS.Timeout | null = null;
  private lastWindowIdleSince: number | null = null;
  private autoShutdownRunning = false;
  /** Page-instance registry is separate from client identity used for control. */
  private readonly connectedPageClients = new Map<string, string>();
  /** Exact transport-to-page binding; unlike page leases, it ends on SSE disconnect. */
  private readonly ssePageByResponse = new Map<ServerResponse, string>();
  /** Handshake pages expire unless their own EventSource promotes them. */
  private readonly pendingWindowPageTimers = new Map<string, NodeJS.Timeout>();
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
  private lastPrimaryStats:
    { sessionId: string; value: SessionStats } | undefined;
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
  /** Short, Session-scoped reason retained only while an owned Runtime is failed. */
  private readonly runtimeFailureReasonsBySession = new Map<string, string>();
  /** Same metadata-only incident ID shown in the Sidebar and private JSONL. */
  private readonly runtimeIncidentIdsBySession = new Map<string, string>();
  /** Fresh accepted prompts win over JSONL mtime while a Runtime is alive. */
  private readonly lastUserPromptAtBySession = new Map<string, number>();
  /** Preserve arrival order even when two local requests share one Date.now() millisecond. */
  private lastPromptOrderAt = 0;
  /** Authoritative mode of the bundled Gate extension in the Primary Runtime. */
  private primaryGateMode: GateMode = "strict";
  private readonly runEpoch: string;
  private readonly runGenerationsBySession = new Map<string, number>();
  /** Session preference survives Runtime reclaim, but never outlives the Pi Chat process. */
  private readonly gateModesBySession = new Map<string, GateMode>();
  /** Read-only extension footer status; it never participates in Runtime or Pane authority. */
  private readonly fastModeBySession = new Map<string, boolean>();
  /** Primary may emit session_start status before get_state binds its exact Session. */
  private pendingPrimaryFastMode?: { rpcGeneration: number; active: boolean };
  /** Pi-native steering is private to each RPC worker until message_start consumes it. */
  private readonly pendingNativeSteeringBySession = new Map<
    string,
    NativeSteeringSnapshot
  >();
  /** Admission timestamps become sidebar recency only when Pi consumes the steering message. */
  private readonly nativeSteeringAdmissionsBySession = new Map<
    string,
    NativeSteeringAdmissions
  >();
  /** Session → generation whose settlement deferred steering cleanup. */
  private readonly nativeSteeringResetAfterSettlement = new Map<string, number>();
  /** Route, Stop, and settlement cleanup share one Runtime reset per Session. */
  private readonly nativeSteeringResets = new Map<string, Promise<void>>();
  /** Queue authority captured by the Primary restart currently being adopted. */
  private primaryRecoveryFence?: { abortGeneration: number };

  // Primary queue/runtime flags live on PromptScheduler; aliases keep route handlers stable.
  private get promptQueue() {
    return this.scheduler.primaryQueue;
  }
  private get running() {
    return this.scheduler.primaryRunning;
  }
  private set running(value: boolean) {
    this.scheduler.primaryRunning = value;
  }
  private get queuePaused() {
    return this.scheduler.primaryQueuePaused;
  }
  private set queuePaused(value: boolean) {
    this.scheduler.primaryQueuePaused = value;
  }
  private get dispatching() {
    return this.scheduler.primaryDispatching;
  }
  private set dispatching(value: boolean) {
    this.scheduler.primaryDispatching = value;
  }
  private get liveMessage() {
    return this.scheduler.primaryLiveMessage;
  }
  private set liveMessage(value: PiMessage | undefined) {
    this.scheduler.primaryLiveMessage = value;
  }
  private get toolStatus() {
    return this.scheduler.primaryToolStatus;
  }
  private set toolStatus(value: string) {
    this.scheduler.primaryToolStatus = value;
  }
  private get pendingTurnSettings() {
    return this.scheduler.primaryPendingTurnSettings;
  }
  private get pendingExtensionRequest() {
    return this.scheduler.primaryPendingExtensionRequest;
  }
  private set pendingExtensionRequest(value: ExtensionUiRequest | undefined) {
    this.scheduler.primaryPendingExtensionRequest = value;
  }

  constructor(private readonly options: PiChatAppOptions) {
    this.runEpoch = options.runEpoch || randomBytes(16).toString("base64url");
    this.currentCwd = resolve(options.cwd);
    this.primaryRuntimeCwd = this.currentCwd;
    this.startupModels = this.readStartupModels();
    // Cold JSONL views resolve persisted model metadata through knownModels.
    // Seed it from the configured catalogue so models.json models keep their
    // reasoning/input/contextWindow instead of degrading to a bare-name fallback.
    this.rememberModelContextWindows(this.startupModels);
    this.requestToken =
      options.requestToken || randomBytes(32).toString("base64url");
    this.buildIdentity = options.buildIdentity || {
      schemaVersion: 1,
      packageVersion: "unknown",
      revision: "unknown",
      fingerprint: "unknown",
      builtAt: "unknown",
    };
    this.now = options.now || Date.now;
    this.promptEvidence = new PromptEvidenceLedger({ now: this.now });
    this.stateDiagnostics = new StateDiagnosticsRecorder({
      runEpoch: this.runEpoch,
      buildFingerprint: this.buildIdentity.fingerprint,
      now: this.now,
      promptEvidence: () => this.promptEvidence.snapshot(),
    });
    this.streamDiagnostics = new ServerStreamDiagnosticsAggregator((summary) => {
      this.traceState(
        "sse-transport",
        "snapshot-summary",
        summary.sessionId,
        summary.details,
        undefined,
        summary.runGeneration,
      );
    });
    this.sseHub = new SseHub(options.sseSnapshotIntervalMs);
    this.sseHub.setDiagnosticObserver((event) => {
      if (this.streamDiagnostics.observe(event)) return;
      this.traceState(
        "sse-transport",
        event.outcome,
        event.sessionId || "",
        {
          outcome: event.outcome,
          eventType: event.eventType,
          originalEventType: event.originalEventType,
          size: event.size,
          transportClients: event.transportClients,
          controlledByThisWindow: event.controlledByThisWindow,
          foreignOwnerPresent: event.foreignOwnerPresent,
          disconnectReason: event.disconnectReason,
          pendingBytes: event.pendingBytes,
        },
        undefined,
        event.runGeneration,
      );
    });
    // Install adoption before index.ts starts the controller. Readiness remains
    // `starting` until this App has consumed the exact startup response and
    // completed all state required for browser mutations.
    options.primaryRuntime?.setAdopter?.((response, context) =>
      this.adoptPrimaryRuntime(response, context),
    );
    options.primaryRuntime?.subscribe((readiness) => {
      this.broadcast({
        type: "pi_chat_primary_runtime_status",
        primaryRuntime: this.browserPrimaryReadiness(readiness),
      });
    });
    this.sseClients = this.sseHub.clientMap;
    this.lifecycleCoordinator = new ApplicationLifecycleCoordinator(() =>
      this.broadcastLifecycle(),
    );
    // Bare loopback names are used only by in-process test apps. The production
    // entrypoint replaces them with one exact host:port after listen().
    this.allowedHosts = options.allowedHosts || [
      "127.0.0.1",
      "localhost",
      "::1",
    ];
    this.gateRequestTimeoutMs = Math.max(
      1,
      options.gateRequestTimeoutMs ?? DEFAULT_GATE_REQUEST_TIMEOUT_MS,
    );
    this.sseHeartbeatMs = Math.max(10, options.sseHeartbeatMs ?? 20_000);
    this.lastWindowAutoShutdownEnabled =
      options.lastWindowAutoShutdownEnabled ?? false;
    this.lastWindowShutdownGraceMs = Math.max(
      0,
      options.lastWindowShutdownGraceMs ??
        DEFAULT_LAST_WINDOW_SHUTDOWN_GRACE_MS,
    );
    this.lastWindowShutdownPollMs = Math.max(
      10,
      options.lastWindowShutdownPollMs ?? DEFAULT_LAST_WINDOW_SHUTDOWN_POLL_MS,
    );
    this.handshakePageTimeoutMs = Math.max(
      10,
      options.handshakePageTimeoutMs ?? DEFAULT_HANDSHAKE_PAGE_TIMEOUT_MS,
    );
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
      acquirePrimaryOperation: () =>
        this.primaryOperationAdmission.acquire().release,
      acquireRuntimeOperation: (runtime) =>
        this.runtimePool.acquireOperation(runtime),
      touchRuntime: (runtime) => this.runtimePool.touch(runtime),
      applyPendingTurnSettings: (rpc, pending) =>
        this.applyPendingTurnSettings(rpc, pending),
      applyPromptSettings: (rpc, pending, settings, consumeSupersededLegacy) =>
        this.applyPromptSettings(
          rpc,
          pending,
          settings,
          consumeSupersededLegacy,
        ),
      onPrimaryPromptSettingsApplied: (settings) =>
        this.rememberPrimaryAppliedTurnSettings(settings),
      onRuntimePromptSettingsApplied: (runtime, settings) =>
        this.rememberRuntimeAppliedTurnSettings(runtime, settings),
      syncGateMode: (rpc, sessionId, mode) =>
        this.syncGateMode(rpc, sessionId, mode),
      promptRpcObserver: (rpc, sessionId, promptId) =>
        this.promptRpcObserver(rpc, sessionId, promptId),
      tracePrompt: (sessionId, promptId, name) =>
        this.tracePrompt(name, sessionId, promptId),
      abandonPromptDiagnostic: (sessionId, promptId) =>
        this.clearPromptDiagnostic(sessionId, promptId),
      broadcast: (event) => this.broadcast(event),
      publishSessionActivity: (sessionId) =>
        this.broadcastSessionActivity(sessionId),
      onPrimaryPromptAccepted: (sessionId, promptAt) => {
        this.recordUserPrompt(sessionId, promptAt);
        this.warmPrimaryMessageSnapshot();
        this.broadcast({
          type: "pi_chat_sessions_changed",
          action: "created",
          sessionId,
        });
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
        this.broadcast({
          type: "pi_chat_sessions_changed",
          action: "created",
          sessionId: runtime.id,
        });
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
        if (
          !this.options.primaryRuntime ||
          this.primaryReadiness().status === "ready"
        )
          return;
        throw new PrimaryRuntimeUnavailableError(this.primaryReadiness());
      },
      cwd: () => this.currentCwd,
      refreshSessions: async () => {
        await this.options.sessions.list(undefined, this.currentCwd);
      },
      pathForId: (id) => this.options.sessions.pathForId(id),
      summaryForId: (id) => this.options.sessions.summaryForId?.(id) || null,
      isClosed: () => this.closed,
      canSweep: () =>
        this.applicationLifecycle === "idle" &&
        this.activeMutationRequests === 0,
      isViewed: (sessionId) => this.sessionControl.isViewed(sessionId),
      onSecondaryEvent: (runtime, event, source) =>
        this.handleSecondaryEvent(runtime, event, source),
      onReclaimed: (runtime) => this.setFastModeActive(runtime.id, false),
      activeSessionIds: () => this.activeSessionIds(),
      broadcast: (event) => {
        // RuntimePool owns worker restart, while App owns the browser-visible
        // lifecycle generation. Stamp recovery before it reaches SSE so a
        // queued old-child error can never repaint a recovered Session.
        if (
          event.type === "pi_chat_process_recovered" &&
          typeof event.piChatSessionId === "string"
        ) {
          const piChatRunGeneration = this.advanceSessionRunGeneration(
            event.piChatSessionId,
          );
          this.broadcast({
            ...event,
            piChatRunEpoch: this.runEpoch,
            piChatRunGeneration,
          });
          return;
        }
        this.broadcast(event);
      },
    });
    this.runtimes = this.runtimePool.runtimes;
    this.sseHub.onDisconnect((response, clientId, info) => {
      const pageId = this.ssePageByResponse.get(response) || "";
      this.ssePageByResponse.delete(response);
      const pageStillConnected = Boolean(
        pageId &&
        [...this.ssePageByResponse.values()].some(
          (connectedPageId) => connectedPageId === pageId,
        ),
      );
      // SseHub is the one canonical transport departure path. It covers both
      // request-close and server-initiated slow-client/write-error removal, so
      // SessionControl decrements this connection exactly once. Clear page
      // presence only after its final overlapping EventSource has departed.
      this.clientDisconnected(clientId, pageStillConnected ? "" : pageId);
      // Transport diagnostics deliberately exclude client/session identity and
      // payloads. A dropped EventSource remains recoverable and must not alter
      // application lifecycle or Runtime ownership.
      const bytes =
        typeof info.pendingBytes === "number"
          ? `, pendingBytes=${info.pendingBytes}`
          : "";
      console.info(
        `[Pi Chat] SSE disconnected (reason=${info.reason}${bytes})`,
      );
    });
    const sweepMs = Math.max(
      100,
      options.secondaryRuntimeSweepMs ?? DEFAULT_SECONDARY_RUNTIME_SWEEP_MS,
    );
    this.secondaryRuntimeSweepTimer = setInterval(
      () => void this.runtimePool.sweep(),
      sweepMs,
    );
    this.secondaryRuntimeSweepTimer.unref();
    this.unsubscribe = options.rpc.onEvent((event, source) =>
      this.handleRpcEvent(event, source),
    );
  }

  setAllowedHosts(allowedHosts: string[]): void {
    this.allowedHosts = [...allowedHosts];
  }

  private get applicationLifecycle(): ApplicationLifecycle {
    return this.lifecycleCoordinator.lifecycle;
  }
  private get activeMutationRequests(): number {
    return this.lifecycleCoordinator.activeMutations;
  }

  private lifecycleMessage(lifecycle = this.applicationLifecycle): string {
    return lifecycleMessage(lifecycle);
  }

  private broadcastLifecycle(): void {
    this.broadcast({
      type: "pi_chat_application_lifecycle",
      lifecycle: this.applicationLifecycle,
    });
  }

  private beginLifecycle(
    lifecycle: Exclude<ApplicationLifecycle, "idle">,
  ): void {
    this.lifecycleCoordinator.begin(lifecycle);
  }
  private endLifecycle(lifecycle: Exclude<ApplicationLifecycle, "idle">): void {
    this.lifecycleCoordinator.end(lifecycle);
  }
  /** Read custom configured models without waking Pi, so the fresh startup
   * shell can offer real choices before Primary's runtime inventory arrives. */
  private readStartupModels(): ModelInfo[] {
    if (!this.options.modelManager) return [];
    try {
      const raw = JSON.parse(
        readFileSync(this.options.modelManager.path, "utf8"),
      ) as { providers?: Record<string, { models?: unknown[] }> };
      const models: ModelInfo[] = [];
      for (const [provider, config] of Object.entries(raw.providers || {})) {
        for (const item of config?.models || []) {
          if (!item || typeof item !== "object") continue;
          const value = item as Record<string, unknown>;
          if (typeof value.id !== "string" || !value.id) continue;
          const configuredInput = Array.isArray(value.input)
            ? value.input.filter(
                (entry): entry is string =>
                  entry === "text" || entry === "image",
              )
            : [];
          models.push({
            provider,
            id: value.id,
            name:
              typeof value.name === "string" && value.name
                ? value.name
                : value.id,
            reasoning: value.reasoning === true,
            input: configuredInput.length
              ? configuredInput
              : value.imageInput === true
                ? ["text", "image"]
                : ["text"],
            contextWindow:
              typeof value.contextWindow === "number"
                ? value.contextWindow
                : undefined,
            custom: true,
          });
        }
      }
      return models;
    } catch {
      return [];
    }
  }

  private beginMutation(): () => void {
    return this.lifecycleCoordinator.beginMutation();
  }

  private async beginPromptAdmission(sessionId: string): Promise<() => void> {
    const key = sessionId || "primary";
    const previous = this.promptAdmissionTails.get(key) || Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      releaseCurrent = resolveCurrent;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.promptAdmissionTails.set(key, tail);
    await previous.catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (this.promptAdmissionTails.get(key) === tail)
        this.promptAdmissionTails.delete(key);
    };
  }

  private async withLifecycle<T>(
    lifecycle: Exclude<ApplicationLifecycle, "idle">,
    action: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.beginLifecycle(lifecycle);
    try {
      await this.verifyApplicationQuiescent(action);
      return await operation();
    } finally {
      this.endLifecycle(lifecycle);
    }
  }

  private busyConversationCount(): number {
    const primaryBusy =
      this.primaryTurnActive() ||
      this.dispatching ||
      this.queuePaused ||
      this.promptQueue.length > 0 ||
      Boolean(this.pendingExtensionRequest) ||
      Boolean(this.primaryRecovery);
    return this.runtimePool.busyCount() + (primaryBusy ? 1 : 0);
  }

  private assertApplicationQuiescent(action: string): void {
    const busyCount = this.busyConversationCount();
    const transitioningCount = this.runtimePool.transitioningCount;
    if (busyCount || transitioningCount || this.activeMutationRequests) {
      throw new ApplicationBusyError(
        `仍有 ${busyCount + transitioningCount} 个对话正在执行、启动、停止、排队或等待确认，请处理完成后再${action}`,
      );
    }
  }

  private async verifyApplicationQuiescent(action: string): Promise<void> {
    this.assertApplicationQuiescent(action);
    const primaryState = this.primaryReadReady()
      ? await this.options.rpc.send({ type: "get_state" })
      : null;
    const secondaryStates = await this.runtimePool.rpcStatesForQuiescence();
    if (
      [primaryState, ...secondaryStates].some(
        (response) => response && asState(response).isStreaming,
      )
    ) {
      throw new ApplicationBusyError(`仍有对话正在执行，请完成后再${action}`);
    }
    this.assertApplicationQuiescent(action);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelLastWindowShutdown();
    clearInterval(this.secondaryRuntimeSweepTimer);
    for (const timer of this.draftPersistenceRetryTimers.values())
      clearTimeout(timer);
    this.draftPersistenceRetryTimers.clear();
    this.unsubscribe();
    // Distinct Session workers can stop concurrently. Sequential forced-stop
    // windows made shutdown/restart scale by roughly three seconds per worker.
    // Preserve a failed worker's ownership, but still release SSE/HTTP-facing
    // resources so the caller can finish a bounded fail-closed shutdown.
    let runtimeStopFailure: unknown;
    try {
      await this.runtimePool.stopAll({ cleanupDrafts: true });
    } catch (error) {
      runtimeStopFailure = error;
    }
    // Closing the hub emits the canonical disconnect callbacks. Clear control
    // state afterwards so those callbacks cannot leave fresh release timers.
    this.sseHub.closeAll();
    this.ssePageByResponse.clear();
    this.sessionControl.clear();
    for (const timer of this.pendingWindowPageTimers.values()) clearTimeout(timer);
    this.pendingWindowPageTimers.clear();
    this.connectedPageClients.clear();
    this.scheduler.clearPrimary();
    for (const timer of this.pendingExtensionTimers.values())
      clearTimeout(timer);
    this.pendingExtensionTimers.clear();
    this.claimingExtensionRequests.clear();
    this.promptAdmissionTails.clear();
    this.activePromptDiagnostics.clear();
    this.promptEvidence.clear();
    this.streamDiagnostics.clear();
    if (runtimeStopFailure) throw runtimeStopFailure;
  }

  private diagnosticRuntimeProjection(
    sessionId: string,
  ): Record<string, unknown> {
    const runtime = this.runtimePool.get(sessionId);
    const primary = sessionId === this.activeSessionId && !runtime;
    const activity = this.sessionActivity(sessionId);
    return {
      execution: activity.execution,
      running: primary ? this.running : runtime?.running === true,
      hasLive: primary ? Boolean(this.liveMessage) : Boolean(runtime?.liveMessage),
      toolActive: primary ? Boolean(this.toolStatus) : Boolean(runtime?.toolStatus),
      dispatching: primary ? this.dispatching : runtime?.dispatching === true,
      queuePaused: primary ? this.queuePaused : runtime?.queuePaused === true,
      queueLength: primary ? this.promptQueue.length : runtime?.promptQueue.length || 0,
      failed: primary ? this.primaryFailed : runtime?.failed === true,
    };
  }

  private traceState(
    category: string,
    name: string,
    sessionId = "",
    details?: Record<string, unknown>,
    rpcGeneration?: number,
    runGeneration?: number,
    promptId?: string,
  ): void {
    if (!shouldRetainStateDiagnosticEvent(category, name, details)) return;
    try {
      const runtime = sessionId ? this.runtimePool.get(sessionId) : undefined;
      this.stateDiagnostics.record({
        category,
        name,
        sessionId,
        promptId,
        runGeneration: runGeneration ?? (sessionId
          ? this.runGenerationsBySession.get(sessionId) || 0
          : undefined),
        rpcGeneration:
          rpcGeneration || runtime?.rpcGeneration ||
          (sessionId === this.activeSessionId ? this.primaryRpcGeneration : undefined),
        details: {
          ...(sessionId ? this.diagnosticRuntimeProjection(sessionId) : null),
          ...details,
        },
      });
    } catch {
      // Optional observation must never perturb Runtime, HTTP, SSE, or queue work.
    }
  }

  private tracePromptDiagnosticOnly(
    name: string,
    sessionId: string,
    promptId: string,
    rpcGeneration?: number,
    runGeneration?: number,
    details?: Record<string, unknown>,
  ): void {
    this.traceState(
      "prompt",
      name,
      sessionId,
      details,
      rpcGeneration,
      runGeneration,
      promptId,
    );
  }

  private tracePrompt(
    name: string,
    sessionId: string,
    promptId: string,
    rpcGeneration?: number,
    runGeneration?: number,
    details?: Record<string, unknown>,
  ): void {
    this.tracePromptDiagnosticOnly(
      name,
      sessionId,
      promptId,
      rpcGeneration,
      runGeneration,
      details,
    );
    const kind = PROMPT_TRACE_EVIDENCE[name];
    if (!kind) return;
    try {
      this.promptEvidence.record({
        sessionId,
        promptId,
        kind,
        rpcGeneration,
        runGeneration,
      });
    } catch {
      // Prompt evidence remains observation-only and fail-open.
    }
  }

  private activePromptDiagnostic(
    sessionId: string,
    rpcGeneration: number,
  ): ActivePromptDiagnostic | undefined {
    const active = this.activePromptDiagnostics.get(sessionId);
    if (!active) return undefined;
    if (active.rpcGeneration && rpcGeneration && active.rpcGeneration !== rpcGeneration)
      return undefined;
    return active;
  }

  private traceActivePrompt(
    name: string,
    sessionId: string,
    rpcGeneration: number,
    runGeneration?: number,
  ): string | undefined {
    const active = this.activePromptDiagnostic(sessionId, rpcGeneration);
    if (!active) return undefined;
    this.tracePrompt(
      name,
      sessionId,
      active.promptId,
      rpcGeneration,
      runGeneration,
    );
    return active.promptId;
  }

  private clearPromptDiagnostic(sessionId: string, promptId?: string): void {
    const active = this.activePromptDiagnostics.get(sessionId);
    if (!active || (promptId && active.promptId !== promptId)) return;
    this.activePromptDiagnostics.delete(sessionId);
  }

  private observePromptRpc(
    sessionId: string,
    promptId: string,
    observation: RpcRequestObservation,
  ): void {
    try {
      this.promptEvidence.record({
        sessionId,
        promptId,
        kind: PROMPT_RPC_EVIDENCE[observation.outcome],
        rpcGeneration: observation.generation,
      });
    } catch {
      // Exact delivery evidence cannot affect the authoritative RPC observer.
    }
    const name = observation.phase === "allocated"
      ? "rpc-allocated"
      : observation.phase === "written"
        ? "rpc-written"
        : observation.phase === "response"
          ? "rpc-response"
          : "rpc-failed";
    this.tracePrompt(
      name,
      sessionId,
      promptId,
      observation.generation,
      undefined,
      {
        durationMs: observation.durationMs,
        failed: observation.outcome === "response-error"
          || observation.outcome === "not-written"
          || observation.outcome === "process-rejected",
      },
    );
    if (
      observation.outcome === "response-error"
      || observation.outcome === "not-written"
    ) this.clearPromptDiagnostic(sessionId, promptId);
  }

  private promptRpcObserver(
    rpc: PiRpcClient,
    sessionId: string,
    promptId: string,
  ): (observation: RpcRequestObservation) => void {
    const rpcGeneration = rpc.currentGeneration?.() || 0;
    this.activePromptDiagnostics.set(sessionId, { promptId, rpcGeneration });
    return (observation) =>
      this.observePromptRpc(sessionId, promptId, observation);
  }

  private async sendPromptRpc(
    rpc: PiRpcClient,
    sessionId: string,
    promptId: string,
    command: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let observe: ((observation: RpcRequestObservation) => void) | undefined;
    try {
      observe = this.promptRpcObserver(rpc, sessionId, promptId);
    } catch {
      // Prompt delivery remains authoritative when observation allocation fails.
    }
    this.tracePrompt("dispatch", sessionId, promptId);
    try {
      return await rpc.send(
        command,
        PROMPT_PREPARE_TIMEOUT_MS,
        observe ? { observe } : undefined,
      );
    } catch (error) {
      if (!(error instanceof RpcRequestTimeoutError) || !error.outcomeUnknown)
        this.clearPromptDiagnostic(sessionId, promptId);
      throw error;
    }
  }

  private traceViewProjection(
    name: string,
    sessionId: string,
    view: SessionViewData | null,
  ): void {
    this.traceState("projection", name, sessionId, {
      found: Boolean(view),
      stateStreaming: view?.state.isStreaming === true,
      viewStreaming: view?.isStreaming === true,
      sessionRunning: view?.session.running === true,
      hasLive: Boolean(view?.liveMessage),
      toolActive: Boolean(view?.toolStatus),
      queuePaused: view?.queuePaused === true,
      queueLength: view?.queue?.length || 0,
      viewSource: view?.viewSource || "none",
      runtimeStatus: view?.runtimeStatus || "none",
      activityExecution: view?.session.activity?.execution || "none",
    });
  }

  private traceBootstrapProjection(data: BootstrapData): void {
    const sessionId = data.activeSessionId || "";
    const summary = data.sessions.find((session) => session.id === sessionId);
    this.traceState("projection", "bootstrap", sessionId, {
      stateStreaming: data.state.isStreaming === true,
      sessionRunning: summary?.running === true,
      hasLive: Boolean(data.liveMessage),
      toolActive: Boolean(data.toolStatus),
      queuePaused: data.queuePaused === true,
      queueLength: data.queue.length,
      activityExecution: summary?.activity?.execution || "none",
      primaryStatus: data.primaryRuntime.status,
    });
  }

  private broadcast(event: Record<string, unknown>): void {
    const sessionId =
      typeof event.piChatSessionId === "string"
        ? event.piChatSessionId
        : typeof event.sessionId === "string"
          ? event.sessionId
          : "";
    this.traceState(
      "sse",
      "broadcast-intent",
      sessionId,
      {
        eventType: typeof event.type === "string" ? event.type : "unknown",
        transportClients: this.sseHub.size,
        eventRunning: event.running === true,
        eventQueuePaused: event.paused === true,
        eventQueueLength: Array.isArray(event.queue) ? event.queue.length : 0,
        eventExecution:
          event.activity && typeof event.activity === "object" &&
          typeof (event.activity as { execution?: unknown }).execution === "string"
            ? (event.activity as { execution: string }).execution
            : "none",
      },
      undefined,
      typeof event.piChatRunGeneration === "number"
        ? event.piChatRunGeneration
        : undefined,
    );
    this.sseHub.broadcast(event);
    const eventType = typeof event.type === "string" ? event.type : "";
    const runGeneration =
      typeof event.piChatRunGeneration === "number"
        ? event.piChatRunGeneration
        : undefined;
    const activityExecution =
      event.activity && typeof event.activity === "object"
        ? (event.activity as { execution?: unknown }).execution
        : undefined;
    const terminalActivity =
      eventType === "pi_chat_session_status"
      && (activityExecution === "idle"
        || activityExecution === "queued"
        || activityExecution === "failed");
    if (
      (eventType === "agent_settled"
        || eventType === "pi_chat_process_error"
        || terminalActivity)
      && sessionId
      && runGeneration !== undefined
    ) this.streamDiagnostics.flush(sessionId, runGeneration);
  }

  private broadcastRpcEvent(
    event: Record<string, unknown>,
    sessionId: string,
    runGeneration?: number,
  ): void {
    // Pi emits cumulative tool partialResult snapshots. The web client does not
    // render them; forwarding every snapshot creates quadratic SSE traffic and
    // can freeze Chromium's main thread during long or self-referential output.
    if (event.type === "tool_execution_update") return;
    const allowedEvent = event.type === "message_end"
      ? decodeCanonicalMessageEndPayload(event)
      : event;
    if (!allowedEvent) {
      this.traceState("rpc-event", "rejected", sessionId, {
        eventType: "message_end",
        decisionReason: "malformed-critical-event",
      }, undefined, runGeneration);
      return;
    }
    const {
      piChatSessionId: _untrustedSessionId,
      piChatRunEpoch: _untrustedRunEpoch,
      piChatRunGeneration: _untrustedRunGeneration,
      ...runtimeEvent
    } = allowedEvent;
    this.broadcast({
      ...runtimeEvent,
      piChatSessionId: sessionId,
      piChatRunEpoch: this.runEpoch,
      ...(typeof runGeneration === "number"
        ? { piChatRunGeneration: runGeneration }
        : null),
    });
  }

  private broadcastControlState(sessionId: string): void {
    this.traceState("sse", "broadcast-control", sessionId, {
      eventType: "pi_chat_session_control_changed",
    });
    this.sseHub.broadcastEach((clientId) => ({
      type: "pi_chat_session_control_changed",
      sessionId,
      ...this.sessionControl.controlState(sessionId, clientId),
    }));
  }

  private publicQueue(queue = this.promptQueue): QueuedPrompt[] {
    return this.scheduler.publicQueue(queue);
  }

  private incidentControlState(
    sessionId: string,
    clientId = "",
  ): IncidentControlState {
    if (!clientId) return "no-browser-identity";
    const owner = this.sessionControllers.get(sessionId);
    if (!owner) return "unowned";
    if (owner === clientId) return "owned-by-this-window";
    return this.sessionControl.isClientPresent(owner)
      ? "owned-by-other-present-window"
      : "owned-by-stale-window";
  }

  private reportIncident(
    error: unknown,
    input: Omit<IncidentFields, "lifecycle"> & {
      lifecycle?: ApplicationLifecycle;
    },
  ) {
    return recordIncident(this.options.diagnostics, error, {
      ...input,
      lifecycle: input.lifecycle || this.applicationLifecycle,
    });
  }

  private operationForRequest(request: IncomingMessage): IncidentOperation {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname.startsWith("/api/bootstrap")) return "navigation.bootstrap";
    if (/^\/api\/sessions\/[^/]+$/.test(pathname)) return "navigation.session-view";
    if (pathname === "/api/restart") return "lifecycle.restart";
    if (pathname === "/api/shutdown") return "lifecycle.shutdown";
    if (pathname === "/api/chat/prompt") return "prompt.send";
    if (pathname === "/api/chat/abort") return "prompt.abort";
    if (pathname === "/api/extension/respond") return "extension.respond";
    if (/^\/api\/sessions\/[^/]+\/control$/.test(pathname)) return "control.takeover";
    return "navigation.request";
  }

  private sessionIdForRequest(request: IncomingMessage): string {
    const admitted = (request as IncomingMessage & {
      piChatDiagnosticSessionId?: unknown;
    }).piChatDiagnosticSessionId;
    if (typeof admitted === "string" && admitted) return admitted;
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const match = pathname.match(/^\/api\/sessions\/([a-f0-9-]{16,64})(?:\/|$)/i);
    return match?.[1] || "";
  }

  /** Keep failed-runtime diagnostics useful in the sidebar without leaking an unbounded raw transport payload. */
  private recordRuntimeFailure(
    sessionId: string,
    error: unknown,
    incidentIdValue?: string,
  ): void {
    if (!sessionId) return;
    const raw =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
    const message = raw.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
    if (message) this.runtimeFailureReasonsBySession.set(sessionId, message.slice(0, 280));
    const incidentId = incidentIdValue || incidentReference(error)?.incidentId;
    if (incidentId) this.runtimeIncidentIdsBySession.set(sessionId, incidentId);
  }

  private clearRuntimeFailure(sessionId: string): void {
    if (!sessionId) return;
    this.runtimeFailureReasonsBySession.delete(sessionId);
    this.runtimeIncidentIdsBySession.delete(sessionId);
  }

  /** Events are authoritative over a hot-memory get_state snapshot that may lag compaction lifecycle frames. */
  private updateHotCompactionState(
    runtime: SecondaryRuntime | undefined,
    isCompacting: boolean,
  ): void {
    if (runtime) {
      runtime.lastState = {
        ...(runtime.lastState || { model: null, isStreaming: runtime.running }),
        isCompacting,
      };
      return;
    }
    this.lastPrimaryState = { ...this.lastPrimaryState, isCompacting };
  }

  /** Event-owned evidence that a Primary turn still has visible or tool work. */
  private primaryTurnActive(): boolean {
    return this.running || Boolean(this.liveMessage) || Boolean(this.toolStatus);
  }

  /** Event-owned evidence that a Secondary turn still has visible or tool work. */
  private runtimeTurnActive(runtime: SecondaryRuntime): boolean {
    return runtime.running || Boolean(runtime.liveMessage) || Boolean(runtime.toolStatus);
  }

  private sessionActivity(sessionId: string): SessionActivityState {
    const runtime = this.runtimePool.get(sessionId);
    const primary = sessionId === this.activeSessionId && !runtime;
    const failed = primary
      ? this.primaryFailed
      : runtime?.failed === true || runtime?.rpc.isRunning?.() === false;
    const paused = primary ? this.queuePaused : runtime?.queuePaused === true;
    const running = primary
      ? this.primaryTurnActive()
      : Boolean(runtime && this.runtimeTurnActive(runtime));
    const dispatching = primary
      ? this.dispatching
      : runtime?.dispatching === true;
    const queued = primary
      ? this.promptQueue.length > 0
      : (runtime?.promptQueue.length || 0) > 0;
    const failureReason = failed
      ? this.runtimeFailureReasonsBySession.get(sessionId)
      : undefined;
    const failureIncidentId = failed
      ? this.runtimeIncidentIdsBySession.get(sessionId)
      : undefined;
    return {
      ...(failureReason ? { error: failureReason } : null),
      ...(failureIncidentId ? { incidentId: failureIncidentId } : null),
      // `dispatching` also covers the post-settlement FIFO get_state barrier,
      // That barrier keeps restart/shutdown safe, but with no queued turn it is
      // not visible conversation work and must not leave a blue sidebar ring.
      execution: failed
        ? "failed"
        : paused
          ? "paused"
          : running
            ? "running"
            : queued
              ? dispatching
                ? "dispatching"
                : "queued"
              : "idle",
      awaitingConfirmation: Boolean(this.pendingRequestForSession(sessionId)),
    };
  }

  /** One server-derived snapshot prevents Sidebar reconstruction from racing queue/RPC events. */
  /** A recovered worker is a fresh event source; fence off all old-child frames. */
  private advanceSessionRunGeneration(sessionId: string): number {
    const generation = (this.runGenerationsBySession.get(sessionId) || 0) + 1;
    this.runGenerationsBySession.set(sessionId, generation);
    return generation;
  }

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
      running:
        activity.execution === "running" ||
        activity.execution === "dispatching",
    });
  }

  private broadcastQueue(sessionId = this.activeSessionId): void {
    const runtime = this.runtimePool.get(sessionId);
    if (runtime) this.scheduler.broadcastRuntimeQueue(runtime);
    else this.scheduler.broadcastPrimaryQueue();
  }

  private activeSessionIds(): string[] {
    const primaryActive = this.primaryReadReady();
    return [
      ...(primaryActive ? [this.activeSessionId] : []),
      ...this.runtimePool.secondaryActiveIds(),
    ].filter((id): id is string => Boolean(id));
  }

  private controlState(
    sessionId: string,
    clientId = "",
  ): { controlOwner?: string; controlledByThisWindow?: boolean } {
    return this.sessionControl.controlState(sessionId, clientId);
  }

  private requireSessionControl(sessionId: string, clientId: string): void {
    this.sessionControl.requireControl(sessionId, clientId);
  }

  private clearPendingWindowPage(pageId: string): void {
    const timer = this.pendingWindowPageTimers.get(pageId);
    if (timer) clearTimeout(timer);
    this.pendingWindowPageTimers.delete(pageId);
  }

  /**
   * Register a browser page before SSE, without creating a transport lease.
   * The record is deliberately temporary: a crashed renderer has no unload
   * beacon, so only that page's EventSource may promote it to an open window.
   */
  private registerWindowPage(clientId: string, pageId: string): void {
    if (!clientId || !pageId) return;
    // Token recovery can repeat the handshake while this exact page still owns
    // a healthy SSE transport. Never downgrade that durable page lease back to
    // a temporary pre-SSE record: its expiry would erase the only open window
    // and could falsely trigger last-window shutdown after a long idle period.
    if (
      this.connectedPageClients.get(pageId) === clientId &&
      !this.pendingWindowPageTimers.has(pageId) &&
      this.sessionControl.isClientConnected(clientId)
    ) {
      this.cancelLastWindowShutdown();
      return;
    }
    this.connectedPageClients.set(pageId, clientId);
    this.clearPendingWindowPage(pageId);
    const timer = setTimeout(() => {
      if (this.pendingWindowPageTimers.get(pageId) !== timer) return;
      this.pendingWindowPageTimers.delete(pageId);
      if (this.connectedPageClients.get(pageId) !== clientId) return;
      this.connectedPageClients.delete(pageId);
      if (this.openWindowCount() === 0) this.scheduleLastWindowShutdown();
    }, this.handshakePageTimeoutMs);
    timer.unref();
    this.pendingWindowPageTimers.set(pageId, timer);
    this.cancelLastWindowShutdown();
  }

  /** EventSource proves the page is alive; it replaces its temporary lease. */
  private clientConnected(clientId: string, pageId = ""): void {
    if (pageId) {
      this.connectedPageClients.set(pageId, clientId);
      this.clearPendingWindowPage(pageId);
    }
    this.cancelLastWindowShutdown();
    this.sessionControl.clientConnected(clientId);
  }

  private cancelLastWindowShutdown(): void {
    this.lastWindowIdleSince = null;
    if (this.lastWindowShutdownTimer)
      clearTimeout(this.lastWindowShutdownTimer);
    this.lastWindowShutdownTimer = null;
  }

  private openWindowCount(): number {
    return this.connectedPageClients.size;
  }

  /**
   * Lifecycle actions are destructive to every browser transport and Runtime.
   * A token-bearing handshake proves only that a local caller reached this
   * process; it must not let a headless poller wait for idle and then surprise
   * still-open users with a restart. Only an EventSource-backed page may own an
   * explicit restart or shutdown request.
   */
  private isConnectedWindowPage(clientId: string, pageId: string): boolean {
    return Boolean(
      clientId &&
      pageId &&
      this.connectedPageClients.get(pageId) === clientId &&
      !this.pendingWindowPageTimers.has(pageId) &&
      [...this.ssePageByResponse.values()].some(
        (connectedPageId) => connectedPageId === pageId,
      ),
    );
  }

  private scheduleLastWindowShutdown(): void {
    if (
      !this.lastWindowAutoShutdownEnabled ||
      this.closed ||
      !this.options.applicationShutdown ||
      this.openWindowCount() > 0 ||
      this.lastWindowShutdownTimer ||
      this.autoShutdownRunning
    )
      return;
    this.lastWindowShutdownTimer = setTimeout(() => {
      this.lastWindowShutdownTimer = null;
      void this.pollLastWindowShutdown();
    }, this.lastWindowShutdownPollMs);
    this.lastWindowShutdownTimer.unref();
  }

  private async pollLastWindowShutdown(): Promise<void> {
    if (
      !this.lastWindowAutoShutdownEnabled ||
      this.closed ||
      !this.options.applicationShutdown ||
      this.openWindowCount() > 0
    ) {
      this.cancelLastWindowShutdown();
      return;
    }
    if (
      this.applicationLifecycle !== "idle" ||
      this.busyConversationCount() > 0 ||
      this.runtimePool.transitioningCount > 0 ||
      this.activeMutationRequests > 0
    ) {
      this.lastWindowIdleSince = null;
      this.scheduleLastWindowShutdown();
      return;
    }
    const now = this.now();
    this.lastWindowIdleSince ??= now;
    const remaining =
      this.lastWindowShutdownGraceMs - (now - this.lastWindowIdleSince);
    if (remaining > 0) {
      this.lastWindowShutdownTimer = setTimeout(
        () => {
          this.lastWindowShutdownTimer = null;
          void this.pollLastWindowShutdown();
        },
        Math.min(remaining, this.lastWindowShutdownPollMs),
      );
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
        console.error(
          `[Pi Chat] 自动关闭检查失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      this.autoShutdownRunning = false;
      if (this.applicationLifecycle === "idle" && this.openWindowCount() === 0)
        this.scheduleLastWindowShutdown();
    }
  }

  private releaseClient(clientId: string): string {
    for (const [pageId, owner] of this.connectedPageClients) {
      if (owner !== clientId) continue;
      this.clearPendingWindowPage(pageId);
      this.connectedPageClients.delete(pageId);
    }
    return this.sessionControl.releaseClient(clientId);
  }

  private closeWindowClient(clientId: string, pageId: string): string {
    if (!pageId || this.connectedPageClients.get(pageId) !== clientId)
      return "";
    this.clearPendingWindowPage(pageId);
    this.connectedPageClients.delete(pageId);
    this.sessionControl.pageClosed(clientId, pageId);
    const clientStillOpen = [...this.connectedPageClients.values()].some(
      (owner) => owner === clientId,
    );
    if (clientStillOpen) return "";
    return this.sessionControl.closeWindow(clientId);
  }

  private async restSessionAfterWindowClose(
    sessionId: string,
  ): Promise<boolean> {
    if (!sessionId || this.sessionControl.isViewed(sessionId)) return false;
    if (sessionId === this.activeSessionId) {
      if (
        this.running ||
        this.dispatching ||
        this.promptQueue.length ||
        this.liveMessage ||
        this.toolStatus ||
        this.pendingExtensionRequest
      )
        return false;
      const generation = await this.primaryOperationAdmission.closeAndDrain();
      if (generation === null) return false;
      if (
        this.sessionControl.isViewed(sessionId) ||
        this.running ||
        this.dispatching ||
        this.promptQueue.length ||
        this.liveMessage ||
        this.toolStatus ||
        this.pendingExtensionRequest
      ) {
        this.primaryOperationAdmission.reopen(generation);
        return false;
      }
      try {
        await this.options.rpc.stop();
        this.setFastModeActive(sessionId, false);
        this.pendingPrimaryFastMode = undefined;
        this.primaryFailed = true;
        this.broadcast({
          type: "pi_chat_active_session_changed",
          sessionId,
          activeSessionIds: this.activeSessionIds(),
          reclaimed: true,
          reason: "window-closed",
        });
        return true;
      } finally {
        this.primaryOperationAdmission.reopen(generation);
      }
    }
    const runtime = this.runtimePool.get(sessionId);
    if (!runtime || !this.runtimePool.canReclaim(runtime)) return false;
    this.clearNativeSteeringState(sessionId, "reclaim");
    return this.runtimePool.reclaim(sessionId, "idle");
  }

  private clientDisconnected(clientId: string, pageId = ""): void {
    // An SSE connection is a re-connectable transport, not a service-lifetime
    // lease. Keep the page instance registered: only its matching pagehide
    // beacon may turn a network failure into an explicit close intent.
    this.sessionControl.clientDisconnected(clientId, pageId);
  }

  private markSessionViewed(clientId: string, sessionId: string): void {
    this.sessionControl.markViewed(clientId, sessionId);
  }

  private pendingRequestForSession(
    sessionId: string,
  ): ExtensionUiRequest | undefined {
    return sessionId === this.activeSessionId
      ? this.pendingExtensionRequest
      : this.runtimePool.get(sessionId)?.pendingExtensionRequest;
  }

  private stateWithFastMode(sessionId: string, state: PiState): PiState {
    return {
      ...state,
      fastModeActive: this.fastModeBySession.get(sessionId) === true,
    };
  }

  private setFastModeActive(sessionId: string, active: boolean): void {
    if (!sessionId) return;
    const previous = this.fastModeBySession.get(sessionId) === true;
    if (active) this.fastModeBySession.set(sessionId, true);
    else this.fastModeBySession.delete(sessionId);
    if (previous === active) return;
    this.broadcast({
      type: "pi_chat_fast_mode_changed",
      piChatSessionId: sessionId,
      piChatRunEpoch: this.runEpoch,
      active,
    });
  }

  private adoptSecondaryFastMode(runtime: SecondaryRuntime): void {
    if (
      runtime.fastModeGeneration === runtime.rpcGeneration &&
      !runtime.pendingFastMode
    )
      return;
    const pending = runtime.pendingFastMode;
    runtime.pendingFastMode = undefined;
    runtime.fastModeGeneration = runtime.rpcGeneration;
    this.setFastModeActive(
      runtime.id,
      Boolean(pending && pending.rpcGeneration === runtime.rpcGeneration && pending.active),
    );
  }

  private trackPendingRequest(
    sessionId: string,
    request: ExtensionUiRequest,
  ): void {
    const previous = this.pendingExtensionTimers.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.pendingExtensionTimers.delete(sessionId);
      const current = this.pendingRequestForSession(sessionId);
      if (!current || current.id !== request.id) return;
      const runtime = this.runtimePool.get(sessionId);
      const targetRpc =
        runtime?.rpc ||
        (sessionId === this.activeSessionId ? this.options.rpc : null);
      if (targetRpc && targetRpc.isRunning?.() !== false) {
        let write: void | Promise<void>;
        try {
          write = targetRpc.sendRaw({
            type: "extension_ui_response",
            id: request.id,
            cancelled: true,
          });
        } catch (error) {
          this.broadcast({
            type: "pi_chat_process_error",
            piChatSessionId: sessionId,
            error: `权限确认超时清理失败：${error instanceof Error ? error.message : String(error)}`,
          });
          return;
        }
        void Promise.resolve(write).then(() => {
          // Clear only after Node confirms the frame was accepted by stdin.
          // A failed/unknown write keeps the request visible for diagnosis or
          // an explicit retry instead of pretending Pi consumed it.
          if (!this.clearPendingRequest(sessionId, request.id)) return;
          this.broadcast({
            type: "pi_chat_extension_request_timeout",
            piChatSessionId: sessionId,
            id: request.id,
          });
        }).catch((error) => {
          this.broadcast({
            type: "pi_chat_process_error",
            piChatSessionId: sessionId,
            error: `权限确认超时清理失败：${error instanceof Error ? error.message : String(error)}`,
          });
        });
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
    if (sessionId === this.activeSessionId)
      this.pendingExtensionRequest = undefined;
    else {
      const runtime = this.runtimePool.get(sessionId);
      if (runtime) {
        runtime.pendingExtensionRequest = undefined;
        runtime.extensionUiPending = false;
      }
    }
    this.broadcast({
      type: "pi_chat_extension_request_resolved",
      piChatSessionId: sessionId,
      id: current.id,
    });
    this.broadcastSessionActivity(sessionId);
    return true;
  }

  private runtimeEventState(
    sessionId: string,
    runtime?: SecondaryRuntime,
  ): RuntimeEventState {
    const primary = !runtime;
    return {
      runGeneration: this.runGenerationsBySession.get(sessionId) || 0,
      running: primary ? this.running : runtime.running,
      dispatching: primary ? this.dispatching : runtime.dispatching,
      failed: primary ? this.primaryFailed : runtime.failed === true,
      queuePaused: primary ? this.queuePaused : runtime.queuePaused,
      queueLength: primary
        ? this.promptQueue.length
        : runtime.promptQueue.length,
      liveMessage: primary ? this.liveMessage : runtime.liveMessage,
      toolStatus: primary ? this.toolStatus : runtime.toolStatus,
      pendingTerminalMessages: primary
        ? this.primaryPendingTerminalMessages
        : runtime.pendingTerminalMessages,
      pendingTerminalSessionId: primary
        ? this.primaryPendingTerminalSessionId
        : sessionId,
      ...(primary
        ? null
        : {
            extensionUiPending: runtime.extensionUiPending,
            preserveLiveMessageOnProcessError: true,
          }),
    };
  }

  private applyRuntimeEventTransition(
    sessionId: string,
    runtime: SecondaryRuntime | undefined,
    event: Record<string, unknown>,
  ) {
    const transition = transitionRuntimeEvent(
      sessionId,
      this.runtimeEventState(sessionId, runtime),
      event,
    );
    if (!transition.broadcastEvent) return transition;
    const state = transition.state;
    const primary = !runtime;
    this.runGenerationsBySession.set(sessionId, state.runGeneration);
    if (primary) {
      this.running = state.running;
      this.dispatching = state.dispatching;
      this.primaryFailed = state.failed;
      this.queuePaused = state.queuePaused;
      this.liveMessage = state.liveMessage;
      this.toolStatus = state.toolStatus;
      this.primaryPendingTerminalMessages = state.pendingTerminalMessages;
      this.primaryPendingTerminalSessionId =
        state.pendingTerminalSessionId || "";
    } else {
      runtime.running = state.running;
      runtime.dispatching = state.dispatching;
      runtime.failed = state.failed;
      runtime.queuePaused = state.queuePaused;
      runtime.liveMessage = state.liveMessage;
      runtime.toolStatus = state.toolStatus;
      runtime.pendingTerminalMessages = state.pendingTerminalMessages;
      runtime.extensionUiPending = state.extensionUiPending === true;
    }
    for (const effect of transition.effects) {
      if (effect.type === "context-start")
        this.beginContextUsageRefreshTurn(sessionId);
      else if (effect.type === "context-pending")
        this.markContextUsagePendingRefresh(sessionId);
      else if (effect.type === "context-complete")
        this.completeContextUsageRefreshTurn(sessionId);
      else if (effect.type === "gate-mode")
        this.setGateMode(sessionId, effect.mode);
      else if (effect.type === "fast-mode") {
        if (runtime) runtime.fastModeGeneration = runtime.rpcGeneration;
        this.setFastModeActive(sessionId, effect.active);
      }
      else if (effect.type === "extension-request") {
        if (primary) this.pendingExtensionRequest = effect.request;
        else runtime.pendingExtensionRequest = effect.request;
        this.trackPendingRequest(sessionId, effect.request);
        this.broadcastSessionActivity(sessionId);
      } else if (effect.type === "clear-extension-request")
        this.clearPendingRequest(sessionId);
      else if (effect.type === "queue-changed") this.broadcastQueue(sessionId);
      // The legacy handlers emitted the RPC frame before `created`; keep that
      // externally visible order in the owner handler below.
      else if (effect.type === "session-status")
        this.broadcast({
          type: "pi_chat_sessions_changed",
          action: "status",
          sessionId,
        });
    }
    return transition;
  }

  /** Whether this generation still has an admitted or observed native Steer to settle. */
  private hasNativeSteeringPending(
    sessionId: string,
    generation: number,
  ): boolean {
    const snapshot = this.pendingNativeSteeringBySession.get(sessionId);
    const admissions = this.nativeSteeringAdmissionsBySession.get(sessionId);
    return Boolean(
      (snapshot &&
        snapshot.generation === generation &&
        (snapshot.messages.length || snapshot.dequeued.length)) ||
        (admissions &&
          admissions.generation === generation &&
          admissions.items.length),
    );
  }

  /**
   * Drop every native-steering bookkeeping entry for a Session and notify the
   * UI with the reason and how many accepted steers could never execute. Called
   * at process-error, recovery, reclaim, delete, and reset boundaries so stale
   * bookkeeping from a dead worker generation can never pollute a replacement.
   */
  private clearNativeSteeringState(sessionId: string, reason: string): number {
    const snapshot = this.pendingNativeSteeringBySession.get(sessionId);
    const admissions = this.nativeSteeringAdmissionsBySession.get(sessionId);
    const droppedCount = Math.max(
      admissions?.items.length || 0,
      snapshot?.messages.length || 0,
    );
    this.pendingNativeSteeringBySession.delete(sessionId);
    this.nativeSteeringAdmissionsBySession.delete(sessionId);
    this.nativeSteeringResetAfterSettlement.delete(sessionId);
    if (droppedCount > 0)
      this.broadcast({
        type: "pi_chat_native_steering_cleared",
        piChatSessionId: sessionId,
        reason,
        droppedCount,
      });
    return droppedCount;
  }

  private nativeSteeringMessageText(event: Record<string, unknown>): string {
    const message =
      event.message && typeof event.message === "object"
        ? (event.message as PiMessage)
        : null;
    if (!message || message.role !== "user") return "";
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text || "")
      .join("\n");
  }

  /**
   * Returns true when this user message_start is a *verified* native steer
   * consumption: Pi dequeued the matching steering message (queue_update
   * shrank) immediately before forwarding it. A text-only match without a
   * prior dequeue may be an ordinary prompt whose text equals a pending steer
   * and must not consume the admission or reveal the local turn.
   */
  private consumeNativeSteeringAdmission(
    sessionId: string,
    event: Record<string, unknown>,
    generation: number,
  ): boolean {
    if (event.type !== "message_start") return false;
    const text = this.nativeSteeringMessageText(event);
    const snapshot = this.pendingNativeSteeringBySession.get(sessionId);
    const admissions = this.nativeSteeringAdmissionsBySession.get(sessionId);
    if (!text || !snapshot || !admissions) return false;
    if (
      snapshot.generation !== generation ||
      admissions.generation !== generation
    )
      return false;
    const dequeuedIndex = snapshot.dequeued.indexOf(text);
    if (dequeuedIndex < 0) return false;
    const index = admissions.items.findIndex(
      (admission) => admission.message === text,
    );
    if (index < 0) return false;
    snapshot.dequeued.splice(dequeuedIndex, 1);
    const [consumed] = admissions.items.splice(index, 1);
    if (admissions.items.length)
      this.nativeSteeringAdmissionsBySession.set(sessionId, admissions);
    else this.nativeSteeringAdmissionsBySession.delete(sessionId);
    if (snapshot.messages.length || snapshot.dequeued.length)
      this.pendingNativeSteeringBySession.set(sessionId, snapshot);
    else this.pendingNativeSteeringBySession.delete(sessionId);
    this.nativeSteeringResetAfterSettlement.delete(sessionId);
    this.noteUserPrompt(sessionId, consumed.promptAt);
    return true;
  }

  private updateNativeSteeringSnapshot(
    sessionId: string,
    event: Record<string, unknown>,
    generation: number,
  ): void {
    if (event.type !== "queue_update" || !Array.isArray(event.steering)) return;
    const steering = event.steering.filter(
      (message): message is string => typeof message === "string",
    );
    const previous = this.pendingNativeSteeringBySession.get(sessionId);
    const sameGeneration = previous?.generation === generation;
    const previousMessages = sameGeneration ? previous.messages : [];
    // Compute a multiset difference, not a Set difference: two identical Steer
    // messages are distinct queue entries. Preserve earlier verified dequeues
    // until their matching message_start arrives because another queue_update
    // can be emitted in that extension-controlled gap.
    const remainingCounts = new Map<string, number>();
    for (const message of steering)
      remainingCounts.set(message, (remainingCounts.get(message) || 0) + 1);
    const newlyDequeued: string[] = [];
    for (const message of previousMessages) {
      const remaining = remainingCounts.get(message) || 0;
      if (remaining > 0) remainingCounts.set(message, remaining - 1);
      else newlyDequeued.push(message);
    }
    const dequeued = [
      ...(sameGeneration ? previous.dequeued : []),
      ...newlyDequeued,
    ];
    if (steering.length || dequeued.length)
      this.pendingNativeSteeringBySession.set(sessionId, {
        generation,
        messages: steering,
        dequeued,
      });
    else this.pendingNativeSteeringBySession.delete(sessionId);
  }

  private async resetNativeSteering(
    sessionId: string,
    runtime?: SecondaryRuntime,
    reason = "settled-before-consumption",
  ): Promise<void> {
    const existing = this.nativeSteeringResets.get(sessionId);
    if (existing) return existing;
    const reset = (async () => {
      try {
        if (runtime) {
          await this.runtimePool.recover(runtime);
          this.clearRuntimeFailure(runtime.id);
          this.broadcastSessionActivity(runtime.id);
        } else {
          // Controller-managed restart adopts the startup state before resolve.
          // Re-reading get_state here used to reopen the same split authority.
          await this.restartPrimaryRuntime(this.activeSessionPath || undefined);
          // The replacement process cannot own the prior generation's live or
          // tool projection, including legacy embedding bridges without an
          // adopter callback.
          this.liveMessage = undefined;
          this.toolStatus = "";
          this.clearRuntimeFailure(sessionId);
        }
        this.clearNativeSteeringState(sessionId, reason);
      } catch (error) {
        // restart() stops the old worker before starting its replacement. Once
        // replacement startup fails, every queued native Steer is definitively
        // lost and must be settled even though recovery itself rejected.
        const droppedCount = this.clearNativeSteeringState(
          sessionId,
          "process-error",
        );
        if (droppedCount > 0)
          throw new NativeSteeringResetError(error, droppedCount);
        throw error;
      }
    })();
    this.nativeSteeringResets.set(sessionId, reset);
    try {
      await reset;
    } finally {
      if (this.nativeSteeringResets.get(sessionId) === reset)
        this.nativeSteeringResets.delete(sessionId);
    }
  }

  private handleSecondaryEvent(
    runtime: SecondaryRuntime,
    event: Record<string, unknown>,
    source?: RpcEventSource,
  ): void {
    const currentGeneration = runtime.rpc.currentGeneration?.() || 0;
    const sourceGeneration = source?.generation || currentGeneration;
    const fastMode = fastModeStatusFromExtensionEvent(event);
    const unpublished = this.runtimePool.get(runtime.id) !== runtime;
    const staleGeneration = Boolean(
      sourceGeneration &&
      ((currentGeneration && sourceGeneration !== currentGeneration) ||
        (runtime.rpcGeneration &&
          sourceGeneration !== runtime.rpcGeneration)),
    );
    if (unpublished || staleGeneration) {
      if (
        fastMode !== null &&
        sourceGeneration &&
        (!currentGeneration || sourceGeneration === currentGeneration)
      )
        runtime.pendingFastMode = {
          rpcGeneration: sourceGeneration,
          active: fastMode,
        };
      if (
        event.type === "pi_chat_process_error" &&
        runtime.pendingFastMode?.rpcGeneration === sourceGeneration
      )
        runtime.pendingFastMode = undefined;
      return;
    }
    const type = String(event.type || "");
    const generation = runtime.rpcGeneration;
    const queuePausedBeforeEvent = runtime.queuePaused;
    this.traceState("rpc-event", "received", runtime.id, {
      eventType: type || "unknown",
      sourceGeneration: source?.generation || 0,
    }, generation);
    let droppedNativeSteering = 0;
    if (type === "pi_chat_process_error") {
      this.setFastModeActive(runtime.id, false);
      this.recordRuntimeFailure(
        runtime.id,
        event.error,
        typeof event.incidentId === "string" ? event.incidentId : undefined,
      );
      droppedNativeSteering = this.clearNativeSteeringState(
        runtime.id,
        "process-error",
      );
    }
    if (type === "compaction_start")
      this.updateHotCompactionState(runtime, true);
    else if (
      type === "compaction_end" ||
      type === "agent_settled" ||
      type === "pi_chat_process_error"
    )
      this.updateHotCompactionState(runtime, false);
    this.updateNativeSteeringSnapshot(runtime.id, event, generation);
    const consumedSteering = this.consumeNativeSteeringAdmission(
      runtime.id,
      event,
      generation,
    );
    const transition = this.applyRuntimeEventTransition(
      runtime.id,
      runtime,
      event,
    );
    if (!transition.broadcastEvent) {
      this.traceState("rpc-event", "rejected", runtime.id, {
        eventType: type || "unknown",
        decisionReason: "malformed-critical-event",
      }, generation);
      return;
    }
    this.runtimePool.touch(runtime);
    if (type === "agent_start")
      this.traceActivePrompt(
        "agent-start",
        runtime.id,
        generation,
        transition.state.runGeneration,
      );
    else if (type === "pi_chat_process_error") {
      const promptId = this.traceActivePrompt(
        "process-failed",
        runtime.id,
        generation,
        transition.state.runGeneration,
      );
      if (promptId) this.clearPromptDiagnostic(runtime.id, promptId);
    }
    if (consumedSteering || droppedNativeSteering > 0)
      transition.broadcastEvent = {
        ...transition.broadcastEvent,
        ...(consumedSteering ? { nativeSteeringConsumed: true } : null),
        ...(droppedNativeSteering > 0
          ? { nativeSteeringDroppedCount: droppedNativeSteering }
          : null),
      };
    this.broadcastRpcEvent(
      transition.broadcastEvent,
      runtime.id,
      transition.state.runGeneration,
    );
    if (transition.effects.some((effect) => effect.type === "session-created"))
      this.broadcast({
        type: "pi_chat_sessions_changed",
        action: "created",
        sessionId: runtime.id,
      });
    const settled = transition.effects.some(
      (effect) => effect.type === "settled",
    );
    if (settled) {
      const promptId = this.traceActivePrompt(
        "settled",
        runtime.id,
        generation,
        transition.state.runGeneration,
      );
      void this.finalizePersistedDraftWhenVisible(runtime);
      setTimeout(() => this.warmRuntimeMessageSnapshot(runtime), 0);
      if (this.hasNativeSteeringPending(runtime.id, generation))
        this.nativeSteeringResetAfterSettlement.set(runtime.id, generation);
      // Pi's RPC event schema has no run ID. Its JSONL stdout ordering is the
      // only usable ordering contract, so place a response barrier after the
      // terminal event before admitting another prompt. Frames preceding this
      // get_state response must be handled while this generation is still the
      // current one; a delayed old settled frame can therefore never clear the
      // following turn or dispatch its queue early.
      if (!runtime.dispatching) {
        runtime.dispatching = true;
        this.broadcastSessionActivity(runtime.id);
        void this.drainSecondaryAfterSettlement(
          runtime,
          runtime.rpcGeneration,
          promptId,
        );
      }
    } else if (
      type === "agent_start" ||
      type === "tool_execution_start" ||
      type === "tool_execution_end"
    ) {
      this.broadcastSessionActivity(runtime.id);
    } else if (type === "pi_chat_process_error") {
      // The raw error frame opens the pane-level error; this activity frame
      // retains the concise reason in sidebar/cache snapshots too. A crash
      // while dispatching or waiting on a settlement barrier must not leave
      // this Session's queue permanently stuck: release the dispatch lock and
      // unpause so the next mutation can recover and continue.
      runtime.dispatching = false;
      runtime.queuePaused = queuePausedBeforeEvent;
      // transitionRuntimeEvent published its conservative paused state before
      // this crash cleanup. Publish the released state as the final authority.
      this.broadcastQueue(runtime.id);
      this.broadcastSessionActivity(runtime.id);
    }
  }

  /**
   * Pi documents stdout events as a JSONL stream and emits agent_settled only
   * after the session-level run is done. The RPC event payload nevertheless
   * has no immutable run ID. A queued get_state response is therefore our
   * explicit FIFO drain barrier before this Session may begin another turn.
   */
  private async drainSecondaryAfterSettlement(
    runtime: SecondaryRuntime,
    sourceGeneration = runtime.rpcGeneration,
    promptId?: string,
  ): Promise<void> {
    try {
      const state = asState(
        await runtime.rpc.send(
          { type: "get_state" },
          SETTLEMENT_STATE_TIMEOUT_MS,
          // A short ordinary reader may already own get_state. This barrier
          // must be a later FIFO command, not a coalesced waiter that inherits
          // that reader's caller timeout.
          { independentRead: true },
        ),
      );
      if (
        this.runtimePool.get(runtime.id) !== runtime ||
        sourceGeneration !== runtime.rpcGeneration
      )
        return;
      if (promptId && this.activePromptDiagnostic(runtime.id, sourceGeneration)?.promptId === promptId) {
        this.tracePrompt(
          "settlement-barrier",
          runtime.id,
          promptId,
          sourceGeneration,
        );
        this.clearPromptDiagnostic(runtime.id, promptId);
      }
      runtime.lastState = state;
      runtime.running = state.isStreaming;
      if (
        !runtime.running &&
        this.nativeSteeringResetAfterSettlement.get(runtime.id) ===
          sourceGeneration &&
        this.hasNativeSteeringPending(runtime.id, sourceGeneration)
      ) {
        await this.resetNativeSteering(
          runtime.id,
          runtime,
          "settled-before-consumption",
        );
        runtime.dispatching = false;
        this.broadcastSessionActivity(runtime.id);
        void this.dispatchRuntimeNext(runtime);
        void this.runtimePool.sweep();
        return;
      }
      runtime.dispatching = false;
      this.broadcastSessionActivity(runtime.id);
      if (!runtime.running) {
        void this.dispatchRuntimeNext(runtime);
        void this.runtimePool.sweep();
      }
    } catch (error) {
      if (
        this.runtimePool.get(runtime.id) !== runtime ||
        sourceGeneration !== runtime.rpcGeneration
      )
        return;
      if (promptId && this.activePromptDiagnostic(runtime.id, sourceGeneration)?.promptId === promptId) {
        this.tracePromptDiagnosticOnly("process-failed", runtime.id, promptId, sourceGeneration);
        this.clearPromptDiagnostic(runtime.id, promptId);
      }
      runtime.dispatching = false;
      runtime.failed = true;
      runtime.queuePaused = runtime.promptQueue.length > 0;
      const message = `Pi 结算同步失败：${error instanceof Error ? error.message : String(error)}`;
      const incident = this.reportIncident(error, {
        sessionId: runtime.id,
        runtimeKind: "secondary",
        rpcGeneration: runtime.rpcGeneration,
        childPid: runtime.rpc.currentPid?.() || undefined,
        operation: "runtime.settlement",
        queueLength: runtime.promptQueue.length,
        outcome: "failed",
        errorCode: "SETTLEMENT_SYNC_FAILED",
      });
      this.recordRuntimeFailure(runtime.id, message, incident.incidentId);
      this.broadcastQueue(runtime.id);
      this.broadcast({
        type: "pi_chat_process_error",
        piChatSessionId: runtime.id,
        error: message,
        errorCode: "SETTLEMENT_SYNC_FAILED",
        incidentId: incident.incidentId,
        ...(error instanceof NativeSteeringResetError
          ? { nativeSteeringDroppedCount: error.droppedCount }
          : null),
      });
      this.broadcastSessionActivity(runtime.id);
    }
  }

  private async drainPrimaryAfterSettlement(
    sessionId: string,
    sourceGeneration = this.primaryRpcGeneration,
    promptId?: string,
  ): Promise<void> {
    try {
      const state = asState(
        await this.options.rpc.send(
          { type: "get_state" },
          SETTLEMENT_STATE_TIMEOUT_MS,
          // Preserve the post-settlement FIFO position even if a regular
          // short-budget state read is currently in flight.
          { independentRead: true },
        ),
      );
      if (
        sessionId !== this.primaryBoundSessionId ||
        sourceGeneration !== this.primaryRpcGeneration
      )
        return;
      if (promptId && this.activePromptDiagnostic(sessionId, sourceGeneration)?.promptId === promptId) {
        this.tracePrompt(
          "settlement-barrier",
          sessionId,
          promptId,
          sourceGeneration,
        );
        this.clearPromptDiagnostic(sessionId, promptId);
      }
      this.lastPrimaryState = state;
      this.running = state.isStreaming;
      if (
        !this.running &&
        this.nativeSteeringResetAfterSettlement.get(sessionId) ===
          sourceGeneration &&
        this.hasNativeSteeringPending(sessionId, sourceGeneration)
      ) {
        await this.resetNativeSteering(
          sessionId,
          undefined,
          "settled-before-consumption",
        );
        this.dispatching = false;
        this.broadcastSessionActivity(sessionId);
        void this.dispatchNext();
        return;
      }
      this.dispatching = false;
      this.broadcastSessionActivity(sessionId);
      if (!this.running) void this.dispatchNext();
    } catch (error) {
      if (
        sessionId !== this.primaryBoundSessionId ||
        sourceGeneration !== this.primaryRpcGeneration
      )
        return;
      if (promptId && this.activePromptDiagnostic(sessionId, sourceGeneration)?.promptId === promptId) {
        this.tracePromptDiagnosticOnly("process-failed", sessionId, promptId, sourceGeneration);
        this.clearPromptDiagnostic(sessionId, promptId);
      }
      this.dispatching = false;
      this.primaryFailed = true;
      this.queuePaused = this.promptQueue.length > 0;
      const message = `Pi 结算同步失败：${error instanceof Error ? error.message : String(error)}`;
      const incident = this.reportIncident(error, {
        sessionId,
        runtimeKind: "primary",
        rpcGeneration: sourceGeneration,
        childPid: this.options.rpc.currentPid?.() || undefined,
        operation: "runtime.settlement",
        queueLength: this.promptQueue.length,
        outcome: "failed",
        errorCode: "SETTLEMENT_SYNC_FAILED",
      });
      this.recordRuntimeFailure(sessionId, message, incident.incidentId);
      this.broadcastQueue();
      this.broadcast({
        type: "pi_chat_process_error",
        piChatSessionId: sessionId,
        error: message,
        errorCode: "SETTLEMENT_SYNC_FAILED",
        incidentId: incident.incidentId,
        ...(error instanceof NativeSteeringResetError
          ? { nativeSteeringDroppedCount: error.droppedCount }
          : null),
      });
      this.broadcastSessionActivity(sessionId);
    }
  }

  private async ensureRuntime(id: string): Promise<SecondaryRuntime> {
    // Keep every failed-worker recovery in the App owner: it clears
    // generation-scoped Steer state and resumes already-admitted FIFO work.
    const existing = this.runtimePool.get(id);
    let runtime: SecondaryRuntime;
    if (existing && this.secondaryNeedsRecovery(existing)) {
      await this.recoverRuntime(existing);
      runtime = existing;
    } else runtime = await this.runtimePool.ensure(id);
    this.adoptSecondaryFastMode(runtime);
    if (!runtime.summarySnapshot)
      runtime.summarySnapshot =
        this.options.sessions.summaryForId?.(id) || undefined;
    const desiredGateMode = this.gateModesBySession.get(id);
    if (desiredGateMode && runtime.gateMode !== desiredGateMode) {
      await runtime.rpc.send(
        { type: "prompt", message: `/gate ${desiredGateMode}` },
        PROMPT_PREPARE_TIMEOUT_MS,
      );
      runtime.gateMode = desiredGateMode;
    }
    if (!runtime.messageSnapshot) this.warmRuntimeMessageSnapshot(runtime);
    return runtime;
  }

  private async recoverRuntime(runtime: SecondaryRuntime): Promise<void> {
    // A failed/replaced worker can never deliver steers queued in its old
    // process. Drop the stale bookkeeping so the recovered worker's settlement
    // cannot mistake it for a live leftover and reset itself again.
    this.clearNativeSteeringState(runtime.id, "recovery");
    this.clearPromptDiagnostic(runtime.id);
    try {
      await this.runtimePool.recover(runtime);
      this.adoptSecondaryFastMode(runtime);
    } catch (error) {
      const incident = this.reportIncident(error, {
        sessionId: runtime.id,
        runtimeKind: "secondary",
        rpcGeneration: runtime.rpcGeneration,
        childPid: runtime.rpc.currentPid?.() || undefined,
        operation: "runtime.recovery",
        queueLength: runtime.promptQueue.length,
        outcome: "failed",
        errorCode: "RUNTIME_RECOVERY_FAILED",
      });
      this.recordRuntimeFailure(runtime.id, error, incident.incidentId);
      throw error;
    }
    this.clearRuntimeFailure(runtime.id);
    this.broadcastQueue(runtime.id);
    this.broadcastSessionActivity(runtime.id);
    this.resumeRecoveredRuntimeQueue(runtime);
  }

  private async acquireDraftRuntime(
    clientId = "",
    cwd = this.currentCwd,
  ): Promise<import("./runtime-pool.js").DraftRuntimeLease> {
    const lease = await this.runtimePool.acquireDraft(clientId, cwd);
    this.adoptSecondaryFastMode(lease.runtime);
    return lease;
  }

  /** A new draft may warm beside Primary startup, but no mutation is permitted
   * until the globally-owned compatibility probe succeeds. A failed Primary
   * must use the App-level recovery finalizer so its Session, state, Gate mode,
   * and failure flags stay coherent before the user returns from the draft. */
  private async waitForNewDraftPrimaryCompatibility(): Promise<void> {
    const primaryRuntime = this.options.primaryRuntime;
    if (!primaryRuntime) return;
    if (this.primaryNeedsRecovery(primaryRuntime.snapshot())) {
      await this.ensurePrimaryRuntime();
      return;
    }
    try {
      await primaryRuntime.waitUntilReady();
    } catch (error) {
      // If the asynchronous initial start failed while the draft was warming,
      // give this mutation the same App-level recovery opportunity as prompts.
      if (primaryRuntime.snapshot().status !== "failed") throw error;
      await this.ensurePrimaryRuntime();
    }
  }

  private async finalizePersistedDraft(
    runtime: SecondaryRuntime,
  ): Promise<boolean> {
    if (!(await this.runtimePool.commitDraftIfPersisted(runtime))) return false;
    const retry = this.draftPersistenceRetryTimers.get(runtime);
    if (retry) {
      clearTimeout(retry);
      this.draftPersistenceRetryTimers.delete(runtime);
    }
    this.broadcast({
      type: "pi_chat_sessions_changed",
      action: "created",
      sessionId: runtime.id,
    });
    return true;
  }

  /**
   * `agent_settled` may arrive before the writer's just-created JSONL user row
   * is readable. A prompted draft otherwise retains its intentionally temporary
   * "新对话" summary forever. Retry only while this exact Runtime stays mapped;
   * the bounded timer never creates a second title authority.
   */
  private async finalizePersistedDraftWhenVisible(
    runtime: SecondaryRuntime,
    attempt = 0,
  ): Promise<void> {
    if (
      this.closed ||
      this.runtimePool.get(runtime.id) !== runtime ||
      !runtime.prompted ||
      !runtime.draftSession
    )
      return;
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
      state: this.stateWithFastMode(runtime.id, {
        ...(runtime.lastState || { model: null, isStreaming: runtime.running }),
        isStreaming: this.runtimeTurnActive(runtime) || runtime.dispatching,
      }),
      gateMode: runtime.gateMode,
    };
  }

  /**
   * Empty New drafts have no messages and no real session stats. Avoid a full
   * sessionView round-trip (get_messages / stats / commands) on every New click.
   */
  private async draftSessionView(
    runtime: SecondaryRuntime,
    clientId = "",
  ): Promise<SessionViewData> {
    this.runtimePool.touch(runtime);
    const draft = runtime.draftSession;
    if (!draft) throw new Error("新会话草稿状态丢失");
    let model: ModelInfo | null = this.lastPrimaryState.model;
    let thinkingLevel = this.lastPrimaryState.thinkingLevel;
    try {
      const state = asState(
        await runtime.rpc.send({ type: "get_state" }, 3_000),
      );
      model = state.model;
      thinkingLevel = state.thinkingLevel;
    } catch {
      // Reused draft may still answer; a slow get_state must not block New UX.
    }
    return {
      session: { ...draft, ...this.controlState(runtime.id, clientId) },
      state: this.stateWithFastMode(runtime.id, {
        model,
        thinkingLevel,
        isStreaming: false,
        sessionFile: runtime.sessionPath,
        sessionId: draft.sessionId,
        messageCount: 0,
      }),
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

  private handleRpcEvent(
    event: Record<string, unknown>,
    source?: RpcEventSource,
  ): void {
    const currentGeneration = this.options.rpc.currentGeneration?.() || 0;
    const sourceGeneration = source?.generation || currentGeneration;
    if (
      event.type === "pi_chat_process_error" &&
      (!source?.generation ||
        !currentGeneration ||
        source.generation === currentGeneration)
    ) {
      // Primary can exit after compatibility succeeds but before get_state has
      // bound it to a Session. Readiness must reflect that failure even though
      // no Session-scoped transition or SSE frame can yet be attributed. A
      // source-tagged late event from a replaced child cannot fail its successor.
      this.options.primaryRuntime?.markFailed(event);
    }
    const unboundFastMode = fastModeStatusFromExtensionEvent(event);
    const awaitingPrimaryBinding =
      !this.primaryBoundSessionId ||
      Boolean(
        sourceGeneration &&
        ((currentGeneration && sourceGeneration !== currentGeneration) ||
          sourceGeneration !== this.primaryRpcGeneration),
      );
    if (awaitingPrimaryBinding) {
      if (
        unboundFastMode !== null &&
        sourceGeneration &&
        (!currentGeneration || sourceGeneration === currentGeneration)
      )
        this.pendingPrimaryFastMode = {
          rpcGeneration: sourceGeneration,
          active: unboundFastMode,
        };
      if (
        event.type === "pi_chat_process_error" &&
        this.pendingPrimaryFastMode?.rpcGeneration === sourceGeneration
      )
        this.pendingPrimaryFastMode = undefined;
      return;
    }
    const sessionId = this.primaryBoundSessionId;
    const type = String(event.type || "");
    const generation = this.primaryRpcGeneration;
    const queuePausedBeforeEvent = this.queuePaused;
    this.traceState("rpc-event", "received", sessionId, {
      eventType: type || "unknown",
      sourceGeneration,
    }, generation);
    let droppedNativeSteering = 0;
    if (type === "pi_chat_process_error") {
      this.setFastModeActive(sessionId, false);
      this.recordRuntimeFailure(
        sessionId,
        event.error,
        typeof event.incidentId === "string" ? event.incidentId : undefined,
      );
      droppedNativeSteering = this.clearNativeSteeringState(
        sessionId,
        "process-error",
      );
    }
    if (type === "compaction_start") this.updateHotCompactionState(undefined, true);
    else if (
      type === "compaction_end" ||
      type === "agent_settled" ||
      type === "pi_chat_process_error"
    )
      this.updateHotCompactionState(undefined, false);
    this.updateNativeSteeringSnapshot(sessionId, event, generation);
    const consumedSteering = this.consumeNativeSteeringAdmission(
      sessionId,
      event,
      generation,
    );
    const transition = this.applyRuntimeEventTransition(
      sessionId,
      undefined,
      event,
    );
    if (!transition.broadcastEvent) {
      this.traceState("rpc-event", "rejected", sessionId, {
        eventType: type || "unknown",
        decisionReason: "malformed-critical-event",
      }, generation);
      return;
    }
    if (type === "agent_start")
      this.traceActivePrompt(
        "agent-start",
        sessionId,
        generation,
        transition.state.runGeneration,
      );
    else if (type === "pi_chat_process_error") {
      const promptId = this.traceActivePrompt(
        "process-failed",
        sessionId,
        generation,
        transition.state.runGeneration,
      );
      if (promptId) this.clearPromptDiagnostic(sessionId, promptId);
    }
    if (consumedSteering || droppedNativeSteering > 0)
      transition.broadcastEvent = {
        ...transition.broadcastEvent,
        ...(consumedSteering ? { nativeSteeringConsumed: true } : null),
        ...(droppedNativeSteering > 0
          ? { nativeSteeringDroppedCount: droppedNativeSteering }
          : null),
      };
    this.broadcastRpcEvent(
      transition.broadcastEvent,
      sessionId,
      transition.state.runGeneration,
    );
    if (transition.effects.some((effect) => effect.type === "session-created"))
      this.broadcast({
        type: "pi_chat_sessions_changed",
        action: "created",
        sessionId,
      });
    const settled = transition.effects.some(
      (effect) => effect.type === "settled",
    );
    if (settled) {
      const promptId = this.traceActivePrompt(
        "settled",
        sessionId,
        generation,
        transition.state.runGeneration,
      );
      setTimeout(() => this.warmPrimaryMessageSnapshot(), 0);
      if (this.hasNativeSteeringPending(sessionId, generation))
        this.nativeSteeringResetAfterSettlement.set(sessionId, generation);
      if (!this.dispatching) {
        this.dispatching = true;
        this.broadcastSessionActivity(sessionId);
        void this.drainPrimaryAfterSettlement(
          sessionId,
          sourceGeneration,
          promptId,
        );
      }
    } else if (
      type === "agent_start" ||
      type === "tool_execution_start" ||
      type === "tool_execution_end"
    ) this.broadcastSessionActivity(sessionId);
    else if (type === "pi_chat_process_error") {
      // Never leave the Primary queue stuck behind a stale dispatch lock after
      // the live child exits (see the Secondary branch for the same contract).
      this.dispatching = false;
      this.queuePaused = queuePausedBeforeEvent;
      this.broadcastQueue(sessionId);
      this.broadcastSessionActivity(sessionId);
    }
  }

  private browserPrimaryReadiness(
    readiness = this.options.primaryRuntime?.snapshot() || {
      status: "ready" as const,
      generation: 0,
    },
  ): PrimaryRuntimeReadiness {
    if (readiness.status !== "ready") return readiness;
    return {
      ...readiness,
      ...(this.primaryBoundSessionId
        ? { sessionId: this.primaryBoundSessionId }
        : null),
    };
  }

  private primaryReadiness(): PrimaryRuntimeReadiness {
    return this.browserPrimaryReadiness();
  }

  /**
   * Atomically adopt the exact get_state response that certified this child.
   * The controller publishes ready only after this returns, so bootstrap/SSE,
   * App routing, and Composer capability all observe one ownership boundary.
   */
  private async adoptPrimaryRuntime(
    response: Record<string, unknown>,
    context: PrimaryRuntimeAdoptionContext,
  ): Promise<void> {
    const state = asState(response);
    const childGeneration = this.options.rpc.currentGeneration?.() || 0;
    if (!childGeneration)
      throw new Error("Primary Runtime 启动响应缺少进程 generation");
    this.lastPrimaryState = state;
    this.running = state.isStreaming;
    this.primaryFailed = false;
    this.liveMessage = undefined;
    this.toolStatus = "";
    this.bindPrimaryIdentity(state);
    if (!this.primaryBoundSessionId || this.primaryRpcGeneration !== childGeneration)
      throw new Error("Primary Runtime 启动响应缺少可绑定的 Session identity");
    if (state.model) {
      this.rememberModelContextWindows([state.model]);
      this.lastAvailableModels = [state.model];
    }
    const desiredGateMode = context.sessionFile
      ? this.gateModesBySession.get(this.activeSessionId) || this.primaryGateMode
      : "strict";
    if (desiredGateMode !== "strict")
      await this.options.rpc.send(
        { type: "prompt", message: `/gate ${desiredGateMode}` },
        PROMPT_PREPARE_TIMEOUT_MS,
      );
    this.primaryGateMode = desiredGateMode;
    if (context.restart) {
      const recoveryStillOwnsQueue =
        !this.primaryRecoveryFence ||
        this.primaryRecoveryFence.abortGeneration ===
          this.scheduler.primaryAbortGeneration;
      if (recoveryStillOwnsQueue) this.queuePaused = false;
      else if (this.promptQueue.length) this.queuePaused = true;
      this.broadcastQueue();
    }
  }

  private primaryReadReady(): boolean {
    return (
      this.primaryReadiness().status === "ready" &&
      !this.primaryFailed &&
      this.options.rpc.isRunning?.() !== false
    );
  }

  /** Mutation-time recovery policy; read-only paths keep primaryReadReady(). */
  private primaryNeedsRecovery(
    readiness = this.options.primaryRuntime?.snapshot(),
  ): boolean {
    return (
      readiness?.status === "failed" ||
      this.primaryFailed ||
      this.options.rpc.isRunning?.() === false
    );
  }

  /** Secondary recovery is intentionally separate from abort's no-op policy. */
  private secondaryNeedsRecovery(runtime: SecondaryRuntime): boolean {
    return runtime.failed || runtime.rpc.isRunning?.() === false;
  }

  private async recoverPrimaryRuntimeWithQueueFence(
    primaryRuntime: PrimaryRuntimeReadinessBridge,
    sessionFile?: string,
    cwd = this.primaryRuntimeCwd,
  ): Promise<void> {
    if (this.primaryRecoveryFence) {
      await primaryRuntime.recover(sessionFile, cwd);
      return;
    }
    const recoveryFence = {
      abortGeneration: this.scheduler.primaryAbortGeneration,
    };
    this.primaryRecoveryFence = recoveryFence;
    try {
      await primaryRuntime.recover(sessionFile, cwd);
    } finally {
      if (this.primaryRecoveryFence === recoveryFence)
        this.primaryRecoveryFence = undefined;
    }
  }

  private async ensurePrimaryRuntime(): Promise<void> {
    const primaryRuntime = this.options.primaryRuntime;
    let readiness = primaryRuntime?.snapshot();
    // waitUntilReady() intentionally preserves a failed readiness snapshot for
    // read-only callers. Mutating callers, however, are the recovery boundary:
    // an initial spawn/probe failure must be allowed to retry without requiring
    // a whole server restart.
    if (primaryRuntime && readiness?.status !== "failed") {
      try {
        await primaryRuntime.waitUntilReady();
      } catch (error) {
        readiness = primaryRuntime.snapshot();
        if (readiness.status !== "failed") throw error;
      }
    }
    readiness = primaryRuntime?.snapshot();
    // Reaching this point after waitUntilReady() means the normal startup path
    // is ready. A failed snapshot deliberately skips that wait and falls into
    // the single-flight recovery below.
    if (!this.primaryNeedsRecovery(readiness)) return;
    if (this.primaryRecovery) return this.primaryRecovery;
    const recovery = (async () => {
      try {
        // A cold service may still be completing its initial asynchronous
        // Primary spawn. If it won the race, consume that worker rather than
        // stopping/restarting it a second time.
        if (this.primaryNeedsRecovery(readiness)) {
          this.clearNativeSteeringState(this.activeSessionId, "recovery");
          this.clearPromptDiagnostic(this.activeSessionId);
          // The controller's adopter completes App binding before recover()
          // resolves. Never issue a second get_state here: that recreated the
          // split authority where SSE said ready while App was still adopting.
          if (primaryRuntime) {
            this.options.rpc.setDiagnosticSessionId?.(this.activeSessionId);
            await this.recoverPrimaryRuntimeWithQueueFence(
              primaryRuntime,
              this.activeSessionPath || undefined,
              this.primaryRuntimeCwd,
            );
            if (!(primaryRuntime instanceof PrimaryRuntimeReadinessController)) {
              const state = asState(
                await this.options.rpc.send({ type: "get_state" }),
              );
              this.lastPrimaryState = state;
              this.running = state.isStreaming;
              this.primaryFailed = false;
              this.toolStatus = "";
              this.bindPrimaryIdentity(state);
            }
          } else {
            // Legacy in-process embeddings do not have the controller/adopter
            // contract. Preserve their explicit post-restart state bind; the
            // production entrypoint always takes the controller branch above.
            const response = await this.options.rpc.restart(
              this.activeSessionPath || undefined,
              this.primaryRuntimeCwd,
            );
            const state = asState(
              response || (await this.options.rpc.send({ type: "get_state" })),
            );
            this.lastPrimaryState = state;
            this.running = state.isStreaming;
            this.primaryFailed = false;
            this.toolStatus = "";
            this.bindPrimaryIdentity(state);
          }
          this.clearRuntimeFailure(this.activeSessionId);
          const runGeneration = this.advanceSessionRunGeneration(
            this.activeSessionId,
          );
          this.broadcast({
            type: "pi_chat_process_recovered",
            piChatSessionId: this.activeSessionId,
            piChatRunEpoch: this.runEpoch,
            piChatRunGeneration: runGeneration,
          });
          this.broadcastSessionActivity(this.activeSessionId);
          this.resumeRecoveredPrimaryQueue();
        }
      } catch (error) {
        this.primaryFailed = true;
        if (error instanceof PrimaryRuntimeUnavailableError) throw error;
        throw new Error(
          `主 Pi RPC 恢复失败：${error instanceof Error ? error.message : String(error)}`,
        );
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
    const sessionId = state.sessionFile
      ? idForPath(state.sessionFile)
      : state.sessionId || "";
    if (!sessionId) return;
    const previousSessionId = this.primaryBoundSessionId;
    const previousRpcGeneration = this.primaryRpcGeneration;
    const sameRuntimeFastMode = Boolean(
      previousSessionId &&
      previousRpcGeneration &&
      previousRpcGeneration ===
        (this.options.rpc.currentGeneration?.() || 0) &&
      this.fastModeBySession.get(previousSessionId) === true,
    );
    this.activeSessionId = sessionId;
    this.activeSessionPath = state.sessionFile || this.activeSessionPath;
    this.primaryBoundSessionId = sessionId;
    this.options.rpc.setDiagnosticSessionId?.(sessionId);
    this.primaryRpcGeneration = this.options.rpc.currentGeneration?.() || 0;
    const pendingFastMode = this.pendingPrimaryFastMode;
    this.pendingPrimaryFastMode = undefined;
    if (previousSessionId && previousSessionId !== sessionId)
      this.setFastModeActive(previousSessionId, false);
    if (
      pendingFastMode &&
      pendingFastMode.rpcGeneration === this.primaryRpcGeneration
    )
      this.setFastModeActive(sessionId, pendingFastMode.active);
    else if (previousSessionId !== sessionId)
      this.setFastModeActive(sessionId, sameRuntimeFastMode);
    else if (
      previousRpcGeneration &&
      previousRpcGeneration !== this.primaryRpcGeneration
    )
      this.setFastModeActive(sessionId, false);
  }

  /** Bind Primary's Session only after the readiness gate passed. */
  private async ensurePrimaryIdentity(): Promise<void> {
    if (this.activeSessionId) return;
    await this.ensurePrimaryRuntime();
    // Controller-managed startup adopts identity before publishing ready. Keep
    // a fallback only for legacy embedding doubles that do not expose an adopter.
    if (this.activeSessionId) return;
    const state = asState(await this.options.rpc.send({ type: "get_state" }));
    this.lastPrimaryState = state;
    this.running = state.isStreaming;
    this.bindPrimaryIdentity(state);
  }

  private async extensionCommand(
    message: string,
    rpc = this.options.rpc,
  ): Promise<SlashCommand | null> {
    const match = /^\/([^\s/]+)/.exec(message);
    if (!match) return null;
    const response = await rpc.send({ type: "get_commands" });
    const command = asCommands(response).find((item) => item.name === match[1]);
    return command?.source === "extension" ? command : null;
  }

  /**
   * Validate a captured Model against the exact Runtime that is about to run
   * it. Browser catalogues are advisory and may be stale; a valid-looking ID
   * must never bypass this target-Runtime check.
   */
  private async applyTurnSettings(
    rpc: PiRpcClient,
    settings: PendingTurnSettings,
  ): Promise<AppliedTurnSettings> {
    const applied: AppliedTurnSettings = {};
    if (settings.model) {
      const model = asModels(
        await rpc.send({ type: "get_available_models" }),
      ).find(
        (candidate) =>
          candidate.provider === settings.model!.provider &&
          candidate.id === settings.model!.modelId,
      );
      if (!model) throw new HttpRequestError(400, "所选模型不可用");
      await rpc.send({
        type: "set_model",
        provider: model.provider,
        modelId: model.id,
      });
      this.rememberModelContextWindows([model]);
      applied.model = model;
    }
    if (settings.thinkingLevel) {
      try {
        await rpc.send({
          type: "set_thinking_level",
          level: settings.thinkingLevel,
        });
      } catch (error) {
        if (applied.model)
          throw new PartialTurnSettingsError(applied, error);
        throw error;
      }
      applied.thinkingLevel = settings.thinkingLevel;
    }
    return applied;
  }

  /** Apply and consume the legacy Runtime-wide next-turn setting holder. */
  private async applyPendingTurnSettings(
    rpc: PiRpcClient,
    pending: PendingTurnSettings,
  ): Promise<void> {
    await this.applyTurnSettings(rpc, pending);
    delete pending.model;
    delete pending.thinkingLevel;
  }

  /**
   * A later prompt snapshot supersedes only legacy pending fields that existed
   * before this prompt's admission. Legacy mutations accepted after queueing
   * remain in the holder and belong to the following prompt.
   */
  private supersedePendingTurnSettings(
    pending: PendingTurnSettings,
    snapshot?: PromptSettingsSnapshot,
  ): void {
    if (snapshot?.model) delete pending.model;
    if (snapshot?.thinkingLevel) delete pending.thinkingLevel;
  }

  /**
   * A queued Composer submission owns settings captured at its own admission.
   * Its snapshot wins for this row, but must not consume a legacy setting that
   * arrived later while the row waited behind a running turn.
   */
  private async applyPromptSettings(
    rpc: PiRpcClient,
    pending: PendingTurnSettings,
    snapshot?: PromptSettingsSnapshot,
    consumeSupersededLegacy = false,
  ): Promise<AppliedTurnSettings> {
    const usePendingModel = !snapshot?.model;
    const usePendingThinking = !snapshot?.thinkingLevel;
    const settings: PendingTurnSettings = {
      ...(usePendingModel && pending.model ? { model: pending.model } : null),
      ...(usePendingThinking && pending.thinkingLevel
        ? { thinkingLevel: pending.thinkingLevel }
        : null),
      ...(snapshot?.model ? { model: snapshot.model } : null),
      ...(snapshot?.thinkingLevel
        ? { thinkingLevel: snapshot.thinkingLevel }
        : null),
    };
    const applied = await this.applyTurnSettings(rpc, settings);
    if (usePendingModel) delete pending.model;
    if (usePendingThinking) delete pending.thinkingLevel;
    if (consumeSupersededLegacy)
      this.supersedePendingTurnSettings(pending, snapshot);
    return applied;
  }

  /**
   * Busy Pi workers deliberately skip get_state so navigation and reconnect do
   * not queue behind a long turn. Keep that display snapshot aligned with an
   * accepted setting selection; otherwise a bootstrap/view would overwrite the
   * browser's optimistic Terra/high selection with the prior Sol/max snapshot.
   */
  private rememberPrimaryDisplaySettings(
    patch: Partial<Pick<PiState, "model" | "thinkingLevel">>,
  ): void {
    this.lastPrimaryState = {
      ...this.lastPrimaryState,
      ...patch,
      isStreaming: this.primaryTurnActive() || this.lastPrimaryState.isStreaming,
    };
  }

  private rememberRuntimeDisplaySettings(
    runtime: SecondaryRuntime,
    patch: Partial<Pick<PiState, "model" | "thinkingLevel">>,
  ): void {
    runtime.lastState = {
      ...(runtime.lastState || { model: null, isStreaming: runtime.running }),
      ...patch,
      isStreaming:
        this.runtimeTurnActive(runtime) ||
        runtime.dispatching ||
        runtime.lastState?.isStreaming ||
        false,
    };
  }

  /** Keep hot/busy reads truthful after a prompt snapshot changed settings. */
  private rememberPrimaryAppliedTurnSettings(
    settings: AppliedTurnSettings,
  ): void {
    this.rememberPrimaryDisplaySettings({
      ...(settings.model ? { model: settings.model } : null),
      ...(settings.thinkingLevel
        ? { thinkingLevel: settings.thinkingLevel }
        : null),
    });
  }

  /** Keep a Secondary's hot-memory view aligned before its prompt starts. */
  private rememberRuntimeAppliedTurnSettings(
    runtime: SecondaryRuntime,
    settings: AppliedTurnSettings,
  ): void {
    this.rememberRuntimeDisplaySettings(runtime, {
      ...(settings.model ? { model: settings.model } : null),
      ...(settings.thinkingLevel
        ? { thinkingLevel: settings.thinkingLevel }
        : null),
    });
  }

  private currentGateMode(sessionId: string): GateMode {
    if (!sessionId || sessionId === this.activeSessionId)
      return this.primaryGateMode;
    return (
      this.runtimePool.get(sessionId)?.gateMode ||
      this.gateModesBySession.get(sessionId) ||
      "strict"
    );
  }

  private async syncGateMode(
    rpc: PiRpcClient,
    sessionId: string,
    mode?: GateMode,
  ): Promise<void> {
    // Runtime metadata is authoritative for a live process. Replaying an
    // identical /gate command before every prompt adds a needless serialized
    // RPC round trip and can itself trigger extension work.
    if (!mode || mode === this.currentGateMode(sessionId)) return;
    await rpc.send(
      { type: "prompt", message: `/gate ${mode}` },
      PROMPT_PREPARE_TIMEOUT_MS,
    );
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
    this.broadcast({
      type: "pi_chat_gate_mode_changed",
      mode,
      piChatSessionId: sessionId,
    });
  }

  private recordUserPrompt(sessionId: string, promptAt = this.now()): void {
    if (!sessionId) return;
    // A queued older prompt may dispatch after a newer one was already accepted.
    // Never let that delayed dispatch move the Session backwards in the sidebar.
    const current = this.lastUserPromptAtBySession.get(sessionId) || 0;
    const next = Math.max(current, promptAt);
    this.lastUserPromptAtBySession.set(sessionId, next);
    const runtime = this.runtimePool.get(sessionId);
    if (runtime)
      runtime.lastUserPromptAt = Math.max(runtime.lastUserPromptAt || 0, next);
  }

  private noteUserPrompt(sessionId: string, promptAt = this.now()): void {
    this.recordUserPrompt(sessionId, promptAt);
    // The sidebar needs to move at admission/queue time, never when assistant
    // output later touches the JSONL.
    this.broadcast({
      type: "pi_chat_sessions_changed",
      action: "prompted",
      sessionId,
    });
  }

  private async sendPrompt(
    message: string,
    images: PromptImage[],
    promptAt = this.now(),
    gateMode?: GateMode,
    promptId: string = randomUUID(),
    settings?: PromptSettingsSnapshot,
  ): Promise<PromptAcceptance> {
    return this.scheduler.sendPrimaryPrompt(
      message,
      images,
      promptAt,
      gateMode,
      promptId,
      settings,
      true,
    );
  }

  private warmRuntimeMessageSnapshot(runtime: SecondaryRuntime): void {
    if (typeof this.options.sessions.messagesForId !== "function") return;
    void this.options.sessions
      .messagesForId(runtime.id)
      .then((messages) => {
        if (messages && this.runtimePool.get(runtime.id) === runtime) {
          const reconciled = reconcilePersistedHistory(
            messages,
            runtime.pendingTerminalMessages,
          );
          runtime.messageSnapshot = messages;
          runtime.pendingTerminalMessages = reconciled.pending;
          runtime.summarySnapshot =
            this.options.sessions.summaryForId?.(runtime.id) ||
            runtime.summarySnapshot;
        }
      })
      .catch(() => undefined);
  }

  private warmPrimaryMessageSnapshot(): void {
    const path = this.activeSessionPath;
    const sessionId = this.activeSessionId;
    if (!path || !sessionId) return;
    void readSessionMessages(path)
      .then((messages) => {
        if (
          this.activeSessionPath === path &&
          this.activeSessionId === sessionId
        ) {
          const terminalTail =
            this.primaryPendingTerminalSessionId === sessionId
              ? this.primaryPendingTerminalMessages
              : [];
          const reconciled = reconcilePersistedHistory(messages, terminalTail);
          this.lastPrimaryMessages = messages;
          this.primaryPendingTerminalMessages = reconciled.pending;
          this.lastPrimaryMessagesSessionId = sessionId;
        }
      })
      .catch(() => undefined);
  }

  /** Recovery is demand-driven, but work already accepted before a crash must not strand. */
  private resumeRecoveredRuntimeQueue(runtime: SecondaryRuntime): void {
    if (
      this.closed ||
      this.applicationLifecycle !== "idle" ||
      this.runtimeTurnActive(runtime) ||
      runtime.dispatching ||
      runtime.queuePaused ||
      !runtime.promptQueue.length
    )
      return;
    void this.dispatchRuntimeNext(runtime);
  }

  private resumeRecoveredPrimaryQueue(): void {
    if (
      this.closed ||
      this.applicationLifecycle !== "idle" ||
      this.primaryTurnActive() ||
      this.dispatching ||
      this.queuePaused ||
      !this.promptQueue.length
    )
      return;
    void this.dispatchNext();
  }

  private async dispatchRuntimeNext(runtime: SecondaryRuntime): Promise<void> {
    // Runtime recovery owns stale-lock cleanup. A concurrent Resume must not
    // create a new dispatch lock that the recovery completion could erase.
    if (runtime.recovery) return;
    await this.scheduler.dispatchRuntimeNext(runtime);
  }

  private async dispatchNext(): Promise<void> {
    if (this.primaryRecoveryFence) return;
    await this.scheduler.dispatchPrimaryNext();
  }

  private sessionSummaries(
    sessions: BootstrapData["sessions"],
    clientId = "",
  ): BootstrapData["sessions"] {
    // Empty drafts stay out of the sidebar. Prompted drafts that SessionIndex has
    // not yet scanned must still appear as soon as the first send is accepted.
    const listed = sessions.map((session) => {
      const runtime = this.runtimePool.get(session.id);
      const lastUserPromptAt =
        this.lastUserPromptAtBySession.get(session.id) ??
        runtime?.lastUserPromptAt ??
        session.lastUserPromptAt;
      return {
        ...session,
        ...(runtime?.cwd ? { cwd: runtime.cwd } : null),
        ...(lastUserPromptAt !== undefined ? { lastUserPromptAt } : null),
        writable: this.activeSessionIds().includes(session.id),
        running:
          (session.id === this.activeSessionId && this.primaryTurnActive()) ||
          Boolean(runtime && this.runtimeTurnActive(runtime)),
        queued:
          session.id === this.activeSessionId
            ? this.promptQueue.length > 0
            : (runtime?.promptQueue.length || 0) > 0,
        pendingConfirmation: Boolean(this.pendingRequestForSession(session.id)),
        activity: this.sessionActivity(session.id),
        ...this.controlState(session.id, clientId),
      };
    });
    const known = new Set(listed.map((session) => session.id));
    for (const runtime of this.runtimePool.runtimes.values()) {
      if (known.has(runtime.id)) continue;
      if (
        !runtime.prompted &&
        !this.runtimeTurnActive(runtime) &&
        !runtime.dispatching
      )
        continue;
      // A persisted Session may be momentarily absent from a refresh while its
      // JSONL is being written. Its Runtime captured the indexed summary at
      // activation; use that before the one-message draft fallback so a real
      // title/count cannot regress to "新会话" in the sidebar.
      const base = runtime.summarySnapshot ||
        runtime.draftSession || {
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
        lastUserPromptAt:
          this.lastUserPromptAtBySession.get(runtime.id) ??
          runtime.lastUserPromptAt ??
          base.lastUserPromptAt ??
          base.updatedAt,
        active: true,
        writable: true,
        running:
          this.runtimeTurnActive(runtime) || runtime.dispatching,
        queued: runtime.promptQueue.length > 0,
        pendingConfirmation: Boolean(this.pendingRequestForSession(runtime.id)),
        activity: this.sessionActivity(runtime.id),
        ...this.controlState(runtime.id, clientId),
      });
      known.add(runtime.id);
    }
    return listed.sort(compareSessionsByLastUserPrompt);
  }

  private sidebarSessions(
    sessions: SessionSummary[],
    clientId: string,
    all = false,
    includeIds: readonly string[] = [],
  ): {
    sessions: SessionSummary[];
    total: number;
    directories: SessionDirectorySummary[];
  } {
    const enriched = this.sessionSummaries(sessions, clientId);
    const groups = new Map<string, SessionSummary[]>();
    for (const session of enriched) {
      const key = session.cwd || "";
      const group = groups.get(key);
      if (group) group.push(session);
      else groups.set(key, [session]);
    }
    const directories = [...groups.entries()]
      .map(([cwd, group]) => ({
        cwd,
        count: group.length,
        lastUserPromptAt:
          group[0]?.lastUserPromptAt ?? group[0]?.updatedAt ?? 0,
      }))
      .sort((left, right) => right.lastUserPromptAt - left.lastUserPromptAt);
    if (all) return { sessions: enriched, total: enriched.length, directories };
    const cwdKey = (cwd: string) =>
      cwd ? resolve(cwd).toLowerCase() : "__unknown_cwd__";
    const current =
      [...groups.entries()].find(
        ([cwd]) => cwdKey(cwd) === cwdKey(this.currentCwd),
      )?.[1] || [];
    const selected = current.slice(0, DEFAULT_DIRECTORY_SESSION_LIST_SIZE);
    for (const directory of directories) {
      if (selected.length >= DEFAULT_SESSION_LIST_SIZE) break;
      if (cwdKey(directory.cwd) === cwdKey(this.currentCwd)) continue;
      selected.push(
        ...(groups.get(directory.cwd) || []).slice(
          0,
          Math.min(
            DEFAULT_DIRECTORY_SESSION_LIST_SIZE,
            DEFAULT_SESSION_LIST_SIZE - selected.length,
          ),
        ),
      );
    }
    // Pins are browser-local presentation preferences. The read-only inventory
    // endpoint may request their bounded stable IDs so an older pinned Session
    // remains visible without forcing an unbounded all=1 scan into every page.
    if (includeIds.length) {
      const selectedIds = new Set(selected.map((session) => session.id));
      const requested = new Set(includeIds);
      for (const session of enriched) {
        if (!requested.has(session.id) || selectedIds.has(session.id)) continue;
        selected.push(session);
        selectedIds.add(session.id);
      }
    }
    return { sessions: selected, total: enriched.length, directories };
  }

  private cachedSessionList(activePath?: string): Promise<SessionSummary[]> {
    const cached = (
      this.options.sessions as SessionIndex & {
        listCached?: (
          activePath?: string,
          cwd?: string,
        ) => Promise<SessionSummary[]>;
      }
    ).listCached;
    return cached
      ? cached.call(this.options.sessions, activePath)
      : this.options.sessions.list(activePath);
  }

  private async restartPrimaryRuntime(
    sessionFile?: string,
    cwd = this.primaryRuntimeCwd,
  ): Promise<void> {
    if (cwd !== this.primaryRuntimeCwd)
      throw new Error("Primary Runtime 工作目录不可在原进程上重绑定");
    if (this.options.primaryRuntime) {
      this.options.rpc.setDiagnosticSessionId?.(
        sessionFile ? idForPath(sessionFile) : this.activeSessionId,
      );
      await this.recoverPrimaryRuntimeWithQueueFence(
        this.options.primaryRuntime,
        sessionFile,
        cwd,
      );
      // The production controller exposes setAdopter(). Test/embedding bridges
      // may implement the optional method without installing an adopter, so
      // only the concrete controller uses this early return.
      if (this.options.primaryRuntime instanceof PrimaryRuntimeReadinessController)
        return;
    } else await this.options.rpc.restart(sessionFile, cwd);
    // Legacy embedding bridges have no adoption callback; preserve their old
    // post-restart Gate synchronization without affecting production.
    const desiredGateMode = sessionFile
      ? this.gateModesBySession.get(this.activeSessionId) ||
        this.primaryGateMode
      : "strict";
    if (desiredGateMode !== "strict")
      await this.options.rpc.send(
        { type: "prompt", message: `/gate ${desiredGateMode}` },
        PROMPT_PREPARE_TIMEOUT_MS,
      );
    this.primaryGateMode = desiredGateMode;
  }

  private async reloadRpc(knownState?: PiState): Promise<void> {
    this.assertApplicationQuiescent("修改资源配置");
    const state =
      knownState || asState(await this.options.rpc.send({ type: "get_state" }));
    if (state.isStreaming)
      throw new Error("请先停止所有并行生成，再修改资源配置");
    await this.runtimePool.stopAll();
    await this.restartPrimaryRuntime(state.sessionFile);
    this.broadcast({ type: "pi_chat_reloaded" });
  }

  private async applyResourceFileTransaction<T>(
    snapshots: FileSnapshot[],
    mutation: () => Promise<T>,
  ): Promise<T> {
    const state = asState(await this.options.rpc.send({ type: "get_state" }));
    if (state.isStreaming)
      throw new Error("请先停止所有并行生成，再修改资源配置");
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
        throw new Error(
          `资源修改失败，自动恢复也失败：${original}；恢复错误：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      throw new Error(`资源修改失败，原配置已自动恢复：${original}`);
    }
  }

  /** Changes only the persisted default/index context for future drafts. Existing
   * Session paths and dedicated Runtime cwd values are immutable. Native folder
   * pickers wait outside this queue; each returned selection gets a short,
   * lifecycle-guarded commit in FIFO order. */
  private async changeWorkspace(
    selected: string,
  ): Promise<{
    workspaceName: string;
    cwd: string;
    workspaceEpoch: string;
    workspaceRevision: number;
  }> {
    let releaseTurn!: () => void;
    const previous = this.workspaceCommitTail;
    const turn = new Promise<void>((resolveTurn) => {
      releaseTurn = resolveTurn;
    });
    this.workspaceCommitTail = previous.catch(() => undefined).then(() => turn);
    await previous.catch(() => undefined);
    try {
      const releaseMutation = this.beginMutation();
      try {
        const selectedCwd = resolve(selected);
        if (!(await stat(selectedCwd)).isDirectory())
          throw new Error("所选工作目录不存在或不是文件夹");
        await saveWorkspace(selectedCwd);
        if (selectedCwd.toLowerCase() !== this.currentCwd.toLowerCase()) {
          this.currentCwd = selectedCwd;
          this.workspaceRevision += 1;
          this.broadcast({
            type: "pi_chat_workspace_changed",
            cwd: selectedCwd,
            workspaceEpoch: this.runEpoch,
            workspaceRevision: this.workspaceRevision,
          });
        }
        return {
          workspaceName: basename(selectedCwd),
          cwd: selectedCwd,
          workspaceEpoch: this.runEpoch,
          workspaceRevision: this.workspaceRevision,
        };
      } finally {
        releaseMutation();
      }
    } finally {
      releaseTurn();
    }
  }

  private async renameSession(
    id: string,
    name: string,
  ): Promise<{ id: string; name: string }> {
    const isPrimary = id === this.activeSessionId;
    const knownRuntime = this.runtimePool.get(id);
    const draft = knownRuntime?.draftSession;
    if (draft)
      throw new Error("空白新对话会在发送第一条消息后保存，届时才能重命名");
    // A hot Runtime is already bound to this persisted Session. Avoid a global
    // index scan on its mutation response path; a cold target still gets the
    // existing ensureRuntime() lookup/retry before it can be written.
    const existingRuntime = isPrimary ? null : knownRuntime || null;
    const wasOpen = isPrimary || Boolean(existingRuntime);
    const runtime = isPrimary
      ? null
      : existingRuntime || (await this.ensureRuntime(id));
    const releaseRuntimeOperation = runtime
      ? this.runtimePool.acquireOperation(runtime)
      : this.primaryOperationAdmission.acquire().release;
    try {
      await (runtime?.rpc || this.options.rpc).send({
        type: "set_session_name",
        name,
      });
    } finally {
      releaseRuntimeOperation();
    }
    // A Runtime created only to rename a cold Session is not retained. Its
    // dedicated process is safely reclaimed after its mutation lease releases.
    if (!wasOpen && runtime && !runtime.running) {
      this.clearNativeSteeringState(id, "reclaim");
      await this.runtimePool.reclaim(id, "idle");
    }
    // JSONL indexing is read projection, not mutation authority. Do not make
    // a confirmed Pi write wait for a recursive SessionIndex scan or bootstrap;
    // the existing sessions-changed SSE refresh converges it asynchronously.
    if (id === this.activeSessionId && this.primarySummarySnapshot)
      this.primarySummarySnapshot = { ...this.primarySummarySnapshot, name };
    else if (existingRuntime?.summarySnapshot)
      existingRuntime.summarySnapshot = { ...existingRuntime.summarySnapshot, name };
    this.broadcast({
      type: "pi_chat_sessions_changed",
      action: "renamed",
      sessionId: id,
    });
    return { id, name };
  }

  private async deleteSession(id: string): Promise<BootstrapData> {
    await this.options.sessions.list(undefined, this.currentCwd);
    const isPrimary = id === this.activeSessionId;
    const state = isPrimary
      ? asState(await this.options.rpc.send({ type: "get_state" }, 12_000))
      : null;
    // Prefer the live worker path. A brand-new Session may still be absent from
    // SessionIndex when the user deletes it from the sidebar or current view.
    const runtime = this.runtimePool.get(id);
    const path = isPrimary
      ? state?.sessionFile
      : runtime?.sessionPath ||
        runtime?.draftSessionPath ||
        this.options.sessions.pathForId(id);
    if (!isPrimary && !path && !runtime) throw new Error("会话不存在");
    if (isPrimary) {
      if (
        this.primaryTurnActive() ||
        this.promptQueue.length ||
        this.pendingExtensionRequest
      )
        throw new Error(
          "请先停止当前生成、处理权限确认并清空队列，再删除此会话",
        );
      const result = rpcData<{ cancelled: boolean }>(
        await this.options.rpc.send({ type: "new_session" }, 30_000),
      );
      if (result.cancelled)
        throw new Error("扩展取消了新建会话，无法删除当前会话");
    } else if (runtime) {
      // releaseForDeletion owns admission close-and-drain; do not hold a normal
      // operation lease here or it would correctly block its own stop.
      if (
        this.runtimeTurnActive(runtime) ||
        runtime.promptQueue.length ||
        runtime.extensionUiPending
      )
        throw new Error(
          "请先停止该会话的生成、处理权限确认并清空队列，再删除对话",
        );
      const released = await this.runtimePool.releaseForDeletion(id);
      if (!released) throw new Error("该会话正在执行其他操作，请稍后重试删除");
    }
    if (path && existsSync(path)) await unlink(path);
    this.lastUserPromptAtBySession.delete(id);
    this.gateModesBySession.delete(id);
    this.fastModeBySession.delete(id);
    this.clearRuntimeFailure(id);
    this.clearNativeSteeringState(id, "deleted");
    this.sessionControl.clearSession(id);
    await this.options.sessions.list(this.activeSessionPath, this.currentCwd);
    this.broadcast({
      type: "pi_chat_sessions_changed",
      action: "deleted",
      sessionId: id,
    });
    return this.bootstrap();
  }

  private async coldSessionView(
    id: string,
    session: SessionSummary,
    turnLimit: number,
    clientId: string,
  ): Promise<SessionViewData | null> {
    const snapshot = await this.options.sessions.snapshotForId?.(id);
    if (snapshot)
      return this.coldSessionViewFromSnapshot(id, session, snapshot, turnLimit, clientId);
    const messages = await this.options.sessions.messagesForId(id);
    if (!messages) return null;
    return this.coldSessionViewFromSnapshot(
      id,
      session,
      { messages, settings: {} },
      turnLimit,
      clientId,
    );
  }

  private coldSessionViewFromSnapshot(
    id: string,
    session: SessionSummary,
    snapshot: Pick<SessionFileSnapshot, "messages" | "settings"> & { usage?: SessionUsageSnapshot },
    turnLimit: number,
    clientId: string,
  ): SessionViewData {
    const windowed = messageWindow(snapshot.messages, turnLimit);
    const settings = snapshot.settings || {};
    return {
      session: {
        ...session,
        active: false,
        writable: false,
        running: false,
        queued: false,
      },
      // Never borrow Primary's active settings for history. Pi persists these
      // change events in each JSONL, so reading them keeps cold views truthful.
      state: {
        model: this.modelFromSessionSettings(settings),
        thinkingLevel: settings.thinkingLevel,
        fastModeActive: false,
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
      stats: snapshot.usage
        ? this.offlineStatsFromUsage(id, snapshot.usage)
        : undefined,
      // Gate is a fixed Pi Chat system control. Startup self-heals its adapter;
      // a cold history read does not need to rediscover that resource on disk.
      gateAvailable: true,
      // A cold Session has no live Runtime to report its Gate; report the
      // process-remembered mode (or the safe strict default) until activation
      // replaces it with the Runtime-confirmed value.
      gateMode: this.currentGateMode(id),
      commands: [],
      viewSource: "cold-jsonl",
      pendingExtensionRequest: this.pendingRequestForSession(id),
      ...this.controlState(id, clientId),
    };
  }

  private hotMemoryView(
    id: string,
    turnLimit: number,
    clientId: string,
  ): SessionViewData | null {
    const runtime =
      id === this.activeSessionId ? null : this.runtimePool.get(id);
    const primary = id === this.activeSessionId && this.primaryReadReady();
    if (!runtime && !primary) return null;
    if (runtime) this.runtimePool.touch(runtime);
    const summary = primary
      ? this.primarySummarySnapshot || {
          id,
          sessionId: this.lastPrimaryState.sessionId || id,
          name: this.lastPrimaryState.sessionName || "当前对话",
          preview: "",
          cwd: this.currentCwd,
          updatedAt: this.now(),
          messageCount: this.lastPrimaryState.messageCount || 0,
          active: true,
        }
      : runtime!.summarySnapshot || runtime!.draftSession;
    if (!summary) return null;
    const persisted = primary
      ? this.lastPrimaryMessagesSessionId === id
        ? this.lastPrimaryMessages
        : undefined
      : runtime!.messageSnapshot;
    const tail = primary
      ? this.primaryPendingTerminalSessionId === id
        ? this.primaryPendingTerminalMessages
        : []
      : runtime!.pendingTerminalMessages;
    const messages = reconcilePersistedHistory(persisted || [], tail).messages;
    const windowed = messageWindow(messages, turnLimit);
    const state = primary
      ? this.lastPrimaryState
      : runtime!.lastState || { model: null, isStreaming: runtime!.running };
    const streaming = primary
      ? this.primaryTurnActive()
      : this.runtimeTurnActive(runtime!) || runtime!.dispatching;
    return {
      session: {
        ...summary,
        active: true,
        writable: true,
        running: streaming,
        queued: primary
          ? this.promptQueue.length > 0
          : runtime!.promptQueue.length > 0,
      },
      state: this.stateWithFastMode(id, { ...state, isStreaming: streaming }),
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
      stats: primary
        ? this.lastPrimaryStats?.sessionId === id
          ? this.lastPrimaryStats.value
          : undefined
        : runtime!.lastStats,
      queue: primary
        ? this.publicQueue()
        : this.publicQueue(runtime!.promptQueue),
      queuePaused: primary ? this.queuePaused : runtime!.queuePaused,
      commands: primary
        ? this.lastPrimaryCommands.length
          ? [...BUILTIN_COMMANDS, ...this.lastPrimaryCommands]
          : undefined
        : runtime!.commands?.length
          ? [...BUILTIN_COMMANDS, ...runtime!.commands]
          : undefined,
      gateMode: primary ? this.primaryGateMode : runtime!.gateMode,
      pendingExtensionRequest: this.pendingRequestForSession(id),
      historyPending: !persisted,
      reconcilePending:
        !persisted ||
        tail.length > 0 ||
        (primary
          ? this.lastPrimaryStats?.sessionId !== id
          : !runtime!.statsKnown || !runtime!.commandsKnown),
      viewSource: "hot-memory",
      ...this.controlState(id, clientId),
    };
  }

  private async sessionView(
    id: string,
    turnLimit = RECENT_TURN_WINDOW_SIZE,
    clientId = "",
  ): Promise<SessionViewData | null> {
    const knownRuntime = this.runtimePool.get(id);
    const targetRuntimeBusy =
      id === this.activeSessionId
        ? this.primaryTurnActive()
        : Boolean(
            knownRuntime &&
            (this.runtimeTurnActive(knownRuntime) || knownRuntime.dispatching),
          );
    // Cold history is a pure JSONL read. Avoid waking or querying the Primary RPC
    // and avoid rescanning every Session when the index already knows this ID.
    if (id !== this.activeSessionId && !knownRuntime) {
      const index = this.options.sessions as SessionIndex & {
        cachedSummaryForId?: (
          sessionId: string,
        ) => Promise<SessionSummary | null>;
      };
      const knownSession =
        this.options.sessions.summaryForId?.(id) ||
        (await index.cachedSummaryForId?.(id));
      if (knownSession)
        return this.coldSessionView(id, knownSession, turnLimit, clientId);
    }
    // Browser /api/sessions/:id/view has a 65s client budget. Several default 30s
    // Pi RPC calls used to stack past that during compaction or long tool turns,
    // producing a late red "请求超时（65 秒）" even after compaction finished.
    const SHORT_RPC_MS = 4_000;
    const MESSAGES_RPC_MS = 6_000;
    const primaryAvailable =
      this.applicationLifecycle === "idle" && this.primaryReadReady();
    let state: PiState = this.lastPrimaryState;
    if (
      primaryAvailable &&
      !(id !== this.activeSessionId && targetRuntimeBusy)
    ) {
      // Controller-managed startup already adopted the exact state response
      // that certified this child. A view must never reopen authority binding
      // with another get_state; retain a legacy fallback only when no adopted
      // generation exists.
      const currentPrimaryGeneration =
        this.options.rpc.currentGeneration?.() || 0;
      const canSkipStateProbe =
        Boolean(this.activeSessionId) &&
        Boolean(this.activeSessionPath) &&
        (currentPrimaryGeneration
          ? this.primaryRpcGeneration === currentPrimaryGeneration
          : this.primaryTurnActive());
      if (canSkipStateProbe) {
        state = {
          ...this.lastPrimaryState,
          isStreaming: targetRuntimeBusy,
        };
      } else {
        try {
          state = asState(
            await this.options.rpc.send({ type: "get_state" }, SHORT_RPC_MS),
          );
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
    const knownBusy =
      id === this.activeSessionId
        ? this.primaryTurnActive()
        : Boolean(
            secondaryRuntime &&
            (this.runtimeTurnActive(secondaryRuntime) ||
              secondaryRuntime.dispatching),
          );
    // A busy Runtime already has a known Session path/index entry. Do not rescan
    // every JSONL merely to switch back to it: streaming writes continuously
    // invalidate mtime and made this navigation visibly stall.
    const indexedSession = knownBusy
      ? this.options.sessions.summaryForId?.(id) ||
        secondaryRuntime?.draftSession
      : null;
    const sessions = indexedSession
      ? this.sessionSummaries([indexedSession], clientId)
      : this.sessionSummaries(
          await this.options.sessions.list(
            this.activeSessionPath,
            this.currentCwd,
          ),
          clientId,
        );
    // A fresh New view is valid even though it is deliberately absent from the
    // sidebar until its first user message is persisted.
    const session =
      sessions.find((item) => item.id === id) || secondaryRuntime?.draftSession;
    if (!session) return null;
    const secondaryReadable =
      this.applicationLifecycle === "idle" &&
      secondaryRuntime &&
      !secondaryRuntime.failed &&
      secondaryRuntime.rpc.isRunning?.() !== false
        ? secondaryRuntime
        : null;
    const runtime =
      id === this.activeSessionId && primaryAvailable
        ? {
            rpc: this.options.rpc,
            running: this.running,
            liveMessage: this.liveMessage,
            toolStatus: this.toolStatus,
          }
        : secondaryReadable;
    if (runtime) {
      if (id !== this.activeSessionId)
        this.runtimePool.touch(runtime as SecondaryRuntime);
      const busy =
        runtime.running ||
        Boolean(runtime.liveMessage) ||
        Boolean(runtime.toolStatus) ||
        Boolean((runtime as SecondaryRuntime).dispatching);
      const sessionIndex = this.options.sessions as SessionIndex & {
        cachedSnapshotForId?: (
          sessionId: string,
        ) => import("./session-index.js").SessionFileSnapshot | null;
        snapshotForId?: (
          sessionId: string,
        ) => Promise<import("./session-index.js").SessionFileSnapshot | null>;
      };
      // For an already-open streaming Session, use the last parsed JSONL branch
      // immediately. The live assistant snapshot arrives separately over SSE.
      let snapshot = busy
        ? (sessionIndex.cachedSnapshotForId?.(id) ?? null)
        : null;
      if (!snapshot && !busy && sessionIndex.snapshotForId)
        snapshot = await sessionIndex.snapshotForId(id);
      const persistedRuntimeMessages =
        id === this.activeSessionId && this.lastPrimaryMessagesSessionId === id
          ? this.lastPrimaryMessages
          : (secondaryRuntime?.messageSnapshot ?? null);
      const terminalTail =
        id === this.activeSessionId
          ? this.primaryPendingTerminalSessionId === id
            ? this.primaryPendingTerminalMessages
            : []
          : secondaryRuntime?.pendingTerminalMessages || [];
      let persistedMessages: PiMessage[] | null =
        snapshot?.messages ??
        (busy
          ? persistedRuntimeMessages
          : typeof this.options.sessions.messagesForId === "function"
            ? await this.options.sessions.messagesForId(id)
            : null);
      let messages: PiMessage[] | null = persistedMessages
        ? reconcilePersistedHistory(persistedMessages, terminalTail).messages
        : terminalTail.length
          ? reconcilePersistedHistory([], terminalTail).messages
          : null;
      if (!messages && !busy) {
        const path =
          (typeof this.options.sessions.pathForId === "function"
            ? this.options.sessions.pathForId(id)
            : null) ||
          (runtime as SecondaryRuntime).sessionPath ||
          (runtime as SecondaryRuntime).draftSessionPath;
        if (path) {
          try {
            persistedMessages = await readSessionMessages(path);
            messages = reconcilePersistedHistory(
              persistedMessages,
              terminalTail,
            ).messages;
          } catch {
            messages = null;
          }
        }
      }
      let stateResponse: Record<string, unknown> | null = null;
      let statsResponse: Record<string, unknown> | null = null;
      let commandsResponse: Record<string, unknown> | null = null;
      if (!busy) {
        try {
          const primaryAdopted =
            id === this.activeSessionId &&
            Boolean(this.primaryRpcGeneration) &&
            this.primaryRpcGeneration ===
              (this.options.rpc.currentGeneration?.() || 0);
          const probes = await Promise.all([
            primaryAdopted
              ? Promise.resolve(null)
              : runtime.rpc
                  .send({ type: "get_state" }, SHORT_RPC_MS)
                  .catch(() => null),
            runtime.rpc
              .send({ type: "get_session_stats" }, SHORT_RPC_MS)
              .catch(() => null),
            runtime.rpc
              .send({ type: "get_commands" }, SHORT_RPC_MS)
              .catch(() => null),
          ]);
          stateResponse = probes[0];
          statsResponse = probes[1];
          commandsResponse = probes[2];
        } catch {
          // Disk history + last known liveMessage still form a usable view.
        }
      }
      const rememberedState =
        id === this.activeSessionId
          ? this.lastPrimaryState
          : secondaryRuntime?.lastState || { model: null };
      const liveState = stateResponse
        ? asState(stateResponse)
        : ({
            ...rememberedState,
            isStreaming: busy,
          } satisfies PiState);
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
          persistedMessages = asMessages(
            await runtime.rpc.send(
              { type: "get_messages" },
              busy ? 3_000 : MESSAGES_RPC_MS,
            ),
          );
          messages = reconcilePersistedHistory(
            persistedMessages,
            terminalTail,
          ).messages;
        } catch (error) {
          throw error;
        }
      }
      if (!messages) throw new Error("无法读取会话消息");
      if (persistedMessages) {
        const reconciled = reconcilePersistedHistory(
          persistedMessages,
          terminalTail,
        );
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
          ? snapshot
            ? await this.offlineStatsForId(id, snapshot.usage)
            : undefined
          : await this.offlineStatsForId(id, snapshot?.usage);
      const rememberedCommands =
        id === this.activeSessionId
          ? this.lastPrimaryCommands
          : secondaryRuntime?.commands;
      if (secondaryRuntime) {
        secondaryRuntime.summarySnapshot = session;
        secondaryRuntime.lastStats = stats;
        secondaryRuntime.statsKnown =
          Boolean(statsResponse) || secondaryRuntime.statsKnown;
      } else if (id === this.activeSessionId)
        this.primarySummarySnapshot = session;
      return {
        session,
        state: this.stateWithFastMode(id, liveState),
        messages: windowed.messages,
        messageTotal: windowed.total,
        turnTotal: windowed.turns,
        visibleTurnCount: windowed.visibleTurns,
        messagesTruncated: windowed.truncated,
        isActive: true,
        runtimeStatus: "active",
        isStreaming: busy || liveState.isStreaming,
        liveMessage: runtime.liveMessage,
        toolStatus: runtime.toolStatus,
        stats,
        queue:
          id === this.activeSessionId
            ? this.publicQueue()
            : this.publicQueue((runtime as SecondaryRuntime).promptQueue),
        queuePaused:
          id === this.activeSessionId
            ? this.queuePaused
            : (runtime as SecondaryRuntime).queuePaused,
        commands: commandsResponse
          ? [...BUILTIN_COMMANDS, ...asCommands(commandsResponse)]
          : rememberedCommands?.length
            ? [...BUILTIN_COMMANDS, ...rememberedCommands]
            : undefined,
        gateMode:
          id === this.activeSessionId
            ? this.primaryGateMode
            : (runtime as SecondaryRuntime).gateMode,
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
    if (this.contextUsagePendingRefresh.has(id))
      this.contextUsageRefreshTurn.add(id);
  }

  private completeContextUsageRefreshTurn(id: string): void {
    if (!this.contextUsageRefreshTurn.delete(id)) return;
    this.contextUsagePendingRefresh.delete(id);
  }

  private rememberModelContextWindows(models: ModelInfo[]): void {
    for (const model of models) {
      const key = `${model.provider}\u0000${model.id}`;
      this.knownModels.set(key, model);
      if (typeof model.contextWindow === "number" && model.contextWindow > 0)
        this.modelContextWindows.set(key, model.contextWindow);
    }
  }

  private modelFromSessionSettings(
    settings: SessionSettingsSnapshot,
  ): ModelInfo | null {
    if (!settings.provider || !settings.modelId) return null;
    return (
      this.knownModels.get(`${settings.provider}\u0000${settings.modelId}`) ||
        // Keep the actual persisted identifier visible if a model was later removed
        // from the current catalogue; this is still more truthful than Primary's model.
        {
          provider: settings.provider,
          id: settings.modelId,
          name: settings.modelId,
        }
    );
  }

  private offlineStatsFromUsage(
    id: string,
    usage: SessionUsageSnapshot,
  ): SessionStats {
    const stats: SessionStats = { tokens: usage.tokens };
    if (usage.context) {
      const contextWindow =
        this.modelContextWindows.get(
          `${usage.context.provider || ""}\u0000${usage.context.model || ""}`,
        ) || 0;
      if (!contextWindow)
        console.warn(
          `[Pi Chat] 冷会话上下文用量：未找到模型 ${usage.context.provider}/${usage.context.model} 的 contextWindow`,
        );
      if (contextWindow > 0) {
        const pendingRefresh = this.contextUsagePendingRefresh.has(id);
        stats.contextUsage = pendingRefresh
          ? { tokens: null, contextWindow, percent: null }
          : {
              tokens: usage.context.tokens,
              contextWindow,
              percent: Math.min(
                100,
                (usage.context.tokens / contextWindow) * 100,
              ),
            };
        if (pendingRefresh) stats.contextUsagePendingRefresh = true;
      }
    }
    return stats;
  }

  private async offlineStatsForId(
    id: string,
    knownUsage?: SessionUsageSnapshot,
  ): Promise<SessionStats | undefined> {
    // Optional-chained: test doubles and older indexes may not implement usageForId.
    const usage =
      knownUsage ??
      (await Promise.resolve(this.options.sessions.usageForId?.(id)).catch(
        () => null,
      ));
    return usage ? this.offlineStatsFromUsage(id, usage) : undefined;
  }

  /** Prefer Pi's live counters, but use persisted usage whenever it omits occupancy. */
  private async statsForSession(
    id: string,
    response: Record<string, unknown>,
  ): Promise<SessionStats> {
    const live = asSessionStats(response);
    const fallback = await this.offlineStatsForId(id);
    const contextUsage = live.contextUsage || fallback?.contextUsage;
    return {
      ...live,
      ...(contextUsage ? { contextUsage } : {}),
      ...(fallback?.contextUsagePendingRefresh
        ? { contextUsagePendingRefresh: true }
        : {}),
    };
  }

  private async bootstrap(
    clientId = "",
    coherenceRetry = 0,
  ): Promise<BootstrapData> {
    const readinessAtStart = this.primaryReadiness();
    if (
      this.applicationLifecycle !== "idle" &&
      (this.primaryFailed || this.options.rpc.isRunning?.() === false)
    ) {
      throw new ApplicationLifecycleConflictError(
        this.applicationLifecycle,
        this.lifecycleMessage(),
      );
    }
    // Bootstrap is a Session directory/read projection, not permission to make
    // the service wait for a stopped Primary. A healthy existing worker still
    // provides its current state, while a missing/crashed worker is recovered
    // only at the first real write (or an explicit activation).
    const primaryAvailable =
      readinessAtStart.status === "ready" &&
      !this.primaryFailed &&
      this.options.rpc.isRunning?.() !== false;
    const primaryStateAdopted = Boolean(
      this.primaryBoundSessionId &&
        this.primaryRpcGeneration &&
        this.primaryRpcGeneration ===
          (this.options.rpc.currentGeneration?.() || this.primaryRpcGeneration),
    );
    let state = this.lastPrimaryState;
    if (
      primaryAvailable &&
      !primaryStateAdopted &&
      !(this.primaryTurnActive() && this.activeSessionPath)
    ) {
      try {
        state = asState(
          await this.options.rpc.send(
            { type: "get_state" },
            this.activeSessionPath ? 4_000 : 12_000,
          ),
        );
        this.lastPrimaryState = state;
        this.running = state.isStreaming;
        this.bindPrimaryIdentity(state);
      } catch (error) {
        if (!this.activeSessionPath) throw error;
        state = {
          ...this.lastPrimaryState,
          isStreaming: this.primaryTurnActive(),
        };
      }
    } else if (this.primaryTurnActive() && this.activeSessionPath)
      state = { ...state, isStreaming: true };

    const busy = this.primaryTurnActive() || state.isStreaming;
    if (busy && !state.isStreaming) state = { ...state, isStreaming: true };
    if (!this.lastAvailableModels.length && state.model) {
      this.rememberModelContextWindows([state.model]);
      this.lastAvailableModels = [state.model];
    }
    const diskMessages = this.activeSessionPath
      ? await readSessionMessages(this.activeSessionPath).catch(() => null)
      : null;
    let messages: PiMessage[] | null = null;
    const primaryTerminalTail =
      this.primaryPendingTerminalSessionId === this.activeSessionId
        ? this.primaryPendingTerminalMessages
        : [];
    if (diskMessages) {
      const reconciled = reconcilePersistedHistory(
        diskMessages,
        primaryTerminalTail,
      );
      this.lastPrimaryMessages = diskMessages;
      this.primaryPendingTerminalMessages = reconciled.pending;
      this.lastPrimaryMessagesSessionId = this.activeSessionId;
      messages = reconciled.messages;
    } else if (this.lastPrimaryMessagesSessionId === this.activeSessionId) {
      messages = reconcilePersistedHistory(
        this.lastPrimaryMessages,
        primaryTerminalTail,
      ).messages;
    }
    // JSONL is authoritative enough for an immediately readable bootstrap.
    // An empty brand-new busy Session can render its live/optimistic message;
    // never hold the whole shell open waiting for get_messages.
    if (primaryAvailable && !messages && !busy) {
      const rpcMessages = asMessages(
        await this.options.rpc.send({ type: "get_messages" }, 12_000),
      );
      const reconciled = reconcilePersistedHistory(
        rpcMessages,
        primaryTerminalTail,
      );
      this.lastPrimaryMessages = rpcMessages;
      this.primaryPendingTerminalMessages = reconciled.pending;
      this.lastPrimaryMessagesSessionId = this.activeSessionId;
      messages = reconciled.messages;
    }

    if (primaryAvailable && !busy) {
      const [modelsResponse, commandsResponse, statsResponse] =
        await Promise.all([
          this.options.rpc
            .send({ type: "get_available_models" }, 8_000)
            .catch(() => null),
          this.options.rpc
            .send({ type: "get_commands" }, 8_000)
            .catch(() => null),
          this.options.rpc
            .send({ type: "get_session_stats" }, 8_000)
            .catch(() => null),
        ]);
      if (modelsResponse) {
        const models = this.options.modelManager
          ? await this.options.modelManager.annotate(asModels(modelsResponse))
          : asModels(modelsResponse);
        this.rememberModelContextWindows(models);
        this.lastAvailableModels = models;
      }
      if (commandsResponse)
        this.lastPrimaryCommands = asCommands(commandsResponse);
      if (statsResponse)
        this.lastPrimaryStats = {
          sessionId: this.activeSessionId,
          value: await this.statsForSession(
            this.activeSessionId,
            statsResponse,
          ),
        };
    }
    const availableModels = this.lastAvailableModels.length
      ? this.lastAvailableModels
      : this.startupModels;
    const windowedMessages = messageWindow(messages || []);
    const sidebar = this.sidebarSessions(
      await this.cachedSessionList(state.sessionFile),
      clientId,
    );
    this.primarySummarySnapshot =
      sidebar.sessions.find((session) => session.id === this.activeSessionId) ||
      this.primarySummarySnapshot;
    const readinessAtEnd = this.primaryReadiness();
    if (
      coherenceRetry < 1 &&
      (readinessAtEnd.generation !== readinessAtStart.generation ||
        readinessAtEnd.status !== readinessAtStart.status)
    ) {
      // Startup/recovery crossed this request while independent Session/JSONL
      // work was awaiting. Never return old state with a newer ready marker (or
      // the reverse); rebuild once from the already-adopted generation. This
      // does not send another get_state for a controller-owned Primary.
      return this.bootstrap(clientId, coherenceRetry + 1);
    }
    return {
      buildIdentity: this.buildIdentity,
      state: this.stateWithFastMode(this.activeSessionId, state),
      messages: windowedMessages.messages,
      messageTotal: windowedMessages.total,
      turnTotal: windowedMessages.turns,
      visibleTurnCount: windowedMessages.visibleTurns,
      messagesTruncated: windowedMessages.truncated,
      activeSessionId: this.activeSessionId,
      activeSessionIds: this.activeSessionIds(),
      liveMessage: this.liveMessage,
      toolStatus: this.toolStatus,
      stats:
        this.lastPrimaryStats?.sessionId === this.activeSessionId
          ? this.lastPrimaryStats.value
          : await this.offlineStatsForId(this.activeSessionId),
      models: availableModels,
      commands: [...BUILTIN_COMMANDS, ...this.lastPrimaryCommands],
      queue: this.publicQueue(),
      queuePaused: this.queuePaused,
      pendingExtensionRequest: this.pendingRequestForSession(
        this.activeSessionId,
      ),
      gateMode: this.primaryGateMode,
      ...this.controlState(this.activeSessionId, clientId),
      workspaceCwd: this.currentCwd,
      workspaceEpoch: this.runEpoch,
      workspaceRevision: this.workspaceRevision,
      sessions: sidebar.sessions,
      sessionDirectories: sidebar.directories,
      sessionsTotal: sidebar.total,
      applicationLifecycle: this.applicationLifecycle,
      primaryRuntime: readinessAtStart,
    };
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const requestError = requestGuardError(request, {
        allowedHosts: this.allowedHosts,
        token: this.requestToken,
      });
      if (requestError) return json(response, 403, { error: requestError });
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        await this.handleApi(request, response, url);
        return;
      }
      if (this.options.devMiddleware) {
        this.options.devMiddleware(request, response, () => {
          if (!response.writableEnded)
            json(response, 404, { error: "Not found" });
        });
        return;
      }
      await this.serveStatic(request, response, url.pathname);
    } catch (error) {
      const clientId = requestClientId(request);
      const pageId = requestPageId(request);
      const sessionId = this.sessionIdForRequest(request);
      const operation = this.operationForRequest(request);
      const runtime = sessionId ? this.runtimePool.get(sessionId) : undefined;
      const runtimeKind = sessionId
        ? runtime
          ? "secondary"
          : sessionId === this.activeSessionId
            ? "primary"
            : undefined
        : undefined;
      const queueLength = runtime
        ? runtime.promptQueue.length
        : runtimeKind === "primary"
          ? this.promptQueue.length
          : undefined;
      const rpcGeneration = runtime?.rpcGeneration
        || (runtimeKind === "primary" ? this.primaryRpcGeneration : undefined);
      const childPid = runtime?.rpc.currentPid?.()
        || (runtimeKind === "primary" ? this.options.rpc.currentPid?.() : undefined)
        || undefined;
      const report = (
        outcome: import("./incident-diagnostics.js").IncidentOutcome,
        errorCode: string,
      ) => this.reportIncident(error, {
        sessionId,
        browserId: clientId,
        pageId,
        runtimeKind,
        rpcGeneration,
        childPid,
        operation,
        queueLength,
        controlState: sessionId
          ? this.incidentControlState(sessionId, clientId)
          : "no-browser-identity",
        outcome,
        errorCode,
      });
      if (error instanceof ApplicationLifecycleConflictError) {
        const incident = report("rejected", "APPLICATION_LIFECYCLE_BLOCKED");
        response.setHeader("retry-after", "2");
        const isBootstrap =
          new URL(request.url || "/", "http://127.0.0.1").pathname ===
          "/api/bootstrap";
        return json(response, 503, {
          error: error.message,
          code: "APPLICATION_LIFECYCLE_BLOCKED",
          lifecycle: error.lifecycle,
          retryable: true,
          incidentId: incident.incidentId,
          ...(isBootstrap ? { requestToken: this.requestToken } : {}),
        });
      }
      if (error instanceof ApplicationBusyError) {
        const incident = report("rejected", "APPLICATION_BUSY");
        return json(response, 409, {
          error: error.message,
          code: "APPLICATION_BUSY",
          incidentId: incident.incidentId,
        });
      }
      if (error instanceof PrimaryRuntimeUnavailableError) {
        const existing = incidentReference(error.readiness);
        const incident = existing || report("failed", "PRIMARY_RUNTIME_UNAVAILABLE");
        return json(response, 503, {
          error: error.message,
          code: incidentErrorCode(error) || "PRIMARY_RUNTIME_UNAVAILABLE",
          incidentId: incident.incidentId,
          primaryRuntime: error.readiness,
        });
      }
      if (error instanceof SessionControlConflictError) {
        const incident = report("rejected", "SESSION_CONTROL_CONFLICT");
        return json(response, 409, {
          error: error.message,
          code: "SESSION_CONTROL_CONFLICT",
          incidentId: incident.incidentId,
        });
      }
      if (error instanceof RuntimeCapacityError) {
        const incident = report("rejected", "RUNTIME_CAPACITY_EXHAUSTED");
        return json(response, 409, {
          error: error.message,
          code: "RUNTIME_CAPACITY_EXHAUSTED",
          incidentId: incident.incidentId,
        });
      }
      if (error instanceof OperationAdmissionClosedError) {
        const incident = report("rejected", "OPERATION_ADMISSION_CLOSED");
        return json(response, 409, {
          error: error.message,
          code: "OPERATION_ADMISSION_CLOSED",
          incidentId: incident.incidentId,
        });
      }
      if (error instanceof HttpRequestError) {
        const incident = report("rejected", "HTTP_REQUEST_REJECTED");
        return json(response, error.status, {
          error: error.message,
          code: "HTTP_REQUEST_REJECTED",
          incidentId: incident.incidentId,
        });
      }
      if (error instanceof RpcFrameTooLargeError) {
        const incident = report("oversized", error.code);
        return json(response, error.status, {
          error: error.message,
          code: error.code,
          incidentId: incident.incidentId,
        });
      }
      if (response.headersSent) {
        response.end();
        return;
      }
      const incident = report("failed", "UNEXPECTED_SERVER_ERROR");
      const message = error instanceof Error ? error.message : String(error);
      json(response, 500, {
        error: message,
        code: "UNEXPECTED_SERVER_ERROR",
        incidentId: incident.incidentId,
      });
    }
  }

  private async handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const traceHttpRequest = url.pathname !== "/api/diagnostics/snapshot"
      && !/^\/api\/sessions\/[a-f0-9]{20}\/background-subagents$/.test(url.pathname);
    const diagnosticStartedAt = this.now();
    let diagnosticEnded = false;
    if (traceHttpRequest) {
      response.once("finish", () => {
        if (diagnosticEnded) return;
        diagnosticEnded = true;
        this.traceState("http", "request-end", this.sessionIdForRequest(request), {
          method: request.method || "GET",
          route: url.pathname,
          status: response.statusCode,
          durationMs: this.now() - diagnosticStartedAt,
        });
      });
      this.traceState("http", "request-start", this.sessionIdForRequest(request), {
        method: request.method || "GET",
        route: url.pathname,
      });
    }
    try {
      // Parsing/identity validation deliberately precedes the lifecycle lease. A
      // malformed or stale browser request is not an admitted mutation and cannot
      // briefly prevent explicit restart/shutdown from reaching quiescence.
      const admission = apiRouteAdmission(request, url);
      if (admission.bodyBeforeMutationLease) {
        const body = await bodyJson(request, admission.bodyLimit);
        if (admission.validateSessionId) {
          const sessionId = requiredSessionId(body);
          Object.defineProperty(request, "piChatDiagnosticSessionId", {
            configurable: true,
            value: sessionId,
          });
        }
        const releaseMutation = this.beginMutation();
        try {
          await this.handleApiCore(request, response, url, body);
        } finally {
          releaseMutation();
        }
        return;
      }
      const releaseMutation = admission.ordinaryMutation
        ? this.beginMutation()
        : null;
      try {
        await this.handleApiCore(request, response, url);
      } finally {
        releaseMutation?.();
      }
    } catch (error) {
      if (traceHttpRequest)
        this.traceState("http", "request-error", this.sessionIdForRequest(request), {
          method: request.method || "GET",
          route: url.pathname,
          status: response.headersSent ? response.statusCode : 0,
          durationMs: this.now() - diagnosticStartedAt,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      throw error;
    }
  }

  private async listSessionsRoute(input: {
    clientId: string;
    all: boolean;
    fresh: boolean;
    includeIds: string[];
    directory: boolean;
    cwd: string;
    offset: number;
    limit: number;
  }): Promise<unknown> {
    const page = (sidebar: ReturnType<PiChatApp["sidebarSessions"]>) => {
      if (!input.directory)
        return {
          sessions: sidebar.sessions,
          total: sidebar.total,
          directories: sidebar.directories,
        };
      const cwdKey = (cwd: string) =>
        cwd ? resolve(cwd).toLowerCase() : "__unknown_cwd__";
      const key = cwdKey(input.cwd);
      return {
        sessions: sidebar.sessions
          .filter((session) => cwdKey(session.cwd) === key)
          .slice(input.offset, input.offset + input.limit),
        total:
          sidebar.directories.find((directory) => cwdKey(directory.cwd) === key)
            ?.count || 0,
        directories: sidebar.directories,
      };
    };
    const list = () =>
      input.fresh
        ? this.options.sessions.list(
            this.activeSessionPath || this.lastPrimaryState.sessionFile,
          )
        : this.cachedSessionList(
            this.activeSessionPath || this.lastPrimaryState.sessionFile,
          );
    if (this.applicationLifecycle !== "idle") {
      const result = page(
        this.sidebarSessions(
          await list(),
          input.clientId,
          input.all || input.directory,
          input.includeIds,
        ),
      );
      return { ...result, applicationLifecycle: this.applicationLifecycle };
    }
    // Sidebar inventory is a pure Session Index read. Do not probe Primary here:
    // a just-restarted worker can be slow while JSONL metadata is fully usable.
    const result = page(
      this.sidebarSessions(
        await list(),
        input.clientId,
        input.all || input.directory,
        input.includeIds,
      ),
    );
    return { ...result, applicationLifecycle: this.applicationLifecycle };
  }

  private async readOnlySessionPath(sessionId: string): Promise<string | null> {
    const runtime = this.runtimePool.get(sessionId);
    const regular = (sessionId === this.activeSessionId
      ? this.activeSessionPath || this.lastPrimaryState.sessionFile
      : runtime?.sessionPath)
      || this.options.sessions.pathForId(sessionId);
    return regular || await this.subagentStatuses.knownChildSessionPath(sessionId);
  }

  private async backgroundSubagentsRoute(sessionId: string): Promise<BackgroundSubagentSnapshot | null> {
    const path = await this.readOnlySessionPath(sessionId);
    if (!path) return null;
    return this.subagentStatuses.listForParentSession(path);
  }

  private async backgroundSubagentViewRoute(input: {
    parentSessionId: string;
    childSessionId: string;
    clientId: string;
    turns: number;
  }): Promise<SessionViewData | null> {
    const parentPath = await this.readOnlySessionPath(input.parentSessionId);
    if (!parentPath) return null;
    const target = await this.subagentStatuses.navigationTargetForParentSession(
      parentPath,
      input.childSessionId,
    );
    if (!target) return null;
    const summary = parseSessionContent(target.path, target.content, target.modifiedAt, {
      includeSubagents: true,
      displayName: target.label,
    });
    if (!summary || summary.id !== input.childSessionId) return null;
    const snapshot = readSessionSnapshotContent(target.content);
    const view = this.coldSessionViewFromSnapshot(
      input.childSessionId,
      { ...summary, active: false },
      snapshot,
      input.turns,
      input.clientId,
    );
    this.traceViewProjection(
      "subagent-session-view",
      input.childSessionId,
      view,
    );
    return view;
  }

  private async sessionViewRoute(input: {
    sessionId: string;
    clientId: string;
    turns: number;
    fast: boolean;
  }): Promise<SessionViewData | null> {
    // Reading a cold history is deliberately view-only; no Runtime is created.
    const view = input.fast
      ? this.hotMemoryView(input.sessionId, input.turns, input.clientId)
      : await this.sessionView(input.sessionId, input.turns, input.clientId);
    this.traceViewProjection(
      input.fast ? "session-view-fast" : "session-view",
      input.sessionId,
      view,
    );
    return view;
  }

  private async handleApiCore(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    preparedBody?: Record<string, unknown>,
  ): Promise<void> {
    const clientId = requestClientId(request);
    if (url.pathname === "/api/diagnostics/snapshot") {
      if (request.method !== "GET") return methodNotAllowed(response);
      const pageId = requestPageId(request);
      if (!clientId || !pageId)
        return json(response, 400, {
          error: "导出诊断需要浏览器窗口与页面标识",
          code: "DIAGNOSTIC_CLIENT_REQUIRED",
        });
      if (this.connectedPageClients.get(pageId) !== clientId)
        return json(response, 409, {
          error: "当前页面已关闭或尚未完成连接，无法导出诊断",
          code: "DIAGNOSTIC_PAGE_NOT_REGISTERED",
        });
      this.streamDiagnostics.checkpoint();
      return json(response, 200, this.stateDiagnostics.snapshot());
    }
    if (
      await handleBootstrapRoute(
        {
          lifecycle: () => this.applicationLifecycle,
          assertBootstrapAllowed: () => {
            if (this.applicationLifecycle !== "idle")
              throw new ApplicationLifecycleConflictError(
                this.applicationLifecycle,
                this.lifecycleMessage(),
              );
          },
          requestToken: () => this.requestToken,
          buildIdentity: () => this.buildIdentity,
          openWindowCount: () => this.openWindowCount(),
          cancelLastWindowShutdown: () => this.cancelLastWindowShutdown(),
          scheduleLastWindowShutdown: () => this.scheduleLastWindowShutdown(),
          registerWindowPage: (id, pageId) =>
            this.registerWindowPage(id, pageId),
          bootstrap: async (id) => {
            const data = await this.bootstrap(id);
            this.traceBootstrapProjection(data);
            return data;
          },
        },
        request,
        response,
        url,
        clientId,
      )
    )
      return;
    if (
      await handleSubagentsReadRoute(
        {
          backgroundSubagents: (sessionId) => this.backgroundSubagentsRoute(sessionId),
          backgroundSubagentView: (input) => this.backgroundSubagentViewRoute(input),
        },
        request,
        response,
        url,
        clientId,
        {
          recentTurns: RECENT_TURN_WINDOW_SIZE,
          maxTurns: MAX_TURN_WINDOW_SIZE,
          turnIncrement: TURN_WINDOW_INCREMENT,
        },
      )
    )
      return;
    if (
      await handleSessionsReadRoute(
        {
          listSessions: (input) => this.listSessionsRoute(input),
          sessionView: (input) => this.sessionViewRoute(input),
        },
        request,
        response,
        url,
        clientId,
        {
          recentTurns: RECENT_TURN_WINDOW_SIZE,
          maxTurns: MAX_TURN_WINDOW_SIZE,
          turnIncrement: TURN_WINDOW_INCREMENT,
          directoryLimit: DEFAULT_DIRECTORY_SESSION_LIST_SIZE,
          maxDirectoryLimit: MAX_DIRECTORY_SESSION_LIST_SIZE,
        },
      )
    )
      return;

    if (url.pathname === "/api/events") {
      if (request.method !== "GET") return methodNotAllowed(response);
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      // A browser commonly opens SSE only after its initial bootstrap. Include
      // the current Primary capability snapshot here so a fast start that
      // completes between those two connections cannot leave the client pinned
      // forever to bootstrap's earlier `starting` state.
      response.write(
        `event: ready\ndata: ${JSON.stringify({ ok: true, lifecycle: this.applicationLifecycle, piChatRunEpoch: this.runEpoch, workspaceEpoch: this.runEpoch, primaryRuntime: this.primaryReadiness() })}\n\n`,
      );
      this.traceState("sse", "ready", this.activeSessionId, {
        lifecycle: this.applicationLifecycle,
        primaryStatus: this.primaryReadiness().status,
      });
      const pageId = requestPageId(request) || clientId;
      this.sseHub.add(response, clientId);
      this.ssePageByResponse.set(response, pageId);
      this.clientConnected(clientId, pageId);
      this.traceState("sse", "connected", this.activeSessionId, {
        openWindows: this.openWindowCount(),
      });
      const timer = setInterval(
        () => this.sseHub.heartbeat(response),
        this.sseHeartbeatMs,
      );
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
      const pageId = requestPageId(request);
      if (!clientId || !pageId)
        return json(response, 400, { error: "浏览器页面标识无效" });
      const body = await bodyJson(request);
      const revision = body.revision;
      if (typeof body.foreground !== "boolean")
        return json(response, 400, { error: "浏览器前台状态无效" });
      if (
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 1
      )
        return json(response, 400, { error: "浏览器前台状态序号无效" });
      // Presence is page-scoped, not just client-scoped. A stale renderer or
      // handshake-only helper must not mutate the foreground lease of a live page.
      if (!this.isConnectedWindowPage(clientId, pageId)) {
        return json(response, 409, { error: "当前页面的事件连接已断开，正在重新连接" });
      }
      const accepted = body.foreground
        ? this.sessionControl.noteClientPresence(clientId, pageId, revision)
        : this.sessionControl.noteClientBackground(clientId, pageId, revision);
      if (!accepted) {
        return json(response, 409, { error: "事件连接已断开，正在重新连接" });
      }
      json(response, 200, { present: this.sessionControl.isClientPresent(clientId) });
      return;
    }

    if (url.pathname === "/api/window/close") {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (!clientId)
        return json(response, 400, { error: "缺少窗口标识，无法安全关闭" });
      if (this.applicationLifecycle !== "idle")
        throw new ApplicationLifecycleConflictError(
          this.applicationLifecycle,
          this.lifecycleMessage(),
        );
      const pageId = requestPageId(request) || clientId;
      // `unload` is also emitted for discarded/frozen background renderers on
      // some Chromium/PWA paths. Only a beacon that explicitly says it came
      // from the foreground, backed by the server's still-fresh presence lease,
      // may request service-lifetime shutdown.
      const foregroundCloseIntent =
        url.searchParams.get("foreground") === "1" &&
        this.sessionControl.isClientPresent(clientId);
      const viewedSessionId = this.closeWindowClient(clientId, pageId);
      const otherWindowCount = this.openWindowCount();
      // A Prompt may already hold an admission lease while its request body is
      // still arriving. Do not stop any Runtime until all admitted mutations finish.
      const rested =
        otherWindowCount > 0 &&
        this.activeMutationRequests === 0 &&
        this.runtimePool.startingCount === 0
          ? await this.restSessionAfterWindowClose(viewedSessionId)
          : false;
      if (otherWindowCount === 0 && foregroundCloseIntent)
        this.scheduleLastWindowShutdown();
      json(response, 200, {
        shuttingDown: false,
        closeWindow: true,
        sessionId: viewedSessionId || undefined,
        rested,
        remainingWindows: otherWindowCount,
        ...(otherWindowCount === 0 &&
        foregroundCloseIntent &&
        this.lastWindowAutoShutdownEnabled &&
        this.options.applicationShutdown
          ? { autoShutdownPending: true }
          : {}),
      });
      return;
    }

    if (url.pathname === "/api/restart" || url.pathname === "/api/shutdown") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const shuttingDown = url.pathname === "/api/shutdown";
      const lifecycle = shuttingDown ? "shutting-down" : "restarting";
      if (shuttingDown && !this.options.applicationShutdown)
        return json(response, 501, {
          error: "当前启动方式不支持从网页关闭 Pi Chat；请关闭服务进程。",
        });
      if (!shuttingDown && !this.options.applicationRestart)
        return json(response, 501, {
          error:
            "当前启动方式不支持应用更新并重启；请在 Pi Chat 项目目录运行 npm run build 后重启服务。",
        });
      const lifecyclePageId = requestPageId(request);
      if (!clientId || !lifecyclePageId)
        return json(response, 400, {
          error: "重启或关闭必须由当前 Pi Chat 页面显式发起",
          code: "LIFECYCLE_CLIENT_REQUIRED",
        });
      if (!this.isConnectedWindowPage(clientId, lifecyclePageId)) {
        const error = new Error("生命周期请求页面没有活动事件连接");
        const incident = this.reportIncident(error, {
          browserId: clientId,
          pageId: lifecyclePageId,
          operation: shuttingDown ? "lifecycle.shutdown" : "lifecycle.restart",
          controlState: "no-browser-identity",
          outcome: "rejected",
          errorCode: "LIFECYCLE_PAGE_NOT_CONNECTED",
        });
        return json(response, 409, {
          error: "当前页面尚未完成连接或已断开，无法安全重启或关闭 Pi Chat",
          code: "LIFECYCLE_PAGE_NOT_CONNECTED",
          incidentId: incident.incidentId,
        });
      }
      this.beginLifecycle(lifecycle);
      try {
        await this.verifyApplicationQuiescent(
          shuttingDown ? "关闭 Pi Chat" : "应用更新并重启",
        );
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
      const body = preparedBody || (await bodyJson(request, PROMPT_BODY_LIMIT));
      const message =
        typeof body.message === "string" ? body.message.trim() : "";
      const requestedSessionId = requiredSessionId(body);
      const requestedGateMode: GateMode | undefined =
        body.gateMode === "strict" || body.gateMode === "open"
          ? body.gateMode
          : undefined;
      const requestedSettings = promptSettingsSnapshot(body);
      if (
        body.delivery !== undefined &&
        body.delivery !== "queue" &&
        body.delivery !== "steer"
      )
        return json(response, 400, { error: "消息交付方式无效" });
      const delivery: PromptDelivery =
        body.delivery === "steer" ? "steer" : "queue";
      const images = promptImages(body.images);
      if (!message && !images.length)
        return json(response, 400, { error: "消息或图片不能为空" });
      const promptAt = this.nextUserPromptAt();
      const admittedSessionId = requestedSessionId;
      const releasePromptAdmission =
        await this.beginPromptAdmission(admittedSessionId);
      let releaseRuntimeAdmission: (() => void) | null = null;
      try {
        // Before creating a *new* Secondary, bind Primary identity through the
        // readiness gate. An already-owned Secondary remains usable even if the
        // independent Primary startup subsequently fails.
        const existingSecondary =
          this.runtimePool.get(requestedSessionId) || null;
        // Steering changes an already-running agent. It must never wake a cold
        // Session, recover a failed worker, or bind a new Primary identity.
        if (delivery === "steer") {
          const requestedIsPrimary =
            Boolean(this.activeSessionId) &&
            requestedSessionId === this.activeSessionId;
          const steeringRuntime = requestedIsPrimary
            ? null
            : existingSecondary;
          const targetRpc = steeringRuntime?.rpc || this.options.rpc;
          const targetGeneration = requestedIsPrimary
            ? this.primaryRpcGeneration
            : (steeringRuntime?.rpcGeneration || 0);
          const targetAbortGeneration = requestedIsPrimary
            ? this.scheduler.primaryAbortGeneration
            : (steeringRuntime?.abortGeneration || 0);
          const targetRunning = requestedIsPrimary
            ? this.running || Boolean(this.liveMessage) || Boolean(this.toolStatus)
            : steeringRuntime?.running === true || Boolean(steeringRuntime?.liveMessage) || Boolean(steeringRuntime?.toolStatus);
          if (
            (!requestedIsPrimary && !steeringRuntime) ||
            !targetRunning ||
            targetRpc.isRunning?.() === false
          )
            return json(response, 409, {
              error: "当前对话未在运行，无法发送 Steer 消息",
              code: "STEER_NOT_RUNNING",
            });
          releaseRuntimeAdmission = steeringRuntime
            ? this.runtimePool.acquireOperation(steeringRuntime)
            : this.primaryOperationAdmission.acquire().release;
          if (message.startsWith("/"))
            return json(response, 400, {
              error: "Slash 指令不能作为 Steer 消息发送",
            });
          if (requestedSettings)
            return json(response, 400, {
              error: "Steer 消息不能修改下一轮模型设置",
            });
          // Bounded native steering backlog: Pi's own queue, this admission
          // bookkeeping, the text snapshot, and the browser's hidden local
          // turns all grow with every accepted Steer. Reuse the queue caps so
          // a long tool call cannot accumulate an unbounded steer backlog.
          const existingAdmissions =
            this.nativeSteeringAdmissionsBySession.get(requestedSessionId);
          const currentAdmissions =
            existingAdmissions &&
            existingAdmissions.generation === targetGeneration
              ? existingAdmissions
              : { generation: targetGeneration, items: [] };
          if (currentAdmissions.items.length >= MAX_NATIVE_STEERING)
            return json(response, 409, {
              error: `Steer 队列已满，最多保留 ${MAX_NATIVE_STEERING} 条未执行的 Steer`,
            });
          const incomingImageChars = images.reduce(
            (sum, image) => sum + image.data.length,
            0,
          );
          const queuedImageChars = currentAdmissions.items.reduce(
            (sum, admission) => sum + admission.imageChars,
            0,
          );
          if (queuedImageChars + incomingImageChars > MAX_NATIVE_STEERING_IMAGE_CHARS)
            return json(response, 409, {
              error: "Steer 排队图片总量超限",
            });
          const steeringMessage = message || "请查看这些图片。";
          currentAdmissions.items.push({
            message: steeringMessage,
            promptAt,
            imageChars: incomingImageChars,
          });
          this.nativeSteeringAdmissionsBySession.set(
            requestedSessionId,
            currentAdmissions,
          );
          let deliveryUncertain = false;
          try {
            await targetRpc.send(
              {
                type: "steer",
                message: steeringMessage,
                ...(images.length ? { images } : {}),
              },
              PROMPT_PREPARE_TIMEOUT_MS,
            );
          } catch (error) {
            if (error instanceof RpcRequestTimeoutError && error.outcomeUnknown) {
              // The steer JSONL command may already be in Pi stdin (and Pi may
              // even have emitted queue_update). Retain its admission so later
              // dequeue/clear events can settle the hidden local turn.
              deliveryUncertain = true;
            } else {
              const current =
                this.nativeSteeringAdmissionsBySession.get(requestedSessionId);
              if (current && current.generation === targetGeneration) {
                const index = current.items.findIndex(
                  (admission) =>
                    admission.message === steeringMessage &&
                    admission.promptAt === promptAt,
                );
                if (index >= 0) current.items.splice(index, 1);
                if (current.items.length)
                  this.nativeSteeringAdmissionsBySession.set(
                    requestedSessionId,
                    current,
                  );
                else
                  this.nativeSteeringAdmissionsBySession.delete(
                    requestedSessionId,
                  );
              }
              throw error;
            }
          }
          // Auxiliary probe only: a timeout must not rewrite an already
          // accepted Steer into a 500. A dead worker, however, can never
          // deliver it, so clean up and reject instead.
          let probeState: ReturnType<typeof asState> | null = null;
          try {
            probeState = asState(
              await targetRpc.send({ type: "get_state" }, 2_000),
            );
          } catch (error) {
            if (error instanceof RpcRequestTimeoutError) {
              probeState = null;
            } else {
              this.clearNativeSteeringState(requestedSessionId, "process-error");
              return json(response, 409, {
                error: "Pi 已退出，Steer 消息未执行",
              });
            }
          }
          if (
            probeState &&
            !probeState.isStreaming &&
            this.hasNativeSteeringPending(requestedSessionId, targetGeneration)
          ) {
            await this.resetNativeSteering(
              requestedSessionId,
              steeringRuntime || undefined,
              "settled-before-consumption",
            );
            if (steeringRuntime) {
              if (steeringRuntime.abortGeneration === targetAbortGeneration) {
                this.broadcastQueue(steeringRuntime.id);
                this.broadcastSessionActivity(steeringRuntime.id);
                if (
                  !this.runtimeTurnActive(steeringRuntime) &&
                  !steeringRuntime.dispatching &&
                  !steeringRuntime.queuePaused
                )
                  setTimeout(
                    () => void this.dispatchRuntimeNext(steeringRuntime),
                    0,
                  );
              }
            } else if (
              this.scheduler.primaryAbortGeneration === targetAbortGeneration
            ) {
              this.broadcastQueue(requestedSessionId);
              this.broadcastSessionActivity(requestedSessionId);
              if (
                !this.primaryTurnActive() &&
                !this.dispatching &&
                !this.queuePaused
              )
                setTimeout(() => void this.dispatchNext(), 0);
            }
            return json(response, 409, {
              error: "当前对话已结束，Steer 消息未执行",
              code: "STEER_ALREADY_SETTLED",
            });
          }
          json(response, 202, {
            accepted: true,
            queued: false,
            steered: true,
            ...(deliveryUncertain ? { deliveryUncertain: true } : null),
          });
          return;
        }
        // Production readiness must bind the primary before allocating a worker;
        // legacy in-process test hosts have no startup controller and retain the
        // historical lazy identity behavior for their minimal RPC doubles.
        if (!this.activeSessionId && !existingSecondary)
          await this.ensurePrimaryIdentity();
        // A browser tab can outlive a Pi Chat restart. Restore its requested Session on demand
        // instead of rejecting the prompt because the old in-memory worker map was lost.
        const requestedIsPrimary = requestedSessionId === this.activeSessionId;
        if (
          !requestedIsPrimary &&
          !this.activeSessionIds().includes(requestedSessionId)
        )
          await this.ensureRuntime(requestedSessionId);
        const secondaryRuntime = !requestedIsPrimary
          ? this.runtimePool.get(requestedSessionId) || null
          : null;
        if (secondaryRuntime) {
          releaseRuntimeAdmission =
            this.runtimePool.acquireOperation(secondaryRuntime);
          this.runtimePool.touch(secondaryRuntime);
          if (this.secondaryNeedsRecovery(secondaryRuntime))
            await this.recoverRuntime(secondaryRuntime);
        } else {
          releaseRuntimeAdmission =
            this.primaryOperationAdmission.acquire().release;
          await this.ensurePrimaryRuntime();
        }
        const targetRpc = secondaryRuntime?.rpc || this.options.rpc;
        const extensionCommand = message
          ? await this.extensionCommand(message, targetRpc)
          : null;
        if (extensionCommand) {
          if (images.length)
            return json(response, 400, {
              error: "Extension 指令不能同时附加图片",
            });
          // Extension commands are not one ordinary Agent run. If a caller
          // bypasses the normal browser busy guard, abandon ambiguous
          // observation rather than attributing its events to an older prompt.
          this.clearPromptDiagnostic(
            secondaryRuntime?.id || this.activeSessionId,
          );
          await targetRpc.send(
            { type: "prompt", message },
            PROMPT_PREPARE_TIMEOUT_MS,
          );
          const requestedGateMode =
            extensionCommand.name === "gate"
              ? gateModeFromCommand(message)
              : null;
          if (requestedGateMode)
            this.setGateMode(
              secondaryRuntime?.id || this.activeSessionId,
              requestedGateMode,
            );
          this.noteUserPrompt(
            secondaryRuntime?.id || this.activeSessionId,
            promptAt,
          );
          const state = asState(await targetRpc.send({ type: "get_state" }));
          if (secondaryRuntime) {
            secondaryRuntime.running = state.isStreaming;
            secondaryRuntime.prompted = true;
            await this.finalizePersistedDraft(secondaryRuntime);
            this.broadcast({
              type: "pi_chat_sessions_changed",
              action: "created",
              sessionId: secondaryRuntime.id,
            });
          } else this.running = state.isStreaming;
          json(response, 202, {
            accepted: true,
            queued: false,
            extension: true,
            command: extensionCommand.name,
            description: extensionCommand.description,
            isStreaming: state.isStreaming,
          });
          return;
        }
        if (secondaryRuntime) {
          if (this.scheduler.runtimeBusyForQueue(secondaryRuntime)) {
            const enqueueError = this.scheduler.assertCanEnqueue(
              secondaryRuntime.promptQueue,
              images,
            );
            if (enqueueError)
              return json(response, 409, { error: enqueueError });
            const queued = this.scheduler.enqueueRuntime(
              secondaryRuntime,
              message,
              images,
              promptAt,
              requestedGateMode,
              requestedSettings,
            );
            // This snapshot is now durably admitted into the private FIFO, so
            // it supersedes only legacy settings that predated its admission.
            this.supersedePendingTurnSettings(
              secondaryRuntime.pendingTurnSettings,
              requestedSettings,
            );
            this.tracePrompt("admitted", secondaryRuntime.id, queued.id);
            this.tracePrompt("queued", secondaryRuntime.id, queued.id);
            this.noteUserPrompt(secondaryRuntime.id, promptAt);
            return json(response, 202, {
              accepted: true,
              queued: true,
              id: queued.id,
              queue: this.publicQueue(secondaryRuntime.promptQueue),
            });
          }
          const promptId = randomUUID();
          const generation = secondaryRuntime.abortGeneration;
          try {
            let appliedSettings: AppliedTurnSettings;
            try {
              appliedSettings = await this.applyPromptSettings(
                secondaryRuntime.rpc,
                secondaryRuntime.pendingTurnSettings,
                requestedSettings,
                true,
              );
            } catch (error) {
              if (error instanceof PartialTurnSettingsError)
                this.rememberRuntimeAppliedTurnSettings(
                  secondaryRuntime,
                  error.applied,
                );
              throw error;
            }
            this.rememberRuntimeAppliedTurnSettings(
              secondaryRuntime,
              appliedSettings,
            );
            if (
              generation !== secondaryRuntime.abortGeneration ||
              this.applicationLifecycle !== "idle"
            )
              throw new Error("消息发送已取消");
            await this.syncGateMode(
              secondaryRuntime.rpc,
              secondaryRuntime.id,
              requestedGateMode,
            );
            secondaryRuntime.running = true;
            this.tracePrompt("admitted", secondaryRuntime.id, promptId);
            this.broadcastSessionActivity(secondaryRuntime.id);
            try {
              await this.sendPromptRpc(
                secondaryRuntime.rpc,
                secondaryRuntime.id,
                promptId,
                {
                  type: "prompt",
                  message: message || "请查看这些图片。",
                  ...(images.length ? { images } : {}),
                },
              );
            } catch (error) {
              // The command may already be buffered in Pi stdin. Preserve the
              // running state and let its lifecycle event decide; treating this
              // as a definite failure can race/duplicate a following prompt.
              if (!(error instanceof RpcRequestTimeoutError) || !error.outcomeUnknown) throw error;
              this.tracePrompt("delivery-uncertain", secondaryRuntime.id, promptId);
              this.scheduler.notifySecondaryPromptAccepted(
                secondaryRuntime,
                promptAt,
              );
              json(response, 202, {
                accepted: true,
                queued: false,
                deliveryUncertain: true,
              });
              return;
            }
            this.scheduler.notifySecondaryPromptAccepted(
              secondaryRuntime,
              promptAt,
            );
            json(response, 202, { accepted: true, queued: false });
          } catch (error) {
            secondaryRuntime.running = false;
            this.broadcastSessionActivity(secondaryRuntime.id);
            throw error;
          }
          return;
        }
        if (this.scheduler.primaryBusyForQueue()) {
          const enqueueError = this.scheduler.assertCanEnqueue(
            this.promptQueue,
            images,
          );
          if (enqueueError) return json(response, 409, { error: enqueueError });
          const queued = this.scheduler.enqueuePrimary(
            message,
            images,
            promptAt,
            requestedGateMode,
            requestedSettings,
          );
          // The queue owns the admitted immutable snapshot. A later legacy
          // mutation remains pending for a following row.
          this.supersedePendingTurnSettings(
            this.pendingTurnSettings,
            requestedSettings,
          );
          this.tracePrompt("admitted", this.activeSessionId, queued.id);
          this.tracePrompt("queued", this.activeSessionId, queued.id);
          this.noteUserPrompt(this.activeSessionId, promptAt);
          json(response, 202, {
            accepted: true,
            queued: true,
            id: queued.id,
            queue: this.publicQueue(),
          });
          return;
        }
        const promptId = randomUUID();
        this.tracePrompt("admitted", this.activeSessionId, promptId);
        const acceptance = await this.sendPrompt(
          message,
          images,
          promptAt,
          requestedGateMode,
          promptId,
          requestedSettings,
        );
        if (acceptance === "unknown")
          this.tracePrompt("delivery-uncertain", this.activeSessionId, promptId);
        json(response, 202, {
          accepted: true,
          queued: false,
          ...(acceptance === "unknown" ? { deliveryUncertain: true } : null),
        });
        return;
      } finally {
        releaseRuntimeAdmission?.();
        releasePromptAdmission();
      }
    }

    const queueCancelMatch = /^\/api\/chat\/queue\/([a-f0-9-]{36})$/.exec(
      url.pathname,
    );
    if (queueCancelMatch) {
      if (request.method !== "DELETE") return methodNotAllowed(response);
      const body = preparedBody || (await bodyJson(request));
      const sessionId = requiredSessionId(body);
      const runtime = this.runtimePool.get(sessionId);
      if (!runtime && sessionId !== this.activeSessionId)
        return json(response, 409, {
          error: "该会话尚未恢复运行，请刷新页面后重试",
        });
      if (runtime) this.runtimePool.touch(runtime);
      const queue = runtime?.promptQueue || this.promptQueue;
      const index = queue.findIndex((item) => item.id === queueCancelMatch[1]);
      if (index < 0)
        return json(response, 404, { error: "队列消息不存在或已经开始执行" });
      this.tracePrompt("cancelled", sessionId, queueCancelMatch[1]);
      queue.splice(index, 1);
      if (runtime) {
        if (!queue.length) runtime.queuePaused = false;
      } else if (!queue.length) this.queuePaused = false;
      this.broadcastQueue(sessionId);
      json(response, 200, {
        queue: this.publicQueue(queue),
        paused: runtime?.queuePaused ?? this.queuePaused,
      });
      return;
    }

    if (url.pathname === "/api/chat/queue/resume") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || (await bodyJson(request));
      const sessionId = requiredSessionId(body);
      const runtime = this.runtimePool.get(sessionId);
      if (!runtime && sessionId !== this.activeSessionId)
        return json(response, 409, {
          error: "该会话尚未恢复运行，请刷新页面后重试",
        });
      if (runtime) {
        this.runtimePool.touch(runtime);
        if (this.secondaryNeedsRecovery(runtime))
          await this.recoverRuntime(runtime);
        runtime.queuePaused = false;
        this.broadcastQueue(sessionId);
        void this.dispatchRuntimeNext(runtime);
        return json(response, 200, {
          queue: this.publicQueue(runtime.promptQueue),
          paused: false,
        });
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
      const selected = await (
        this.options.pickWorkspaceFolder || pickWorkspaceFolder
      )(this.currentCwd);
      if (!selected) return json(response, 200, { cancelled: true });
      if (!(await stat(resolve(selected))).isDirectory())
        return json(response, 400, { error: "所选工作目录不存在或不是文件夹" });
      json(response, 200, { cancelled: false, cwd: resolve(selected) });
      return;
    }

    if (url.pathname === "/api/workspace/pick") {
      if (request.method !== "POST") return methodNotAllowed(response);
      // The native picker waits without an admission lease. Its returned path
      // commits through changeWorkspace(), which serializes and rechecks the
      // lifecycle immediately before persistence.
      const selected = await (
        this.options.pickWorkspaceFolder || pickWorkspaceFolder
      )(this.currentCwd);
      if (!selected) return json(response, 200, { cancelled: true });
      await this.changeWorkspace(selected);
      // Bootstrap outside the short commit lease, then use its one authoritative
      // snapshot for both legacy and revision-aware browser response fields.
      // A later picker commit therefore cannot split old and new clients.
      const data = await this.bootstrap();
      json(response, 200, {
        cancelled: false,
        workspaceName: basename(data.workspaceCwd),
        cwd: data.workspaceCwd,
        workspaceEpoch: data.workspaceEpoch,
        workspaceRevision: data.workspaceRevision,
        data,
      });
      return;
    }

    // Local/automation path only (scripts, future local CLI). The browser UI
    // chooses defaults through /api/workspace/pick. Not a remote-access surface;
    // the service itself is loopback-only.
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
      const body = preparedBody || (await bodyJson(request));
      const sessionId = requiredSessionId(body);
      // Compact changes the target Runtime's context outside PromptScheduler's
      // ordinary-turn FIFO. Serialize its target resolution, idle proof, and
      // RPC write with prompt admission so a concurrent send cannot pass the
      // idle check and start against a newly compacted context.
      const releasePromptAdmission = await this.beginPromptAdmission(sessionId);
      let releaseRuntimeOperation: (() => void) | null = null;
      try {
        // A cold/reclaimed persisted Session is neither the Primary nor an
        // error. Bind Primary identity before allocating a new Secondary, then
        // use the App-owned restoration path so Gate, recovery, fast mode, and
        // RuntimePool capacity/reclaim ownership remain authoritative here.
        let secondaryRuntime = this.runtimePool.get(sessionId) || null;
        if (!secondaryRuntime && !this.activeSessionId)
          await this.ensurePrimaryIdentity();
        const requestedIsPrimary = sessionId === this.activeSessionId;
        if (!requestedIsPrimary && !secondaryRuntime) {
          try {
            secondaryRuntime = await this.ensureRuntime(sessionId);
          } catch (error) {
            if (error instanceof SessionNotFoundError)
              return json(response, 409, { error: "该会话尚未启用" });
            throw error;
          }
        }
        if (secondaryRuntime) {
          releaseRuntimeOperation =
            this.runtimePool.acquireOperation(secondaryRuntime);
          this.runtimePool.touch(secondaryRuntime);
          if (this.secondaryNeedsRecovery(secondaryRuntime))
            await this.recoverRuntime(secondaryRuntime);
        } else {
          releaseRuntimeOperation =
            this.primaryOperationAdmission.acquire().release;
          await this.ensurePrimaryRuntime();
        }
        if (
          secondaryRuntime
            ? this.scheduler.runtimeBusyForQueue(secondaryRuntime)
            : this.scheduler.primaryBusyForQueue()
        )
          return json(response, 409, {
            error: "请先停止该会话的生成并清空队列",
          });
        const customInstructions =
          typeof body.customInstructions === "string"
            ? body.customInstructions.trim()
            : "";
        const result = rpcData<Record<string, unknown>>(
          await (secondaryRuntime?.rpc || this.options.rpc).send(
            {
              type: "compact",
              ...(customInstructions ? { customInstructions } : {}),
            },
            PROMPT_PREPARE_TIMEOUT_MS,
          ),
        );
        json(response, 200, { result });
        return;
      } finally {
        releaseRuntimeOperation?.();
        releasePromptAdmission();
      }
    }

    if (url.pathname === "/api/chat/abort") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || (await bodyJson(request));
      const sessionId = requiredSessionId(body);
      const runtime = this.runtimePool.get(sessionId);
      if (runtime) {
        const releaseRuntimeOperation =
          this.runtimePool.acquireOperation(runtime);
        try {
          this.runtimePool.touch(runtime);
          runtime.abortGeneration += 1;
          if (runtime.failed || runtime.rpc.isRunning?.() === false)
            return json(response, 200, {
              ok: true,
              isStreaming: false,
              queuePaused: runtime.queuePaused,
            });
          if (runtime.promptQueue.length || runtime.dispatching)
            runtime.queuePaused = true;
          const steeringGeneration = runtime.rpcGeneration;
          if (this.hasNativeSteeringPending(sessionId, steeringGeneration))
            this.nativeSteeringResetAfterSettlement.set(
              sessionId,
              steeringGeneration,
            );
          try {
            await runtime.rpc.send({ type: "abort" }, 5_000);
          } catch (error) {
            if (
              !(error instanceof RpcRequestTimeoutError) ||
              !error.outcomeUnknown ||
              error.requestType !== "abort"
            )
              throw error;
            // Pi has received abort but may still be waiting for its agent/tool
            // stack to become idle. An agent_settled event can beat this timeout,
            // so preserve the event-owned running state instead of reviving it.
            const abortPending = runtime.running;
            this.broadcastQueue(sessionId);
            this.broadcastSessionActivity(sessionId);
            return json(response, 200, {
              ok: true,
              abortPending,
              isStreaming: abortPending,
              queuePaused: runtime.queuePaused,
            });
          }
          // Abort itself is enough; a long get_state after abort was a common freeze.
          // Prefer a short probe, then fall back to "stopped" and let agent_settled finish.
          let isStreaming = false;
          try {
            const state = asState(
              await runtime.rpc.send({ type: "get_state" }, 2_000),
            );
            isStreaming = state.isStreaming;
          } catch {
            isStreaming = false;
          }
          runtime.running = isStreaming;
          // Re-check accepted admissions after abort: a concurrent Steer may
          // have been admitted while abort was in flight even if Pi never
          // emitted the queue_update snapshot for an uncertain write.
          if (this.hasNativeSteeringPending(sessionId, steeringGeneration)) {
            await this.resetNativeSteering(
              sessionId,
              runtime,
              "abort",
            );
            isStreaming = false;
            runtime.running = false;
          }
          this.broadcastQueue(sessionId);
          this.broadcastSessionActivity(sessionId);
          return json(response, 200, {
            ok: true,
            isStreaming,
            queuePaused: runtime.queuePaused,
          });
        } finally {
          releaseRuntimeOperation();
        }
      }
      if (sessionId !== this.activeSessionId)
        return json(response, 409, { error: "该会话不是活动运行会话" });
      const releasePrimaryOperation =
        this.primaryOperationAdmission.acquire().release;
      try {
        this.scheduler.primaryAbortGeneration += 1;
        if (this.promptQueue.length || this.dispatching)
          this.queuePaused = true;
        if (this.primaryFailed || this.options.rpc.isRunning?.() === false) {
          this.broadcastQueue();
          this.broadcastSessionActivity(sessionId);
          return json(response, 200, {
            ok: true,
            isStreaming: false,
            queuePaused: this.queuePaused,
          });
        }
        const steeringGeneration = this.primaryRpcGeneration;
        if (this.hasNativeSteeringPending(sessionId, steeringGeneration))
          this.nativeSteeringResetAfterSettlement.set(
            sessionId,
            steeringGeneration,
          );
        try {
          await this.options.rpc.send({ type: "abort" }, 5_000);
        } catch (error) {
          if (
            !(error instanceof RpcRequestTimeoutError) ||
            !error.outcomeUnknown ||
            error.requestType !== "abort"
          )
            throw error;
          // The command may still be executing inside Pi. Preserve event-owned
          // running state because agent_settled can arrive just before timeout.
          const abortPending = this.running;
          this.broadcastQueue();
          this.broadcastSessionActivity(sessionId);
          return json(response, 200, {
            ok: true,
            abortPending,
            isStreaming: abortPending,
            queuePaused: this.queuePaused,
          });
        }
        this.broadcastQueue();
        let isStreaming = false;
        try {
          const state = asState(
            await this.options.rpc.send({ type: "get_state" }, 2_000),
          );
          isStreaming = state.isStreaming;
        } catch {
          isStreaming = false;
        }
        this.running = isStreaming;
        // Re-check accepted admissions after abort: a concurrent Steer may
        // have been admitted while abort was in flight even if Pi never
        // emitted the queue_update snapshot for an uncertain write.
        if (this.hasNativeSteeringPending(sessionId, steeringGeneration)) {
          await this.resetNativeSteering(sessionId, undefined, "abort");
          isStreaming = false;
          this.running = false;
        }
        this.broadcastSessionActivity(sessionId);
        json(response, 200, {
          ok: true,
          isStreaming,
          queuePaused: this.queuePaused,
        });
        return;
      } finally {
        releasePrimaryOperation();
      }
    }

    const manageSessionMatch = /^\/api\/sessions\/([a-f0-9]{20})$/.exec(
      url.pathname,
    );
    if (manageSessionMatch) {
      if (request.method === "PATCH") {
        this.requireSessionControl(manageSessionMatch[1], clientId);
        const body = await bodyJson(request);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name))
          return json(response, 400, {
            error: "名称必须为 1 到 120 个有效字符",
          });
        json(
          response,
          200,
          await this.renameSession(manageSessionMatch[1], name),
        );
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
      if (!clientId)
        return json(response, 400, { error: "浏览器窗口标识无效" });
      const body = await bodyJson(request);
      const expectedSessionId =
        typeof body.sessionId === "string" ? body.sessionId : "";
      if (!/^[a-f0-9]{20}$/.test(expectedSessionId))
        return json(response, 400, { error: "待清除的会话标识无效" });
      const viewing = this.sessionControl.clearViewed(
        clientId,
        expectedSessionId,
      );
      if (!viewing) {
        const runtime = this.runtimePool.get(expectedSessionId);
        if (runtime && this.runtimePool.canReclaim(runtime))
          void this.runtimePool.sweep();
      }
      json(response, 200, { viewing });
      return;
    }

    const viewingMatch = /^\/api\/sessions\/([a-f0-9]{20})\/viewing$/.exec(
      url.pathname,
    );
    if (viewingMatch) {
      if (request.method !== "POST") return methodNotAllowed(response);
      if (!clientId)
        return json(response, 400, { error: "浏览器窗口标识无效" });
      const id = viewingMatch[1];
      const runtime = this.runtimePool.get(id);
      // A running Runtime is authoritative. Avoid a full SessionIndex scan after
      // every hot navigation just to prove a worker we already own exists.
      const indexed =
        !runtime && id !== this.activeSessionId
          ? this.options.sessions.summaryForId?.(id) ||
            (await this.options.sessions.list(undefined, this.currentCwd)).find(
              (session) => session.id === id,
            )
          : true;
      if (!indexed && !runtime && id !== this.activeSessionId)
        return json(response, 404, { error: "会话不存在" });
      this.markSessionViewed(clientId, id);
      if (runtime) this.runtimePool.touch(runtime);
      json(response, 200, { viewing: id });
      return;
    }

    const warmMatch = /^\/api\/sessions\/([a-f0-9]{20})\/warm$/.exec(
      url.pathname,
    );
    if (warmMatch) {
      if (request.method !== "POST") return methodNotAllowed(response);
      const id = warmMatch[1];
      const existing = this.runtimePool.get(id) || null;
      // A Primary may still own this session after service startup. Bind that
      // identity before allocating any cold Secondary so one JSONL never gains
      // two live Pi writers.
      if (!existing && !this.activeSessionId)
        await this.ensurePrimaryIdentity();
      // Warm is a Session-local capability upgrade. It deliberately performs
      // no full sessionView probes; a cold JSONL pane remains immediately
      // readable even if spawning fails or capacity is exhausted.
      if (id === this.activeSessionId) {
        await this.ensurePrimaryRuntime();
        return json(response, 200, {
          sessionId: id,
          state: this.stateWithFastMode(id, {
            ...this.lastPrimaryState,
            isStreaming: this.primaryTurnActive(),
          }),
          gateMode: this.primaryGateMode,
        } satisfies SessionRuntimeReadyData);
      }
      const runtime = existing || (await this.ensureRuntime(id));
      json(response, 200, this.runtimeReady(runtime));
      return;
    }

    const activateMatch = /^\/api\/sessions\/([a-f0-9]{20})\/activate$/.exec(
      url.pathname,
    );
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
      const view = await this.sessionView(
        id,
        RECENT_TURN_WINDOW_SIZE,
        clientId,
      );
      if (!view) return json(response, 404, { error: "会话不存在" });
      json(response, 200, view);
      return;
    }

    if (url.pathname === "/api/sessions/new") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || (await bodyJson(request, PROMPT_BODY_LIMIT));
      const requestedCwd =
        typeof body.cwd === "string" && body.cwd.trim()
          ? resolve(body.cwd)
          : this.currentCwd;
      if (!(await stat(requestedCwd)).isDirectory())
        return json(response, 400, {
          error: "新对话工作目录不存在或不是文件夹",
        });
      const initial =
        body.initial &&
        typeof body.initial === "object" &&
        !Array.isArray(body.initial)
          ? (body.initial as InitialPromptRequest)
          : null;
      const initialMessage =
        typeof initial?.message === "string" ? initial.message.trim() : "";
      const initialImages = initial ? promptImages(initial.images) : [];
      const initialGateMode: GateMode | undefined =
        initial?.gateMode === "strict" || initial?.gateMode === "open"
          ? initial.gateMode
          : undefined;
      if (initial?.gateMode !== undefined && !initialGateMode)
        return json(response, 400, { error: "无效的 Gate 模式" });
      if (
        initial?.thinkingLevel !== undefined &&
        !THINKING_LEVELS.includes(initial.thinkingLevel)
      )
        return json(response, 400, { error: "无效的 Thinking 强度" });
      if (
        initial?.model !== undefined &&
        (!initial.model ||
          typeof initial.model.provider !== "string" ||
          !initial.model.provider ||
          typeof initial.model.modelId !== "string" ||
          !initial.model.modelId)
      )
        return json(response, 400, { error: "新对话模型配置无效" });
      if (initial && !initialMessage && !initialImages.length)
        return json(response, 400, { error: "消息或图片不能为空" });
      // A failed initial Primary must be recovered before allocating a draft;
      // otherwise a failed compatibility proof can leave an unnecessary
      // Secondary worker behind. Healthy/starting Primary still overlaps its
      // startup with draft creation as before.
      const primaryWasFailed = this.primaryNeedsRecovery();
      if (primaryWasFailed) await this.waitForNewDraftPrimaryCompatibility();
      const draftLease = await this.acquireDraftRuntime(clientId, requestedCwd);
      try {
        // Spawn and Primary compatibility are intentionally overlapped while
        // Primary is starting. The draft remains unprompted until the common
        // compatibility proof joins.
        if (!primaryWasFailed) await this.waitForNewDraftPrimaryCompatibility();
        // The lease spans creation, preferences, Gate and prompt admission: an
        // empty draft cannot be reclaimed between these parts of one first turn.
        this.markSessionViewed(clientId, draftLease.runtime.id);
        if (!initial) {
          const view = await this.draftSessionView(
            draftLease.runtime,
            clientId,
          );
          json(response, 200, view);
          return;
        }
        const runtime = draftLease.runtime;
        // Use the same per-Session prompt FIFO as ordinary /chat/prompt. The
        // runtime lease protects reclamation; this admission prevents a caller
        // that learns the newly allocated ID from interleaving another prompt
        // between first-turn setup commands and the user instruction.
        const releasePromptAdmission = await this.beginPromptAdmission(
          runtime.id,
        );
        try {
          this.requireSessionControl(runtime.id, clientId);
          const promptAt = this.nextUserPromptAt();
          const initialSettings: PendingTurnSettings = {
            ...(initial.model
              ? {
                  model: {
                    provider: initial.model.provider,
                    modelId: initial.model.modelId,
                  },
                }
              : null),
            ...(initial.thinkingLevel
              ? { thinkingLevel: initial.thinkingLevel }
              : null),
          };
          if (initialSettings.model || initialSettings.thinkingLevel) {
            try {
              const appliedSettings = await this.applyTurnSettings(
                runtime.rpc,
                initialSettings,
              );
              this.rememberRuntimeAppliedTurnSettings(runtime, appliedSettings);
            } catch (error) {
              if (error instanceof PartialTurnSettingsError)
                this.rememberRuntimeAppliedTurnSettings(runtime, error.applied);
              throw error;
            }
          }
          const extensionCommand = initialMessage
            ? await this.extensionCommand(initialMessage, runtime.rpc)
            : null;
          if (extensionCommand && initialImages.length)
            return json(response, 400, {
              error: "Extension 指令不能同时附加图片",
            });
          await this.syncGateMode(runtime.rpc, runtime.id, initialGateMode);
          const promptId = extensionCommand ? "" : randomUUID();
          runtime.running = true;
          if (promptId) {
            this.tracePrompt("admitted", runtime.id, promptId);
          }
          this.broadcastSessionActivity(runtime.id);
          let deliveryUncertain = false;
          try {
            const command = {
              type: "prompt",
              message: initialMessage || "请查看这些图片。",
              ...(initialImages.length ? { images: initialImages } : {}),
            };
            if (promptId)
              await this.sendPromptRpc(runtime.rpc, runtime.id, promptId, command);
            else await runtime.rpc.send(command, PROMPT_PREPARE_TIMEOUT_MS);
            if (extensionCommand) {
              // Extension commands can complete synchronously without an
              // agent_start event. Refresh only their minimal state so the
              // Runtime never remains falsely marked running, then commit the
              // draft using the same semantics as ordinary extension commands.
              const state = asState(
                await runtime.rpc.send({ type: "get_state" }),
              );
              runtime.lastState = state;
              runtime.running = state.isStreaming;
              runtime.prompted = true;
              this.noteUserPrompt(runtime.id, promptAt);
              await this.finalizePersistedDraft(runtime);
            } else {
              this.scheduler.notifySecondaryPromptAccepted(runtime, promptAt);
            }
          } catch (error) {
            if (error instanceof RpcRequestTimeoutError && error.outcomeUnknown) {
              // The initial draft request is still a write to Pi stdin. Do not
              // discard its newly-created Runtime or let a later prompt race a
              // turn Pi may have accepted after the HTTP acknowledgement timer.
              deliveryUncertain = true;
              if (promptId)
                this.tracePrompt("delivery-uncertain", runtime.id, promptId);
              this.scheduler.notifySecondaryPromptAccepted(runtime, promptAt);
            } else {
              runtime.running = false;
              this.broadcastSessionActivity(runtime.id);
              throw error;
            }
          }
          json(response, 202, {
            ...this.runtimeReady(runtime),
            session: {
              ...(runtime.draftSession || {
                id: runtime.id,
                sessionId: runtime.lastState?.sessionId || runtime.id,
                name: "新对话",
                preview: "新对话",
                cwd: runtime.cwd,
                updatedAt: this.now(),
                messageCount: 1,
                active: true,
              }),
              active: true,
            },
            accepted: true,
            queued: false,
            ...(deliveryUncertain ? { deliveryUncertain: true } : null),
            // A timed-out extension write has not been proven to execute; use
            // the ordinary uncertain-prompt UX instead of claiming success.
            ...(extensionCommand && !deliveryUncertain
              ? {
                  extension: true,
                  command: extensionCommand.name,
                  description: extensionCommand.description,
                  isStreaming: this.runtimeTurnActive(runtime),
                }
              : null),
          } satisfies InitialPromptData);
        } finally {
          releasePromptAdmission();
        }
      } catch (error) {
        if (
          draftLease.created &&
          error instanceof PrimaryRuntimeUnavailableError
        ) {
          // releaseForDeletion drains Runtime admission; release this route's
          // handoff lease first or cleanup would wait on itself indefinitely.
          draftLease.release();
          await this.runtimePool
            .discardDraft(draftLease.runtime)
            .catch(() => undefined);
        }
        throw error;
      } finally {
        draftLease.release();
      }
      return;
    }

    const customModelMatch =
      /^\/api\/models\/([A-Za-z0-9._-]{1,80})\/([^/]{1,200})$/.exec(
        url.pathname,
      );
    if (customModelMatch) {
      if (!this.options.modelManager)
        return json(response, 501, { error: "模型管理不可用" });
      const provider = decodeURIComponent(customModelMatch[1]);
      const modelId = decodeURIComponent(customModelMatch[2]);
      if (request.method === "GET") {
        json(response, 200, {
          model: await this.options.modelManager.getCustomConfig(
            provider,
            modelId,
          ),
        });
        return;
      }
      if (request.method === "PUT") {
        const result = await this.withLifecycle(
          "resources-reloading",
          "更新模型配置",
          async () => {
            const body = await bodyJson(request);
            const state = asState(
              await this.options.rpc.send({ type: "get_state" }),
            );
            const wasActive =
              state.model?.provider === provider && state.model?.id === modelId;
            const snapshot = await snapshotFile(
              this.options.modelManager!.path,
            );
            const updated = await this.applyResourceFileTransaction(
              [snapshot],
              () => this.options.modelManager!.update(provider, modelId, body),
            );
            // A rename invalidates the session's model reference; reselect the new
            // key so the UI never points at a model that no longer exists.
            if (
              wasActive &&
              (updated.provider !== provider || updated.id !== modelId)
            ) {
              try {
                await this.options.rpc.send({
                  type: "set_model",
                  provider: updated.provider,
                  modelId: updated.id,
                });
              } catch {
                // The renamed model may be unreachable (auth/network); the user can
                // reselect it from the refreshed model list.
              }
            }
            return this.bootstrap();
          },
        );
        json(response, 200, result);
        return;
      }
      return methodNotAllowed(response);
    }

    if (url.pathname === "/api/models") {
      if (!this.options.modelManager)
        return json(response, 501, { error: "模型管理不可用" });
      if (request.method !== "POST" && request.method !== "DELETE")
        return methodNotAllowed(response);
      const result = await this.withLifecycle(
        "resources-reloading",
        "更新模型配置",
        async () => {
          const body = await bodyJson(request);
          const snapshot = await snapshotFile(this.options.modelManager!.path);
          if (request.method === "POST") {
            await this.applyResourceFileTransaction([snapshot], () =>
              this.options.modelManager!.add(body),
            );
          } else {
            const state = asState(
              await this.options.rpc.send({ type: "get_state" }),
            );
            if (
              state.model?.provider === body.provider &&
              state.model?.id === body.modelId
            )
              throw new Error("请先切换到其他模型，再删除当前模型");
            await this.applyResourceFileTransaction([snapshot], () =>
              this.options.modelManager!.remove(body.provider, body.modelId),
            );
          }
          return this.bootstrap();
        },
      );
      json(response, 200, result);
      return;
    }

    if (url.pathname === "/api/models/set") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || (await bodyJson(request));
      const provider = typeof body.provider === "string" ? body.provider : "";
      const modelId = typeof body.modelId === "string" ? body.modelId : "";
      const sessionId = requiredSessionId(body);
      const secondaryRuntime = this.runtimePool.get(sessionId) || null;
      if (!provider || !modelId)
        return json(response, 400, { error: "provider 和 modelId 必填" });
      if (!secondaryRuntime && sessionId !== this.activeSessionId)
        return json(response, 409, { error: "该会话尚未启用" });
      // Legacy direct setting calls may come from an older window. Serialize
      // them with prompt admission so they cannot interleave a newer prompt's
      // captured set_model → set_thinking_level → prompt transaction.
      const releaseSettingAdmission = await this.beginPromptAdmission(sessionId);
      try {
      if (secondaryRuntime) {
        return this.runtimePool.withOperation(secondaryRuntime, async () => {
          if (this.secondaryNeedsRecovery(secondaryRuntime))
            await this.recoverRuntime(secondaryRuntime);
          const targetRpc = secondaryRuntime.rpc;
          if (secondaryRuntime.running) {
            const model = asModels(
              await targetRpc.send({ type: "get_available_models" }),
            ).find((item) => item.provider === provider && item.id === modelId);
            if (!model) return json(response, 404, { error: "所选模型不可用" });
            secondaryRuntime.pendingTurnSettings.model = { provider, modelId };
            this.rememberRuntimeDisplaySettings(secondaryRuntime, { model });
            return json(response, 200, { model, pending: true });
          }
          const model = rpcData<ModelInfo>(
            await targetRpc.send({ type: "set_model", provider, modelId }),
          );
          this.rememberRuntimeDisplaySettings(secondaryRuntime, { model });
          return json(response, 200, { model, pending: false });
        });
      }
      const releasePrimaryOperation =
        this.primaryOperationAdmission.acquire().release;
      try {
        await this.ensurePrimaryRuntime();
        const targetRunning = this.running;
        if (targetRunning) {
          const model = asModels(
            await this.options.rpc.send({ type: "get_available_models" }),
          ).find((item) => item.provider === provider && item.id === modelId);
          if (!model) return json(response, 404, { error: "所选模型不可用" });
          this.pendingTurnSettings.model = { provider, modelId };
          this.rememberPrimaryDisplaySettings({ model });
          return json(response, 200, { model, pending: true });
        }
        const model = rpcData<ModelInfo>(
          await this.options.rpc.send({ type: "set_model", provider, modelId }),
        );
        this.rememberPrimaryDisplaySettings({ model });
        return json(response, 200, { model, pending: false });
      } finally {
        releasePrimaryOperation();
      }
      } finally {
        releaseSettingAdmission();
      }
      return;
    }

    if (url.pathname === "/api/thinking/set") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || (await bodyJson(request));
      const level =
        typeof body.level === "string" &&
        THINKING_LEVELS.includes(body.level as ThinkingLevel)
          ? (body.level as ThinkingLevel)
          : null;
      const sessionId = requiredSessionId(body);
      const secondaryRuntime = this.runtimePool.get(sessionId) || null;
      if (!level) return json(response, 400, { error: "无效的 Thinking 强度" });
      if (!secondaryRuntime && sessionId !== this.activeSessionId)
        return json(response, 409, { error: "该会话尚未启用" });
      // See /api/models/set: direct legacy mutations share the prompt FIFO.
      const releaseSettingAdmission = await this.beginPromptAdmission(sessionId);
      try {
      if (secondaryRuntime) {
        return this.runtimePool.withOperation(secondaryRuntime, async () => {
          if (this.secondaryNeedsRecovery(secondaryRuntime))
            await this.recoverRuntime(secondaryRuntime);
          if (secondaryRuntime.running) {
            secondaryRuntime.pendingTurnSettings.thinkingLevel = level;
            this.rememberRuntimeDisplaySettings(secondaryRuntime, {
              thinkingLevel: level,
            });
            return json(response, 200, { level, pending: true });
          }
          await secondaryRuntime.rpc.send({
            type: "set_thinking_level",
            level,
          });
          const state = asState(
            await secondaryRuntime.rpc.send({ type: "get_state" }),
          );
          secondaryRuntime.lastState = state;
          secondaryRuntime.running = state.isStreaming;
          return json(response, 200, {
            level: state.thinkingLevel,
            pending: false,
          });
        });
      }
      const releasePrimaryOperation =
        this.primaryOperationAdmission.acquire().release;
      try {
        await this.ensurePrimaryRuntime();
        if (this.running) {
          this.pendingTurnSettings.thinkingLevel = level;
          this.rememberPrimaryDisplaySettings({ thinkingLevel: level });
          return json(response, 200, { level, pending: true });
        }
        await this.options.rpc.send({ type: "set_thinking_level", level });
        const state = asState(
          await this.options.rpc.send({ type: "get_state" }),
        );
        this.lastPrimaryState = state;
        this.running = state.isStreaming;
        return json(response, 200, {
          level: state.thinkingLevel,
          pending: false,
        });
      } finally {
        releasePrimaryOperation();
      }
      } finally {
        releaseSettingAdmission();
      }
      return;
    }

    if (url.pathname === "/api/resources/browse") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = await bodyJson(request);
      const kind = typeof body.kind === "string" ? body.kind : "";
      if (
        ![
          "skills-root",
          "extensions-root",
          "packages-root",
          "models-root",
        ].includes(kind)
      ) {
        return json(response, 400, { error: "kind 无效" });
      }
      const path = this.options.resources.resolveBrowsePath(
        kind as
          "skills-root" | "extensions-root" | "packages-root" | "models-root",
      );
      await revealInExplorer(path);
      json(response, 200, { ok: true, path });
      return;
    }

    if (url.pathname === "/api/resources/skills") {
      if (request.method !== "GET") return methodNotAllowed(response);
      const result = await this.options.resources.listSkills(
        this.primaryRuntimeCwd,
      );
      return json(response, 200, {
        ...result,
        resources: result.resources.filter((item) => item.enabled),
      });
    }

    if (url.pathname === "/api/resources/extensions") {
      if (request.method !== "GET") return methodNotAllowed(response);
      const result = await this.options.resources.listExtensions(
        this.primaryRuntimeCwd,
      );
      return json(response, 200, {
        ...result,
        resources: result.resources.filter((item) => item.enabled),
      });
    }

    if (url.pathname === "/api/resources/packages") {
      if (request.method !== "GET") return methodNotAllowed(response);
      const result = await this.options.resources.listPackages(
        this.primaryRuntimeCwd,
      );
      return json(response, 200, {
        ...result,
        resources: result.resources.filter((item) => item.enabled),
      });
    }

    if (url.pathname === "/api/extension-ui/respond") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || (await bodyJson(request));
      if (typeof body.id !== "string")
        return json(response, 400, { error: "id 必填" });
      const sessionId = requiredSessionId(body);
      const runtime = this.runtimePool.get(sessionId);
      const targetRpc =
        runtime?.rpc ||
        (sessionId === this.activeSessionId ? this.options.rpc : null);
      if (!targetRpc)
        return json(response, 409, { error: "Extension 对应的会话已经关闭" });
      // Claim synchronously so two windows cannot answer the same request. Keep
      // the authoritative pending state until sendRaw succeeds; a transport
      // failure must leave the dialog retryable.
      const claimKey = `${sessionId}\u0000${body.id}`;
      const pending = this.pendingRequestForSession(sessionId);
      if (
        !pending ||
        pending.id !== body.id ||
        this.claimingExtensionRequests.has(claimKey)
      )
        return json(response, 409, {
          error: "该确认已在另一窗口处理，或已失效",
        });
      this.claimingExtensionRequests.add(claimKey);
      let releaseRuntimeOperation: (() => void) | null = null;
      try {
        releaseRuntimeOperation = runtime
          ? this.runtimePool.acquireOperation(runtime)
          : this.primaryOperationAdmission.acquire().release;
        const command: Record<string, unknown> = {
          type: "extension_ui_response",
          id: body.id,
        };
        if (body.cancelled === true) command.cancelled = true;
        else if (typeof body.confirmed === "boolean")
          command.confirmed = body.confirmed;
        else if (typeof body.value === "string") command.value = body.value;
        else command.cancelled = true;
        try {
          await targetRpc.sendRaw(command);
        } catch (error) {
          if (error instanceof RpcRequestTimeoutError && error.outcomeUnknown) {
            // The frame may have reached Pi. Clear the single-use request so a
            // second browser attempt cannot duplicate the Gate decision.
            this.clearPendingRequest(sessionId, body.id);
            return json(response, 202, { ok: true, deliveryUncertain: true });
          }
          throw error;
        }
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

  private async serveStatic(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const root = resolve(this.options.webRoot);
    const requestPath =
      pathname === "/"
        ? "index.html"
        : normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
    let filePath = resolve(root, requestPath);
    if (
      !filePath.startsWith(
        `${root}${process.platform === "win32" ? "\\" : "/"}`,
      ) &&
      filePath !== root
    ) {
      return json(response, 403, { error: "Forbidden" });
    }
    if (!existsSync(filePath) || !(await stat(filePath)).isFile()) {
      const acceptsHtml = String(request.headers.accept || "").includes(
        "text/html",
      );
      const looksLikeAsset = Boolean(extname(requestPath));
      if (!acceptsHtml || looksLikeAsset)
        return json(response, 404, { error: "Not found" });
      filePath = join(root, "index.html");
    }
    if (!existsSync(filePath))
      return json(response, 404, {
        error: "前端尚未构建，请先运行 npm run build",
      });
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type":
        MIME_TYPES[extname(filePath)] || "application/octet-stream",
      "cache-control":
        extname(filePath) === ".html"
          ? "no-cache"
          : "public, max-age=31536000, immutable",
    });
    createReadStream(filePath).pipe(response);
  }
}
