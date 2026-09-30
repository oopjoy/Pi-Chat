import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import {
  appendTerminalMessage,
  assistantMessageRequestsTool,
  reconcilePersistedHistory,
} from "../shared/streaming-assistant.js";
import { compareSessionsByLastUserPrompt } from "../shared/session-order.js";
import { classifyNativeRetryEvent } from "../shared/retry-lifecycle.js";
import { MAX_PROMPT_IMAGES_ENCODED_BYTES } from "../shared/rpc-contracts.js";
import type { PromptEvidenceFactKind } from "../shared/prompt-evidence.js";
import { shouldRetainStateDiagnosticEvent } from "../shared/state-diagnostics.js";
import { normalizePromptFailure, visibleAssistantErrorDetail, type PromptFailure } from "../shared/assistant-error.js";
import type {
  ApplicationLifecycle,
  BackgroundSubagentSnapshot,
  BootstrapData,
  BuildIdentity,
  ExtensionUiRequest,
  GateMode,
  HealthData,
  InitialPromptData,
  ModelInfo,
  PiMessage,
  PiState,
  PendingPromptProjection,
  PendingSteer,
  PrimaryRuntimeReadiness,
  PromptDelivery,
  PromptImage,
  PromptSettingsSnapshot,
  QueuedPrompt,
  SessionActivityState,
  SessionCopyData,
  SessionDirectorySummary,
  SessionForkOrigin,
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
  readClipboardFiles,
  pickWorkspaceFolder,
  isSafeDefaultApplicationFile,
  openWithDefaultApplication,
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
import { LiveMessageIdentityRegistry } from "./live-message-identity.js";
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
  RpcProcessExitUnconfirmedError,
  RpcRequestTimeoutError,
  isRpcOutcomeUnknown,
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
  readSessionSnapshot,
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
  RuntimeStartupError,
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
import { SessionRelationStore } from "./session-relations.js";
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
import { handleWorkspaceOpenRoute } from "./routes/workspace-open.js";
import { handleWorkspaceReadRoute } from "./routes/workspace-read.js";
import { handleResourcesReadRoute } from "./routes/resources-read.js";
import { handleDiagnosticsReadRoute } from "./routes/diagnostics-read.js";
import { handleLifecycleControlRoute } from "./routes/lifecycle-control.js";
import { handleLocalFilesWorkspaceRoute } from "./routes/local-files-and-workspace.js";
import { dequeueNativeSteering } from "./services/native-steering-dequeue.js";
import {
  admitNativeSteering,
  type NativeSteeringAdmissions,
} from "./services/native-steering-admission.js";
import { renameSession } from "./services/session-rename-service.js";
import { validateSessionDeletePath } from "./services/session-delete-path.js";
import { prepareSessionDeletionRuntime } from "./services/session-delete-runtime.js";
import { finalizeSessionDelete } from "./services/session-delete-finalize.js";
import { finalizeSessionCopy } from "./services/session-copy-finalize.js";
import { validateSessionCopyPreparation } from "./services/session-copy-preparation.js";
import {
  executeSessionCopyRpc,
  validateCopiedSessionIdentity,
} from "./services/session-copy-transaction.js";
import { applyModelFileTransaction } from "./services/model-file-transaction.js";
import { projectColdSessionView, projectHotMemoryView } from "./services/session-view-projection.js";
import { readColdSessionView } from "./services/cold-session-view.js";
import { readSessionView, StaleSessionViewRuntimeError } from "./services/session-view-service.js";
import { forwardRuntimeEvent } from "./services/runtime-event-bridge.js";
import { projectPromptFailureLifecycle } from "./services/prompt-failure-lifecycle.js";
import { drainSecondaryAfterSettlement as drainSecondaryAfterSettlementService } from "./services/secondary-settlement-drain.js";
import { drainPrimaryAfterSettlement as drainPrimaryAfterSettlementService } from "./services/primary-settlement-drain.js";
import { finalizeAcceptedRuntimeEvent } from "./services/runtime-event-lifecycle.js";
import { abortRuntime } from "./services/runtime-abort.js";
import { admitPromptExtension } from "./services/prompt-extension-admission.js";
import { admitPromptToQueue } from "./services/prompt-queue-admission.js";
import { sessionViewFromCurrentProjection } from "./services/session-hot-view.js";
import { handleSecondaryEvent as handleSecondaryEventService, handleRpcEvent as handleRpcEventService } from "./services/runtime-event-handlers.js";
import { bootstrap as bootstrapPrimary } from "./services/primary-bootstrap.js";
import { dispatchSecondaryPrompt } from "./services/prompt-secondary-dispatch.js";
import { dispatchPrimaryPrompt } from "./services/prompt-primary-dispatch.js";
import {
  compactRuntime,
  type RuntimeCompactionResult,
} from "./services/runtime-compaction.js";
import { respondToExtension } from "./services/extension-response.js";
import { createProviderManagement } from "./services/provider-management.js";
import { createCustomModelManagement } from "./services/custom-model-management.js";
import { createRuntimeSettingsService } from "./services/runtime-settings.js";
import { assertApplicationQuiescent, verifyApplicationQuiescent } from "./services/application-quiescence.js";
import {
  reloadPrimaryResources,
  restartPrimaryRuntime as restartPrimaryRuntimeService,
} from "./services/primary-runtime-lifecycle.js";
import { handleSessionMutationsRoute } from "./routes/session-mutations.js";
import { handleSessionRuntimeControlRoute } from "./routes/session-runtime-control.js";
import { handleQueueControlRoute } from "./routes/queue-control.js";
import { handleWorkspaceControlRoute } from "./routes/workspace-control.js";
import { parseNewSessionInput } from "./routes/new-session-input.js";
import { dispatchNewDraftFirstTurn } from "./services/new-draft-first-turn.js";
import { prepareNewDraftRuntime } from "./services/new-draft-preparation.js";
import { handleModelManagementRoute } from "./routes/model-management.js";
import { handlePromptRoute } from "./routes/prompt-route.js";
import { handleNewSessionRoute } from "./routes/new-session.js";
import { handleExtensionResponseRoute } from "./routes/extension-response.js";
import {
  THINKING_LEVELS,
  requiredSessionId,
} from "./routes/request-validation.js";
import { parsePromptRouteInput } from "./routes/prompt-input.js";
import { handleWindowControlRoute } from "./routes/window-control.js";
import { SubagentStatusProvider } from "./subagent-status-provider.js";
import { apiRouteAdmission, PROMPT_BODY_LIMIT } from "./api-route-admission.js";
import {
  assistantLinkedWorkspaceFiles,
  normalizeWorkspaceRelativePath,
  readWorkspaceFile,
  recentModifiedWorkspaceFiles,
  workspaceFileTargetPath,
} from "./workspace-files.js";

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
const MAX_PERSISTED_PROMPT_IDENTITIES_PER_SESSION = 64;
const MAX_PERSISTED_PROMPT_IDENTITY_SESSIONS = 128;
const MAX_PENDING_PROMPT_BASELINE_IDS = 256;
const MAX_CONSUMED_STEER_PROJECTIONS_PER_SESSION = 64;
const MAX_CONSUMED_STEER_PROJECTION_SESSIONS = 128;
// Pi may emit agent_settled before the new JSONL user record is visible to a
// concurrent reader. Keep the draft's provisional sidebar summary only across
// this small bounded visibility window.
const DRAFT_PERSISTENCE_RETRY_DELAYS_MS = [40, 120, 300, 700];
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
  /** Pi Chat-only Fork provenance sidecar; never writes into Pi JSONL. */
  sessionRelations?: SessionRelationStore;
  webRoot: string;
  cwd: string;
  resources: ResourceManager;
  /** Test seam for the explicit Workspace-preview Open action. */
  openLocalFile?: (path: string, verifyTarget: () => Promise<string>) => Promise<void>;
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
  /** Pi package version frozen by the process-wide Runtime launch plan. */
  piVersion?: string;
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

interface PendingConsumedSteer {
  id: string;
  payloadFingerprint: string;
  promptAt: number;
  timestamp?: number;
  baselinePersistedUserIds: Set<string>;
  baselinePersistedTailId?: string;
}

interface PersistedSteerProjection {
  payloadFingerprint: string;
  timestamp?: number;
}

interface ActivePromptDiagnostic {
  promptId: string;
  rpcGeneration: number;
  route?: PromptSettingsSnapshot["model"];
  failure?: PromptFailure;
  retryAttempt?: number;
  retryPending?: boolean;
  retryExhausted?: boolean;
  retryExhaustedPublished?: boolean;
  terminalPublished?: boolean;
}

interface PersistedPromptIdentity {
  promptId: string;
  payloadFingerprint: string;
  timestamp?: number;
}

interface PendingAcceptedPrompt {
  id: string;
  promptId: string;
  /** Browser correlation only; never Server Prompt authority. */
  clientPromptOperationId?: string;
  message: PiMessage;
  expectedTurnTotal: number;
  /** Persisted rows already visible at admission can never be this Prompt's echo. */
  baselinePersistedUserIds: ReadonlySet<string>;
  settings?: PromptSettingsSnapshot;
}

interface ActiveSessionRunTiming {
  generation: number;
  startedAt: number;
}

interface SettledSessionRunTiming {
  generation: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
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
  private readonly sessionRelations: SessionRelationStore;
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
  /** Clone/Fork temporarily changes a bound Pi RPC identity before restoring its source binding. */
  private readonly copyingSessionIds = new Set<string>();
  /** A verified destination exists, but the immutable source writer has not yet recovered. */
  private readonly copyRecoveryPendingSessionIds = new Set<string>();
  /** A verified destination exists, but Session Index has not confirmed its browser projection. */
  private readonly copyProjectionPendingSessionIds = new Set<string>();
  /** Clone/Fork RPC delivery is unknown and must not invite a duplicate copy. */
  private readonly copyOutcomePendingSessionIds = new Set<string>();
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
  /** A compaction changes prompt structure; unresolved writes must fence later prompts. */
  private readonly compactionPendingBySession = new Set<string>();
  /** A compact RPC may emit activity before its acknowledgement is known. */
  private readonly uncertainCompactionBySession = new Set<string>();
  /** An Extension UI answer may be written without proof that Pi consumed it. */
  private readonly uncertainExtensionResponseBySession = new Set<string>();
  /** Non-idempotent RPC writes whose acknowledgement was lost. */
  private readonly rpcOutcomePendingBySession = new Set<string>();
  /** Tokenizes uncertain writes so a late response cannot clear a newer fence. */
  private readonly rpcOutcomeTokensBySession = new Map<string, string>();
  /** Primary new_session may have switched identity before DELETE was acknowledged. */
  private readonly deletionOutcomePendingBySession = new Set<string>();
  private readonly modelContextWindows = new Map<string, number>();
  /** Current model catalogue, retained so cold JSONL settings get a display name without waking Pi. */
  private readonly knownModels = new Map<string, ModelInfo>();
  private lastAvailableModels: ModelInfo[] = [];
  /** Host-side model catalogue; refreshed after atomic models.json mutations. */
  private startupModels: ModelInfo[];
  private modelCatalogueRevision = 1;
  private modelRuntimeSyncPending = false;
  private modelCatalogueWatcher?: FSWatcher;
  private modelCatalogueRefreshTimer?: ReturnType<typeof setTimeout>;
  private modelRuntimeSyncTimer?: ReturnType<typeof setTimeout>;
  private modelRuntimeSyncInFlight = false;
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
  /** Accepted ordinary turns survive a browser reload until their JSONL row is visible. */
  private readonly pendingAcceptedPromptsBySession = new Map<string, PendingAcceptedPrompt[]>();
  /**
   * Bounded process-local projection cache joining Server Prompt identity to
   * the JSONL entry that eventually persisted it. This metadata is never
   * written into Pi JSONL; it only makes browser reconciliation exact.
   */
  private readonly persistedPromptIdsBySession = new Map<
    string,
    Map<string, PersistedPromptIdentity>
  >();
  /** Preserve arrival order even when two local requests share one Date.now() millisecond. */
  private lastPromptOrderAt = 0;
  /** Authoritative mode of the bundled Gate extension in the Primary Runtime. */
  private primaryGateMode: GateMode = "strict";
  private readonly runEpoch: string;
  /** Stable identity for each transient Runtime message lifecycle. */
  private readonly liveMessageIdentities = new LiveMessageIdentityRegistry();
  private readonly runGenerationsBySession = new Map<string, number>();
  /** Server-owned turn timing survives browser/SSE reconnects without entering Pi JSONL. */
  private readonly activeRunTimingBySession = new Map<string, ActiveSessionRunTiming>();
  private readonly settledRunTimingBySession = new Map<string, SettledSessionRunTiming>();
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
  /** Verified consumed Steers waiting for their persisted User row to become visible. */
  private readonly pendingConsumedSteersBySession = new Map<
    string,
    PendingConsumedSteer[]
  >();
  /** Bounded process-local Steer labels reattached to matching JSONL projections. */
  private readonly persistedSteerProjectionsBySession = new Map<
    string,
    Map<string, PersistedSteerProjection>
  >();
  /** Monotonic browser-facing revision for the native Steer projection. */
  private readonly nativeSteeringProjectionRevisions = new Map<string, number>();
  /** Short-lived correlation from Pi's dequeue event to the initiating HTTP response. */
  private readonly nativeSteeringDequeueResults = new Map<
    string,
    { sessionId: string; generation: number; createdAt: number; items: Array<{ id: string; message: string }> }
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
    const sessionCachePath = typeof options.sessions.cachePath === "string"
      ? options.sessions.cachePath
      : join(options.cwd, ".pi-chat-session-index.json");
    this.sessionRelations = options.sessionRelations || new SessionRelationStore(
      join(dirname(sessionCachePath), "pi-chat-session-relations.json"),
    );
    this.options.sessions.setForkNameOverrideReader?.((sessionId) =>
      this.sessionRelations.getNameOverride(sessionId),
    );
    this.currentCwd = resolve(options.cwd);
    this.primaryRuntimeCwd = this.currentCwd;
    this.startupModels = this.readStartupModels();
    // Cold JSONL views resolve persisted model metadata through knownModels.
    // Seed it from the configured catalogue so models.json models keep their
    // reasoning/input/contextWindow instead of degrading to a bare-name fallback.
    this.rememberModelContextWindows(this.startupModels);
    this.startModelCatalogueWatcher();
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
      // Fast is owned by the live Runtime generation. Clear the old Primary
      // projection at the readiness boundary, before any bootstrap/view can
      // observe a replacement that is still starting or has failed.
      if (readiness.status !== "ready" && this.primaryBoundSessionId)
        this.setFastModeActive(this.primaryBoundSessionId, false);
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
      runtime: {
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
        currentPromptSettings: (sessionId) => this.currentPromptSettings(sessionId),
      },
      preparation: {
        applyPendingTurnSettings: (rpc, pending) =>
          this.applyPendingTurnSettings(rpc, pending),
        applyPromptSettings: (
          rpc,
          pending,
          settings,
          consumeSupersededLegacy,
          sessionId,
        ) =>
          this.applyPromptSettings(
            rpc,
            pending,
            settings,
            consumeSupersededLegacy,
            sessionId,
          ),
        onPrimaryPromptSettingsApplied: (settings) =>
          this.rememberPrimaryAppliedTurnSettings(settings),
        onRuntimePromptSettingsApplied: (runtime, settings) =>
          this.rememberRuntimeAppliedTurnSettings(runtime, settings),
        syncGateMode: (rpc, sessionId, mode) =>
          this.syncGateMode(rpc, sessionId, mode),
      },
      observation: {
        promptRpcObserver: (rpc, sessionId, promptId) =>
          this.promptRpcObserver(rpc, sessionId, promptId),
        tracePrompt: (sessionId, promptId, name) =>
          this.tracePrompt(name, sessionId, promptId),
        abandonPromptDiagnostic: (sessionId, promptId) =>
          this.clearPromptDiagnostic(sessionId, promptId),
      },
      publication: {
        broadcast: (event) => this.broadcast(event),
        publishSessionActivity: (sessionId) =>
          this.broadcastSessionActivity(sessionId),
        onPrimaryPromptAccepted: (sessionId, promptAt, message, images, settings, promptId, clientPromptOperationId) => {
          this.recordAcceptedPrompt(sessionId, promptId || randomUUID(), promptAt, message, images, settings, clientPromptOperationId);
          this.warmPrimaryMessageSnapshot();
          this.broadcast({
            type: "pi_chat_sessions_changed",
            action: "created",
            sessionId,
          });
        },
        onSecondaryPromptAccepted: (runtime, promptAt, message, images, settings, promptId, clientPromptOperationId) => {
          this.recordAcceptedPrompt(runtime.id, promptId || randomUUID(), promptAt, message, images, settings, clientPromptOperationId);
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
      onReclaimed: (runtime, reason) =>
        this.clearSessionRuntimeTransientState(runtime.id, `reclaim:${reason}`, {
          advanceGeneration: true,
        }),
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
  private modelRouteKey(model: Pick<ModelInfo, "provider" | "id" | "api">): string {
    return [model.provider, model.id, model.api || ""].join(String.fromCharCode(0));
  }

  private mergeHostAndRuntimeModels(runtimeModels: ModelInfo[], hostModels: ModelInfo[]): ModelInfo[] {
    const result = new Map<string, ModelInfo>();
    for (const model of [...runtimeModels, ...hostModels]) {
      const key = this.modelRouteKey(model);
      result.set(key, { ...result.get(key), ...model });
    }
    return [...result.values()];
  }

  private readStartupModels(): ModelInfo[] {
    if (!this.options.modelManager) return [];
    try {
      const raw = JSON.parse(
        readFileSync(this.options.modelManager.path, "utf8"),
      ) as { providers?: Record<string, { models?: unknown[]; api?: unknown }> };
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
            ...(typeof value.api === "string"
              ? { api: value.api }
              : typeof config.api === "string"
                ? { api: config.api }
                : null),
            name:
              typeof value.name === "string" && value.name
                ? value.name
                : value.id,
            source: "models-json",
            authMode: "api-key",
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

  private startModelCatalogueWatcher(): void {
    const modelPath = this.options.modelManager?.path;
    if (!modelPath) return;
    try {
      this.modelCatalogueWatcher = watch(dirname(modelPath), (_event, filename) => {
        if (filename && filename.toString() !== basename(modelPath)) return;
        if (this.modelCatalogueRefreshTimer) clearTimeout(this.modelCatalogueRefreshTimer);
        this.modelCatalogueRefreshTimer = setTimeout(() => {
          this.modelCatalogueRefreshTimer = undefined;
          if (this.closed) return;
          try {
            if (!existsSync(modelPath)) {
              // Atomic replacement can expose a short rename gap. Give the
              // replacement event a chance, then publish a real deletion.
              this.modelCatalogueRefreshTimer = setTimeout(() => {
                this.modelCatalogueRefreshTimer = undefined;
                if (!this.closed && !existsSync(modelPath))
                  this.refreshHostModelCatalogue();
              }, 100);
              return;
            }
            JSON.parse(readFileSync(modelPath, "utf8"));
            this.refreshHostModelCatalogue();
          } catch {
            // Ignore a transient partial/malformed external write; atomic saves
            // produce another event after the complete file is visible.
          }
        }, 50);
      });
      this.modelCatalogueWatcher.on("error", () => {
        // Watching is advisory; API mutations and bootstrap remain authoritative.
      });
    } catch {
      // The API mutation path still refreshes synchronously when watching is unavailable.
    }
  }

  private refreshHostModelCatalogue(): ModelInfo[] {
    const previous = this.startupModels;
    const next = this.readStartupModels();
    this.startupModels = next;
    const changed = JSON.stringify(previous) !== JSON.stringify(next);
    this.rememberModelContextWindows(next);
    if (changed) {
      this.modelCatalogueRevision += 1;
      this.modelRuntimeSyncPending = true;
      this.broadcast({
        type: "pi_chat_models_updated",
        models: this.mergeHostAndRuntimeModels(this.lastAvailableModels, next),
        revision: this.modelCatalogueRevision,
        runtimeSync: "waiting-for-runtime-reload",
      });
      this.scheduleModelRuntimeSync();
    }
    return next;
  }

  private scheduleModelRuntimeSync(delayMs = 100): void {
    if (!this.modelRuntimeSyncPending || this.closed || this.modelRuntimeSyncInFlight) return;
    if (this.modelRuntimeSyncTimer) clearTimeout(this.modelRuntimeSyncTimer);
    this.modelRuntimeSyncTimer = setTimeout(() => {
      this.modelRuntimeSyncTimer = undefined;
      void this.syncModelRuntime().catch(() => {
        // Keep pending=true and retry when the current turn settles or when the
        // next catalogue change arrives; failed reloads never replace the live Runtime.
      });
    }, delayMs);
  }

  private async syncModelRuntime(): Promise<void> {
    if (!this.modelRuntimeSyncPending || this.closed || this.modelRuntimeSyncInFlight) return;
    if (this.busyConversationCount() > 0) {
      this.scheduleModelRuntimeSync(500);
      return;
    }
    this.modelRuntimeSyncInFlight = true;
    try {
      await this.withLifecycle("models-refreshing", "同步模型 Runtime", async () => {
        await this.reloadRpc();
        const models = asModels(await this.options.rpc.send({ type: "get_available_models" }));
        this.lastAvailableModels = models;
        const hostKeys = new Set(this.startupModels.map((model) => this.modelRouteKey(model)));
        const runtimeKeys = new Set(models.map((model) => this.modelRouteKey(model)));
        this.modelRuntimeSyncPending = [...hostKeys].some((key) => !runtimeKeys.has(key));
        this.broadcast({
          type: "pi_chat_models_updated",
          models: this.mergeHostAndRuntimeModels(models, this.startupModels),
          revision: this.modelCatalogueRevision,
          runtimeSync: this.modelRuntimeSyncPending ? "waiting-for-runtime-reload" : "ready",
        });
      });
    } finally {
      this.modelRuntimeSyncInFlight = false;
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
      // Host-only model catalogue refreshes do not touch the active Pi Runtime;
      // an in-flight prompt therefore keeps its immutable route snapshot.
      if (lifecycle !== "models-refreshing")
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
    assertApplicationQuiescent({
      busyConversationCount: () => this.busyConversationCount(),
      transitioningCount: () => this.runtimePool.transitioningCount,
      activeMutationRequests: () => this.activeMutationRequests,
      primaryReadReady: () => this.primaryReadReady(),
      primaryState: async () => this.options.rpc.send({ type: "get_state" }),
      secondaryStates: () => this.runtimePool.rpcStatesForQuiescence(),
    }, action);
  }

  private async verifyApplicationQuiescent(action: string): Promise<void> {
    await verifyApplicationQuiescent({
      busyConversationCount: () => this.busyConversationCount(),
      transitioningCount: () => this.runtimePool.transitioningCount,
      activeMutationRequests: () => this.activeMutationRequests,
      primaryReadReady: () => this.primaryReadReady(),
      primaryState: async () => this.options.rpc.send({ type: "get_state" }),
      secondaryStates: () => this.runtimePool.rpcStatesForQuiescence(),
    }, action);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.modelCatalogueRefreshTimer) clearTimeout(this.modelCatalogueRefreshTimer);
    if (this.modelRuntimeSyncTimer) clearTimeout(this.modelRuntimeSyncTimer);
    this.modelCatalogueRefreshTimer = undefined;
    this.modelRuntimeSyncTimer = undefined;
    this.modelCatalogueWatcher?.close();
    this.modelCatalogueWatcher = undefined;
    this.cancelLastWindowShutdown();
    clearInterval(this.secondaryRuntimeSweepTimer);
    for (const timer of this.draftPersistenceRetryTimers.values())
      clearTimeout(timer);
    this.draftPersistenceRetryTimers.clear();
    this.unsubscribe();
    // Stop admitting Primary operations before waiting for in-flight resets.
    // Existing leases are allowed to drain, while every late caller fails
    // closed at the application boundary.
    const primaryAdmissionDrain = this.primaryOperationAdmission.closeAndDrain();
    // A settlement barrier or Primary recovery may already be changing child
    // ownership. Wait for those in-flight continuations before stopping
    // workers; the closed fence below prevents any new recovery/restart.
    const primaryRecovery = this.primaryRecovery;
    await Promise.allSettled([
      ...this.nativeSteeringResets.values(),
      ...(primaryRecovery ? [primaryRecovery] : []),
      primaryAdmissionDrain,
    ]);
    // Distinct Session workers can stop concurrently. Sequential forced-stop
    // windows made shutdown/restart scale by roughly three seconds per worker.
    // Preserve a failed worker's ownership, but still release SSE/HTTP-facing
    // resources so the caller can finish a bounded fail-closed shutdown.
    let runtimeStopFailure: unknown;
    try {
      await this.runtimePool.stopAll({ cleanupDrafts: true, terminal: true });
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
    // Fast is a live Runtime-generation projection, never a persisted Session
    // preference. Drop it explicitly on process shutdown so a reused App/test
    // instance cannot expose the previous generation after close.
    this.fastModeBySession.clear();
    this.pendingPrimaryFastMode = undefined;
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

  /** Project Pi's native retry lifecycle without becoming a retry authority. */
  private broadcastPromptFailureLifecycle(
    sessionId: string,
    event: Record<string, unknown>,
    runGeneration: number,
    rpcGeneration: number,
  ): void {
    const active = this.activePromptDiagnostic(sessionId, rpcGeneration);
    if (!active) return;
    projectPromptFailureLifecycle({
      active,
      sessionId,
      event,
      runGeneration,
      rpcGeneration,
    }, {
      runEpoch: () => this.runEpoch,
      broadcast: (next) => this.broadcast(next),
      recordEvidence: (fact) => this.promptEvidence.record(fact),
    });
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
    this.activePromptDiagnostics.set(sessionId, {
      promptId,
      rpcGeneration,
      route: this.currentPromptSettings(sessionId)?.model,
    });
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

  private browserEventAuthority(
    event: Record<string, unknown>,
  ): Record<string, unknown> {
    const sessionId =
      typeof event.piChatSessionId === "string" ? event.piChatSessionId : "";
    const withEpoch = typeof event.piChatRunEpoch === "string"
      ? event
      : { ...event, piChatRunEpoch: this.runEpoch };
    if (!sessionId || typeof withEpoch.piChatRunGeneration === "number")
      return withEpoch;
    // Generation zero is meaningful before the first agent_start. The browser
    // tracks explicit zero separately from an unknown generation, so even
    // queue/gate events emitted before the first turn participate in the same
    // stale-event fence without being mistaken for a terminal snapshot.
    return {
      ...withEpoch,
      piChatRunGeneration: this.runGenerationsBySession.get(sessionId) || 0,
    };
  }

  private broadcast(event: Record<string, unknown>): void {
    const outboundEvent = this.browserEventAuthority(event);
    const sessionId =
      typeof outboundEvent.piChatSessionId === "string"
        ? outboundEvent.piChatSessionId
        : typeof outboundEvent.sessionId === "string"
          ? outboundEvent.sessionId
          : "";
    this.traceState(
      "sse",
      "broadcast-intent",
      sessionId,
      {
        eventType: typeof outboundEvent.type === "string" ? outboundEvent.type : "unknown",
        transportClients: this.sseHub.size,
        eventRunning: outboundEvent.running === true,
        eventQueuePaused: outboundEvent.paused === true,
        eventQueueLength: Array.isArray(outboundEvent.queue) ? outboundEvent.queue.length : 0,
        eventExecution:
          outboundEvent.activity && typeof outboundEvent.activity === "object" &&
          typeof (outboundEvent.activity as { execution?: unknown }).execution === "string"
            ? (outboundEvent.activity as { execution: string }).execution
            : "none",
      },
      undefined,
      typeof outboundEvent.piChatRunGeneration === "number"
        ? outboundEvent.piChatRunGeneration
        : undefined,
    );
    this.sseHub.broadcast(outboundEvent);
    const eventType = typeof outboundEvent.type === "string" ? outboundEvent.type : "";
    const runGeneration =
      typeof outboundEvent.piChatRunGeneration === "number"
        ? outboundEvent.piChatRunGeneration
        : undefined;
    const activityExecution =
      outboundEvent.activity && typeof outboundEvent.activity === "object"
        ? (outboundEvent.activity as { execution?: unknown }).execution
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
    forwardRuntimeEvent({
      runEpoch: () => this.runEpoch,
      traceRejected: (decisionReason, id, generation) => this.traceState(
        "rpc-event",
        "rejected",
        id,
        { eventType: "message_end", decisionReason },
        undefined,
        generation,
      ),
      eventRunTiming: (id, type, generation) => this.eventRunTiming(id, type, generation),
      broadcast: (next) => this.broadcast(next),
    }, event, sessionId, runGeneration);
  }

  private broadcastControlState(sessionId: string): void {
    this.traceState("sse", "broadcast-control", sessionId, {
      eventType: "pi_chat_session_control_changed",
    });
    this.sseHub.broadcastEach((clientId) => ({
      type: "pi_chat_session_control_changed",
      sessionId,
      piChatRunEpoch: this.runEpoch,
      piChatRunGeneration: this.runGenerationsBySession.get(sessionId) || 0,
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
    if (pathname === "/api/chat/steers/dequeue") return "prompt.abort";
    if (pathname === "/api/chat/abort") return "prompt.abort";
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
    const message = visibleAssistantErrorDetail(raw)
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (message) this.runtimeFailureReasonsBySession.set(sessionId, message.slice(0, 280));
    const incidentId = incidentIdValue || incidentReference(error)?.incidentId;
    if (incidentId) this.runtimeIncidentIdsBySession.set(sessionId, incidentId);
  }

  private clearRuntimeFailure(sessionId: string): void {
    if (!sessionId) return;
    this.runtimeFailureReasonsBySession.delete(sessionId);
    this.runtimeIncidentIdsBySession.delete(sessionId);
    this.copyRecoveryPendingSessionIds.delete(sessionId);
  }

  private rpcOutcomeUnknown(error: unknown): boolean {
    if (error instanceof RpcProcessExitUnconfirmedError || isRpcOutcomeUnknown(error))
      return true;
    if (error instanceof Error && "cause" in error)
      return this.rpcOutcomeUnknown(error.cause);
    return false;
  }

  private lateRpcOutcomeHandler(
    sessionId: string,
    token: string,
    kind: "generic" | "compact" | "extension" | "delete" | "copy",
    requestId?: string,
  ) {
    return (response: Record<string, unknown>) => {
      if (this.closed) return;
      if (
        response.type !== "response" ||
        this.rpcOutcomeTokensBySession.get(sessionId) !== token
      )
        return;
      this.rpcOutcomeTokensBySession.delete(sessionId);
      this.rpcOutcomePendingBySession.delete(sessionId);
      if (kind === "compact") {
        this.compactionPendingBySession.delete(sessionId);
        this.uncertainCompactionBySession.delete(sessionId);
      } else if (kind === "delete") {
        this.deletionOutcomePendingBySession.delete(sessionId);
      } else if (kind === "copy") {
        // A successful late copy response may have created a destination, so
        // retain the duplicate guard until its SessionIndex projection is
        // verified. An explicit RPC failure proves no copy was committed.
        if (response.success === false)
          this.copyOutcomePendingSessionIds.delete(sessionId);
      } else if (kind === "extension" && requestId) {
        const pending = this.pendingRequestForSession(sessionId);
        if (pending?.id === requestId)
          this.clearPendingRequest(sessionId, requestId);
      }
      this.broadcastSessionActivity(sessionId);
    };
  }

  private sessionMutationOutcomePending(sessionId: string): boolean {
    return Boolean(
      sessionId && (
        this.rpcOutcomePendingBySession.has(sessionId) ||
        this.uncertainExtensionResponseBySession.has(sessionId) ||
        this.uncertainCompactionBySession.has(sessionId) ||
        this.deletionOutcomePendingBySession.has(sessionId) ||
        this.copyOutcomePendingSessionIds.has(sessionId) ||
        (
          this.compactionPendingBySession.has(sessionId) &&
          !this.compactionIsActive(sessionId)
        )
      ),
    );
  }

  private installRpcOutcomeFence(sessionId: string, token?: string): void {
    if (!sessionId) return;
    this.rpcOutcomePendingBySession.add(sessionId);
    if (!this.rpcOutcomeTokensBySession.has(sessionId))
      this.rpcOutcomeTokensBySession.set(sessionId, token || randomUUID());
    this.broadcastSessionActivity(sessionId);
  }

  private markRpcOutcomePending(
    sessionId: string,
    error: unknown,
    token?: string,
  ): void {
    if (!sessionId || !this.rpcOutcomeUnknown(error)) return;
    this.installRpcOutcomeFence(sessionId, token);
  }

  /** Convert an acknowledged-but-unresolved RPC mutation into one retry-safe HTTP outcome. */
  private rethrowResultPending(
    error: unknown,
    operation: string,
    operationOutcomeUnknown = true,
  ): never {
    if (this.rpcOutcomeUnknown(error))
      throw new HttpRequestError(
        409,
        `${operation}结果尚未确认；请刷新页面核对，不要重复操作`,
        "RESULT_PENDING",
        true,
        operationOutcomeUnknown,
      );
    throw error;
  }

  /**
   * Clear process-owned state for one Session without touching its persisted
   * JSONL or its durable Gate preference. Resource reload/recovery uses this
   * with an advanced run generation; deletion additionally drops the identity
   * anchors and preference below. Keeping this boundary centralized prevents a
   * late Fast/Steer/Ask/terminal callback from repopulating a replaced worker.
   */
  private clearSessionRuntimeTransientState(
    sessionId: string,
    reason: string,
    options: { advanceGeneration?: boolean; removeGatePreference?: boolean } = {},
  ): void {
    if (!sessionId) return;
    if (options.advanceGeneration) this.advanceSessionRunGeneration(sessionId);
    const extensionTimer = this.pendingExtensionTimers.get(sessionId);
    if (extensionTimer) clearTimeout(extensionTimer);
    this.pendingExtensionTimers.delete(sessionId);
    const pendingRequest = this.pendingRequestForSession(sessionId);
    if (sessionId === this.activeSessionId) {
      this.pendingExtensionRequest = undefined;
      this.pendingPrimaryFastMode = undefined;
      this.primaryPendingTerminalMessages = [];
      this.primaryPendingTerminalSessionId = "";
    } else {
      const runtime = this.runtimePool.get(sessionId);
      if (runtime) {
        runtime.pendingExtensionRequest = undefined;
        runtime.extensionUiPending = false;
        runtime.pendingFastMode = undefined;
        runtime.pendingTerminalMessages = [];
        runtime.liveMessage = undefined;
        runtime.toolStatus = "";
      }
    }
    this.activePromptDiagnostics.delete(sessionId);
    this.contextUsagePendingRefresh.delete(sessionId);
    this.contextUsageRefreshTurn.delete(sessionId);
    this.liveMessageIdentities.clear(sessionId);
    this.clearSessionRunTiming(sessionId);
    this.clearNativeSteeringState(sessionId, reason);
    for (const [dequeueId, result] of this.nativeSteeringDequeueResults) {
      if (result.sessionId === sessionId) this.nativeSteeringDequeueResults.delete(dequeueId);
    }
    this.setFastModeActive(sessionId, false);
    this.compactionPendingBySession.delete(sessionId);
    this.uncertainCompactionBySession.delete(sessionId);
    this.uncertainExtensionResponseBySession.delete(sessionId);
    this.rpcOutcomePendingBySession.delete(sessionId);
    this.rpcOutcomeTokensBySession.delete(sessionId);
    this.clearRuntimeFailure(sessionId);
    if (options.removeGatePreference) {
      this.gateModesBySession.delete(sessionId);
      this.runGenerationsBySession.delete(sessionId);
    }
    if (pendingRequest) {
      this.broadcast({
        type: "pi_chat_extension_request_resolved",
        piChatSessionId: sessionId,
        id: pendingRequest.id,
      });
      this.broadcastSessionActivity(sessionId);
    }
  }

  /** A copy operation has no second browser-dialog authority while the source RPC is rebound. */
  private cancelInteractiveCopyHook(
    sessionId: string,
    rpc: PiRpcClient,
    event: Record<string, unknown>,
  ): boolean {
    if (
      !this.copyingSessionIds.has(sessionId) ||
      event.type !== "extension_ui_request" ||
      typeof event.id !== "string" ||
      !["select", "confirm", "input", "editor"].includes(
        String(event.method || ""),
      )
    )
      return false;
    void rpc
      .sendRaw({ type: "extension_ui_response", id: event.id, cancelled: true })
      .catch(() => undefined);
    return true;
  }

  /** Events are authoritative over a hot-memory get_state snapshot that may lag compaction lifecycle frames. */
  private updateHotCompactionState(
    runtime: SecondaryRuntime | undefined,
    isCompacting: boolean,
  ): void {
    const sessionId = runtime?.id || this.activeSessionId;
    if (sessionId) {
      if (isCompacting) this.compactionPendingBySession.add(sessionId);
      else this.compactionPendingBySession.delete(sessionId);
    }
    if (runtime) {
      runtime.lastState = {
        ...(runtime.lastState || { model: null, isStreaming: runtime.running }),
        isCompacting,
      };
      return;
    }
    this.lastPrimaryState = { ...this.lastPrimaryState, isCompacting };
  }

  /** A known active compaction is queueable; an unknown compact RPC outcome is not. */
  private compactionIsActive(sessionId: string): boolean {
    const runtime = this.runtimePool.get(sessionId);
    return runtime
      ? runtime.lastState?.isCompacting === true
      : sessionId === this.activeSessionId && this.lastPrimaryState.isCompacting === true;
  }

  /** Event-owned evidence that a Primary turn still has visible or tool work. */
  private primaryTurnActive(): boolean {
    return this.running || Boolean(this.liveMessage) || Boolean(this.toolStatus);
  }

  /** Event-owned evidence that a Secondary turn still has visible or tool work. */
  private runtimeTurnActive(runtime: SecondaryRuntime): boolean {
    return runtime.running || Boolean(runtime.liveMessage) || Boolean(runtime.toolStatus);
  }

  /** Begin timing only when Pi has produced authoritative execution evidence. */
  private beginSessionRunTiming(sessionId: string, generation: number): ActiveSessionRunTiming {
    const existing = this.activeRunTimingBySession.get(sessionId);
    if (existing?.generation === generation) return existing;
    const timing = { generation, startedAt: this.now() } satisfies ActiveSessionRunTiming;
    this.activeRunTimingBySession.set(sessionId, timing);
    return timing;
  }

  /** Freeze the server-observed duration at a terminal lifecycle boundary. */
  private finishSessionRunTiming(sessionId: string, generation: number): SettledSessionRunTiming | undefined {
    const active = this.activeRunTimingBySession.get(sessionId);
    if (!active || active.generation !== generation) return undefined;
    const endedAt = Math.max(active.startedAt, this.now());
    const settled = {
      generation,
      startedAt: active.startedAt,
      endedAt,
      durationMs: endedAt - active.startedAt,
    } satisfies SettledSessionRunTiming;
    this.activeRunTimingBySession.delete(sessionId);
    this.settledRunTimingBySession.delete(sessionId);
    this.settledRunTimingBySession.set(sessionId, settled);
    // A long-lived server must not retain one timing record for every deleted
    // or short-lived Session forever. The newest records are sufficient for
    // returning to a recently completed process card.
    while (this.settledRunTimingBySession.size > 256) {
      const oldest = this.settledRunTimingBySession.keys().next().value;
      if (typeof oldest !== "string") break;
      this.settledRunTimingBySession.delete(oldest);
    }
    return settled;
  }

  private clearSessionRunTiming(sessionId: string): void {
    this.activeRunTimingBySession.delete(sessionId);
    this.settledRunTimingBySession.delete(sessionId);
  }

  private sessionRunTiming(sessionId: string): { runStartedAt?: number; lastRunDurationMs?: number } {
    const active = this.activeRunTimingBySession.get(sessionId);
    const settled = this.settledRunTimingBySession.get(sessionId);
    return {
      ...(active ? { runStartedAt: active.startedAt } : null),
      ...(settled ? { lastRunDurationMs: settled.durationMs } : null),
    };
  }

  private eventRunTiming(
    sessionId: string,
    eventType: string,
    generation: number | undefined,
  ): { startedAt?: number; durationMs?: number; endedAt?: number } {
    const active = this.activeRunTimingBySession.get(sessionId);
    if (active && (generation === undefined || active.generation === generation))
      return { startedAt: active.startedAt };
    const settled = this.settledRunTimingBySession.get(sessionId);
    if (
      settled &&
      (generation === undefined || settled.generation === generation) &&
      (eventType === "agent_settled" || eventType === "pi_chat_process_error")
    )
      return {
        startedAt: settled.startedAt,
        durationMs: settled.durationMs,
        endedAt: settled.endedAt,
      };
    return {};
  }

  private sessionActivity(sessionId: string): SessionActivityState {
    const runTiming = this.sessionRunTiming(sessionId);
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
    const compactionPending = this.compactionPendingBySession.has(sessionId);
    const rpcOutcomePending = this.rpcOutcomePendingBySession.has(sessionId);
    const failureReason = failed
      ? this.runtimeFailureReasonsBySession.get(sessionId)
      : undefined;
    const failureIncidentId = failed
      ? this.runtimeIncidentIdsBySession.get(sessionId)
      : undefined;
    return {
      ...(runTiming.runStartedAt !== undefined ? { runStartedAt: runTiming.runStartedAt } : null),
      ...(runTiming.lastRunDurationMs !== undefined ? { lastRunDurationMs: runTiming.lastRunDurationMs } : null),
      ...(failureReason ? { error: failureReason } : null),
      ...(failureIncidentId ? { incidentId: failureIncidentId } : null),
      // `dispatching` also covers the post-settlement FIFO get_state barrier,
      // That barrier keeps restart/shutdown safe, but with no queued turn it is
      // not visible conversation work and must not leave a blue sidebar ring.
      execution: failed
        ? "failed"
        : paused
          ? "paused"
          : running || compactionPending || rpcOutcomePending
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
    const runtime = this.runtimePool.get(sessionId);
    const queue = runtime
      ? this.publicQueue(runtime.promptQueue)
      : sessionId === this.activeSessionId
        ? this.publicQueue()
        : [];
    const queuePaused = runtime
      ? runtime.queuePaused
      : sessionId === this.activeSessionId
        ? this.queuePaused
        : false;
    this.broadcast({
      type: "pi_chat_session_status",
      piChatSessionId: sessionId,
      // Activity is derived from the same Pi turn as the event stream. Carry
      // its immutable lifecycle identity so a delayed "running" snapshot from
      // a completed turn cannot repaint the sidebar spinner after settlement.
      piChatRunEpoch: this.runEpoch,
      piChatRunGeneration: this.runGenerationsBySession.get(sessionId) || 0,
      activity,
      // Queue and activity are sampled from the same Runtime-owned state. This
      // cumulative snapshot lets the browser converge when a queue_update or
      // queue_dispatch frame is coalesced by SSE backpressure.
      queue,
      paused: queuePaused,
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
      let keepAdmissionClosed = false;
      try {
        try {
          await this.options.rpc.stop();
        } catch (error) {
          keepAdmissionClosed = this.rpcOutcomeUnknown(error);
          this.rethrowResultPending(error, "回收会话运行时");
        }
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
        if (!keepAdmissionClosed)
          this.primaryOperationAdmission.reopen(generation);
      }
    }
    const runtime = this.runtimePool.get(sessionId);
    if (!runtime || !this.runtimePool.canReclaim(runtime)) return false;
    this.clearNativeSteeringState(sessionId, "reclaim");
    try {
      return await this.runtimePool.reclaim(sessionId, "idle");
    } catch (error) {
      this.rethrowResultPending(error, "回收会话运行时");
    }
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
    this.uncertainExtensionResponseBySession.delete(sessionId);
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
    const projectedEvent = this.liveMessageIdentities.project(sessionId, event);
    const transition = transitionRuntimeEvent(
      sessionId,
      this.runtimeEventState(sessionId, runtime),
      projectedEvent,
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
    // A consumed Steer may be waiting for its JSONL User row. That projection
    // belongs to the worker generation that verified dequeue + message_start;
    // retaining it across recovery could label a later ordinary same-text row.
    this.pendingConsumedSteersBySession.delete(sessionId);
    this.nativeSteeringResetAfterSettlement.delete(sessionId);
    const revision = droppedCount > 0
      ? this.advanceNativeSteeringProjection(sessionId)
      : (this.nativeSteeringProjectionRevisions.get(sessionId) || 0);
    if (droppedCount > 0)
      this.broadcast({
        type: "pi_chat_native_steering_cleared",
        piChatSessionId: sessionId,
        reason,
        droppedCount,
        pendingSteerRevision: revision,
      });
    return droppedCount;
  }

  private advanceNativeSteeringProjection(sessionId: string): number {
    const revision = (this.nativeSteeringProjectionRevisions.get(sessionId) || 0) + 1;
    this.nativeSteeringProjectionRevisions.set(sessionId, revision);
    return revision;
  }

  private pendingSteerProjection(sessionId: string): {
    items: PendingSteer[];
    revision: number;
  } {
    const admissions = this.nativeSteeringAdmissionsBySession.get(sessionId);
    return {
      items: (admissions?.items || []).map((item) => ({
        id: item.id,
        message: item.message,
        imageCount: item.imageCount || 0,
        createdAt: item.promptAt,
      })),
      revision: this.nativeSteeringProjectionRevisions.get(sessionId) || 0,
    };
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
   * Pi's native Alt+Up action clears the whole remaining queue. The preceding
   * queue_update looks identical to consumption, so this correlated event
   * removes only the cleared suffix from both snapshot and admissions before a
   * future message_start can mistake it for executed steering.
   */
  private settleNativeSteeringDequeue(
    sessionId: string,
    event: Record<string, unknown>,
    generation: number,
  ): Array<{ id: string; message: string }> {
    const dequeueId = typeof event.dequeueId === "string" ? event.dequeueId : "";
    const steering = Array.isArray(event.steering)
      ? event.steering.filter((message): message is string => typeof message === "string")
      : null;
    if (!dequeueId || !steering) return [];
    const admissions = this.nativeSteeringAdmissionsBySession.get(sessionId);
    let items: Array<{ id: string; message: string }> = [];
    if (admissions?.generation === generation && steering.length <= admissions.items.length) {
      const candidate = admissions.items.slice(admissions.items.length - steering.length);
      if (candidate.every((admission, index) => admission.message === steering[index])) {
        items = candidate.map(({ id, message }) => ({ id, message }));
        admissions.items.splice(admissions.items.length - steering.length, steering.length);
        if (admissions.items.length)
          this.nativeSteeringAdmissionsBySession.set(sessionId, admissions);
        else this.nativeSteeringAdmissionsBySession.delete(sessionId);
      }
    }
    const snapshot = this.pendingNativeSteeringBySession.get(sessionId);
    if (snapshot?.generation === generation && steering.length <= snapshot.dequeued.length) {
      const suffix = snapshot.dequeued.slice(snapshot.dequeued.length - steering.length);
      if (suffix.every((message, index) => message === steering[index]))
        snapshot.dequeued.splice(snapshot.dequeued.length - steering.length, steering.length);
      if (snapshot.messages.length || snapshot.dequeued.length)
        this.pendingNativeSteeringBySession.set(sessionId, snapshot);
      else this.pendingNativeSteeringBySession.delete(sessionId);
    }
    const now = Date.now();
    for (const [id, result] of this.nativeSteeringDequeueResults) {
      if (now - result.createdAt > 5 * 60_000)
        this.nativeSteeringDequeueResults.delete(id);
    }
    this.nativeSteeringDequeueResults.set(dequeueId, {
      sessionId,
      generation,
      createdAt: now,
      items,
    });
    while (this.nativeSteeringDequeueResults.size > 64) {
      const oldest = this.nativeSteeringDequeueResults.keys().next().value;
      if (typeof oldest !== "string") break;
      this.nativeSteeringDequeueResults.delete(oldest);
    }
    if (items.length) {
      const revision = this.advanceNativeSteeringProjection(sessionId);
      this.broadcast({
        type: "pi_chat_native_steering_dequeued",
        piChatRunEpoch: this.runEpoch,
        piChatSessionId: sessionId,
        ids: items.map((item) => item.id),
        pendingSteerRevision: revision,
      });
    }
    return items;
  }

  /** Retain only server-verified Steer provenance until JSONL exposes its User row. */
  private rememberConsumedNativeSteer(
    sessionId: string,
    event: Record<string, unknown>,
    admission: NativeSteeringAdmissions["items"][number],
  ): void {
    const message = event.message && typeof event.message === "object"
      ? event.message as PiMessage
      : null;
    if (!message || message.role !== "user") return;
    const timestamp = typeof message.timestamp === "number"
      && Number.isFinite(message.timestamp)
      ? message.timestamp
      : undefined;
    const pending = this.pendingConsumedSteersBySession.get(sessionId) || [];
    pending.push({
      id: admission.id,
      payloadFingerprint: this.promptPayloadFingerprint(message),
      promptAt: admission.promptAt,
      ...(timestamp !== undefined ? { timestamp } : null),
      baselinePersistedUserIds: admission.baselinePersistedUserIds,
      ...(admission.baselinePersistedTailId
        ? { baselinePersistedTailId: admission.baselinePersistedTailId }
        : null),
    });
    while (pending.length > MAX_CONSUMED_STEER_PROJECTIONS_PER_SESSION)
      pending.shift();
    this.pendingConsumedSteersBySession.delete(sessionId);
    this.pendingConsumedSteersBySession.set(sessionId, pending);
    while (
      this.pendingConsumedSteersBySession.size
      > MAX_CONSUMED_STEER_PROJECTION_SESSIONS
    )
      this.pendingConsumedSteersBySession.delete(
        this.pendingConsumedSteersBySession.keys().next().value!,
      );
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
  ): string | undefined {
    if (event.type !== "message_start") return undefined;
    const text = this.nativeSteeringMessageText(event);
    const snapshot = this.pendingNativeSteeringBySession.get(sessionId);
    const admissions = this.nativeSteeringAdmissionsBySession.get(sessionId);
    if (!text || !snapshot || !admissions) return undefined;
    if (
      snapshot.generation !== generation ||
      admissions.generation !== generation
    )
      return undefined;
    const dequeuedIndex = snapshot.dequeued.indexOf(text);
    if (dequeuedIndex < 0) return undefined;
    const index = admissions.items.findIndex(
      (admission) => admission.message === text,
    );
    if (index < 0) return undefined;
    snapshot.dequeued.splice(dequeuedIndex, 1);
    const [consumed] = admissions.items.splice(index, 1);
    if (admissions.items.length)
      this.nativeSteeringAdmissionsBySession.set(sessionId, admissions);
    else this.nativeSteeringAdmissionsBySession.delete(sessionId);
    if (snapshot.messages.length || snapshot.dequeued.length)
      this.pendingNativeSteeringBySession.set(sessionId, snapshot);
    else this.pendingNativeSteeringBySession.delete(sessionId);
    this.nativeSteeringResetAfterSettlement.delete(sessionId);
    this.advanceNativeSteeringProjection(sessionId);
    this.noteUserPrompt(sessionId, consumed.promptAt);
    this.rememberConsumedNativeSteer(sessionId, event, consumed);
    return consumed.id;
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
    if (this.closed) {
      this.clearNativeSteeringState(sessionId, "application-close");
      return;
    }
    const existing = this.nativeSteeringResets.get(sessionId);
    if (existing) return existing;
    const reset = (async () => {
      try {
        if (this.closed) {
          this.clearNativeSteeringState(sessionId, "application-close");
          return;
        }
        if (runtime) {
          await this.runtimePool.recover(runtime);
          if (this.closed) {
            this.clearNativeSteeringState(sessionId, "application-close");
            return;
          }
          this.clearRuntimeFailure(runtime.id);
          this.broadcastSessionActivity(runtime.id);
        } else {
          // Controller-managed restart adopts the startup state before resolve.
          // Re-reading get_state here used to reopen the same split authority.
          await this.restartPrimaryRuntime(this.activeSessionPath || undefined);
          if (this.closed) {
            this.clearNativeSteeringState(sessionId, "application-close");
            return;
          }
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

  private handleSecondaryEvent(runtime: SecondaryRuntime, event: Record<string, unknown>, source?: RpcEventSource): void {
    handleSecondaryEventService(this, runtime, event, source);
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
    await drainSecondaryAfterSettlementService({
      closed: () => this.closed,
      isCurrent: (candidate, generation) => this.runtimePool.get(candidate.id) === candidate && generation === candidate.rpcGeneration,
      activePromptId: (sessionId, generation) => this.activePromptDiagnostic(sessionId, generation)?.promptId,
      traceSettled: (sessionId, id, generation) => this.tracePrompt("settlement-barrier", sessionId, id, generation),
      traceFailure: (sessionId, id, generation) => this.tracePromptDiagnosticOnly("process-failed", sessionId, id, generation),
      clearPrompt: (sessionId, id) => this.clearPromptDiagnostic(sessionId, id),
      adoptState: (candidate, state) => { candidate.lastState = state; candidate.running = state.isStreaming; },
      shouldResetSteering: (sessionId, generation) =>
        this.nativeSteeringResetAfterSettlement.get(sessionId) === generation && this.hasNativeSteeringPending(sessionId, generation),
      resetSteering: (candidate) => this.resetNativeSteering(candidate.id, candidate, "settled-before-consumption"),
      broadcastActivity: (sessionId) => this.broadcastSessionActivity(sessionId),
      dispatchNext: (candidate) => { void this.dispatchRuntimeNext(candidate); },
      sweep: () => { void this.runtimePool.sweep(); },
      timeoutMs: () => SETTLEMENT_STATE_TIMEOUT_MS,
      markSettlementFailure: (candidate, error) => {
        const message = `Pi 结算同步失败：${error instanceof Error ? error.message : String(error)}`;
        const incident = this.reportIncident(error, {
          sessionId: candidate.id,
          runtimeKind: "secondary",
          rpcGeneration: candidate.rpcGeneration,
          childPid: candidate.rpc.currentPid?.() || undefined,
          operation: "runtime.settlement",
          queueLength: candidate.promptQueue.length,
          outcome: "failed",
          errorCode: "SETTLEMENT_SYNC_FAILED",
        });
        this.recordRuntimeFailure(candidate.id, message, incident.incidentId);
        this.broadcastQueue(candidate.id);
        this.broadcast({
          type: "pi_chat_process_error",
          piChatSessionId: candidate.id,
          error: message,
          errorCode: "SETTLEMENT_SYNC_FAILED",
          incidentId: incident.incidentId,
          ...(error instanceof NativeSteeringResetError ? { nativeSteeringDroppedCount: error.droppedCount } : null),
        });
        this.broadcastSessionActivity(candidate.id);
      },
    }, runtime, sourceGeneration, promptId);
  }

  private async drainPrimaryAfterSettlement(
    sessionId: string,
    sourceGeneration = this.primaryRpcGeneration,
    promptId?: string,
  ): Promise<void> {
    await drainPrimaryAfterSettlementService({
      readState: async () => asState(
        await this.options.rpc.send(
          { type: "get_state" },
          SETTLEMENT_STATE_TIMEOUT_MS,
          // Preserve the post-settlement FIFO position even if a regular
          // short-budget state read is currently in flight.
          { independentRead: true },
        ),
      ),
      closed: () => this.closed,
      isCurrent: (id, generation) =>
        id === this.primaryBoundSessionId && generation === this.primaryRpcGeneration,
      activePromptId: (id, generation) =>
        this.activePromptDiagnostic(id, generation)?.promptId,
      traceSettled: (id, prompt, generation) =>
        this.tracePrompt("settlement-barrier", id, prompt, generation),
      traceFailure: (id, prompt, generation) =>
        this.tracePromptDiagnosticOnly("process-failed", id, prompt, generation),
      clearPrompt: (id, prompt) => this.clearPromptDiagnostic(id, prompt),
      adoptState: (state) => {
        this.lastPrimaryState = state;
        this.running = state.isStreaming;
      },
      isRunning: () => this.running,
      shouldResetSteering: (id, generation) =>
        this.nativeSteeringResetAfterSettlement.get(id) === generation &&
        this.hasNativeSteeringPending(id, generation),
      resetSteering: (id) =>
        this.resetNativeSteering(id, undefined, "settled-before-consumption"),
      releaseDispatch: () => { this.dispatching = false; },
      broadcastActivity: (id) => this.broadcastSessionActivity(id),
      dispatchNext: () => { void this.dispatchNext(); },
      markSettlementFailure: (id, error) => {
        this.primaryFailed = true;
        this.queuePaused = this.promptQueue.length > 0;
        const message = `Pi 结算同步失败：${error instanceof Error ? error.message : String(error)}`;
        const incident = this.reportIncident(error, {
          sessionId: id,
          runtimeKind: "primary",
          rpcGeneration: sourceGeneration,
          childPid: this.options.rpc.currentPid?.() || undefined,
          operation: "runtime.settlement",
          queueLength: this.promptQueue.length,
          outcome: "failed",
          errorCode: "SETTLEMENT_SYNC_FAILED",
        });
        this.recordRuntimeFailure(id, message, incident.incidentId);
        this.broadcastQueue();
        this.broadcast({
          type: "pi_chat_process_error",
          piChatSessionId: id,
          error: message,
          errorCode: "SETTLEMENT_SYNC_FAILED",
          incidentId: incident.incidentId,
          ...(error instanceof NativeSteeringResetError
            ? { nativeSteeringDroppedCount: error.droppedCount }
            : null),
        });
        this.broadcastSessionActivity(id);
      },
    }, sessionId, sourceGeneration, promptId);
  }

  /** Abort one Secondary through the owner-held operation lease. */
  private async abortSecondaryRuntime(
    sessionId: string,
    runtime: SecondaryRuntime,
    present: (result: { ok: true; isStreaming: boolean; queuePaused: boolean; abortPending?: boolean }) => void,
  ): Promise<void> {
    runtime.abortGeneration += 1;
    const release = this.runtimePool.acquireOperation(runtime);
    try {
      this.runtimePool.touch(runtime);
      const result = await abortRuntime({
        pauseQueueForAbort: () => {
          if (runtime.promptQueue.length || runtime.dispatching) runtime.queuePaused = true;
        },
        queuePaused: () => runtime.queuePaused,
        unavailable: () => runtime.failed || runtime.rpc.isRunning?.() === false,
        unavailableResult: () => ({
          ok: true,
          isStreaming: false,
          queuePaused: runtime.queuePaused,
        }),
        steeringGeneration: () => runtime.rpcGeneration,
        hasNativeSteeringPending: (generation) =>
          this.hasNativeSteeringPending(sessionId, generation),
        armNativeSteeringReset: (generation) =>
          this.nativeSteeringResetAfterSettlement.set(sessionId, generation),
        sendAbort: async () => { await runtime.rpc.send({ type: "abort" }, 5_000); },
        abortOutcomeUnknown: (error) =>
          error instanceof RpcRequestTimeoutError &&
          error.outcomeUnknown &&
          error.requestType === "abort",
        running: () => runtime.running,
        broadcastUncertainAbort: () => {
          this.broadcastQueue(sessionId);
          this.broadcastSessionActivity(sessionId);
        },
        broadcastBeforeStateProbe: () => {},
        readState: async () => asState(
          await runtime.rpc.send({ type: "get_state" }, 2_000),
        ),
        setRunning: (running) => { runtime.running = running; },
        resetNativeSteering: () => this.resetNativeSteering(sessionId, runtime, "abort"),
        broadcastStoppedAbort: () => {
          this.broadcastQueue(sessionId);
          this.broadcastSessionActivity(sessionId);
        },
      });
      // Keep the response write inside the operation lease: a Session
      // reclaim/delete must not overtake the abort acknowledgement.
      present(result);
    } finally {
      release();
    }
  }

  /** Abort the Primary through its owner-held operation lease. */
  private async abortPrimaryRuntime(
    sessionId: string,
    present: (result: { ok: true; isStreaming: boolean; queuePaused: boolean; abortPending?: boolean }) => void,
  ): Promise<void> {
    this.scheduler.primaryAbortGeneration += 1;
    const release = this.primaryOperationAdmission.acquire().release;
    try {
      const result = await abortRuntime({
        pauseQueueForAbort: () => {
          if (this.promptQueue.length || this.dispatching) this.queuePaused = true;
        },
        queuePaused: () => this.queuePaused,
        unavailable: () => this.primaryFailed || this.options.rpc.isRunning?.() === false,
        unavailableResult: () => {
          this.broadcastQueue();
          this.broadcastSessionActivity(sessionId);
          return { ok: true, isStreaming: false, queuePaused: this.queuePaused };
        },
        steeringGeneration: () => this.primaryRpcGeneration,
        hasNativeSteeringPending: (generation) =>
          this.hasNativeSteeringPending(sessionId, generation),
        armNativeSteeringReset: (generation) =>
          this.nativeSteeringResetAfterSettlement.set(sessionId, generation),
        sendAbort: async () => { await this.options.rpc.send({ type: "abort" }, 5_000); },
        abortOutcomeUnknown: (error) =>
          error instanceof RpcRequestTimeoutError &&
          error.outcomeUnknown &&
          error.requestType === "abort",
        running: () => this.running,
        broadcastUncertainAbort: () => {
          this.broadcastQueue();
          this.broadcastSessionActivity(sessionId);
        },
        broadcastBeforeStateProbe: () => this.broadcastQueue(),
        readState: async () => asState(
          await this.options.rpc.send({ type: "get_state" }, 2_000),
        ),
        setRunning: (running) => { this.running = running; },
        resetNativeSteering: () => this.resetNativeSteering(sessionId, undefined, "abort"),
        broadcastStoppedAbort: () => this.broadcastSessionActivity(sessionId),
      });
      // Same response-write boundary as Secondary abort.
      present(result);
    } finally {
      release();
    }
  }

  /** Compact a Session behind its prompt/admission and Runtime ownership fences. */
  private async compactSession(
    sessionId: string,
    customInstructions: string,
    present: (result: RuntimeCompactionResult) => void,
  ): Promise<void> {
    const releasePromptAdmission = await this.beginPromptAdmission(sessionId);
    let releaseRuntimeOperation: (() => void) | null = null;
    try {
      // A cold/reclaimed persisted Session is neither Primary nor an error.
      // Bind Primary identity before allocating a Secondary so restoration,
      // Gate, recovery, fast mode, and RuntimePool capacity stay App-owned.
      let secondaryRuntime = this.runtimePool.get(sessionId) || null;
      if (!secondaryRuntime && !this.activeSessionId) {
        try {
          await this.ensurePrimaryIdentity();
        } catch (error) {
          this.rethrowResultPending(error, "准备压缩运行时", false);
        }
      }
      const requestedIsPrimary = sessionId === this.activeSessionId;
      if (!requestedIsPrimary && !secondaryRuntime) {
        try {
          secondaryRuntime = await this.ensureRuntime(sessionId);
        } catch (error) {
          if (error instanceof SessionNotFoundError) {
            present({ kind: "conflict", error: "该会话尚未启用" });
            return;
          }
          throw error;
        }
      }
      if (secondaryRuntime) {
        releaseRuntimeOperation = this.runtimePool.acquireOperation(secondaryRuntime);
        this.runtimePool.touch(secondaryRuntime);
        if (this.secondaryNeedsRecovery(secondaryRuntime))
          await this.recoverRuntime(secondaryRuntime);
      } else {
        releaseRuntimeOperation = this.primaryOperationAdmission.acquire().release;
        try {
          await this.ensurePrimaryRuntime();
        } catch (error) {
          this.rethrowResultPending(error, "准备压缩运行时", false);
        }
      }
      const targetRpc = secondaryRuntime?.rpc || this.options.rpc;
      const result = await compactRuntime({
        outcomePending: () =>
          this.compactionPendingBySession.has(sessionId) ||
          this.sessionMutationOutcomePending(sessionId),
        busy: () => secondaryRuntime
          ? this.scheduler.runtimeBusyForQueue(secondaryRuntime)
          : this.scheduler.primaryBusyForQueue(),
        newOutcomeToken: () => randomUUID(),
        sendCompact: async (command, outcomeToken) => rpcData<Record<string, unknown>>(
          await targetRpc.send(
            command,
            PROMPT_PREPARE_TIMEOUT_MS,
            {
              onLateResponse: this.lateRpcOutcomeHandler(
                sessionId,
                outcomeToken,
                "compact",
              ),
            },
          ),
        ),
        outcomeUnknown: (error) => this.rpcOutcomeUnknown(error),
        markOutcomePending: (error, token) =>
          this.markRpcOutcomePending(sessionId, error, token),
        markUncertainCompaction: () => this.uncertainCompactionBySession.add(sessionId),
        broadcastActivity: () => this.broadcastSessionActivity(sessionId),
        rethrowResultPending: (error) => this.rethrowResultPending(error, "上下文压缩"),
      }, customInstructions);
      // Preserve the response-write-before-admission-release boundary. A
      // same-Session Prompt may not pass this compact transaction until its
      // caller has received the compact outcome.
      present(result);
    } finally {
      releaseRuntimeOperation?.();
      releasePromptAdmission();
    }
  }

  private async ensureRuntime(id: string): Promise<SecondaryRuntime> {
    // Keep every failed-worker recovery in the App owner: it clears
    // generation-scoped Steer state and resumes already-admitted FIFO work.
    const existing = this.runtimePool.get(id);
    let runtime: SecondaryRuntime;
    if (existing?.operationAdmission.isClosed) {
      // RuntimePool owns the late confirmed-exit detach path. Do not call
      // recover() directly while its writer admission is still fenced.
      runtime = await this.runtimePool.ensure(id);
    } else if (existing && this.secondaryNeedsRecovery(existing)) {
      await this.recoverRuntime(existing);
      runtime = existing;
    } else runtime = await this.runtimePool.ensure(id);
    this.adoptSecondaryFastMode(runtime);
    if (!runtime.summarySnapshot)
      runtime.summarySnapshot =
        this.options.sessions.summaryForId?.(id) || undefined;
    const desiredGateMode = this.gateModesBySession.get(id);
    if (desiredGateMode && runtime.gateMode !== desiredGateMode) {
      const outcomeToken = randomUUID();
      try {
        await runtime.rpc.send(
          { type: "prompt", message: `/gate ${desiredGateMode}` },
          PROMPT_PREPARE_TIMEOUT_MS,
          {
            onLateResponse: this.lateRpcOutcomeHandler(
              id,
              outcomeToken,
              "generic",
            ),
          },
        );
      } catch (error) {
        this.markRpcOutcomePending(id, error, outcomeToken);
        this.rethrowResultPending(error, "同步 Gate", false);
      }
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
      session: {
        ...draft,
        activity: this.sessionActivity(runtime.id),
        ...this.controlState(runtime.id, clientId),
      },
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

  private handleRpcEvent(event: Record<string, unknown>, source?: RpcEventSource): void {
    handleRpcEventService(this, event, source);
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
    if (this.closed) return;
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
    if (desiredGateMode !== "strict") {
      const outcomeToken = randomUUID();
      try {
        await this.options.rpc.send(
          { type: "prompt", message: `/gate ${desiredGateMode}` },
          PROMPT_PREPARE_TIMEOUT_MS,
          {
            onLateResponse: this.lateRpcOutcomeHandler(
              this.activeSessionId,
              outcomeToken,
              "generic",
            ),
          },
        );
      } catch (error) {
        this.markRpcOutcomePending(this.activeSessionId, error, outcomeToken);
        if (this.rpcOutcomeUnknown(error))
          this.primaryOperationAdmission.fence();
        throw error;
      }
      if (this.closed) return;
    }
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
    if (this.closed) throw new Error("Pi Chat 已关闭");
    if (this.primaryOperationAdmission.isClosed) {
      if (!this.options.rpc.isExitConfirmed?.())
        throw new OperationAdmissionClosedError("Primary Runtime 正在确认退出，请稍后重试");
      this.primaryOperationAdmission.reopen(this.primaryOperationAdmission.generation);
    }
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
            if (this.closed) return;
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
            if (this.closed) return;
            const state = asState(
              response || (await this.options.rpc.send({ type: "get_state" })),
            );
            if (this.closed) return;
            this.lastPrimaryState = state;
            this.running = state.isStreaming;
            this.primaryFailed = false;
            this.toolStatus = "";
            this.bindPrimaryIdentity(state);
          }
          if (this.closed) return;
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
        if (this.rpcOutcomeUnknown(error)) {
          // A failed Primary restart may still own its JSONL. Fence new
          // operations until the RPC client proves that child ownership ended.
          this.primaryOperationAdmission.fence();
          throw error;
        }
        throw new Error(
          `主 Pi RPC 恢复失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
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
    sessionId?: string,
  ): Promise<AppliedTurnSettings> {
    const applied: AppliedTurnSettings = {};
    if (settings.model) {
      const available = asModels(
        await rpc.send({ type: "get_available_models" }),
      );
      const model = available.find(
        (candidate) =>
          candidate.provider === settings.model!.provider &&
          candidate.id === settings.model!.modelId &&
          // When the browser captured the Runtime API, require the same full
          // route. Legacy inventories may omit api and remain pair-compatible.
          (!settings.model!.api || candidate.api === settings.model!.api),
      );
      // Name the rejected pair and the catalogue it was checked against: a
      // silent generic message left the user unable to tell which Runtime
      // refused the selection or that the catalogue simply lacks that model.
      if (!model)
        throw new HttpRequestError(
          400,
          `所选模型不可用：${settings.model.provider}/${settings.model.modelId} 不在当前会话 Pi Runtime 的模型列表中（该 Runtime 提供 ${available.length} 个模型）。请在模型菜单中改选该 Runtime 提供的模型；若你刚更新过模型配置，请重启该会话的 Pi Runtime 后重试。`,
          "MODEL_UNAVAILABLE",
        );
      // Pi RPC's documented set_model command accepts only provider/modelId.
      // Two advertised API routes sharing that pair cannot be selected
      // deterministically by this Runtime version, so reject the ambiguous
      // route instead of acknowledging a choice Pi cannot faithfully execute.
      if (
        new Set(
          available
            .filter(
              (candidate) =>
                candidate.provider === settings.model!.provider &&
                candidate.id === settings.model!.modelId,
            )
            .map((candidate) => candidate.api || ""),
        ).size > 1
      )
        throw new HttpRequestError(
          409,
          `所选模型路由当前 Pi Runtime 无法区分：${settings.model.provider}/${settings.model.modelId}${settings.model.api ? `（${settings.model.api}）` : ""}。请在 Pi Runtime 支持 API 路由选择前改用唯一模型 ID。`,
          "MODEL_ROUTE_AMBIGUOUS",
        );
      const outcomeToken = randomUUID();
      try {
        await rpc.send(
          {
            type: "set_model",
            provider: model.provider,
            modelId: model.id,
          },
          undefined,
          {
            onLateResponse: this.lateRpcOutcomeHandler(
              sessionId || "",
              outcomeToken,
              "generic",
            ),
          },
        );
      } catch (error) {
        this.markRpcOutcomePending(sessionId || "", error, outcomeToken);
        throw error;
      }
      this.rememberModelContextWindows([model]);
      applied.model = model;
      // Pi clamps every non-reasoning model to off as part of set_model. Record
      // that known side effect and do not issue an incompatible follow-up
      // strength that would make the hot display diverge from Runtime state.
      if (model.reasoning === false) applied.thinkingLevel = "off";
    }
    if (settings.thinkingLevel && applied.model?.reasoning !== false) {
      const outcomeToken = randomUUID();
      try {
        await rpc.send(
          {
            type: "set_thinking_level",
            level: settings.thinkingLevel,
          },
          undefined,
          {
            onLateResponse: this.lateRpcOutcomeHandler(
              sessionId || "",
              outcomeToken,
              "generic",
            ),
          },
        );
      } catch (error) {
        this.markRpcOutcomePending(sessionId || "", error, outcomeToken);
        if (applied.model)
          throw new PartialTurnSettingsError(applied, error);
        throw error;
      }
      applied.thinkingLevel = settings.thinkingLevel;
    }
    const appliedModel = applied.model;
    if (
      settings.model &&
      appliedModel &&
      appliedModel.reasoning !== false
    ) {
      try {
        const state = asState(await rpc.send({ type: "get_state" }));
        const thinkingLevel = state.thinkingLevel as ThinkingLevel | undefined;
        if (
          state.model?.provider === appliedModel.provider &&
          state.model.id === appliedModel.id &&
          thinkingLevel &&
          THINKING_LEVELS.includes(thinkingLevel)
        )
          applied.thinkingLevel = thinkingLevel;
      } catch (error) {
        // Model/Thinking writes were already acknowledged. A failed read must
        // neither make the following Prompt ambiguous nor claim an unconfirmed
        // clamped value; the next Runtime refresh can repair the projection.
        console.warn(
          `[Pi Chat] 切换模型后无法确认 Thinking 强度${sessionId ? `（Session ${sessionId}）` : ""}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
    sessionId?: string,
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
    let applied: AppliedTurnSettings;
    try {
      applied = await this.applyTurnSettings(rpc, settings, sessionId);
    } catch (error) {
      // applyTurnSettings marks only a mutating set_model/set_thinking write.
      // A read-only catalogue timeout must not become a Session mutation fence.
      this.rethrowResultPending(error, "准备 Prompt 设置", false);
    }
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

  /** Read the already-known Runtime route without issuing a network/provider request. */
  private currentPromptSettings(sessionId: string): PromptSettingsSnapshot | undefined {
    const state = sessionId === this.activeSessionId
      ? this.lastPrimaryState
      : this.runtimePool.get(sessionId)?.lastState;
    const model = state?.model;
    if (!model?.provider || !model.id) return undefined;
    return {
      model: {
        provider: model.provider,
        modelId: model.id,
        ...(model.api ? { api: model.api } : null),
      },
      ...(state?.thinkingLevel ? { thinkingLevel: state.thinkingLevel as ThinkingLevel } : null),
    };
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
    const outcomeToken = randomUUID();
    try {
      await rpc.send(
        { type: "prompt", message: `/gate ${mode}` },
        PROMPT_PREPARE_TIMEOUT_MS,
        {
          onLateResponse: this.lateRpcOutcomeHandler(
            sessionId,
            outcomeToken,
            "generic",
          ),
        },
      );
    } catch (error) {
      this.markRpcOutcomePending(sessionId, error, outcomeToken);
      this.rethrowResultPending(error, "同步 Gate", false);
    }
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

  private pendingPromptMessage(
    id: string,
    promptId: string,
    message: string,
    images: PromptImage[],
    promptAt: number,
  ): PiMessage {
    const content = images.length
      ? [
          ...(message ? [{ type: "text", text: message }] : []),
          ...images.map((image) => ({
            type: "image",
            data: image.data,
            mimeType: image.mimeType,
          })),
        ]
      : message;
    return {
      role: "user",
      content,
      timestamp: promptAt,
      piChatPendingMessageId: id,
      piChatPromptId: promptId,
    };
  }

  private promptPayloadKey(message: PiMessage): string {
    if (typeof message.content === "string") return JSON.stringify([["text", message.content]]);
    if (!Array.isArray(message.content)) return "[]";
    return JSON.stringify(message.content.map((block) =>
      block.type === "image"
        ? ["image", block.data || "", block.mimeType || ""]
        : block.type === "text"
          ? ["text", block.text || ""]
          : [block.type, block.text || ""],
    ));
  }

  private promptPayloadFingerprint(message: PiMessage): string {
    return createHash("sha256").update(this.promptPayloadKey(message)).digest("hex");
  }

  private projectPersistedPromptIds(
    sessionId: string,
    messages: PiMessage[],
  ): void {
    const identities = this.persistedPromptIdsBySession.get(sessionId);
    if (!identities?.size) return;
    this.persistedPromptIdsBySession.delete(sessionId);
    this.persistedPromptIdsBySession.set(sessionId, identities);
    for (const message of messages) {
      const persistedId = message.piChatPersistedMessageId;
      if (!persistedId) continue;
      const identity = identities.get(persistedId);
      if (!identity) continue;
      const timestamp = typeof message.timestamp === "number"
        && Number.isFinite(message.timestamp)
        ? message.timestamp
        : undefined;
      // Entry IDs can survive a canonical rewrite. Reattach projection-only
      // identity only while both content and observed timestamp still match.
      if (
        identity.payloadFingerprint !== this.promptPayloadFingerprint(message)
        || identity.timestamp !== timestamp
      ) {
        identities.delete(persistedId);
        continue;
      }
      message.piChatPromptId = identity.promptId;
    }
    if (!identities.size) this.persistedPromptIdsBySession.delete(sessionId);
  }

  private rememberPersistedPromptId(
    sessionId: string,
    message: PiMessage,
    promptId: string,
  ): void {
    const persistedId = message.piChatPersistedMessageId;
    if (!persistedId) {
      message.piChatPromptId = promptId;
      return;
    }
    const timestamp = typeof message.timestamp === "number"
      && Number.isFinite(message.timestamp)
      ? message.timestamp
      : undefined;
    const identity: PersistedPromptIdentity = {
      promptId,
      payloadFingerprint: this.promptPayloadFingerprint(message),
      ...(timestamp !== undefined ? { timestamp } : null),
    };
    const identities =
      this.persistedPromptIdsBySession.get(sessionId)
      || new Map<string, PersistedPromptIdentity>();
    const existing = identities.get(persistedId);
    // A persisted entry belongs to one Server Prompt. Fail closed rather than
    // rebinding it if a malformed/stale projection ever claims otherwise.
    if (
      existing
      && (
        existing.promptId !== identity.promptId
        || existing.payloadFingerprint !== identity.payloadFingerprint
        || existing.timestamp !== identity.timestamp
      )
    )
      return;
    identities.delete(persistedId);
    identities.set(persistedId, identity);
    while (identities.size > MAX_PERSISTED_PROMPT_IDENTITIES_PER_SESSION)
      identities.delete(identities.keys().next().value!);
    this.persistedPromptIdsBySession.delete(sessionId);
    this.persistedPromptIdsBySession.set(sessionId, identities);
    while (
      this.persistedPromptIdsBySession.size
      > MAX_PERSISTED_PROMPT_IDENTITY_SESSIONS
    )
      this.persistedPromptIdsBySession.delete(
        this.persistedPromptIdsBySession.keys().next().value!,
      );
    message.piChatPromptId = promptId;
  }

  private projectPersistedSteerDeliveries(
    sessionId: string,
    messages: PiMessage[],
  ): void {
    // Pi/JSONL never owns this metadata. Clear labels left on reusable message
    // objects before consulting the bounded trusted projection on every read.
    for (const message of messages) delete message.piChatDelivery;
    const projections = this.persistedSteerProjectionsBySession.get(sessionId);
    if (!projections?.size) return;
    this.persistedSteerProjectionsBySession.delete(sessionId);
    this.persistedSteerProjectionsBySession.set(sessionId, projections);
    for (const message of messages) {
      const persistedId = message.piChatPersistedMessageId;
      if (!persistedId) continue;
      const projection = projections.get(persistedId);
      if (!projection) continue;
      const timestamp = typeof message.timestamp === "number"
        && Number.isFinite(message.timestamp)
        ? message.timestamp
        : undefined;
      if (
        projection.payloadFingerprint !== this.promptPayloadFingerprint(message)
        || projection.timestamp !== timestamp
      ) {
        projections.delete(persistedId);
        continue;
      }
      message.piChatDelivery = "steer";
    }
    if (!projections.size)
      this.persistedSteerProjectionsBySession.delete(sessionId);
  }

  private rememberPersistedSteerDelivery(
    sessionId: string,
    message: PiMessage,
  ): void {
    const persistedId = message.piChatPersistedMessageId;
    if (!persistedId) return;
    const timestamp = typeof message.timestamp === "number"
      && Number.isFinite(message.timestamp)
      ? message.timestamp
      : undefined;
    const projection: PersistedSteerProjection = {
      payloadFingerprint: this.promptPayloadFingerprint(message),
      ...(timestamp !== undefined ? { timestamp } : null),
    };
    const projections = this.persistedSteerProjectionsBySession.get(sessionId)
      || new Map<string, PersistedSteerProjection>();
    const existing = projections.get(persistedId);
    if (
      existing
      && (
        existing.payloadFingerprint !== projection.payloadFingerprint
        || existing.timestamp !== projection.timestamp
      )
    ) return;
    projections.delete(persistedId);
    projections.set(persistedId, projection);
    while (projections.size > MAX_CONSUMED_STEER_PROJECTIONS_PER_SESSION)
      projections.delete(projections.keys().next().value!);
    this.persistedSteerProjectionsBySession.delete(sessionId);
    this.persistedSteerProjectionsBySession.set(sessionId, projections);
    while (
      this.persistedSteerProjectionsBySession.size
      > MAX_CONSUMED_STEER_PROJECTION_SESSIONS
    )
      this.persistedSteerProjectionsBySession.delete(
        this.persistedSteerProjectionsBySession.keys().next().value!,
      );
    message.piChatDelivery = "steer";
  }

  private reconcileConsumedSteerProjections(
    sessionId: string,
    messages: PiMessage[],
  ): void {
    this.projectPersistedSteerDeliveries(sessionId, messages);
    const pending = this.pendingConsumedSteersBySession.get(sessionId);
    if (!pending?.length) return;
    const users = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.role === "user");
    const claimed = new Set<PiMessage>();
    const remaining: PendingConsumedSteer[] = [];
    for (const item of pending) {
      const anchorIndex = item.baselinePersistedTailId
        ? messages.findIndex(
            (message) => message.piChatPersistedMessageId === item.baselinePersistedTailId,
          )
        : -1;
      const persisted = users.find(({ message, index }) => {
        const persistedId = message.piChatPersistedMessageId;
        if (
          !persistedId
          || claimed.has(message)
          || message.piChatDelivery === "steer"
          || item.baselinePersistedUserIds.has(persistedId)
          || this.promptPayloadFingerprint(message) !== item.payloadFingerprint
        ) return false;
        if (item.baselinePersistedTailId && (anchorIndex < 0 || index <= anchorIndex))
          return false;
        const timestamp = typeof message.timestamp === "number"
          && Number.isFinite(message.timestamp)
          ? message.timestamp
          : undefined;
        // Without Pi's exact consumed timestamp or a visible pre-admission tail
        // anchor, payload equality alone must never claim an ordinary old row.
        return item.timestamp !== undefined
          ? timestamp === item.timestamp
          : Boolean(item.baselinePersistedTailId)
            && (timestamp === undefined || timestamp >= item.promptAt);
      })?.message;
      if (!persisted) {
        remaining.push(item);
        continue;
      }
      claimed.add(persisted);
      this.rememberPersistedSteerDelivery(sessionId, persisted);
    }
    if (remaining.length)
      this.pendingConsumedSteersBySession.set(sessionId, remaining);
    else this.pendingConsumedSteersBySession.delete(sessionId);
  }

  private pendingPromptPersisted(
    pending: PendingAcceptedPrompt,
    messages: PiMessage[],
    claimed: ReadonlySet<PiMessage>,
  ): PiMessage | undefined {
    const users = messages.filter((message) => message.role === "user");
    if (!users.length) return undefined;
    const admittedAt = pending.message.timestamp;
    if (typeof admittedAt !== "number" || !Number.isFinite(admittedAt))
      return undefined;
    const payloadKey = this.promptPayloadKey(pending.message);
    const eligible = (message: PiMessage): boolean => {
      const persistedId = message.piChatPersistedMessageId;
      return Boolean(
        persistedId
        && !claimed.has(message)
        && !pending.baselinePersistedUserIds.has(persistedId)
        && (!message.piChatPromptId || message.piChatPromptId === pending.promptId)
        && this.promptPayloadKey(message) === payloadKey
        && typeof message.timestamp === "number"
        && Number.isFinite(message.timestamp)
        && message.timestamp >= admittedAt
      );
    };
    const positional = users[pending.expectedTurnTotal - 1];
    if (positional && eligible(positional)) return positional;

    // Large/windowed or cold-start snapshots can carry a stale cumulative
    // ordinal even though the new JSONL row is already visible. Correlate the
    // ordered pending admission only to a post-admission row that was absent
    // at admission; claimed rows make repeated identical Prompts one-to-one.
    return users.find(eligible);
  }

  private reconcilePendingAcceptedPrompts(
    sessionId: string,
    messages: PiMessage[] | null | undefined,
  ): void {
    if (!messages) return;
    this.projectPersistedPromptIds(sessionId, messages);
    this.reconcileConsumedSteerProjections(sessionId, messages);
    const pending = this.pendingAcceptedPromptsBySession.get(sessionId);
    if (!pending?.length) return;
    const claimed = new Set<PiMessage>();
    const remaining: PendingAcceptedPrompt[] = [];
    for (const item of pending) {
      const persisted = this.pendingPromptPersisted(item, messages, claimed);
      if (!persisted) {
        remaining.push(item);
        continue;
      }
      claimed.add(persisted);
      this.rememberPersistedPromptId(sessionId, persisted, item.promptId);
    }
    if (remaining.length) this.pendingAcceptedPromptsBySession.set(sessionId, remaining);
    else this.pendingAcceptedPromptsBySession.delete(sessionId);
  }

  private pendingPromptForSession(sessionId: string): PendingPromptProjection | undefined {
    const pending = this.pendingAcceptedPromptsBySession.get(sessionId)?.at(-1);
    if (!pending) return undefined;
    return {
      id: pending.id,
      promptId: pending.promptId,
      ...(pending.clientPromptOperationId
        ? { clientPromptOperationId: pending.clientPromptOperationId }
        : null),
      message: pending.message,
      expectedTurnTotal: pending.expectedTurnTotal,
      ...(pending.settings ? { settings: pending.settings } : null),
    };
  }

  private stateWithPendingPromptSettings(
    sessionId: string,
    state: PiState,
  ): PiState {
    const pending = this.pendingPromptForSession(sessionId);
    const settings = pending?.settings;
    if (!settings) return state;
    return {
      ...state,
      ...(settings.model
        ? {
            model: this.modelFromSessionSettings({
              provider: settings.model.provider,
              modelId: settings.model.modelId,
            }),
          }
        : null),
      ...(settings.thinkingLevel
        ? { thinkingLevel: settings.thinkingLevel }
        : null),
    };
  }

  private recordAcceptedPrompt(
    sessionId: string,
    promptId: string,
    promptAt: number,
    message: string,
    images: PromptImage[],
    settings?: PromptSettingsSnapshot,
    clientPromptOperationId?: string,
  ): void {
    this.recordUserPrompt(sessionId, promptAt);
    if (!sessionId) return;
    const runtime = this.runtimePool.get(sessionId);
    const persisted = sessionId === this.activeSessionId && this.lastPrimaryMessagesSessionId === sessionId
      ? this.lastPrimaryMessages
      : runtime?.messageSnapshot ||
        this.options.sessions.cachedSnapshotForId?.(sessionId)?.messages ||
        [];
    const existing = this.pendingAcceptedPromptsBySession.get(sessionId) || [];
    const id = randomUUID();
    const pending: PendingAcceptedPrompt = {
      id,
      promptId,
      message: this.pendingPromptMessage(id, promptId, message, images, promptAt),
      expectedTurnTotal: persisted.filter((item) => item.role === "user").length + existing.length + 1,
      baselinePersistedUserIds: new Set(
        persisted.flatMap((item) =>
          item.role === "user" && item.piChatPersistedMessageId
            ? [item.piChatPersistedMessageId]
            : [],
        ).slice(-MAX_PENDING_PROMPT_BASELINE_IDS),
      ),
      ...(settings ? { settings } : null),
      ...(clientPromptOperationId ? { clientPromptOperationId } : null),
    };
    this.pendingAcceptedPromptsBySession.set(sessionId, [...existing, pending]);
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
    expectedAbortGeneration?: number,
    clientPromptOperationId?: string,
  ): Promise<PromptAcceptance> {
    return this.scheduler.sendPrimaryPrompt(
      message,
      images,
      promptAt,
      gateMode,
      promptId,
      settings,
      true,
      expectedAbortGeneration,
      clientPromptOperationId,
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
          this.reconcilePendingAcceptedPrompts(runtime.id, messages);
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
          this.reconcilePendingAcceptedPrompts(sessionId, messages);
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
    await restartPrimaryRuntimeService({
      closed: () => this.closed,
      primaryRuntime: this.options.primaryRuntime,
      isConcreteReadinessController: () => this.options.primaryRuntime instanceof PrimaryRuntimeReadinessController,
      rpc: this.options.rpc,
      primaryRuntimeCwd: () => this.primaryRuntimeCwd,
      activeSessionId: () => this.activeSessionId,
      currentGateMode: () => this.gateModesBySession.get(this.activeSessionId) || this.primaryGateMode,
      recoverPrimary: (runtime, file, runtimeCwd) => this.recoverPrimaryRuntimeWithQueueFence(runtime, file, runtimeCwd),
      legacyRestart: async (file, runtimeCwd) => { await this.options.rpc.restart(file, runtimeCwd); },
      lateRpcOutcomeHandler: (id, token) => this.lateRpcOutcomeHandler(id, token, "generic"),
      markRpcOutcomePending: (id, error, token) => this.markRpcOutcomePending(id, error, token),
      isOutcomeUnknown: (error) => this.rpcOutcomeUnknown(error),
      fencePrimaryOperation: () => this.primaryOperationAdmission.fence(),
      setPrimaryGateMode: (mode) => { this.primaryGateMode = mode; },
    }, sessionFile, cwd);
  }

  private async reloadRpc(knownState?: PiState): Promise<void> {
    this.assertApplicationQuiescent("修改资源配置");
    const state = knownState || asState(await this.options.rpc.send({ type: "get_state" }));
    const replacedSessionIds = new Set([
      this.activeSessionId,
      ...this.runtimePool.runtimes.keys(),
    ]);
    for (const sessionId of replacedSessionIds)
      this.clearSessionRuntimeTransientState(sessionId, "resources-reloading", {
        advanceGeneration: true,
      });
    await reloadPrimaryResources({
      getPrimaryState: async () => state,
      stopSecondaryRuntimes: () => this.runtimePool.stopAll({ terminal: false }),
      restartPrimary: (sessionFile) => this.restartPrimaryRuntime(sessionFile),
      rethrowResultPending: (error, operation) => this.rethrowResultPending(error, operation),
      broadcastReloaded: () => this.broadcast({ type: "pi_chat_reloaded" }),
    }, state);
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
      // ResourceManager inventories are read projections. Invalidate them only
      // after the file transaction commits, before the replacement Runtime
      // starts reading the new settings/resources.
      this.options.resources.invalidate?.();
      await this.reloadRpc(state);
      return result;
    } catch (error) {
      // Once the resource file mutation has committed, an unknown reload RPC
      // outcome must not trigger an immediate rollback/restart race. The
      // caller receives one retry-safe result-pending response instead.
      if (error instanceof HttpRequestError && error.code === "RESULT_PENDING")
        throw error;
      if (!changed) {
        this.options.resources.invalidate?.();
        // The file-manager write itself may have reached disk before its RPC
        // acknowledgement timed out. Treat that outcome as uncertain too;
        // retrying a POST/DELETE/PUT could duplicate the mutation.
        this.rethrowResultPending(error, "更新资源配置");
        throw error;
      }
      const original = error instanceof Error ? error.message : String(error);
      try {
        await restoreSnapshots(snapshots);
        this.options.resources.invalidate?.();
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

  /** Compatibility wrapper; the transaction owner lives in the model service. */
  private async applyModelFileTransaction<T>(mutation: () => Promise<T>): Promise<T> {
    if (!this.options.modelManager) throw new Error("模型管理不可用");
    return applyModelFileTransaction(
      {
        snapshot: () => snapshotFile(this.options.modelManager!.path),
        restore: (snapshot) => restoreSnapshots([snapshot]),
        invalidateCatalogue: () => this.refreshHostModelCatalogue(),
        rethrowResultPending: (error, operation) => this.rethrowResultPending(error, operation, false),
      },
      "更新模型配置",
      mutation,
    );
  }

  private providerManagementService() {
    if (!this.options.modelManager) throw new Error("模型管理不可用");
    return createProviderManagement({
      manager: this.options.modelManager,
      withLifecycle: (description, mutation) =>
        this.withLifecycle("models-refreshing", description, mutation),
      withModelFileTransaction: (mutation) => this.applyModelFileTransaction(mutation),
      primaryState: async () => this.options.rpc.send({ type: "get_state" }),
      secondaryStates: () => this.runtimePool.rpcStatesForQuiescence(),
      bootstrap: () => this.bootstrap(),
    });
  }

  private runtimeSettingsService() {
    return createRuntimeSettingsService({
      activeSessionId: () => this.activeSessionId,
      primaryRpc: () => this.options.rpc,
      primaryRunning: () => this.running,
      secondaryRuntime: (sessionId) => this.runtimePool.get(sessionId) || null,
      ensurePrimaryRuntime: () => this.ensurePrimaryRuntime(),
      recoverSecondary: (runtime) => this.recoverRuntime(runtime),
      withSecondaryOperation: (runtime, operation) => this.runtimePool.withOperation(runtime, operation),
      acquirePrimaryOperation: () => this.primaryOperationAdmission.acquire().release,
      mutationOutcomePending: (sessionId) => this.sessionMutationOutcomePending(sessionId),
      availableModels: async (rpc) => asModels(await rpc.send({ type: "get_available_models" })),
      lateRpcOutcomeHandler: (sessionId, token) => this.lateRpcOutcomeHandler(sessionId, token, "generic"),
      markRpcOutcomePending: (sessionId, error, token) => this.markRpcOutcomePending(sessionId, error, token),
      rethrowResultPending: (error, operation, fence = true) => this.rethrowResultPending(error, operation, fence),
      rememberRuntimeModel: (runtime, model) => this.rememberRuntimeDisplaySettings(runtime, { model }),
      rememberPrimaryModel: (model) => this.rememberPrimaryDisplaySettings({ model }),
      stagePrimaryModel: (provider, modelId) => { this.pendingTurnSettings.model = { provider, modelId }; },
      rememberRuntimeThinking: (runtime, level) => this.rememberRuntimeDisplaySettings(runtime, { thinkingLevel: level }),
      rememberPrimaryThinking: (level) => this.rememberPrimaryDisplaySettings({ thinkingLevel: level }),
      stagePrimaryThinking: (level) => { this.pendingTurnSettings.thinkingLevel = level; },
      updateRuntimeState: (runtime, state) => {
        runtime.lastState = state;
        runtime.running = state.isStreaming;
      },
      updatePrimaryState: (state) => {
        this.lastPrimaryState = state;
        this.running = state.isStreaming;
      },
    });
  }

  private customModelManagementService() {
    if (!this.options.modelManager) throw new Error("模型管理不可用");
    return createCustomModelManagement({
      manager: this.options.modelManager,
      withLifecycle: (description, mutation) =>
        this.withLifecycle("models-refreshing", description, mutation),
      withModelFileTransaction: (mutation) => this.applyModelFileTransaction(mutation),
      primaryState: async () => asState(await this.options.rpc.send({ type: "get_state" })),
      primaryTurnActive: () => this.primaryTurnActive(),
      setPrimaryModel: async (provider, modelId) => {
        const outcomeToken = randomUUID();
        try {
          await this.options.rpc.send(
            { type: "set_model", provider, modelId },
            undefined,
            { onLateResponse: this.lateRpcOutcomeHandler(this.activeSessionId, outcomeToken, "generic") },
          );
        } catch (error) {
          if (this.rpcOutcomeUnknown(error)) {
            this.markRpcOutcomePending(this.activeSessionId, error, outcomeToken);
            this.rethrowResultPending(error, "确认重命名模型");
          }
        }
      },
      bootstrap: () => this.bootstrap(),
    });
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
        // Normalize equivalent spellings while retaining canonical UNC/WSL
        // workspace identity; Windows path.resolve() preserves UNC roots.
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

  private reportSessionRelationFailure(operation: string, error: unknown): void {
    console.error(`[Pi Chat] Session relation ${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  private async forkOriginForSession(destinationSessionId: string): Promise<SessionForkOrigin | undefined> {
    let relation;
    try { relation = await this.sessionRelations.getForkOrigin(destinationSessionId); }
    catch (error) {
      this.reportSessionRelationFailure("read", error);
      return undefined;
    }
    if (!relation) return undefined;
    const runtime = this.runtimePool.get(relation.sourceSessionId);
    let source = runtime?.summarySnapshot
      || (relation.sourceSessionId === this.activeSessionId ? this.primarySummarySnapshot : undefined)
      || this.options.sessions.summaryForId(relation.sourceSessionId);
    if (!source) {
      try { source = await this.options.sessions.cachedSummaryForId(relation.sourceSessionId); }
      catch { /* An unavailable source is still valid Fork provenance. */ }
    }
    return {
      ...relation,
      sourceName: source?.name || relation.sourceName,
      sourceAvailable: Boolean(source),
    };
  }

  private async runBoundSessionCopy(input: {
    id: string;
    sourcePath: string;
    mode: "clone" | "fork";
    entryId?: string;
    runtime?: SecondaryRuntime;
    knownSessionIds: ReadonlySet<string>;
  }): Promise<{ sessionId: string; sessionPath: string; piSessionId: string; warning?: string }> {
    const rpc = input.runtime?.rpc || this.options.rpc;
    let committed: { sessionId: string; sessionPath: string; piSessionId: string; warning?: string } | null = null;
    this.copyingSessionIds.add(input.id);
    try {
      const copyResult = await executeSessionCopyRpc({
        host: {
          lateRpcOutcomeHandler: (id, token) => this.lateRpcOutcomeHandler(id, token, "copy"),
          markRpcOutcomePending: (id, error, token) => this.markRpcOutcomePending(id, error, token),
          installOutcomeFence: (id, token) => this.installRpcOutcomeFence(id, token),
          addCopyOutcomePending: (id) => this.copyOutcomePendingSessionIds.add(id),
        },
        rpc,
        sourceSessionId: input.id,
        mode: input.mode,
        entryId: input.entryId,
      });
      committed = validateCopiedSessionIdentity({
        sourcePath: input.sourcePath,
        sourceSessionId: input.id,
        sessionIdForPath: (path) => idForPath(path),
        state: copyResult.state,
        knownSessionIds: input.knownSessionIds,
        liveRuntimeIds: new Set(this.runtimePool.runtimes.keys()),
        activeSessionId: this.activeSessionId,
        cancelled: copyResult.cancelled,
        mutationOutcomeUnknown: copyResult.mutationOutcomeUnknown,
        copyMayHaveCommitted: copyResult.copyMayHaveCommitted,
        installOutcomeFence: () => this.installRpcOutcomeFence(input.id, copyResult.outcomeToken),
        mode: input.mode,
      });
      return committed;
    } finally {
      this.copyingSessionIds.delete(input.id);
      try {
        if (input.runtime) {
          input.runtime.failed = true;
          // copySession closed this Runtime's admission for the duration of
          // the attached-writer transaction; its owner may recover in place
          // before the outer finally reopens that exact generation.
          await this.runtimePool.recover(input.runtime, true);
        } else {
          await this.restartPrimaryRuntime(input.sourcePath);
        }
      } catch (error) {
        if (!committed) throw error;
        if (!input.runtime) this.primaryFailed = true;
        this.copyRecoveryPendingSessionIds.add(input.id);
        this.recordRuntimeFailure(input.id, error);
        console.error(`[Pi Chat] Session copy source recovery failed: ${error instanceof Error ? error.message : String(error)}`);
        committed.warning = "新对话已创建，但原对话恢复尚未确认；请勿重复操作";
      }
    }
  }

  private async copySession(
    id: string,
    mode: "clone" | "fork",
    persistedMessageId?: string,
  ): Promise<SessionCopyData> {
    if (
      this.copyRecoveryPendingSessionIds.has(id) ||
      this.copyProjectionPendingSessionIds.has(id) ||
      this.sessionMutationOutcomePending(id)
    )
      throw new HttpRequestError(409, "上次新对话已创建，但恢复或列表投影尚未确认；请勿重复操作");
    const releasePromptAdmission = await this.beginPromptAdmission(id);
    try {
      const knownSessions = await this.options.sessions.list();
      const knownSessionIds = new Set(knownSessions.map((session) => session.id));
      let runtime = this.runtimePool.get(id);
      const primary = id === this.activeSessionId && !runtime;
      if (!primary && !runtime) runtime = await this.ensureRuntime(id);
      const candidateSourcePath = runtime?.sessionPath
        || this.options.sessions.pathForId(id)
        || (primary ? this.lastPrimaryState.sessionFile : undefined);
      const candidateSummary = runtime?.summarySnapshot
        || this.options.sessions.summaryForId(id)
        || (primary ? this.primarySummarySnapshot || undefined : undefined);
      const target = mode === "fork"
        ? await this.options.sessions.forkTargetForId(id, persistedMessageId || "")
        : null;
      const copyPreparation = validateSessionCopyPreparation({
        mode,
        sourcePath: candidateSourcePath,
        summary: candidateSummary,
        draft: Boolean(runtime?.draftSession),
        primary,
        primaryBusy: this.primaryTurnActive()
          || this.dispatching
          || this.promptQueue.length > 0
          || this.queuePaused
          || Boolean(this.pendingExtensionRequest)
          || this.lastPrimaryState.isCompacting === true,
        secondaryBusy: Boolean(runtime && (!this.runtimePool.isIdle(runtime) || runtime.failed)),
        forkTargetAvailable: Boolean(target),
      });
      const sourcePath = copyPreparation.sourcePath;
      const summary = copyPreparation.summary;

      const operationAdmission = runtime
        ? runtime.operationAdmission
        : this.primaryOperationAdmission;
      const operationGeneration = await operationAdmission.closeAndDrain();
      if (operationGeneration === null)
        throw new HttpRequestError(409, "该会话正在休眠或切换，请刷新后重试");
      let copied;
      try {
        copied = await this.runBoundSessionCopy({
          id,
          sourcePath,
          mode,
          runtime,
          knownSessionIds,
          ...(target ? { entryId: target.entryId } : null),
        });
      } finally {
        operationAdmission.reopen(operationGeneration);
      }

      return finalizeSessionCopy({
        host: {
          now: () => this.now(),
          recordFork: (destinationSessionId, origin) => this.sessionRelations.recordFork(destinationSessionId, origin),
          reportRelationFailure: (operation, error) => this.reportSessionRelationFailure(operation, error),
          listSessions: () => this.options.sessions.list(),
          summaryForId: (sessionId) => this.options.sessions.summaryForId(sessionId),
          pathForId: (sessionId) => this.options.sessions.pathForId(sessionId),
          markProjectionPending: (sourceSessionId) => this.copyProjectionPendingSessionIds.add(sourceSessionId),
          clearOutcome: (sourceSessionId) => {
            this.copyOutcomePendingSessionIds.delete(sourceSessionId);
            this.rpcOutcomePendingBySession.delete(sourceSessionId);
            this.rpcOutcomeTokensBySession.delete(sourceSessionId);
          },
          broadcastCopied: ({ action, sessionId, sourceSessionId }) =>
            this.broadcast({ type: "pi_chat_sessions_changed", action, sessionId, sourceSessionId }),
        },
        sourceSessionId: id,
        sourceName: summary.name,
        mode,
        copied,
        ...(target ? { forkTarget: target } : null),
        ...(persistedMessageId ? { persistedMessageId } : null),
      });
    } finally {
      releasePromptAdmission();
    }
  }

  /** Test/embedding compatibility wrapper around the destructive path guard. */
  private async validatedSessionDeletePath(path: string, sessionId: string): Promise<string> {
    return validateSessionDeletePath({
      sessionRoot: () => this.options.sessions.root,
      indexedPath: (candidate) => this.options.sessions.pathForId(candidate),
    }, path, sessionId);
  }

  private async deleteSession(id: string): Promise<BootstrapData> {
    if (this.deletionOutcomePendingBySession.has(id)) {
      const fencedRuntime = this.runtimePool.get(id);
      // A prior deletion stop failed only because child exit was unconfirmed.
      // Once the same Runtime proves its child is gone, the destructive delete
      // itself has not yet run and may safely be retried.
      if (
        fencedRuntime?.admissionFenceReason === "deletion" &&
        fencedRuntime.rpc.isExitConfirmed?.()
      )
        this.deletionOutcomePendingBySession.delete(id);
      else
        throw new HttpRequestError(
          409,
          "删除结果尚未确认；请刷新对话列表核对，不要重复操作",
          "RESULT_PENDING",
          true,
        );
    }
    if (this.sessionMutationOutcomePending(id))
      throw new HttpRequestError(
        409,
        "上一次操作结果尚未确认；请刷新页面核对，不要重复执行会话操作",
        "RESULT_PENDING",
        true,
      );
    const orphanedStart = this.runtimePool.orphanedStart(id);
    if (orphanedStart) {
      try {
        await this.runtimePool.releaseOrphanedStart(id);
      } catch (error) {
        this.rethrowResultPending(error, "删除会话");
      }
    }
    await this.options.sessions.list(undefined, this.currentCwd);
    const runtime = this.runtimePool.get(id);
    const indexedPath = runtime?.sessionPath || runtime?.draftSessionPath || this.options.sessions.pathForId(id);
    const finalize = (path: string | undefined) => finalizeSessionDelete({
      getForkOrigin: (sessionId) => this.sessionRelations.getForkOrigin(sessionId),
      removeForkDestination: (sessionId) => this.sessionRelations.removeDestination(sessionId),
      restoreForkOrigin: (sessionId, origin) => this.sessionRelations.recordFork(sessionId, origin as SessionForkOrigin),
      reportRelationFailure: (operation, error) => this.reportSessionRelationFailure(operation, error),
      validateDeletePath: (candidatePath, sessionId) => validateSessionDeletePath({
        sessionRoot: () => this.options.sessions.root,
        indexedPath: (candidate) => this.options.sessions.pathForId(candidate),
      }, candidatePath, sessionId),
      clearDeletedSessionState: (sessionId) => {
        this.deletionOutcomePendingBySession.delete(sessionId);
        this.clearSessionRuntimeTransientState(sessionId, "deleted", { removeGatePreference: true });
        this.lastUserPromptAtBySession.delete(sessionId);
        this.pendingAcceptedPromptsBySession.delete(sessionId);
        this.persistedPromptIdsBySession.delete(sessionId);
        this.pendingConsumedSteersBySession.delete(sessionId);
        this.persistedSteerProjectionsBySession.delete(sessionId);
        this.nativeSteeringProjectionRevisions.delete(sessionId);
        this.runGenerationsBySession.delete(sessionId);
        this.copyOutcomePendingSessionIds.delete(sessionId);
        this.copyProjectionPendingSessionIds.delete(sessionId);
        this.sessionControl.clearSession(sessionId);
      },
      refreshSessions: async () => { await this.options.sessions.list(this.activeSessionPath, this.currentCwd); },
      broadcastDeleted: (sessionId) => this.broadcast({ type: "pi_chat_sessions_changed", action: "deleted", sessionId }),
      bootstrap: () => this.bootstrap(),
    }, id, path) as Promise<BootstrapData>;
    if (id !== this.activeSessionId && !indexedPath && !runtime) {
      // The fresh SessionIndex scan above proved that this is a stale sidebar
      // row. Delete is idempotent: retire its projections rather than showing
      // an error for a JSONL another process already removed.
      return finalize(undefined);
    }
    const deletionRuntime = await prepareSessionDeletionRuntime({
      activeSessionId: () => this.activeSessionId,
      primaryState: async () => asState(await this.options.rpc.send({ type: "get_state" }, 12_000)),
      primaryTurnActive: () => this.primaryTurnActive(),
      primaryQueueLength: () => this.promptQueue.length,
      primaryExtensionPending: () => Boolean(this.pendingExtensionRequest),
      resetPrimarySession: async () => {
        const outcomeToken = randomUUID();
        try {
          return rpcData<{ cancelled: boolean }>(
            await this.options.rpc.send(
              { type: "new_session" },
              30_000,
              { onLateResponse: this.lateRpcOutcomeHandler(id, outcomeToken, "delete") },
            ),
          );
        } catch (error) {
          if (this.rpcOutcomeUnknown(error)) {
            this.deletionOutcomePendingBySession.add(id);
            this.markRpcOutcomePending(id, error, outcomeToken);
          }
          this.rethrowResultPending(error, "删除会话");
        }
      },
      runtime: () => runtime,
      indexedSessionPath: (sessionId) => this.options.sessions.pathForId(sessionId),
      runtimeSessionPath: (candidate) => candidate.sessionPath || candidate.draftSessionPath,
      runtimeTurnActive: (candidate) => this.runtimeTurnActive(candidate),
      runtimeQueueLength: (candidate) => candidate.promptQueue.length,
      runtimeExtensionPending: (candidate) => candidate.extensionUiPending,
      releaseRuntimeForDeletion: async (sessionId) => {
        try {
          return Boolean(await this.runtimePool.releaseForDeletion(sessionId));
        } catch (error) {
          if (error instanceof RpcProcessExitUnconfirmedError)
            this.deletionOutcomePendingBySession.add(sessionId);
          this.rethrowResultPending(error, "删除会话");
        }
      },
    }, id);
    return finalize(deletionRuntime.path);
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
    snapshot: Pick<SessionFileSnapshot, "messages" | "settings" | "sourceMessageTotal" | "sourceTurnTotal" | "sourceMessagesTruncated" | "usageComplete"> & { usage?: SessionUsageSnapshot },
    turnLimit: number,
    clientId: string,
  ): SessionViewData {
    this.reconcilePendingAcceptedPrompts(id, snapshot.messages);
    return projectColdSessionView({
      modelFromSettings: (settings) => this.modelFromSessionSettings(settings),
      sessionActivity: (sessionId) => this.sessionActivity(sessionId),
      offlineStats: (sessionId, usage) => this.offlineStatsFromUsage(sessionId, usage),
      currentGateMode: (sessionId) => this.currentGateMode(sessionId),
      pendingRequest: (sessionId) => this.pendingRequestForSession(sessionId),
      controlState: (sessionId, browserId) => this.controlState(sessionId, browserId),
    }, { id, session, snapshot, turnLimit, clientId });
  }

  private hotMemoryView(
    id: string,
    turnLimit: number,
    clientId: string,
  ): SessionViewData | null {
    const runtime = id === this.activeSessionId ? null : this.runtimePool.get(id);
    const primary = id === this.activeSessionId && this.primaryReadReady();
    if (!runtime && !primary) return null;
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
      ? this.lastPrimaryMessagesSessionId === id ? this.lastPrimaryMessages : undefined
      : runtime!.messageSnapshot;
    const tail = primary
      ? this.primaryPendingTerminalSessionId === id ? this.primaryPendingTerminalMessages : []
      : runtime!.pendingTerminalMessages;
    const state = this.stateWithPendingPromptSettings(
      id,
      primary ? this.lastPrimaryState : runtime!.lastState || { model: null, isStreaming: runtime!.running },
    );
    const streaming = primary
      ? this.primaryTurnActive()
      : this.runtimeTurnActive(runtime!) || runtime!.dispatching;
    return projectHotMemoryView({
      modelFromSettings: (settings) => this.modelFromSessionSettings(settings),
      sessionActivity: (sessionId) => this.sessionActivity(sessionId),
      offlineStats: (sessionId, usage) => this.offlineStatsFromUsage(sessionId, usage),
      currentGateMode: (sessionId) => this.currentGateMode(sessionId),
      pendingRequest: (sessionId) => this.pendingRequestForSession(sessionId),
      controlState: (sessionId, browserId) => this.controlState(sessionId, browserId),
      touch: (sessionId) => { const target = this.runtimePool.get(sessionId); if (target) this.runtimePool.touch(target); },
      reconcilePendingPrompts: (sessionId, messages) => this.reconcilePendingAcceptedPrompts(sessionId, messages),
      pendingPrompt: (sessionId) => this.pendingPromptForSession(sessionId),
      pendingSteers: (sessionId) => this.pendingSteerProjection(sessionId),
      stateWithPendingPromptSettings: (sessionId, next) => this.stateWithPendingPromptSettings(sessionId, next),
      stateWithFastMode: (sessionId, next) => this.stateWithFastMode(sessionId, next),
    }, {
      id,
      turnLimit,
      clientId,
      primary,
      source: {
        summary,
        persisted,
        terminalTail: tail,
        state,
        streaming,
        liveMessage: primary ? this.liveMessage : runtime!.liveMessage,
        toolStatus: primary ? this.toolStatus : runtime!.toolStatus,
        stats: primary
          ? this.lastPrimaryStats?.sessionId === id ? this.lastPrimaryStats.value : undefined
          : runtime!.lastStats,
        queue: primary ? this.publicQueue() : this.publicQueue(runtime!.promptQueue),
        queuePaused: primary ? this.queuePaused : runtime!.queuePaused,
        commands: primary
          ? this.lastPrimaryCommands.length ? [...BUILTIN_COMMANDS, ...this.lastPrimaryCommands] : undefined
          : runtime!.commands?.length ? [...BUILTIN_COMMANDS, ...runtime!.commands] : undefined,
        gateMode: primary ? this.primaryGateMode : runtime!.gateMode,
        historyPending: !persisted,
        reconcilePending: !persisted || tail.length > 0 || (primary
          ? this.lastPrimaryStats?.sessionId !== id
          : !runtime!.statsKnown || !runtime!.commandsKnown),
      },
    });
  }

  private async coldSessionViewForId(
    id: string,
    turnLimit: number,
    clientId: string,
    includeForkOrigin = false,
  ): Promise<SessionViewData | null> {
    return readColdSessionView({
      index: this.options.sessions,
      activeSessionPath: () => this.activeSessionPath,
      currentCwd: () => this.currentCwd,
      projectSnapshot: (sessionId, session, snapshot, limit, browserId) =>
        this.coldSessionViewFromSnapshot(sessionId, session, snapshot, limit, browserId),
      projectMessages: (sessionId, session, limit, browserId) =>
        this.coldSessionView(sessionId, session, limit, browserId),
      forkOrigin: (sessionId) => this.forkOriginForSession(sessionId),
    }, id, turnLimit, clientId, includeForkOrigin);
  }

  private async sessionView(
    id: string,
    turnLimit = RECENT_TURN_WINDOW_SIZE,
    clientId = "",
    options: { fast?: boolean; includeForkOrigin?: boolean } = {},
  ): Promise<SessionViewData | null> {
    return readSessionView({
      isPrimary: (sessionId) => sessionId === this.activeSessionId,
      secondaryExists: (sessionId) => this.runtimePool.has(sessionId),
      acquirePrimary: () => {
        const lease = this.primaryOperationAdmission.acquire();
        return { ...lease, rpcGeneration: this.options.rpc.currentGeneration?.() || 0 };
      },
      primaryCurrent: (sessionId, lease) =>
        this.activeSessionId === sessionId
        && this.primaryOperationAdmission.generation === lease.generation
        && (this.options.rpc.currentGeneration?.() || 0) === lease.rpcGeneration
        && this.options.rpc.isRunning?.() !== false,
      acquireSecondary: (sessionId) => {
        const runtime = this.runtimePool.get(sessionId)!;
        const release = this.runtimePool.acquireOperation(runtime);
        return {
          generation: runtime.operationAdmission.generation,
          rpcGeneration: runtime.rpc.currentGeneration?.() || 0,
          release,
        };
      },
      secondaryCurrent: (sessionId, lease) => {
        const runtime = this.runtimePool.get(sessionId);
        return Boolean(
          runtime
          && runtime.operationAdmission.generation === lease.generation
          && (runtime.rpc.currentGeneration?.() || 0) === lease.rpcGeneration
          && runtime.rpc.isRunning?.() !== false,
        );
      },
      hotView: (sessionId, limit, browserId) => this.hotMemoryView(sessionId, limit, browserId),
      currentProjection: (sessionId, limit, browserId, assertCurrent) =>
        this.sessionViewFromCurrentProjection(sessionId, limit, browserId, assertCurrent),
      coldView: (sessionId, limit, browserId, includeForkOrigin) =>
        this.coldSessionViewForId(sessionId, limit, browserId, includeForkOrigin),
      forkOrigin: (sessionId) => this.forkOriginForSession(sessionId),
    }, id, turnLimit, clientId, options);
  }

  private async sessionViewFromCurrentProjection(
    id: string,
    turnLimit = RECENT_TURN_WINDOW_SIZE,
    clientId = "",
    assertCurrentHotRuntime?: () => void,
  ): Promise<SessionViewData | null> {
    const owner = this;
    return sessionViewFromCurrentProjection({
      index: this.options.sessions,
      primaryRpc: this.options.rpc,
      builtinCommands: BUILTIN_COMMANDS,
      secondaryForId: (sessionId) => this.runtimePool.get(sessionId),
      touchSecondary: (runtime) => this.runtimePool.touch(runtime),
      get activeSessionId() { return owner.activeSessionId; },
      get activeSessionPath() { return owner.activeSessionPath; },
      get applicationLifecycle() { return owner.applicationLifecycle; },
      get currentCwd() { return owner.currentCwd; },
      get primaryRpcGeneration() { return owner.primaryRpcGeneration; },
      get lastPrimaryState() { return owner.lastPrimaryState; },
      set lastPrimaryState(state) { owner.lastPrimaryState = state; },
      get running() { return owner.running; },
      set running(running) { owner.running = running; },
      get primarySummarySnapshot() { return owner.primarySummarySnapshot; },
      set primarySummarySnapshot(summary) { owner.primarySummarySnapshot = summary; },
      get liveMessage() { return owner.liveMessage; },
      get toolStatus() { return owner.toolStatus; },
      get lastPrimaryMessagesSessionId() { return owner.lastPrimaryMessagesSessionId; },
      set lastPrimaryMessagesSessionId(id) { owner.lastPrimaryMessagesSessionId = id; },
      get lastPrimaryMessages() { return owner.lastPrimaryMessages; },
      set lastPrimaryMessages(messages) { owner.lastPrimaryMessages = messages; },
      get primaryPendingTerminalSessionId() { return owner.primaryPendingTerminalSessionId; },
      get primaryPendingTerminalMessages() { return owner.primaryPendingTerminalMessages; },
      set primaryPendingTerminalMessages(messages) { owner.primaryPendingTerminalMessages = messages; },
      get lastPrimaryCommands() { return owner.lastPrimaryCommands; },
      get primaryGateMode() { return owner.primaryGateMode; },
      get queuePaused() { return owner.queuePaused; },
      now: () => this.now(),
      primaryTurnActive: () => this.primaryTurnActive(),
      runtimeTurnActive: (runtime) => this.runtimeTurnActive(runtime),
      primaryReadReady: () => this.primaryReadReady(),
      bindPrimaryIdentity: (state) => this.bindPrimaryIdentity(state),
      coldSessionViewForId: (id, limit, client) => this.coldSessionViewForId(id, limit, client),
      coldSessionView: (id, session, limit, client) => this.coldSessionView(id, session, limit, client),
      sessionSummaries: (sessions, client) => this.sessionSummaries(sessions, client),
      reconcilePendingAcceptedPrompts: (id, messages) => this.reconcilePendingAcceptedPrompts(id, messages),
      pendingPromptForSession: (id) => this.pendingPromptForSession(id),
      pendingSteerProjection: (id) => this.pendingSteerProjection(id),
      statsForSession: (id, response) => this.statsForSession(id, response),
      offlineStatsForId: (id, usage) => this.offlineStatsForId(id, usage),
      stateWithFastMode: (id, state) => this.stateWithFastMode(id, state),
      stateWithPendingPromptSettings: (id, state) => this.stateWithPendingPromptSettings(id, state),
      sessionActivity: (id) => this.sessionActivity(id),
      controlState: (id, client) => this.controlState(id, client),
      publicQueue: (queue) => this.publicQueue(queue),
      pendingRequestForSession: (id) => this.pendingRequestForSession(id),
    }, id, turnLimit, clientId, assertCurrentHotRuntime);
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
    knownUsage?: SessionUsageSnapshot,
  ): Promise<SessionStats> {
    const live = asSessionStats(response);
    const fallback = await this.offlineStatsForId(id, knownUsage);
    const contextUsage = live.contextUsage || fallback?.contextUsage;
    return {
      ...live,
      ...(contextUsage ? { contextUsage } : {}),
      ...(fallback?.contextUsagePendingRefresh
        ? { contextUsagePendingRefresh: true }
        : {}),
    };
  }

  private async bootstrap(clientId = "", coherenceRetry = 0): Promise<BootstrapData> {
    const owner = this;
    const bootstrapPorts: any = {
      options: this.options,
      builtinCommands: BUILTIN_COMMANDS,
      get activeSessionId() { return owner.activeSessionId; },
      get activeSessionPath() { return owner.activeSessionPath; },
      get applicationLifecycle() { return owner.applicationLifecycle; },
      get primaryFailed() { return owner.primaryFailed; },
      get lastPrimaryState() { return owner.lastPrimaryState; },
      set lastPrimaryState(state) { owner.lastPrimaryState = state; },
      get running() { return owner.running; },
      set running(value) { owner.running = value; },
      get primaryBoundSessionId() { return owner.primaryBoundSessionId; },
      get primaryRpcGeneration() { return owner.primaryRpcGeneration; },
      get lastAvailableModels() { return owner.lastAvailableModels; },
      set lastAvailableModels(value) { owner.lastAvailableModels = value; },
      get lastPrimaryMessagesSessionId() { return owner.lastPrimaryMessagesSessionId; },
      set lastPrimaryMessagesSessionId(value) { owner.lastPrimaryMessagesSessionId = value; },
      get lastPrimaryMessages() { return owner.lastPrimaryMessages; },
      set lastPrimaryMessages(value) { owner.lastPrimaryMessages = value; },
      get primaryPendingTerminalSessionId() { return owner.primaryPendingTerminalSessionId; },
      get primaryPendingTerminalMessages() { return owner.primaryPendingTerminalMessages; },
      set primaryPendingTerminalMessages(value) { owner.primaryPendingTerminalMessages = value; },
      get primarySummarySnapshot() { return owner.primarySummarySnapshot; },
      set primarySummarySnapshot(value) { owner.primarySummarySnapshot = value; },
      get lastPrimaryStats() { return owner.lastPrimaryStats; },
      set lastPrimaryStats(value) { owner.lastPrimaryStats = value; },
      get lastPrimaryCommands() { return owner.lastPrimaryCommands; },
      set lastPrimaryCommands(value) { owner.lastPrimaryCommands = value; },
      get primaryGateMode() { return owner.primaryGateMode; },
      get queuePaused() { return owner.queuePaused; },
      get liveMessage() { return owner.liveMessage; },
      get toolStatus() { return owner.toolStatus; },
      get modelRuntimeSyncPending() { return owner.modelRuntimeSyncPending; },
      set modelRuntimeSyncPending(value) { owner.modelRuntimeSyncPending = value; },
      get modelCatalogueRevision() { return owner.modelCatalogueRevision; },
      get workspaceRevision() { return owner.workspaceRevision; },
      get startupModels() { return owner.startupModels; },
      currentCwd: this.currentCwd,
      runEpoch: this.runEpoch,
      buildIdentity: this.buildIdentity,
      primaryReadiness: () => this.primaryReadiness(),
      primaryTurnActive: () => this.primaryTurnActive(),
      bindPrimaryIdentity: (state: any) => this.bindPrimaryIdentity(state),
      rememberModelContextWindows: (models: any) => this.rememberModelContextWindows(models),
      modelRouteKey: (model: any) => this.modelRouteKey(model),
      mergeHostAndRuntimeModels: (models: any, startup: any) => this.mergeHostAndRuntimeModels(models, startup),
      statsForSession: (id: string, response: any, usage: any) => this.statsForSession(id, response, usage),
      offlineStatsFromUsage: (id: string, usage: any) => this.offlineStatsFromUsage(id, usage),
      offlineStatsForId: (id: string) => this.offlineStatsForId(id),
      reconcilePendingAcceptedPrompts: (id: string, messages: any) => this.reconcilePendingAcceptedPrompts(id, messages),
      pendingPromptForSession: (id: string) => this.pendingPromptForSession(id),
      pendingSteerProjection: (id: string) => this.pendingSteerProjection(id),
      sidebarSessions: (sessions: any, client: string) => this.sidebarSessions(sessions, client),
      sessionActivity: (id: string) => this.sessionActivity(id),
      controlState: (id: string, client: string) => this.controlState(id, client),
      stateWithFastMode: (id: string, state: any) => this.stateWithFastMode(id, state),
      stateWithPendingPromptSettings: (id: string, state: any) => this.stateWithPendingPromptSettings(id, state),
      publicQueue: () => this.publicQueue(),
      pendingRequestForSession: (id: string) => this.pendingRequestForSession(id),
      activeSessionIds: () => this.activeSessionIds(),
      forkOriginForSession: (id: string) => this.forkOriginForSession(id),
      lifecycleMessage: () => this.lifecycleMessage(),
      bootstrap: (id: string, retry: number) => this.bootstrap(id, retry),
    };
    return bootstrapPrimary(bootstrapPorts, clientId, coherenceRetry);
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
      if (error instanceof RuntimeStartupError) {
        const incident = report("failed", error.code);
        return json(response, 503, {
          error: error.message,
          code: error.code,
          retryable: true,
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
      if (this.rpcOutcomeUnknown(error)) {
        const incident = report("rejected", "RESULT_PENDING");
        return json(response, 409, {
          error: "操作结果尚未确认；请刷新页面核对，不要重复操作",
          code: "RESULT_PENDING",
          retryable: true,
          outcomeUnknown: true,
          incidentId: incident.incidentId,
        });
      }
      if (error instanceof HttpRequestError) {
        const incident = report("rejected", error.code);
        return json(response, error.status, {
          error: error.message,
          code: error.code,
          ...(error.retryable ? { retryable: true } : null),
          ...(error.outcomeUnknown ? { outcomeUnknown: true } : null),
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
        const releaseMutation = admission.acquireMutationLeaseAfterBody === false
          ? null
          : this.beginMutation();
        try {
          await this.handleApiCore(request, response, url, body);
        } finally {
          releaseMutation?.();
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

  private async workspaceCwdForSession(sessionId: string): Promise<string | null> {
    // Files is a cold persisted-Session surface. Runtime membership alone is
    // not persistence proof: an empty Primary or Secondary draft must remain
    // unavailable until SessionIndex observes its first durable turn.
    const summary = this.options.sessions.summaryForId?.(sessionId)
      || await this.options.sessions.cachedSummaryForId(sessionId);
    return summary?.cwd ? resolve(summary.cwd) : null;
  }

  private async workspaceRecentFilesRoute(input: { sessionId: string }): Promise<unknown | null> {
    const cwd = await this.workspaceCwdForSession(input.sessionId);
    if (!cwd) return null;
    const snapshot = await this.options.sessions.snapshotForId(input.sessionId);
    return snapshot ? recentModifiedWorkspaceFiles(snapshot.messages, cwd) : null;
  }

  private async workspaceRecentFileContext(
    input: { sessionId: string; path: string },
  ): Promise<{ cwd: string; path: string } | null> {
    const cwd = await this.workspaceCwdForSession(input.sessionId);
    if (!cwd) return null;
    const snapshot = await this.options.sessions.snapshotForId(input.sessionId);
    if (!snapshot) return null;
    const path = normalizeWorkspaceRelativePath(input.path);
    if (!recentModifiedWorkspaceFiles(snapshot.messages, cwd).files.some((file) => file.path === path))
      throw new HttpRequestError(404, "文件不在当前对话的最近修改列表中");
    return { cwd, path };
  }

  private async workspaceLinkedFileContext(
    input: { sessionId: string; path: string },
  ): Promise<{ cwd: string; path: string } | null> {
    const cwd = await this.workspaceCwdForSession(input.sessionId);
    if (!cwd) return null;
    const snapshot = await this.options.sessions.snapshotForId(input.sessionId);
    if (!snapshot) return null;
    const path = normalizeWorkspaceRelativePath(input.path);
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (!assistantLinkedWorkspaceFiles(snapshot.messages, cwd).has(key))
      throw new HttpRequestError(404, "文件链接不在当前对话的已保存回复中");
    return { cwd, path };
  }

  private async workspaceFileRoute(input: { sessionId: string; path: string }): Promise<unknown | null> {
    const context = await this.workspaceRecentFileContext(input);
    return context ? readWorkspaceFile(context.cwd, context.path) : null;
  }

  private async openValidatedWorkspaceFile(context: { cwd: string; path: string }): Promise<{ ok: true; path: string }> {
    if (!isSafeDefaultApplicationFile(context.path))
      throw new HttpRequestError(409, "为安全起见，此文件类型不能直接打开");
    const target = await workspaceFileTargetPath(context.cwd, context.path);
    const verifyTarget = () => workspaceFileTargetPath(context.cwd, context.path);
    if (this.options.openLocalFile) await this.options.openLocalFile(target, verifyTarget);
    else await openWithDefaultApplication(target, verifyTarget);
    return { ok: true, path: context.path };
  }

  private async workspaceOpenFileRoute(input: { sessionId: string; path: string }): Promise<unknown | null> {
    const context = await this.workspaceRecentFileContext(input);
    if (!context) return null;
    // Re-validate the exact preview contract at click time before asking the OS
    // to open anything; direct API callers cannot bypass text/symlink checks.
    await readWorkspaceFile(context.cwd, context.path);
    return this.openValidatedWorkspaceFile(context);
  }

  private async workspaceOpenLinkedFileRoute(input: { sessionId: string; path: string }): Promise<unknown | null> {
    const context = await this.workspaceLinkedFileContext(input);
    return context ? this.openValidatedWorkspaceFile(context) : null;
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
    const running = target.status === "running";
    const attention = target.status === "attention";
    const execution: SessionActivityState["execution"] = running
      ? "running"
      : attention
        ? "paused"
        : target.status === "waiting"
          ? "queued"
          : target.status === "failed"
            ? "failed"
            : "idle";
    const activity: SessionActivityState = {
      execution,
      awaitingConfirmation: attention,
      ...(running ? { runStartedAt: target.startedAt } : null),
      ...(!running && ["complete", "failed", "cancelled"].includes(target.status)
        ? { lastRunDurationMs: target.elapsedMs }
        : null),
    };
    const liveView: SessionViewData = {
      ...view,
      session: {
        ...view.session,
        running,
        queued: target.status === "waiting",
        activity,
      },
      state: { ...view.state, isStreaming: running },
      isStreaming: running,
      ...(target.activity || running ? { toolStatus: target.activity || "正在运行" } : null),
    };
    this.traceViewProjection(
      "subagent-session-view",
      input.childSessionId,
      liveView,
    );
    return liveView;
  }

  private async sessionViewRoute(input: {
    sessionId: string;
    clientId: string;
    turns: number;
    fast: boolean;
  }): Promise<SessionViewData | null> {
    // Reading a cold history is deliberately view-only; no Runtime is created.
    // Hot views retain their operation lease through Fork-origin lookup so an
    // awaited relation read cannot outlive the Runtime projection it decorates.
    const projected = await this.sessionView(
      input.sessionId,
      input.turns,
      input.clientId,
      { fast: input.fast, includeForkOrigin: true },
    );
    this.traceViewProjection(
      input.fast ? "session-view-fast" : "session-view",
      input.sessionId,
      projected,
    );
    return projected;
  }

  private async handleApiCore(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    preparedBody?: Record<string, unknown>,
  ): Promise<void> {
    const clientId = requestClientId(request);
    if (
      await handleDiagnosticsReadRoute(
        {
          isRegisteredWindowPage: (client, page) => this.connectedPageClients.get(page) === client,
          checkpoint: () => this.streamDiagnostics.checkpoint(),
          snapshot: () => this.stateDiagnostics.snapshot(),
        },
        request,
        response,
        url,
      )
    )
      return;
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
      await handleWorkspaceOpenRoute(
        {
          openWorkspaceFile: (input) => this.workspaceOpenFileRoute(input),
          openLinkedWorkspaceFile: (input) => this.workspaceOpenLinkedFileRoute(input),
        },
        request,
        response,
        url,
        preparedBody,
      )
    )
      return;
    if (
      await handleWorkspaceReadRoute(
        {
          workspaceRecentFiles: (input) => this.workspaceRecentFilesRoute(input),
          workspaceFile: (input) => this.workspaceFileRoute(input),
        },
        request,
        response,
        url,
      )
    )
      return;
    if (
      await handleResourcesReadRoute(
        {
          resources: this.options.resources,
          primaryRuntimeCwd: () => this.primaryRuntimeCwd,
        },
        request,
        response,
        url,
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

    if (
      await handleWindowControlRoute(
        {
          assertIdle: () => {
            if (this.applicationLifecycle !== "idle")
              throw new ApplicationLifecycleConflictError(
                this.applicationLifecycle,
                this.lifecycleMessage(),
              );
          },
          isConnectedWindowPage: (client, page) => this.isConnectedWindowPage(client, page),
          noteClientPresence: (client, page, revision, foreground) =>
            foreground
              ? this.sessionControl.noteClientPresence(client, page, revision)
              : this.sessionControl.noteClientBackground(client, page, revision),
          isClientPresent: (client) => this.sessionControl.isClientPresent(client),
          closeWindowClient: (client, page) => this.closeWindowClient(client, page),
          openWindowCount: () => this.openWindowCount(),
          activeMutationRequests: () => this.activeMutationRequests,
          runtimeStartingCount: () => this.runtimePool.startingCount,
          restSessionAfterWindowClose: (sessionId) => this.restSessionAfterWindowClose(sessionId),
          scheduleLastWindowShutdown: () => this.scheduleLastWindowShutdown(),
          lastWindowAutoShutdownEnabled: () => this.lastWindowAutoShutdownEnabled,
          applicationShutdownAvailable: () => Boolean(this.options.applicationShutdown),
        },
        request,
        response,
        url,
      )
    )
      return;

    if (
      await handleLifecycleControlRoute(
        {
          applicationShutdownAvailable: () => Boolean(this.options.applicationShutdown),
          applicationRestartAvailable: () => Boolean(this.options.applicationRestart),
          isConnectedWindowPage: (client, page) => this.isConnectedWindowPage(client, page),
          beginLifecycle: (lifecycle) => this.beginLifecycle(lifecycle),
          endLifecycle: (lifecycle) => this.endLifecycle(lifecycle),
          verifyApplicationQuiescent: (reason) => this.verifyApplicationQuiescent(reason),
          broadcast: (event) => this.broadcast(event),
          shutdown: (reason) => this.options.applicationShutdown?.(reason as ApplicationShutdownReason),
          restart: () => this.options.applicationRestart!(),
          reportIncident: (error, input) => this.reportIncident(
            error,
            input as Parameters<PiChatApp["reportIncident"]>[1],
          ),
        },
        request,
        response,
        url,
      )
    )
      return;

    if (
      await handleLocalFilesWorkspaceRoute(
        {
          pickLocalFiles: () => pickLocalFiles(),
          readClipboardFiles: (files) => readClipboardFiles(files),
          pickWorkspaceFolder: (cwd) => (this.options.pickWorkspaceFolder || pickWorkspaceFolder)(cwd),
          currentCwd: () => this.currentCwd,
        },
        request,
        response,
        url,
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
      this.sseHub.add(response, clientId, {
        streamingDelta: url.searchParams.get("stream") === "delta-v1",
      });
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

    if (url.pathname === "/api/chat/steers/dequeue") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || (await bodyJson(request));
      const requestedSessionId = requiredSessionId(body);
      const result = await dequeueNativeSteering(
        {
          beginPromptAdmission: (sessionId) => this.beginPromptAdmission(sessionId),
          resolveTarget: (sessionId) => {
            const requestedIsPrimary = Boolean(this.activeSessionId) && sessionId === this.activeSessionId;
            const runtime = requestedIsPrimary ? null : this.runtimePool.get(sessionId) || null;
            if (!requestedIsPrimary && !runtime) return null;
            return {
              rpc: runtime?.rpc || this.options.rpc,
              generation: requestedIsPrimary ? this.primaryRpcGeneration : (runtime?.rpcGeneration || 0),
              releaseRuntimeAdmission: runtime
                ? this.runtimePool.acquireOperation(runtime)
                : this.primaryOperationAdmission.acquire().release,
            };
          },
          completed: (dequeueId) => this.nativeSteeringDequeueResults.get(dequeueId),
          settle: (sessionId, dequeueId, items, generation) => this.settleNativeSteeringDequeue(
            sessionId,
            { dequeueId, steering: items },
            generation,
          ),
          forget: (dequeueId) => this.nativeSteeringDequeueResults.delete(dequeueId),
        },
        requestedSessionId,
      );
      return json(response, 200, result);
    }

    if (url.pathname === "/api/chat/prompt") {
      const promptHost = new Proxy(this as any, {
        get: (target, property) => Reflect.get(target, property, target),
        set: (target, property, value) => Reflect.set(target, property, value, target),
      });
      Object.assign(promptHost, {
        PROMPT_BODY_LIMIT,
        PROMPT_PREPARE_TIMEOUT_MS,
        MAX_NATIVE_STEERING,
        MAX_NATIVE_STEERING_IMAGE_CHARS,
        MAX_PENDING_PROMPT_BASELINE_IDS,
        gateModeFromCommand,
      });
      await handlePromptRoute(promptHost, request, response, url, preparedBody);
      return;
    }

    if (
      await handleQueueControlRoute(
        {
          target: (sessionId) => {
            const runtime = this.runtimePool.get(sessionId);
            if (runtime)
              return {
                queue: runtime.promptQueue,
                getPaused: () => runtime.queuePaused,
                setPaused: (paused) => { runtime.queuePaused = paused; },
                touch: () => this.runtimePool.touch(runtime),
                recover: this.secondaryNeedsRecovery(runtime)
                  ? () => this.recoverRuntime(runtime)
                  : undefined,
                dispatch: () => { void this.dispatchRuntimeNext(runtime); },
              };
            if (sessionId !== this.activeSessionId) return null;
            return {
              queue: this.promptQueue,
              getPaused: () => this.queuePaused,
              setPaused: (paused) => { this.queuePaused = paused; },
              touch: () => {},
              dispatch: () => { void this.dispatchNext(); },
            };
          },
          publicQueue: (queue) => this.publicQueue(queue),
          traceCancelled: (sessionId, queueId) =>
            this.tracePrompt("cancelled", sessionId, queueId),
          broadcastQueue: (sessionId) => this.broadcastQueue(sessionId),
        },
        request,
        response,
        url,
        preparedBody,
      )
    ) return;

    if (
      await handleWorkspaceControlRoute(
        {
          currentCwd: () => this.currentCwd,
          pickWorkspaceFolder: (cwd) =>
            (this.options.pickWorkspaceFolder || pickWorkspaceFolder)(cwd),
          changeWorkspace: (path) => this.changeWorkspace(path),
          bootstrap: () => this.bootstrap(),
        },
        request,
        response,
        url,
        preparedBody,
      )
    ) return;

    if (url.pathname === "/api/chat/compact") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || (await bodyJson(request));
      const sessionId = requiredSessionId(body);
      const customInstructions =
        typeof body.customInstructions === "string"
          ? body.customInstructions.trim()
          : "";
      await this.compactSession(sessionId, customInstructions, (result) => {
        if (result.kind === "conflict")
          json(response, 409, {
            error: result.error,
            ...(result.code ? { code: result.code } : null),
          });
        else json(response, 200, { result: result.result });
      });
      return;
    }

    if (url.pathname === "/api/chat/abort") {
      if (request.method !== "POST") return methodNotAllowed(response);
      const body = preparedBody || (await bodyJson(request));
      const sessionId = requiredSessionId(body);
      const runtime = this.runtimePool.get(sessionId);
      if (runtime) {
        await this.abortSecondaryRuntime(sessionId, runtime, (result) =>
          json(response, 200, result),
        );
        return;
      }
      if (sessionId !== this.activeSessionId)
        return json(response, 409, { error: "该会话不是活动运行会话" });
      await this.abortPrimaryRuntime(sessionId, (result) => json(response, 200, result));
      return;
    }

    if (
      await handleSessionMutationsRoute(
        {
          requireSessionControl: (sessionId, client) => this.requireSessionControl(sessionId, client),
          beginPromptAdmission: (sessionId) => this.beginPromptAdmission(sessionId),
          renameSession: (sessionId, name) => renameSession({
            sessionMutationOutcomePending: (id) => this.sessionMutationOutcomePending(id),
            activeSessionId: () => this.activeSessionId,
            knownRuntime: (id) => this.runtimePool.get(id),
            ensureRuntime: (id) => this.ensureRuntime(id),
            primaryRpc: () => this.options.rpc,
            acquireRuntimeOperation: (runtime) => this.runtimePool.acquireOperation(runtime),
            acquirePrimaryOperation: () => this.primaryOperationAdmission.acquire().release,
            lateRpcOutcomeHandler: (id, token) => this.lateRpcOutcomeHandler(id, token, "generic"),
            markRpcOutcomePending: (id, error, token) => this.markRpcOutcomePending(id, error, token),
            rethrowResultPending: (error, operation) => this.rethrowResultPending(error, operation),
            clearNativeSteeringState: (id, reason) => this.clearNativeSteeringState(id, reason),
            reclaimRuntime: (id) => this.runtimePool.reclaim(id, "idle").then(() => undefined),
            persistForkNameOverride: async (id, name) => {
              const applied = await this.sessionRelations.setNameOverride(id, name);
              if (applied) this.options.sessions.applyForkNameOverride(id, name);
            },
            updateRuntimeName: (id, name) => {
              if (id === this.activeSessionId && this.primarySummarySnapshot)
                this.primarySummarySnapshot = { ...this.primarySummarySnapshot, name };
              else {
                const runtime = this.runtimePool.get(id);
                if (runtime?.summarySnapshot)
                  runtime.summarySnapshot = { ...runtime.summarySnapshot, name };
              }
            },
            broadcastRenamed: (id) => this.broadcast({ type: "pi_chat_sessions_changed", action: "renamed", sessionId: id }),
          }, sessionId, name),
          deleteSession: (sessionId) => this.deleteSession(sessionId),
          copySession: (sessionId, mode, persistedMessageId) =>
            this.copySession(sessionId, mode, persistedMessageId),
        },
        request,
        response,
        url,
        clientId,
        preparedBody,
      )
    )
      return;

    if (
      await handleSessionRuntimeControlRoute(
        {
          activeSessionId: () => this.activeSessionId,
          runtimeExists: (sessionId) => this.runtimePool.has(sessionId),
          runtimeCanReclaim: (sessionId) => {
            const runtime = this.runtimePool.get(sessionId);
            return Boolean(runtime && this.runtimePool.canReclaim(runtime));
          },
          sweepRuntimes: () => { void this.runtimePool.sweep(); },
          clearViewed: (client, sessionId) => this.sessionControl.clearViewed(client, sessionId),
          knownSession: async (sessionId) => Boolean(
            (await (this.options.sessions as SessionIndex).cachedSummaryForId?.(sessionId))
            || this.options.sessions.summaryForId?.(sessionId)
            || (await this.options.sessions.list(undefined, this.currentCwd)).some((session) => session.id === sessionId),
          ),
          markViewed: (client, sessionId) => this.markSessionViewed(client, sessionId),
          touchRuntime: (sessionId) => { const runtime = this.runtimePool.get(sessionId); if (runtime) this.runtimePool.touch(runtime); },
          ensurePrimaryIdentity: () => this.ensurePrimaryIdentity(),
          ensurePrimaryRuntime: () => this.ensurePrimaryRuntime(),
          ensureSecondaryRuntime: async (sessionId) => { await this.ensureRuntime(sessionId); },
          primaryReady: (sessionId) => ({
            sessionId,
            state: this.stateWithFastMode(sessionId, { ...this.lastPrimaryState, isStreaming: this.primaryTurnActive() }),
            gateMode: this.primaryGateMode,
          }),
          secondaryReady: (sessionId) => this.runtimeReady(this.runtimePool.get(sessionId)!),
          sessionView: (sessionId, browserId) => this.sessionView(sessionId, RECENT_TURN_WINDOW_SIZE, browserId),
          rethrowResultPending: (error, operation, fence = true) => this.rethrowResultPending(error, operation, fence),
        },
        request,
        response,
        url,
      )
    ) return;

    if (await handleNewSessionRoute({
      currentCwd: () => this.currentCwd,
      primaryNeedsRecovery: () => this.primaryNeedsRecovery(),
      waitForPrimaryCompatibility: () => this.waitForNewDraftPrimaryCompatibility(),
      acquireDraft: (owner, cwd) => this.acquireDraftRuntime(owner, cwd),
      rethrowResultPending: (error, operation) => this.rethrowResultPending(error, operation, false),
      markViewed: (owner, sessionId) => this.markSessionViewed(owner, sessionId),
      draftView: (runtime, owner) => this.draftSessionView(runtime, owner),
      beginPromptAdmission: (sessionId) => this.beginPromptAdmission(sessionId),
      firstTurn: async (runtime, input) => {
        const initialAbortGeneration = runtime.abortGeneration;
        const promptAt = this.nextUserPromptAt();
        const initialSettings: PromptSettingsSnapshot = input.settings || {};
        const result = await dispatchNewDraftFirstTurn({
          requireControl: () => this.requireSessionControl(runtime.id, clientId),
          applySettings: () => this.applyTurnSettings(runtime.rpc, initialSettings, runtime.id),
          isPartialSettingsError: (error): error is PartialTurnSettingsError => error instanceof PartialTurnSettingsError,
          rememberPartialSettings: (applied) => this.rememberRuntimeAppliedTurnSettings(runtime, applied),
          rememberSettings: (applied) => this.rememberRuntimeAppliedTurnSettings(runtime, applied),
          assertCurrent: () => {
            if (initialAbortGeneration !== runtime.abortGeneration || this.applicationLifecycle !== "idle")
              throw new Error("消息发送已取消");
          },
          extensionCommand: (message) => this.extensionCommand(message, runtime.rpc),
          syncGate: () => this.syncGateMode(runtime.rpc, runtime.id, input.gateMode),
          setRunning: (running) => { runtime.running = running; },
          traceAdmitted: (id) => this.tracePrompt("admitted", runtime.id, id),
          broadcastActivity: () => this.broadcastSessionActivity(runtime.id),
          sendPrompt: (message, images, promptId) => this.sendPromptRpc(runtime.rpc, runtime.id, promptId, {
            type: "prompt", message, ...(images.length ? { images } : {}),
          }).then(() => undefined),
          sendExtensionPrompt: async (message) => { await runtime.rpc.send({ type: "prompt", message }, PROMPT_PREPARE_TIMEOUT_MS); },
          readState: async () => asState(await runtime.rpc.send({ type: "get_state" })),
          adoptExtensionState: async (state) => {
            runtime.lastState = state;
            runtime.running = state.isStreaming;
            runtime.prompted = true;
            this.noteUserPrompt(runtime.id, promptAt);
            await this.finalizePersistedDraft(runtime);
          },
          noteUserPrompt: () => this.noteUserPrompt(runtime.id, promptAt),
          notifyPromptAccepted: (id) => this.scheduler.notifySecondaryPromptAccepted(runtime, promptAt, input.message, input.images, initialSettings, id, input.clientPromptOperationId || undefined),
          traceDeliveryUncertain: (id) => this.tracePrompt("delivery-uncertain", runtime.id, id),
          readyData: () => this.runtimeReady(runtime),
          sessionData: () => ({ ...(runtime.draftSession || { id: runtime.id, sessionId: runtime.lastState?.sessionId || runtime.id, name: "新对话", preview: "新对话", cwd: runtime.cwd, updatedAt: this.now(), messageCount: 1, active: true }), active: true }),
          runtimeTurnActive: () => this.runtimeTurnActive(runtime),
          onFailure: () => { runtime.running = false; this.broadcastSessionActivity(runtime.id); },
        }, {
          message: input.message,
          images: input.images,
          promptId: input.message ? randomUUID() : "",
          settings: initialSettings,
        });
        return {
          ...result.ready,
          session: result.session,
          accepted: true,
          queued: false,
          ...(result.promptId ? { promptId: result.promptId } : null),
          ...(result.deliveryUncertain ? { deliveryUncertain: true } : null),
          ...(result.extension && !result.deliveryUncertain ? { extension: true, command: result.extension.name, description: result.extension.description, isStreaming: result.extension.isStreaming } : null),
        } satisfies InitialPromptData;
      },
      discardDraft: (runtime) => this.runtimePool.discardDraft(runtime).then(() => undefined),
    }, request, response, url, clientId, preparedBody)) return;

    if (
      await handleModelManagementRoute({
        available: () => Boolean(this.options.modelManager),
        providerService: () => this.providerManagementService(),
        customModelService: () => this.customModelManagementService(),
        runtimeSettingsService: () => this.runtimeSettingsService(),
        beginPromptAdmission: (sessionId) => this.beginPromptAdmission(sessionId),
      }, request, response, url, preparedBody)
    ) return;

    if (
      await handleExtensionResponseRoute({
        respond: (input) => respondToExtension({
          target: (sessionId) => {
            const runtime = this.runtimePool.get(sessionId);
            const rpc = runtime?.rpc || (sessionId === this.activeSessionId ? this.options.rpc : null);
            if (!rpc) return null;
            return {
              rpc,
              release: runtime
                ? this.runtimePool.acquireOperation(runtime)
                : this.primaryOperationAdmission.acquire().release,
            };
          },
          hasUncertain: (sessionId) => this.uncertainExtensionResponseBySession.has(sessionId),
          pendingRequest: (sessionId) => this.pendingRequestForSession(sessionId),
          claim: (key) => {
            if (this.claimingExtensionRequests.has(key)) return false;
            this.claimingExtensionRequests.add(key);
            return true;
          },
          releaseClaim: (key) => this.claimingExtensionRequests.delete(key),
          rpcOutcomeUnknown: (error) => this.rpcOutcomeUnknown(error),
          markOutcomePending: (sessionId, error) => this.markRpcOutcomePending(sessionId, error),
          markUncertain: (sessionId) => this.uncertainExtensionResponseBySession.add(sessionId),
          rethrowResultPending: (error, operation) => this.rethrowResultPending(error, operation),
          clearPending: (sessionId, requestId) => this.clearPendingRequest(sessionId, requestId),
        }, input),
      }, request, response, url, preparedBody)
    ) return;

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
