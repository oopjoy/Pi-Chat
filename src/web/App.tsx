import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  lazy,
  Suspense,
  useState,
} from "react";
import { appendTerminalMessage, assistantMessageRequestsTool } from "../shared/streaming-assistant";
import {
  applyStreamingDelta,
  decodeStreamingCheckpoint,
  MESSAGE_CHECKPOINT_EVENT,
  MESSAGE_DELTA_EVENT,
  type StreamingMessageAppend,
  type StreamingWireProjection,
} from "../shared/streaming-wire";
import type { StateDiagnosticExportBundle } from "../shared/state-diagnostics";
import type {
  ApplicationLifecycle,
  BootstrapData,
  ExtensionUiRequest,
  ModelInfo,
  PiMessage,
  PiState,
  PrimaryRuntimeReadiness,
  PromptDelivery,
  PromptImage,
  PendingSteer,
  QueuedPrompt,
  SessionActivityState,
  SessionDirectorySummary,
  SessionSummary,
  SessionRuntimeReadyData,
  SessionViewData,
  SlashCommand,
  ThinkingLevel,
} from "../shared/types";
import { ApiRequestError, api } from "./api";
import { AppShell } from "./components/AppShell";
import { AskQuestionnaireDialog } from "./components/AskQuestionnaireDialog";
import { ConversationPane } from "./components/ConversationPane";
import { composerDraftKeyId, type ComposerDraftKey } from "./state/composer";
import { ComposerControls } from "./components/ComposerControls";
import {
  describeGateRequest,
  ExtensionDialog,
} from "./components/ExtensionDialog";
import { ChevronRightIcon, PiMarkIcon } from "./components/Icons";
import type { ManagementSection } from "./components/ManagementPanel";
import {
  SessionDialog,
  type SessionDialogState,
} from "./components/SessionDialog";
import { SessionInventory } from "./components/SessionInventory";
import { useLiveMessageScheduler } from "./hooks/use-live-message";
import { liveMessageSchedulePolicy } from "./lib/live-message-policy";
import {
  shouldReconnectEventSource,
  usePiEventSource,
} from "./hooks/use-pi-event-source";
import {
  activeSessionIdsFromEvent,
  applyActiveSessionIds,
} from "./lib/active-sessions";
import {
  parseAskQuestionnaire,
} from "./lib/ask-questionnaire";
import { recentSessionWorkspaces } from "./lib/session-workspaces";
import { adjacentUserMessageOffset } from "./lib/conversation-navigation";
import {
  composerWaitStatus,
  runtimePreparationForDisplay,
} from "./lib/composer-wait-status";
import { extensionExecutionNotice } from "./lib/extension-notice";
import {
  gateModeFromCommand,
  gateModeFromNotice,
  type GateMode,
} from "./lib/gate-mode";
import {
  assistantMessage,
  lifecycleFromEvent,
  parseEventData,
  userMessage,
} from "./lib/pi-events";
import {
  admitStreamEvent,
  invalidatesSessionViewVersion,
  isSessionScopedEvent,
} from "./application/stream-events";
import { SessionNavigationCoordinator } from "./application/session-navigation-coordinator";
import { acceptApplicationLifecycle } from "./application/application-lifecycle";
import {
  acceptPrimaryReadiness,
  type PrimaryCapabilitySnapshot,
} from "./application/runtime-readiness";
import {
  applyAppearance,
  loadAppearance,
  loadSessionNavigationPreferences,
  loadSidebarOpen,
  loadSidebarWidth,
  saveAppearance,
  saveSessionNavigationPreferences,
  saveSidebarOpen,
  saveSidebarWidth,
  type AppearancePreferences,
} from "./lib/preferences";
import { rememberedSessionId, rememberSessionId } from "./lib/session-location";
import {
  browserStateDiagnosticSnapshot,
  downloadStateDiagnosticBundle,
  recordBrowserStateDiagnostic,
} from "./lib/state-diagnostics";
import {
  DRAFT_FAILURE_SCOPE,
  isTranscriptWorthyFailure,
  localFailureNotice,
  withoutPersistedFailure,
  type LocalFailureNotice,
} from "../shared/assistant-error";
import {
  forgetLocalFailuresForSession,
  recordLocalFailureEntry,
} from "./lib/local-failures";
import {
  BrowserStreamDiagnosticsAggregator,
  type LiveMessageSchedulerOutcome,
} from "./lib/stream-observability";
import {
  appendLocalTurnOnce,
  bindLocalTurnPromptIdentity,
  bindQueuedAdmission,
  diagnoseVisibleUserTurnDuplicates,
  bindQueuedDispatch,
  consumeLocalSteeringTurn,
  localTurnBelongsInTranscript,
  localTurnForPendingPrompt,
  hasLocalTurnForPendingPayload,
  sameUserInstructionForDiagnostic,
  markLocalTurnQueued,
  nextLocalTurnTotal,
  promoteTurnsAbsentFromQueue,
  protectTranscriptWithLocalTurns,
  transcriptConfirmsLocalTurn,
  queuedPromptFromLocalTurn,
  removeLocalTurnAndRebase,
  removePendingSteeringTurns,
  type LocalUserTurn,
} from "./lib/local-user-turn";
import {
  refreshFailureKeepsCommittedView,
  sidebarNavigationBlocked,
} from "./lib/refresh-navigation-guards";
import {
  recoverableRefreshError,
  surfaceAutomaticRefreshError,
} from "./lib/refresh-error-policy";
import { BOTTOM_THRESHOLD, isAtBottom, SessionScrollMemory } from "./lib/session-scroll-memory";
import { loadModelCatalog, mergeModelCatalog, saveModelCatalog } from "./lib/model-catalog";
import { withStreamingAppendHints } from "./lib/streaming-append";
import { SessionViewCache, type SessionViewSnapshot } from "./lib/session-view-cache";
import { workspaceFileActivityParts, workspaceFileActivityRevisionFromParts } from "./lib/workspace-activity";
import { windowPromptReconcileScheduler, type PromptReconcileScheduler } from "./lib/prompt-reconcile-scheduler";
import { PromptCoordinator } from "./application/prompt-coordinator";
import {
  composerStateForSelection,
  promptSettingsForSelection,
  stageSessionComposerSelection,
  validateSelectedRoute,
  type SessionComposerSelection,
} from "./lib/session-composer-selection";
import {
  loadSessionComposerSelections,
  saveSessionComposerSelections,
} from "./lib/session-composer-preferences";
import {
  normalizeCwdKey,
  togglePinnedDirectory,
  togglePinnedSession,
} from "./lib/session-navigation";
import {
  buildIdentityLabel,
  buildIdentityMatches,
  webBuildIdentity,
} from "./lib/build-identity";
import { uniqueSessionSummaries } from "./lib/session-summary";
import {
  conversationPaneReducer,
  emptyConversationPane,
  type ConversationPaneAction,
  type ConversationPaneIdentity,
  type ConversationRuntimeStatus,
} from "./state/conversation-pane";
import {
  askQuestionnaireReducer,
  emptyAskQuestionnaireState,
} from "./state/ask-questionnaire";

// Settings and the workspace inspector are never needed for the first New
// paint. Keep them out of the initial chunk and load them on explicit opening.
const ManagementPanel = lazy(() => import("./components/ManagementPanel").then((module) => ({ default: module.ManagementPanel })));
const EditDiffSidebar = lazy(() => import("./components/EditToolDiff").then((module) => ({ default: module.EditDiffSidebar })));

const LOCAL_DRAFT_BUSY_ID = "__local_draft_busy__";
const WAITING_FOR_PI_STATUS = "正在等待 Pi 处理…";
/** Let the lightweight bootstrap establish the active Session before racing a cold JSONL view. */
const EARLY_HISTORY_VIEW_DELAY_MS = 100;
const MAX_DIRECTORY_PREFIX_SIZE = 5_000;
/** Bootstrap includes Primary capability probes; sidebar JSONL inventory has its own faster read path. */
const EARLY_SIDEBAR_INVENTORY_DELAY_MS = 250;

function promptDraftFromMessage(
  message: PiMessage,
  fallbackText = "",
): { message: string; images: PromptImage[] } {
  if (typeof message.content === "string")
    return { message: message.content, images: [] };
  if (!Array.isArray(message.content))
    return { message: fallbackText, images: [] };
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("\n");
  const images = message.content.flatMap((block) =>
    block.type === "image" && block.data && block.mimeType
      ? [{ type: "image" as const, data: block.data, mimeType: block.mimeType }]
      : [],
  );
  return { message: text || fallbackText, images };
}

/** User-facing reason an accepted Steer was cleared before Pi consumed it. */
function resultPendingError(cause: unknown): boolean {
  // A pre-existing RESULT_PENDING response definitely rejected this new prompt;
  // only the server's explicit outcomeUnknown marker may retain it as a local
  // possibly-accepted turn.
  return cause instanceof ApiRequestError &&
    cause.code === "RESULT_PENDING" &&
    cause.outcomeUnknown;
}

/**
 * The session Runtime refused the selected Model before any prompt was written.
 * Leaving that selection staged would fail every later prompt the same way, so
 * the caller must drop the staged preference and fall back to the Runtime model.
 */
function modelUnavailableError(cause: unknown): boolean {
  return cause instanceof ApiRequestError &&
    (cause.code === "MODEL_UNAVAILABLE" || cause.code === "MODEL_ROUTE_AMBIGUOUS");
}

function finiteRunMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function displaySettingsFromEvent(
  raw: unknown,
  currentModel: ModelInfo | null,
): Partial<Pick<PiState, "model" | "thinkingLevel">> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const settings = raw as Record<string, unknown>;
  const next: Partial<Pick<PiState, "model" | "thinkingLevel">> = {};
  if (typeof settings.thinkingLevel === "string")
    next.thinkingLevel = settings.thinkingLevel;
  if (settings.model && typeof settings.model === "object" && !Array.isArray(settings.model)) {
    const model = settings.model as Record<string, unknown>;
    if (typeof model.provider === "string" && typeof model.modelId === "string") {
      next.model = currentModel &&
          currentModel.provider === model.provider &&
          currentModel.id === model.modelId
        ? currentModel
        : {
            provider: model.provider,
            id: model.modelId,
            name: model.modelId,
          };
    }
  }
  return next;
}

function authoritativeStoppedSteerRejection(
  cause: unknown,
  steering: boolean,
): cause is ApiRequestError {
  if (!steering || !(cause instanceof ApiRequestError) || cause.status !== 409)
    return false;
  return (
    cause.code === "STEER_NOT_RUNNING" ||
    cause.code === "STEER_ALREADY_SETTLED" ||
    /当前对话(?:未在运行|已结束)/.test(cause.message)
  );
}

function steeringClearedMessage(reason: string): string {
  switch (reason) {
    case "settled-before-consumption":
      return "Steer 到达时当前生成已经结束，消息未执行，已清除";
    case "process-error":
      return "Pi 进程已退出，Steer 消息未执行，已清除";
    case "abort":
      return "已停止当前生成，未执行的 Steer 消息已清除";
    case "recovery":
      return "对话已恢复，未执行的 Steer 消息已清除";
    case "reclaim":
      return "对话已空闲回收，未执行的 Steer 消息已清除";
    case "deleted":
      return "对话已删除，未执行的 Steer 消息已清除";
    default:
      return "Steer 消息未执行，已清除";
  }
}

type PaneAuthority = {
  sessionId: string;
  desiredSessionId: string;
  runEpochGeneration: number;
  navigationEpoch: number;
  committedRevision: number;
  draftGeneration: number;
};

type PaneAuthoritySnapshot = PaneAuthority & {
  committedIdentity: ConversationPaneIdentity;
};
type DraftPaneAuthority = Omit<PaneAuthority, "sessionId" | "desiredSessionId">;
/** Refresh metadata is valid only in this page, process, and navigation epoch. */
type RefreshAuthority = Pick<
  PaneAuthority,
  "runEpochGeneration" | "navigationEpoch"
> & {
  refreshEpoch: number;
};
type ScheduledLiveMessage = {
  message: PiMessage;
  authority: PaneAuthoritySnapshot;
  runGeneration: number;
};
type QueueAuthorityProjection = {
  queue: QueuedPrompt[];
  paused: boolean;
  known: boolean;
  accepted?: boolean;
};

/** SSE events whose state can make an in-flight SessionViewData snapshot stale. */

/** Normalize every sidebar field to the browser's latest lifecycle fact. */
function applySidebarRunningOverride(
  session: SessionSummary,
  running: boolean,
): SessionSummary {
  const activity = session.activity;
  if (running) {
    return {
      ...session,
      running: true,
      ...(activity
        ? { activity: { ...activity, execution: "running" } }
        : null),
    };
  }
  if (
    !activity ||
    (activity.execution !== "running" && activity.execution !== "dispatching")
  )
    return { ...session, running: false };
  const queued = session.queued === true;
  return {
    ...session,
    running: false,
    activity: { ...activity, execution: queued ? "queued" : "idle" },
  };
}

/** Keep coarse sidebar queue state aligned with the authoritative item projection. */
function applySidebarQueueProjection(
  session: SessionSummary,
  queue: QueuedPrompt[],
  paused = session.activity?.execution === "paused",
): SessionSummary {
  const queued = queue.length > 0;
  const activity = session.activity;
  const staleQueueActivity =
    activity?.execution === "queued" ||
    activity?.execution === "dispatching" ||
    activity?.execution === "paused";
  return {
    ...session,
    queued,
    ...(staleQueueActivity
      ? {
          activity: {
            ...activity,
            execution: queued
              ? paused
                ? "paused"
                : session.running
                  ? "running"
                  : "queued"
              : session.running
                ? "running"
                : "idle",
          },
        }
      : null),
  };
}

/** Optimistic terminal state for the narrow abort/settlement-to-SSE gap. */
function settleSidebarActivity(session: SessionSummary): SessionSummary {
  return applySidebarRunningOverride(session, false);
}

/** Preserve a terminal duration in the browser cache for instant off-screen returns. */
function settledPaneActivity(
  previous: SessionActivityState | undefined,
  durationMs: number | undefined,
): SessionActivityState {
  const { runStartedAt: _runStartedAt, ...withoutRunStart } = previous || {};
  const execution = previous?.execution === "queued" || previous?.execution === "paused"
    ? previous.execution
    : "idle";
  return {
    ...withoutRunStart,
    execution,
    awaitingConfirmation: false,
    ...(durationMs !== undefined ? { lastRunDurationMs: durationMs } : null),
  };
}

/** A fresh target view can repair a missed terminal SSE only when every live fact is idle. */
export function sessionViewConfirmsIdle(view: SessionViewData): boolean {
  return view.isStreaming !== true
    && view.state.isStreaming !== true
    && view.session.running !== true
    && !view.liveMessage
    && !view.toolStatus;
}

function forkableUserMessageText(message: PiMessage): string {
  const text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text || "")
          .join("\n")
      : "";
  return text.trim();
}

function forkMessagePreview(text: string, imageCount = 0, limit = 600): string {
  const preview = text || "（无文字内容）";
  const truncated = preview.length > limit ? `${preview.slice(0, limit - 1)}…` : preview;
  return imageCount ? `${truncated}\n\n[含 ${imageCount} 张图片]` : truncated;
}

/** A capability snapshot is usable only for this exact selected-model shape. */
function modelCapabilityKey(model: ModelInfo | null | undefined): string {
  if (!model) return "";
  return [model.provider, model.id, model.api || "", ...(model.input || [])].join("\u0000");
}

/**
 * Bootstrap can race Primary adoption and contain an active Session identity
 * with an empty message array. Never treat that partial snapshot as a genuine
 * empty conversation when its authoritative summary says history exists.
 */
function bootstrapNeedsHistoryRecovery(
  data: BootstrapData,
  activeSessionId: string,
): boolean {
  if (!activeSessionId || data.messages.length) return false;
  const summary = data.sessions.find((session) => session.id === activeSessionId);
  const preview = summary?.preview?.trim() || "";
  const summaryHasContent = Boolean(
    preview && preview !== "新对话" && preview !== "尚未发送消息",
  );
  return Boolean(
    (data.messageTotal ?? 0) > 0 ||
      (data.turnTotal ?? 0) > 0 ||
      (data.state.messageCount ?? 0) > 0 ||
      (summary?.turnCount ?? 0) > 0 ||
      summaryHasContent,
  );
}

export interface AppProps {
  /** Test-only clock injection; production uses the browser timer scheduler. */
  promptReconcileScheduler?: PromptReconcileScheduler;
}

export function App({ promptReconcileScheduler }: AppProps = {}) {
  const [pane, dispatchPane] = useReducer(
    conversationPaneReducer,
    undefined,
    emptyConversationPane,
  );
  const paneAuthorityDispatchRef = useRef<
    (
      authority: PaneAuthoritySnapshot,
      action: Exclude<
        ConversationPaneAction,
        {
          type:
            | "COMMIT_BOOTSTRAP"
            | "COMMIT_VIEW"
            | "RESET_DRAFT"
            | "CLEAR_PANE"
            | "DRAFT_WORKSPACE_SELECTED";
        }
      >,
    ) => boolean
  >(() => false);
  /** The synchronous authority mirror changes only with an atomic pane commit. */
  const committedPaneIdentityRef = useRef<ConversationPaneIdentity>(
    pane.identity,
  );
  /** Identity of the pane whose geometry is actually painted in the timeline DOM. */
  const paintedPaneIdentityRef = useRef<ConversationPaneIdentity>(pane.identity);
  /** Commands are part of the committed projection, not a render-closure fallback. */
  const committedPaneCommandsRef = useRef<SlashCommand[]>(pane.commands);
  const paneCommitRevisionRef = useRef(0);
  /** Keeps an initial-bottom intent alive across image/font/layout reflows. */
  const bottomLayoutIntentRef = useRef<{
    revision: number;
    lastTop: number;
  } | null>(null);
  const armBottomLayoutIntent = (timeline: HTMLElement) => {
    bottomLayoutIntentRef.current = {
      revision: paneCommitRevisionRef.current,
      lastTop: timeline.scrollTop,
    };
  };
  const clearBottomLayoutIntent = () => {
    bottomLayoutIntentRef.current = null;
  };
  const draftGenerationRef = useRef(0);
  const viewedSessionIdRef = useRef("");
  /** Draft intent is a coordinator guard only; pane.identity is the sole UI fact. */
  const localDraftRef = useRef(false);
  const { piState: state, messages, pendingUserMessage } = pane;
  /** Long-lived SSE callbacks read the newest Pane state without re-subscribing. */
  const paneStateRef = useRef(state);
  paneStateRef.current = state;
  /** Refresh continuations read the newest pane model without recreating their bootstrap effect. */
  const paneModelRef = useRef(state.model);
  paneModelRef.current = state.model;
  const { messageTotal, turnTotal, visibleTurnCount, messagesTruncated, runStartedAt, lastRunDurationMs } = pane;
  /** Pagination request authority stays in the coordinator map, not the pane reducer. */
  const [, setLoadingEarlierRevision] = useState(0);
  const { stats } = pane;
  const { liveMessage } = pane;
  const persistedWorkspaceActivityParts = useMemo(
    () => workspaceFileActivityParts(messages),
    [messages],
  );
  const liveWorkspaceActivityParts = useMemo(
    () => liveMessage ? workspaceFileActivityParts([liveMessage]) : [],
    [liveMessage],
  );
  const workspaceActivityRevision = useMemo(
    () => workspaceFileActivityRevisionFromParts(
      persistedWorkspaceActivityParts,
      liveWorkspaceActivityParts,
    ),
    [persistedWorkspaceActivityParts, liveWorkspaceActivityParts],
  );
  const streamDiagnosticsRef = useRef<BrowserStreamDiagnosticsAggregator | null>(null);
  streamDiagnosticsRef.current ||= new BrowserStreamDiagnosticsAggregator();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const sessionsRef = useRef<SessionSummary[]>([]);
  /** A remembered pane may load before bootstrap; it must not become a fake one-row sidebar. */
  const sidebarInventoryReadyRef = useRef(false);
  const [sidebarInventoryReady, setSidebarInventoryReady] = useState(false);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [sessionDirectories, setSessionDirectories] = useState<
    SessionDirectorySummary[]
  >([]);
  const [loadingAllSessions, setLoadingAllSessions] = useState(false);
  const [loadingDirectoryKeys, setLoadingDirectoryKeys] = useState<string[]>(
    [],
  );
  const [sessionNavigation, setSessionNavigation] = useState(() =>
    loadSessionNavigationPreferences(),
  );
  const sessionNavigationRef = useRef(sessionNavigation);
  sessionNavigationRef.current = sessionNavigation;
  const showAllSessionsRef = useRef(false);
  /** Highest contiguous directory prefix the browser has explicitly loaded. */
  const directorySessionCoverageRef = useRef(new Map<string, number>());
  /** Full inventory is a replacement barrier for older base/directory requests. */
  const sidebarFullRequestSequenceRef = useRef(0);
  const sidebarCommittedFullSequenceRef = useRef(0);
  /** Avoid retry loops for stale/deleted local pin IDs within one process epoch. */
  const pinnedInventoryAttemptRef = useRef("");
  const [activeSessionId, setActiveSessionId] = useState("");
  const [activeSessionIds, setActiveSessionIds] = useState<string[]>([]);
  const viewedSessionId =
    pane.identity.kind === "session" ? pane.identity.sessionId : "";
  // Keep the last bounded catalogue as an advisory startup fallback. Runtime
  // readiness and prompt admission remain authoritative; this only prevents a
  // transient empty discovery response from making the Model control look dead.
  const [models, setModels] = useState<ModelInfo[]>(() => loadModelCatalog());
  // A cached catalogue is useful immediately, but it is not authoritative for
  // this process generation until Bootstrap/Runtime discovery confirms it.
  const [modelInventoryConfirmed, setModelInventoryConfirmed] = useState(false);
  const [modelRuntimeSyncPending, setModelRuntimeSyncPending] = useState(false);
  useEffect(() => {
    saveModelCatalog(models);
  }, [models]);
  const rememberObservedModel = useCallback((model: ModelInfo | null | undefined) => {
    if (!model) return;
    setModels((current) => mergeModelCatalog(current, [model]));
  }, []);
  const [workspaceCwd, setWorkspaceCwd] = useState("");
  /** Server epoch + revision prevent stale bootstrap metadata from undoing workspace SSE. */
  const workspaceEpochRef = useRef("");
  const workspaceRevisionRef = useRef(0);
  const { draftWorkspaceCwd } = pane;
  const { commands, gateAvailableOverride, queue, queuePaused } = pane;
  /** Last verified catalog remains usable while a cold/fast view intentionally omits discovery. */
  const [confirmedCommands, setConfirmedCommands] = useState<SlashCommand[]>(
    [],
  );
  const rememberConfirmedCommands = useCallback(
    (candidate: SlashCommand[] | undefined) => {
      if (!candidate?.length) return;
      setConfirmedCommands((current) => {
        const unchanged =
          current.length === candidate.length &&
          current.every(
            (command, index) =>
              command.name === candidate[index]?.name &&
              command.description === candidate[index]?.description &&
              command.source === candidate[index]?.source,
          );
        return unchanged ? current : candidate;
      });
    },
    [],
  );
  // Command discovery is Runtime-scoped, while rendering a cold JSONL view is
  // deliberately Runtime-free. Keep its known catalog as a capability fallback
  // rather than waking the Session merely to populate `/` completion.
  const composerCommands = commands.length ? commands : confirmedCommands;
  /** Sessions whose abort request is awaiting a terminal confirmation. */
  const [stoppingSessionIds, setStoppingSessionIds] = useState<string[]>([]);
  const { promptStarting } = pane;
  const [loading, setLoading] = useState(true);
  /** Application-wide maintenance mutation; never used for an ordinary prompt. */
  const [busy, setBusy] = useState(false);
  /** Prompt/Runtime preparation is owned by a Session, so another pane stays usable. */
  const [busySessionIds, setBusySessionIds] = useState<string[]>([]);
  /** Editor-owned snapshots waiting to enter App's existing single-flight send path. */
  const [composerPendingByScope, setComposerPendingByScope] = useState<Record<string, number>>({});
  /** Tombstones keep a late in-flight editor promise from resurrecting deleted data. */
  const [forgottenComposerKeys, setForgottenComposerKeys] = useState<string[]>([]);
  const forgetComposerKey = useCallback((keyId: string) => {
    if (!keyId) return;
    setForgottenComposerKeys((current) => {
      if (current.includes(keyId)) return current;
      return [...current, keyId].slice(-512);
    });
  }, []);
  const updateComposerPending = useCallback((scope: string, count: number) => {
    setComposerPendingByScope((current) => {
      if ((current[scope] || 0) === count) return current;
      const next = { ...current };
      if (count > 0) next[scope] = count;
      else delete next[scope];
      return next;
    });
  }, []);
  const [viewSwitching, setViewSwitching] = useState(false);
  const [paneLoading, setPaneLoading] = useState<{
    sessionId: string;
    name: string;
  } | null>(null);
  const [diffSidebarOpen, setDiffSidebarOpen] = useState(false);
  const [diffSidebarWidth, setDiffSidebarWidth] = useState(460);
  const [refreshing, setRefreshing] = useState(false);
  const refreshOperationTokenRef = useRef<symbol | null>(null);
  const [workspacePicking, setWorkspacePicking] = useState(false);
  /** Invalidates a native picker when its New draft is superseded. */
  const draftWorkspacePickerTokenRef = useRef<symbol | null>(null);
  /** One global default picker at a time; it never owns the visible conversation pane. */
  const workspaceDefaultPickerTokenRef = useRef<symbol | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [managementSection, setManagementSection] =
    useState<ManagementSection | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [closeComplete, setCloseComplete] = useState<
    "window" | "application" | null
  >(null);
  const [sessionDialog, setSessionDialog] = useState<SessionDialogState>(null);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [appearance, setAppearance] =
    useState<AppearancePreferences>(loadAppearance);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /**
   * Runtime/upstream failures stay in the conversation body instead of only
   * flashing the five-second toast, so the user can still read what happened.
   * Browser-local only: these entries never reach Pi or a provider payload.
   */
  const [localFailures, setLocalFailures] = useState<LocalFailureNotice[]>([]);
  const recordLocalFailure = useCallback(
    (scope: string, rawText: string, incidentId?: string): void => {
      if (!scope || !rawText.trim()) return;
      const notice = localFailureNotice(scope, rawText.trim(), incidentId);
      setLocalFailures((current) => recordLocalFailureEntry(current, notice));
    },
    [],
  );
  const {
    toolStatus,
    extensionRequest,
    runtimeStatus,
    control: viewControl,
  } = pane;
  const [askQuestionnaires, dispatchAskQuestionnaire] = useReducer(
    askQuestionnaireReducer,
    undefined,
    emptyAskQuestionnaireState,
  );
  const localDraft = pane.identity.kind === "draft";
  const [eventSourceGeneration, setEventSourceGeneration] = useState(0);
  const [applicationLifecycle, setApplicationLifecycle] =
    useState<ApplicationLifecycle>("idle");
  /** A stale Web bundle may read, but must not mutate a different Server build. */
  const [buildIdentityMismatch, setBuildIdentityMismatch] = useState(false);
  const [serverBuildIdentity, setServerBuildIdentity] =
    useState(webBuildIdentity);
  const [piVersion, setPiVersion] = useState<string | undefined>();
  /** Global Primary capability; separate from the Session/JSONL first-paint state. */
  const [primaryRuntime, setPrimaryRuntime] = useState<PrimaryRuntimeReadiness>(
    { status: "starting", generation: 0 },
  );
  /** The latest Bootstrap snapshot that has confirmed a particular model's input capability. */
  const [primaryCapabilitySnapshot, setPrimaryCapabilitySnapshot] =
    useState<PrimaryCapabilitySnapshot | null>(null);
  // EventSource callbacks retain their transport identity across UI commits.
  // Read current capability facts from refs instead of re-subscribing on each render.
  const primaryRuntimeRef = useRef(primaryRuntime);
  primaryRuntimeRef.current = primaryRuntime;
  /** Single browser projection write boundary for Primary Runtime readiness. */
  const publishPrimaryReadiness = useCallback(
    (next: PrimaryRuntimeReadiness): void => {
      primaryRuntimeRef.current = next;
      setPrimaryRuntime(next);
    },
    [],
  );
  const primaryCapabilitySnapshotRef = useRef(primaryCapabilitySnapshot);
  const publishPrimaryCapabilitySnapshot = useCallback(
    (next: PrimaryCapabilitySnapshot | null): void => {
      primaryCapabilitySnapshotRef.current = next;
      setPrimaryCapabilitySnapshot(next);
    },
    [],
  );
  primaryCapabilitySnapshotRef.current = primaryCapabilitySnapshot;
  /** Session IDs whose Pi Runtime is being prepared outside the reading path. */
  const [warmingSessionIds, setWarmingSessionIds] = useState<string[]>([]);
  /** Browser-local notice: a background Session completed an assistant reply not yet opened here. */
  const [unseenReplySessionIds, setUnseenReplySessionIds] = useState<string[]>(
    [],
  );
  const [mutatingSessionIds, setMutatingSessionIds] = useState<string[]>([]);
  const [copyingSessionIds, setCopyingSessionIds] = useState<string[]>([]);
  /** Browser-local Composer partitions expose only whether the current draft has content. */
  const [composerContentByScope, setComposerContentByScope] = useState<Record<string, boolean>>({});
  // Passive history browsing must stay fast without consuming a Pi Runtime.
  // Keep enough data-only panes to cover normal archive hopping; the server's
  // target snapshot cache has the same entry bound.
  const viewCacheRef = useRef(new SessionViewCache(32));
  /** A structural delete is terminal even if a response is lost in transit. */
  const confirmedDeletedSessionIdsRef = useRef(new Set<string>());
  // Late Runtime/view continuations may still settle after terminal deletion.
  // They must never recreate a cache entry (or a transient overlay) for that ID.
  const rememberSessionView = (view: SessionViewData) => {
    if (confirmedDeletedSessionIdsRef.current.has(view.session.id))
      return undefined;
    // Historical/read-only views may intentionally omit queue authority. Do not
    // turn an unknown queue into an authoritative empty array while caching.
    if (!Array.isArray(view.queue)) return viewCacheRef.current.remember(view);
    const sessionId = view.session.id;
    const filteredQueue = filterCancelledQueue(sessionId, view.queue);
    const latest = latestQueueProjectionRef.current.get(sessionId);
    if (!latest) {
      latestQueueProjectionRef.current.set(sessionId, {
        queue: filteredQueue,
        paused: view.queuePaused === true,
      });
      queueProjectionSourceRef.current.set(sessionId, "view");
      advanceQueueProjectionRevision(sessionId);
    }
    // A stale response may arrive after a newer queue event and still be
    // cached for a later navigation. Keep the cache in the same authority
    // domain as the event projection, including an explicit empty queue.
    const projection = latest || {
      queue: filteredQueue,
      paused: view.queuePaused === true,
    };
    return viewCacheRef.current.remember({
      ...view,
      queue: projection.queue,
      queuePaused: projection.paused,
    });
  };
  const refreshSessionCache = (id: string, patch: Partial<SessionViewData>) =>
    confirmedDeletedSessionIdsRef.current.has(id)
      ? undefined
      : viewCacheRef.current.refresh(id, patch);
  /**
   * Queue projections are event-owned and can be newer than a cached Session
   * view. Never let a stale cached view resurrect an item already removed by a
   * queue_update/dispatch event.
   */
  function withLatestQueueProjection(view: SessionViewSnapshot): SessionViewSnapshot;
  function withLatestQueueProjection(view: undefined): undefined;
  function withLatestQueueProjection(view: SessionViewSnapshot | undefined): SessionViewSnapshot | undefined;
  function withLatestQueueProjection(view: SessionViewSnapshot | undefined): SessionViewSnapshot | undefined {
    if (!view) return undefined;
    const latest = latestQueueProjectionRef.current.get(view.session.id);
    if (!latest) return view;
    return {
      ...view,
      queue: latest.queue,
      queuePaused: latest.paused,
    };
  };
  const patchSessionCache = (
    id: string,
    patch: Parameters<SessionViewCache["patch"]>[1],
  ) =>
    confirmedDeletedSessionIdsRef.current.has(id)
      ? undefined
      : viewCacheRef.current.patch(id, patch);
  const updateLiveSessionCache = (id: string, message: PiMessage) =>
    confirmedDeletedSessionIdsRef.current.has(id)
      ? undefined
      : viewCacheRef.current.updateLive(id, message);
  /**
   * HTTP acknowledgements and SSE can both be lost during a reconnect. A later
   * authoritative Session view still contains the scheduler's queue, so bind
   * its stable queue IDs to matching local admissions before transcript
   * protection decides whether those rows should remain hidden.
   */
  const reconcileQueuedAdmissions = (
    sessionId: string,
    queue: QueuedPrompt[] | undefined,
  ) => {
    if (!sessionId || !queue?.length) return;
    const turns = localUserTurnsRef.current.get(sessionId);
    if (!turns?.length) return;
    for (const queued of queue)
      bindQueuedAdmission(
        turns,
        queued.id,
        queued.message,
        queued.imageCount,
      );
  };
  const appendTerminalSessionCache = (id: string, message: PiMessage) =>
    confirmedDeletedSessionIdsRef.current.has(id)
      ? undefined
      : viewCacheRef.current.appendTerminal(id, message);
  const [pendingSteersBySession, setPendingSteersBySession] = useState<
    Record<string, PendingSteer[]>
  >({});
  const pendingSteersRef = useRef(new Map<string, PendingSteer[]>());
  /** Latest server authority prevents an older refresh from reviving a consumed Steer. */
  const pendingSteerProjectionRef = useRef(new Map<string, { revision: number; items: PendingSteer[] }>());
  const syncPendingSteers = (sessionId: string, items: PendingSteer[]) => {
    if (items.length) pendingSteersRef.current.set(sessionId, items);
    else pendingSteersRef.current.delete(sessionId);
    setPendingSteersBySession(Object.fromEntries(pendingSteersRef.current));
  };
  const [gateModes, setGateModes] = useState<Record<string, GateMode>>({});
  const gateModesRef = useRef<Record<string, GateMode>>({});
  const updateGateMode = useCallback(
    (sessionId: string, mode: GateMode | undefined) => {
      const next = { ...gateModesRef.current };
      if (mode) next[sessionId] = mode;
      else delete next[sessionId];
      gateModesRef.current = next;
      patchSessionCache(sessionId, { gateMode: mode });
      setGateModes(next);
    },
    [],
  );
  const [failedSessionIds, setFailedSessionIds] = useState<string[]>([]);
  /** Apply only server-authored Sidebar activity; cache overlay protects it from late HTTP views. */
  const applySessionActivity = useCallback(
    (sessionId: string, activity: SessionActivityState) => {
      const terminalActivity =
        activity.execution === "idle" ||
        activity.execution === "queued" ||
        activity.execution === "failed";
      if (activity.execution === "running" || activity.execution === "dispatching")
        sessionRunningOverridesRef.current.set(sessionId, true);
      else if (terminalActivity)
        sessionRunningOverridesRef.current.set(sessionId, false);
      // `paused` belongs to the follow-up queue and may coexist with an active
      // turn. Preserve the preceding running/terminal authority instead of
      // manufacturing either conclusion from paused alone.
      setFailedSessionIds((current) =>
        activity.execution === "failed"
          ? [...new Set([...current, sessionId])]
          : current.filter((id) => id !== sessionId),
      );
      setSessions((current) =>
        current.map((session) => {
          if (session.id !== sessionId) return session;
          const running =
            activity.execution === "running" ||
            activity.execution === "dispatching"
              ? true
              : terminalActivity
                ? false
                : session.running === true;
          return {
            ...session,
            activity,
            running,
            queued:
              activity.execution === "queued" ||
              activity.execution === "paused",
            pendingConfirmation: activity.awaitingConfirmation,
          };
        }),
      );
      patchSessionCache(sessionId, { sessionActivity: activity });
    },
    [],
  );
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  const diagnosticSidebarRowsRef = useRef(new Map<string, string>());
  const diagnosticUiSignatureRef = useRef("");
  const diagnosticSseRejectionAtRef = useRef(new Map<string, number>());
  const diagnosticCheckpointRef = useRef<() => void>(() => undefined);
  const recordSseRejectionDiagnostic = useCallback((input: {
    sessionId?: string;
    runGeneration?: number;
    eventType: string;
    decisionReason: string;
  }) => {
    const now = Date.now();
    const signature = [
      input.sessionId || "none",
      input.runGeneration ?? "none",
      input.eventType,
      input.decisionReason,
    ].join(":");
    const previous = diagnosticSseRejectionAtRef.current.get(signature) || 0;
    if (now - previous < 30_000) return;
    diagnosticSseRejectionAtRef.current.set(signature, now);
    if (diagnosticSseRejectionAtRef.current.size > 128) {
      for (const [key, recordedAt] of diagnosticSseRejectionAtRef.current) {
        if (now - recordedAt >= 60_000)
          diagnosticSseRejectionAtRef.current.delete(key);
      }
      while (diagnosticSseRejectionAtRef.current.size > 128) {
        const oldest = diagnosticSseRejectionAtRef.current.keys().next().value;
        if (typeof oldest !== "string") break;
        diagnosticSseRejectionAtRef.current.delete(oldest);
      }
    }
    recordBrowserStateDiagnostic("sse", "rejected", {
      sessionId: input.sessionId,
      runGeneration: input.runGeneration,
      details: {
        eventType: input.eventType,
        decisionReason: input.decisionReason,
      },
    });
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const scrollMemoryRef = useRef(new SessionScrollMemory());
  const pendingScrollRestoreRef = useRef("");
  /** Suppresses scroll events caused by replacing the source pane with navigation UI. */
  const scrollMemoryFenceRef = useRef<{ epoch: number; targetSessionId: string } | null>(null);
  const conversationNavigationTargetRef = useRef<number | null>(null);
  /** Abort leases are per Runtime Session; A stopping must not block B. */
  const stoppingOperationTokensRef = useRef(new Map<string, symbol>());
  const lastEventFrameAtRef = useRef(Date.now());
  const sessionEventVersionRef = useRef(new Map<string, number>());
  const lastSessionEventTypeRef = useRef(new Map<string, string>());
  const promptReconcileTimerRef = useRef<{
    scheduler: PromptReconcileScheduler;
    handle: number;
  } | null>(null);
  const promptReconcileSchedulerRef = useRef<PromptReconcileScheduler>(windowPromptReconcileScheduler);
  promptReconcileSchedulerRef.current = promptReconcileScheduler || windowPromptReconcileScheduler;
  const clearPromptReconcileTimer = () => {
    if (promptReconcileTimerRef.current === null) return;
    promptReconcileTimerRef.current.scheduler.clear(promptReconcileTimerRef.current.handle);
    promptReconcileTimerRef.current = null;
  };
  const requestPromptReconcileRef = useRef<(sessionId: string) => void>(() => undefined);
  const sseReconnectTimerRef = useRef<number | null>(null);
  const sseFloodCountRef = useRef(0);
  const clearViewedPromiseRef = useRef<Promise<unknown> | null>(null);
  const applicationLifecycleRef = useRef<ApplicationLifecycle>("idle");
  /** Single browser projection write boundary for application lifecycle. */
  const publishApplicationLifecycle = (next: ApplicationLifecycle): void => {
    applicationLifecycleRef.current = next;
    setApplicationLifecycle(next);
  };
  const resourceReloadActiveRef = useRef(false);
  const handoffWaitRef = useRef<Promise<void> | null>(null);
  const sessionRefreshTimerRef = useRef<number | null>(null);
  const sessionRefreshInFlightRef = useRef(false);
  const sessionRefreshGenerationRef = useRef<number | null>(null);
  const sessionRefreshRequestedRef = useRef(false);
  const loadAllSessionsGenerationRef = useRef<number | null>(null);
  const directoryLoadGenerationsRef = useRef(new Map<string, number>());
  /** DSH-style verified direct-parent address; identity never grants child mutation authority. */
  const subagentAddressesRef = useRef(
    new Map<string, { parentSessionId: string; label: string }>(),
  );
  const rehydrateSubagentAddressChain = useCallback(
    async (sessionId: string, signal?: AbortSignal): Promise<void> => {
      const edges: Array<{ parentSessionId: string; childSessionId: string }> = [];
      const visited = new Set<string>();
      let childSessionId = sessionId;
      while (true) {
        if (visited.has(childSessionId) || edges.length >= 64)
          throw new Error("子代理地址链无效");
        visited.add(childSessionId);
        const address = subagentAddressesRef.current.get(childSessionId);
        if (!address) break;
        edges.push({ parentSessionId: address.parentSessionId, childSessionId });
        childSessionId = address.parentSessionId;
      }
      for (const edge of edges.reverse()) {
        const snapshot = await api.backgroundSubagents(edge.parentSessionId, signal);
        if (!snapshot.steps.some((step) => step.childSessionId === edge.childSessionId))
          throw new ApiRequestError("子代理对话不存在或尚未准备好", 404, "SUBAGENT_VIEW_UNAVAILABLE");
      }
    },
    [],
  );
  const fetchSessionView = useCallback(
    async (
      sessionId: string,
      turns?: number,
      options: { fast?: boolean; signal?: AbortSignal } = {},
    ): Promise<SessionViewData> => {
      const address = subagentAddressesRef.current.get(sessionId);
      if (!address) return api.viewSession(sessionId, turns, options);
      try {
        return await api.viewBackgroundSubagent(
          address.parentSessionId,
          sessionId,
          turns,
          options.signal,
        );
      } catch (error) {
        if (!(error instanceof ApiRequestError) || error.status !== 404) throw error;
        await rehydrateSubagentAddressChain(sessionId, options.signal);
        return api.viewBackgroundSubagent(
          address.parentSessionId,
          sessionId,
          turns,
          options.signal,
        );
      }
    },
    [rehydrateSubagentAddressChain],
  );
  const sessionNavigationCoordinatorRef = useRef<SessionNavigationCoordinator | null>(null);
  if (sessionNavigationCoordinatorRef.current === null)
    sessionNavigationCoordinatorRef.current = new SessionNavigationCoordinator();
  const navigationEpochRef = sessionNavigationCoordinatorRef.current.navigationEpochRef;
  const desiredSessionIdRef = sessionNavigationCoordinatorRef.current.desiredSessionIdRef;
  const navigationAbortRef = sessionNavigationCoordinatorRef.current.navigationAbortRef;
  const navigationStartedAtRef = sessionNavigationCoordinatorRef.current.navigationStartedAtRef;
  /** Accepted local user turns remain visible until a JSONL-derived view includes them. */
  const localUserTurnsRef = useRef(new Map<string, LocalUserTurn[]>());
  const promptCoordinatorRef = useRef(new PromptCoordinator());
  const draftRestorationIntentSequenceRef = useRef(0);
  const appliedDraftRestorationSequencesRef = useRef(new Map<string, number>());
  const steerDequeueExpectedDraftRevisionRef = useRef(new Map<string, number>());
  const [steerDequeueingBySession, setSteerDequeueingBySession] = useState<Record<string, boolean>>({});
  const queueMutationSequenceRef = useRef(new Map<string, number>());
  const appliedQueueMutationSequenceRef = useRef(new Map<string, number>());
  const cancelledQueueIdsRef = useRef(new Map<string, Set<string>>());
  /** In-flight cancellation IDs cannot be interpreted as dispatched merely because they leave the FIFO. */
  const cancellingQueueIdsRef = useRef(new Map<string, Set<string>>());
  const queueProjectionRevisionRef = useRef(new Map<string, number>());
  /** Distinguishes fresh SSE queue authority from a stale HTTP/view snapshot. */
  const queueProjectionSourceRef = useRef(
    new Map<string, "event" | "view" | "ack" | "mutation">(),
  );
  /** Queue IDs whose user turn was already confirmed by a persisted view. */
  const confirmedQueueDispatchIdsRef = useRef(new Map<string, Set<string>>());
  /** Latest queue projection per Session, independent of pane/cache residency. */
  const latestQueueProjectionRef = useRef(
    new Map<string, { queue: QueuedPrompt[]; paused: boolean }>(),
  );
  /** Revision guards are partitioned with the same key as Composer drafts. */
  const composerDraftRevisionsRef = useRef(new Map<string, number>());
  const [restoredComposerDrafts, setRestoredComposerDrafts] = useState<
    Record<string, {
      key: ComposerDraftKey;
      revision: number;
      expectedDraftRevision: number;
      message: string;
      images: PromptImage[];
      prepend?: boolean;
    }>
  >({});
  /** A terminal compaction frame outranks a later stale hot-memory view until a new compaction begins. */
  const completedCompactionSessionIdsRef = useRef(new Set<string>());
  /** Background accepted Steers that were dropped remain explainable when their Session is opened. */
  const unreadSteeringDropMessagesRef = useRef(new Map<string, string>());
  /** Last authoritative turn count from sidebar/view data, safe inside long-lived SSE callbacks. */
  const sourceTurnTotalsRef = useRef(new Map<string, number>());
  /**
   * Desired next-turn Model/Thinking, scoped to one ordinary Composer target.
   * This is intentionally separate from pane.piState, which remains the
   * JSONL/Runtime fact used to label already-generated conversation content.
   */
  const pendingSessionPrefsRef = useRef(
    loadSessionComposerSelections(),
  );
  const [composerSelectionRevision, setComposerSelectionRevision] = useState(0);
  // Desired next-turn selections survive F5 inside this browser tab only. They
  // remain browser intent, never PiState or Server/JSONL authority.
  useEffect(() => {
    saveSessionComposerSelections(pendingSessionPrefsRef.current);
  }, [composerSelectionRevision]);
  /** A cold Session's Gate preference is staged until its next real prompt. */
  const pendingGateModesRef = useRef(new Map<string, GateMode>());
  const [pendingGateModes, setPendingGateModes] = useState<
    Record<string, GateMode>
  >({});
  const stageGateMode = useCallback(
    (sessionId: string, mode: GateMode | undefined) => {
      if (mode) pendingGateModesRef.current.set(sessionId, mode);
      else pendingGateModesRef.current.delete(sessionId);
      setPendingGateModes(Object.fromEntries(pendingGateModesRef.current));
    },
    [],
  );
  const DRAFT_PREFS_KEY = "__local_draft__";
  const warmingSessionIdsRef = useRef(new Set<string>());
  const warmingRuntimeStartsRef = useRef(
    new Map<string, Promise<SessionRuntimeReadyData>>(),
  );
  /** message_end may precede agent_settled; only their pair creates an unread completion notice. */
  const terminalAssistantSessionIdsRef = useRef(new Set<string>());
  /**
   * A canonical assistant terminal closes only that assistant stream. A later
   * same-generation update is stale until Pi explicitly starts another
   * assistant stream; tool calls may still produce another assistant stream in
   * the same generation, so this is intentionally not a generation-wide fence.
   */
  const terminalAssistantStreamGenerationsRef = useRef(new Map<string, number>());
  /** Per-Session browser lease for the server-owned checkpoint/delta stream. */
  const streamingWireProjectionsRef = useRef(new Map<string, StreamingWireProjection>());
  /** Repeated malformed stream recovery is rate-limited per Session. */
  const streamGapRecoveriesRef = useRef(new Map<string, { at: number; count: number }>());
  /** SSE lifecycle is newer than a delayed sidebar/bootstrap summary. */
  const sessionRunningOverridesRef = useRef(new Map<string, boolean>());
  /** Token-only SSE recovery must not erase a still-visible live turn before fresh authority arrives. */
  const transportRecoveryPendingRef = useRef(false);
  const normalizeSessionRunning = (session: SessionSummary): SessionSummary => {
    const running = sessionRunningOverridesRef.current.get(session.id);
    return running === undefined
      ? session
      : applySidebarRunningOverride(session, running);
  };
  const filterCancelledQueue = (
    sessionId: string,
    incoming: QueuedPrompt[],
  ): QueuedPrompt[] => {
    const cancelled = cancelledQueueIdsRef.current.get(sessionId);
    if (!cancelled?.size) return incoming;
    return incoming.filter((item) => !cancelled.has(item.id));
  };
  const advanceQueueProjectionRevision = (sessionId: string): number => {
    const next = (queueProjectionRevisionRef.current.get(sessionId) || 0) + 1;
    queueProjectionRevisionRef.current.set(sessionId, next);
    return next;
  };
  const acceptQueueProjection = (
    sessionId: string,
    incoming: QueuedPrompt[],
    paused: boolean,
    source: "event" | "view" | "ack" | "mutation" = "view",
  ): { queue: QueuedPrompt[]; paused: boolean } => {
    const projection = {
      queue: filterCancelledQueue(sessionId, incoming),
      paused,
    };
    latestQueueProjectionRef.current.set(sessionId, projection);
    queueProjectionSourceRef.current.set(sessionId, source);
    advanceQueueProjectionRevision(sessionId);
    return projection;
  };
  const rememberConfirmedQueueDispatchIds = (
    sessionId: string,
    before: LocalUserTurn[],
    pending: LocalUserTurn[],
    messages: PiMessage[],
    turnTotal: number | undefined,
    messagesTruncated: boolean,
  ): void => {
    const pendingSet = new Set(pending);
    const confirmed = before.filter(
      (turn) =>
        turn.queueState === "dispatched" &&
        !turn.revealOnMessageStart &&
        turn.queueId &&
        !pendingSet.has(turn) &&
        transcriptConfirmsLocalTurn(
          turn,
          messages,
          turnTotal,
          messagesTruncated,
        ),
    );
    if (!confirmed.length) return;
    const ids =
      confirmedQueueDispatchIdsRef.current.get(sessionId) || new Set<string>();
    for (const turn of confirmed) {
      if (!turn.queueId) continue;
      ids.add(turn.queueId);
    }
    // This is only a late-event fence; keep it bounded and let a matching
    // dispatch consume each entry.
    while (ids.size > 64) ids.delete(ids.values().next().value!);
    confirmedQueueDispatchIdsRef.current.set(sessionId, ids);
  };
  const clearEmptyQueuePause = (sessionId: string): void => {
    const projection = latestQueueProjectionRef.current.get(sessionId);
    const queue = projection?.queue || viewCacheRef.current.get(sessionId)?.queue || [];
    if (!queue.length && projection?.paused !== false)
      acceptQueueProjection(sessionId, [], false, "event");
  };
  const acceptQueueProjectionIfCurrent = (
    sessionId: string,
    requestRevision: number,
    incoming: QueuedPrompt[],
    paused: boolean,
  ): { queue: QueuedPrompt[]; paused: boolean; accepted: boolean } => {
    if (
      (queueProjectionRevisionRef.current.get(sessionId) || 0) !==
      requestRevision
    ) {
      const current = latestQueueProjectionRef.current.get(sessionId);
      if (current) return { ...current, accepted: false };
      return {
        ...acceptQueueProjection(sessionId, incoming, paused),
        accepted: true,
      };
    }
    return { ...acceptQueueProjection(sessionId, incoming, paused), accepted: true };
  };
  const queueProjectionForView = (
    sessionId: string,
    incoming: QueuedPrompt[] | undefined,
    paused: boolean,
    requestRevision?: number,
  ): QueueAuthorityProjection => {
    if (!Array.isArray(incoming)) {
      const cached = latestQueueProjectionRef.current.get(sessionId)
        || (() => {
          const view = viewCacheRef.current.get(sessionId);
          return view && Array.isArray(view.queue)
            ? { queue: view.queue, paused: view.queuePaused === true }
            : undefined;
        })();
      return {
        queue: cached?.queue || [],
        paused: cached?.paused ?? paused,
        known: false,
      };
    }
    const projection = requestRevision === undefined
      ? acceptQueueProjection(sessionId, incoming, paused)
      : acceptQueueProjectionIfCurrent(sessionId, requestRevision, incoming, paused);
    return { ...projection, known: true };
  };
  const busySessionCountsRef = useRef(new Map<string, number>());
  /** Prompt preparation may finish authoritatively via a newer SSE run. */
  const promptBusyReleasesRef = useRef(
    new Map<
      string,
      {
        epoch: string;
        afterGeneration: number;
        release: () => void;
        markAccepted: () => void;
        markTerminal: () => void;
      }
    >(),
  );
  const runEpochRef = useRef("");
  /** Increments only on a real replacement, invalidating pre-handoff early reads. */
  const runEpochGenerationRef = useRef(0);
  const sessionRunGenerationsRef = useRef(new Map<string, number>());
  /** Terminal generations are final: late tool/status frames from them are stale. */
  const settledRunGenerationsRef = useRef(new Map<string, number>());
  const refreshEpochRef = useRef(0);
  /** Initial SSE ready is redundant only after this page has committed a bootstrap. */
  const bootstrapCompletedRef = useRef(false);
  /** A failed initial bootstrap gets one ready-driven retry, never a ready loop. */
  const initialReadyRecoveryRequestedRef = useRef(false);
  /** A replacement can announce maintenance before its first idle bootstrap. */
  const replacementBootstrapPendingRef = useRef(false);
  const bootstrapInFlightRef = useRef<Promise<BootstrapData> | null>(null);
  const handshakeInFlightRef = useRef<{
    refreshEpoch: number;
    runEpochGeneration: number;
    request: Promise<boolean>;
  } | null>(null);
  /** First remembered pane may paint while the slower global bootstrap continues. */
  const initialHistoryRef = useRef<{
    id: string;
    refreshEpoch: number;
    runEpochGeneration: number;
    request: Promise<SessionViewData>;
  } | null>(null);
  const recoveringConnectionRef = useRef<Promise<void> | null>(null);
  /** Keep sidebar refreshes from reverting a still-unconfirmed local rename/delete. */
  const optimisticRenamesRef = useRef(
    new Map<string, { token: number; previousName: string; name: string }>(),
  );
  const optimisticDeletesRef = useRef(
    new Map<
      string,
      {
        token: number;
        session: SessionSummary;
        index: number;
        sessionsTotal: number;
        wasViewed: boolean;
      }
    >(),
  );
  const optimisticSessionMutationTokenRef = useRef(0);
  const syncMutatingSessionIds = useCallback(
    () =>
      setMutatingSessionIds([
        ...new Set([
          ...optimisticRenamesRef.current.keys(),
          ...optimisticDeletesRef.current.keys(),
        ]),
      ]),
    [],
  );
  /**
   * Drop UI facts whose producer is the previous Pi Chat process. Persistent
   * session data, Pane authority, and local draft state deliberately remain
   * outside this boundary. An observed process-epoch replacement runs this
   * exact reset before the replacement bootstrap.
   */
  const resetProcessOwnedUiState = useCallback(() => {
    transportRecoveryPendingRef.current = false;
    sessionRunningOverridesRef.current.clear();
    setFailedSessionIds([]);
    setConfirmedCommands([]);
    dispatchAskQuestionnaire({ type: "RESET" });
    completedCompactionSessionIdsRef.current.clear();
    cancelledQueueIdsRef.current.clear();
    queueProjectionRevisionRef.current.clear();
    queueProjectionSourceRef.current.clear();
    confirmedQueueDispatchIdsRef.current.clear();
    latestQueueProjectionRef.current.clear();
    queueMutationSequenceRef.current.clear();
    appliedQueueMutationSequenceRef.current.clear();
    viewCacheRef.current.clear();
    optimisticRenamesRef.current.clear();
    optimisticDeletesRef.current.clear();
    syncMutatingSessionIds();
    setCopyingSessionIds([]);
    busySessionCountsRef.current.clear();
    setBusySessionIds([]);
    for (const lease of promptBusyReleasesRef.current.values()) {
      lease.markTerminal();
      lease.release();
    }
    promptBusyReleasesRef.current.clear();
    warmingRuntimeStartsRef.current.clear();
    warmingSessionIdsRef.current.clear();
    setWarmingSessionIds([]);
    streamDiagnosticsRef.current?.clear();
    sessionRunGenerationsRef.current.clear();
    settledRunGenerationsRef.current.clear();
    terminalAssistantStreamGenerationsRef.current.clear();
    streamingWireProjectionsRef.current.clear();
    streamGapRecoveriesRef.current.clear();
    const viewedSessionId = viewedSessionIdRef.current;
    if (viewedSessionId)
      dispatchPane({
        type: "FAST_MODE_CHANGED",
        sessionId: viewedSessionId,
        active: false,
      });
  }, [syncMutatingSessionIds]);

  /**
   * Resource reload is an in-process Runtime replacement, not a new Pi Chat
   * epoch. Invalidate only process/runtime projections while preserving the
   * user's unsent Composer partitions and local user-authored drafts.
   */
  const resetResourceReloadTransientState = useCallback(() => {
    transportRecoveryPendingRef.current = false;
    refreshEpochRef.current += 1;
    navigationEpochRef.current += 1;
    sessionRunningOverridesRef.current.clear();
    completedCompactionSessionIdsRef.current.clear();
    cancelledQueueIdsRef.current.clear();
    queueProjectionRevisionRef.current.clear();
    queueProjectionSourceRef.current.clear();
    confirmedQueueDispatchIdsRef.current.clear();
    latestQueueProjectionRef.current.clear();
    queueMutationSequenceRef.current.clear();
    appliedQueueMutationSequenceRef.current.clear();
    sessionEventVersionRef.current.clear();
    lastSessionEventTypeRef.current.clear();
    const runtimeIds = new Set([
      ...sessionRunGenerationsRef.current.keys(),
      ...settledRunGenerationsRef.current.keys(),
      ...sessionsRef.current.map((session) => session.id),
    ]);
    const generationFences = new Map<string, number>();
    for (const id of runtimeIds) {
      generationFences.set(
        id,
        Math.max(
          1,
          Math.max(
            sessionRunGenerationsRef.current.get(id) ?? -1,
            settledRunGenerationsRef.current.get(id) ?? -1,
          ) + 1,
        ),
      );
    }
    sessionRunGenerationsRef.current.clear();
    for (const [id, generation] of generationFences)
      sessionRunGenerationsRef.current.set(id, generation);
    settledRunGenerationsRef.current.clear();
    terminalAssistantSessionIdsRef.current.clear();
    terminalAssistantStreamGenerationsRef.current.clear();
    streamingWireProjectionsRef.current.clear();
    streamGapRecoveriesRef.current.clear();
    streamDiagnosticsRef.current?.clear();
    const viewedSessionId = viewedSessionIdRef.current;
    if (viewedSessionId)
      dispatchPane({
        type: "FAST_MODE_CHANGED",
        sessionId: viewedSessionId,
        active: false,
      });
    directoryLoadGenerationsRef.current.clear();
    directorySessionCoverageRef.current.clear();
    pendingSteersRef.current.clear();
    pendingSteerProjectionRef.current.clear();
    setPendingSteersBySession({});
    setSteerDequeueingBySession({});
    setFailedSessionIds([]);
    setConfirmedCommands([]);
    gateModesRef.current = {};
    setGateModes({});
    viewCacheRef.current.clear();
    optimisticRenamesRef.current.clear();
    optimisticDeletesRef.current.clear();
    setCopyingSessionIds([]);
    syncMutatingSessionIds();
    for (const lease of promptBusyReleasesRef.current.values()) {
      lease.markTerminal();
      lease.release();
    }
    promptBusyReleasesRef.current.clear();
    warmingRuntimeStartsRef.current.clear();
    warmingSessionIdsRef.current.clear();
    setWarmingSessionIds([]);
    busySessionCountsRef.current.clear();
    setBusySessionIds([]);
    const currentReadiness = primaryRuntimeRef.current;
    const starting: PrimaryRuntimeReadiness = {
      status: "starting",
      generation: currentReadiness.generation,
    };
    publishPrimaryReadiness(starting);
    publishPrimaryCapabilitySnapshot(null);
    setModelInventoryConfirmed(false);
  }, [syncMutatingSessionIds]);
  const recordSourceTurnTotal = (sessionId: string, total: number): void => {
    if (!Number.isFinite(total)) return;
    sourceTurnTotalsRef.current.set(
      sessionId,
      Math.max(sourceTurnTotalsRef.current.get(sessionId) || 0, total),
    );
  };
  /**
   * Authoritative user-turn watermark for one Session. Local optimistic rows
   * never raise it, so it is the only safe baseline for confirming a new turn
   * from a persisted echo instead of from a speculative ordinal.
   */
  const authoritativeTurnTotal = (sessionId: string): number | undefined => {
    if (!sessionId) return undefined;
    // Two authoritative sources can disagree: the cached view carries the latest
    // snapshot (its `turnTotal` may add a retained terminal tail), while the
    // recorded watermark is monotonic (it survives a rewind). The lower value is
    // the safe direction: an over-high baseline can never confirm a persisted
    // echo, which is exactly the duplicate this baseline exists to prevent.
    const cached = viewCacheRef.current.get(sessionId)?.turnTotal;
    const recorded = sourceTurnTotalsRef.current.get(sessionId);
    const values = [cached, recorded].filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    return values.length ? Math.min(...values) : undefined;
  };
  const applyLocalTurnCount = (session: SessionSummary): SessionSummary => {
    const localTurnTotal = Math.max(
      0,
      ...(localUserTurnsRef.current.get(session.id) || []).map(
        (turn) => turn.expectedTurnTotal,
      ),
    );
    const summaryTurnTotal =
      typeof session.turnCount === "number" &&
      Number.isFinite(session.turnCount)
        ? session.turnCount
        : 0;
    const resolvedTurnTotal = Math.max(
      summaryTurnTotal,
      sourceTurnTotalsRef.current.get(session.id) || 0,
      localTurnTotal,
    );
    return resolvedTurnTotal > summaryTurnTotal
      ? { ...session, turnCount: resolvedTurnTotal }
      : session;
  };
  const normalizeSessionQueue = (session: SessionSummary): SessionSummary => {
    const projection = latestQueueProjectionRef.current.get(session.id);
    if (!projection && !cancelledQueueIdsRef.current.has(session.id))
      return session;
    return applySidebarQueueProjection(
      session,
      projection?.queue || viewCacheRef.current.get(session.id)?.queue || [],
      projection?.paused ??
        (viewCacheRef.current.get(session.id)?.queuePaused === true),
    );
  };
  /**
   * A version-guarded target view is newer than the last browser SSE fact. If
   * it proves the Runtime fully idle, release a stale running override before
   * applying the view; otherwise the pane can settle while the sidebar remains
   * blue until F5 clears process-owned overlays.
   */
  const acceptAuthoritativeIdleSessionView = (
    view: SessionViewData,
  ): SessionViewData => {
    if (!sessionViewConfirmsIdle(view)) return view;
    sessionRunningOverridesRef.current.set(view.session.id, false);
    setSessions((current) =>
      current.map((session) =>
        session.id === view.session.id
          ? settleSidebarActivity(session)
          : session,
      ),
    );
    return {
      ...view,
      session: settleSidebarActivity(view.session),
      isStreaming: false,
      liveMessage: undefined,
      queuePaused: Array.isArray(view.queue)
        ? view.queue.length > 0 && view.queuePaused === true
        : view.queuePaused,
      toolStatus: "",
      state: { ...view.state, isStreaming: false },
    };
  };
  const reconcileOptimisticSessions = (incoming: SessionSummary[]) =>
    uniqueSessionSummaries(incoming)
      .map(normalizeSessionRunning)
      .map(normalizeSessionQueue)
      .map(applyLocalTurnCount)
      .filter(
        (session) =>
          !optimisticDeletesRef.current.has(session.id) &&
          !confirmedDeletedSessionIdsRef.current.has(session.id),
      )
      .map((session) => {
        const rename = optimisticRenamesRef.current.get(session.id);
        return rename ? { ...session, name: rename.name } : session;
      });
  const optimisticSessionsTotal = (incoming: SessionSummary[], total: number) =>
    Math.max(
      0,
      total -
        incoming.filter(
          (session) =>
            optimisticDeletesRef.current.has(session.id) ||
            confirmedDeletedSessionIdsRef.current.has(session.id),
        ).length,
    );
  const sidebarDirectoryKey = (cwd: string) =>
    normalizeCwdKey(cwd) || "__unknown_cwd__";
  /**
   * Base/bootstrap snapshots own their current page, not rows already retained by
   * a wider full snapshot, a directory prefix, or a browser-local pin. Directory
   * responses atomically replace only their cumulative prefix. This keeps a late
   * background refresh from collapsing a successful “加载更多” click.
   */
  const commitSidebarSessions = (
    incoming: SessionSummary[],
    scope:
      | { kind: "base"; fullBarrier?: number }
      | { kind: "directory"; cwd: string; fullBarrier: number }
      | { kind: "full"; requestSequence: number },
  ): boolean => {
    const normalized = reconcileOptimisticSessions(incoming);
    const incomingIds = new Set(normalized.map((session) => session.id));
    const incomingCounts = new Map<string, number>();
    for (const session of normalized) {
      const key = sidebarDirectoryKey(session.cwd);
      incomingCounts.set(key, (incomingCounts.get(key) || 0) + 1);
    }
    if (scope.kind === "full") {
      if (scope.requestSequence < sidebarCommittedFullSequenceRef.current)
        return false;
      sidebarCommittedFullSequenceRef.current = scope.requestSequence;
      showAllSessionsRef.current = true;
      directorySessionCoverageRef.current = new Map(incomingCounts);
      setSessions(normalized);
      return true;
    }
    if (
      scope.fullBarrier !== undefined &&
      scope.fullBarrier !== sidebarCommittedFullSequenceRef.current
    )
      return false;
    if (scope.kind === "directory") {
      const key = sidebarDirectoryKey(scope.cwd);
      directorySessionCoverageRef.current.set(key, normalized.length);
      const pinned = new Set(sessionNavigationRef.current.pinnedSessionIds);
      setSessions((current) =>
        uniqueSessionSummaries([
          ...normalized,
          ...current.filter((session) => {
            const sameDirectory = sidebarDirectoryKey(session.cwd) === key;
            if (!sameDirectory) return true;
            if (incomingIds.has(session.id)) return false;
            return (
              pinned.has(session.id) ||
              session.id === viewedSessionIdRef.current
            );
          }),
        ]),
      );
      return true;
    }
    for (const [key, count] of incomingCounts) {
      if (!directorySessionCoverageRef.current.has(key))
        directorySessionCoverageRef.current.set(key, count);
    }
    const pinned = new Set(sessionNavigationRef.current.pinnedSessionIds);
    setSessions((current) => {
      // Once a full inventory has committed, Bootstrap/base rows are a narrower
      // projection and cannot add back an ID absent from that full replacement.
      if (showAllSessionsRef.current) return current;
      return uniqueSessionSummaries([
        ...normalized,
        ...current.filter((session) => {
          if (incomingIds.has(session.id)) return false;
          if (
            pinned.has(session.id) ||
            session.id === viewedSessionIdRef.current
          )
            return true;
          const key = sidebarDirectoryKey(session.cwd);
          return (
            (directorySessionCoverageRef.current.get(key) || 0) >
            (incomingCounts.get(key) || 0)
          );
        }),
      ]);
    });
    return true;
  };
  const commitLiveMessage = useCallback(
    ({ message, authority }: ScheduledLiveMessage) =>
      paneAuthorityDispatchRef.current(authority, {
        type: "LIVE_MESSAGE_UPDATED",
        sessionId: authority.sessionId,
        message,
      }),
    [],
  );
  const observeLiveMessageSchedule = useCallback(
    (outcome: LiveMessageSchedulerOutcome, scheduled: ScheduledLiveMessage) => {
      streamDiagnosticsRef.current?.scheduler(outcome, {
        sessionId: scheduled.authority.sessionId,
        runGeneration: scheduled.runGeneration,
      });
    },
    [],
  );
  const {
    clearPendingLiveMessage,
    drainPendingLiveMessage,
    scheduleLiveMessage,
  } = useLiveMessageScheduler(
    commitLiveMessage,
    liveMessageSchedulePolicy,
    observeLiveMessageSchedule,
  );

  useEffect(() => {
    if (!viewedSessionId || (!liveMessage && !messages.length)) return;
    const runGeneration = sessionRunGenerationsRef.current.get(viewedSessionId);
    if (runGeneration === undefined) return;
    const identity = { sessionId: viewedSessionId, runGeneration };
    // Restored cached live content has no page-local receive/commit observation
    // and is intentionally omitted rather than guessed as a first paint.
    if (!streamDiagnosticsRef.current?.hasPaintCandidate(identity)) return;
    const runEpochGeneration = runEpochGenerationRef.current;
    const runEpoch = runEpochRef.current;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (
          document.visibilityState !== "visible"
          || !document.hasFocus()
          || runEpochGenerationRef.current !== runEpochGeneration
          || runEpochRef.current !== runEpoch
          || viewedSessionIdRef.current !== identity.sessionId
          || desiredSessionIdRef.current !== identity.sessionId
          || committedPaneIdentityRef.current.kind !== "session"
          || committedPaneIdentityRef.current.sessionId !== identity.sessionId
          || sessionRunGenerationsRef.current.get(identity.sessionId) !== identity.runGeneration
        ) return;
        streamDiagnosticsRef.current?.paint(identity);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [liveMessage, messages, viewedSessionId]);

  useEffect(() => () => streamDiagnosticsRef.current?.clear(), []);
  const reportBackgroundRefreshError = useCallback((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    const hasReadableProjection =
      committedPaneIdentityRef.current.kind !== "none"
      || sessionsRef.current.length > 0
      || Boolean(localDraftRef.current);
    // Automatic reconciliation is best-effort once history or a local draft is
    // already readable. A slow read must not look like conversation loss or a
    // failed mutation; later SSE/sidebar refreshes remain authoritative.
    if (!surfaceAutomaticRefreshError(message, hasReadableProjection)) return;
    setError(message);
  }, []);

  const setRuntimeWarming = useCallback(
    (sessionId: string, warming: boolean) => {
      if (!sessionId) return;
      if (warming) warmingSessionIdsRef.current.add(sessionId);
      else warmingSessionIdsRef.current.delete(sessionId);
      setWarmingSessionIds([...warmingSessionIdsRef.current]);
    },
    [],
  );

  /** A per-pane mutation lease allows A to start while B remains interactive. */
  const beginSessionBusy = useCallback((sessionId: string) => {
    const id = sessionId || LOCAL_DRAFT_BUSY_ID;
    const runEpochGeneration = runEpochGenerationRef.current;
    const counts = busySessionCountsRef.current;
    counts.set(id, (counts.get(id) || 0) + 1);
    setBusySessionIds([...counts.keys()]);
    let released = false;
    return () => {
      if (released || runEpochGenerationRef.current !== runEpochGeneration)
        return;
      released = true;
      const count = (counts.get(id) || 1) - 1;
      if (count > 0) counts.set(id, count);
      else counts.delete(id);
      setBusySessionIds([...counts.keys()]);
    };
  }, []);

  const releasePromptBusy = useCallback(
    (
      sessionId: string,
      eventGeneration?: number,
      eventEpoch?: string,
      terminal = false,
    ) => {
      const lease = promptBusyReleasesRef.current.get(sessionId);
      if (!lease) return;
      if (eventEpoch && lease.epoch && eventEpoch !== lease.epoch) return;
      if (
        typeof eventGeneration === "number" &&
        eventGeneration <= lease.afterGeneration
      )
        return;
      lease.markAccepted();
      if (terminal) {
        promptBusyReleasesRef.current.delete(sessionId);
        lease.markTerminal();
      }
      lease.release();
    },
    [],
  );

  /** Cancel only first-pane navigation work; background reconciliation is separately versioned. */
  const cancelPendingNavigation = useCallback((invalidate = true) => {
    // Abort is advisory: the coordinator advances intent before any resolved
    // continuation can paint, so A → B → A cannot reuse the old authority.
    sessionNavigationCoordinatorRef.current!.cancel(
      invalidate,
      viewedSessionIdRef.current,
    );
    setPaneLoading(null);
    setViewSwitching(false);
  }, []);

  const recordPaneCommit = useCallback((view: SessionViewData) => {
    const startedAt = sessionNavigationCoordinatorRef.current!.consumeStartedAt(
      navigationEpochRef.current,
    );
    if (startedAt === undefined) return;
    const perf = window.performance;
    const elapsedMs = perf.now() - startedAt;
    const source = view.viewSource || "browser-cache";
    if (typeof perf.mark === "function" && typeof perf.measure === "function") {
      perf.mark(`pi-chat:pane-commit:${source}`);
      perf.measure("pi-chat:pane-first-commit", {
        start: startedAt,
        end: perf.now(),
        detail: { sessionId: view.session.id, source, elapsedMs },
      });
    }
    const EventCtor = window.CustomEvent;
    if (typeof EventCtor === "function")
      window.dispatchEvent(
        new EventCtor("pi-chat:pane-first-commit", {
          detail: { sessionId: view.session.id, source, elapsedMs },
        }),
      );
  }, []);

  const commitPane = useCallback(
    (
      action: Extract<
        ConversationPaneAction,
        {
          type:
            "COMMIT_BOOTSTRAP" | "COMMIT_VIEW" | "RESET_DRAFT" | "CLEAR_PANE";
        }
      >,
    ) => {
      const identity =
        action.type === "COMMIT_BOOTSTRAP" || action.type === "COMMIT_VIEW"
          ? action.pane.identity
          : action.type === "RESET_DRAFT"
            ? ({ kind: "draft", sessionId: "" } as const)
            : ({ kind: "none", sessionId: "" } as const);
      const id = identity.kind === "session" ? identity.sessionId : "";
      // This is the only path that changes the pane currently painted by React.
      // Navigation updates desiredSessionIdRef separately and cannot repaint it.
      if (viewedSessionIdRef.current !== id) clearPendingLiveMessage();
      conversationNavigationTargetRef.current = null;
      committedPaneIdentityRef.current = identity;
      const nextCommands =
        action.type === "COMMIT_BOOTSTRAP" || action.type === "COMMIT_VIEW"
          ? action.pane.commands
          : [];
      committedPaneCommandsRef.current = nextCommands;
      rememberConfirmedCommands(nextCommands);
      paneCommitRevisionRef.current += 1;
      if (action.type === "RESET_DRAFT" || action.type === "CLEAR_PANE")
        draftGenerationRef.current += 1;
      viewedSessionIdRef.current = id;
      desiredSessionIdRef.current = id;
      localDraftRef.current = identity.kind === "draft";
      if (!id || !subagentAddressesRef.current.has(id)) rememberSessionId(id);
      dispatchPane(action);
    },
    [clearPendingLiveMessage, rememberConfirmedCommands],
  );

  /**
   * Capture the coordinator facts that authorize an async continuation to alter
   * the visible pane. A matching Session ID alone is insufficient: after
   * A → B → A, an old A request must not replace the newer A pane.
   */
  const capturePaneAuthority = useCallback(
    (sessionId = viewedSessionIdRef.current): PaneAuthoritySnapshot => ({
      sessionId,
      desiredSessionId: desiredSessionIdRef.current,
      runEpochGeneration: runEpochGenerationRef.current,
      navigationEpoch: navigationEpochRef.current,
      committedRevision: paneCommitRevisionRef.current,
      committedIdentity: committedPaneIdentityRef.current,
      draftGeneration: draftGenerationRef.current,
    }),
    [],
  );
  const paneAuthorityCanCommit = useCallback(
    (authority: PaneAuthoritySnapshot) =>
      Boolean(authority.sessionId) &&
      authority.desiredSessionId === authority.sessionId &&
      desiredSessionIdRef.current === authority.sessionId &&
      runEpochGenerationRef.current === authority.runEpochGeneration &&
      navigationEpochRef.current === authority.navigationEpoch &&
      paneCommitRevisionRef.current === authority.committedRevision &&
      committedPaneIdentityRef.current.kind ===
        authority.committedIdentity.kind &&
      committedPaneIdentityRef.current.sessionId ===
        authority.committedIdentity.sessionId &&
      draftGenerationRef.current === authority.draftGeneration,
    [],
  );
  const refreshAuthorityIsCurrent = useCallback(
    (authority: RefreshAuthority) =>
      refreshEpochRef.current === authority.refreshEpoch &&
      runEpochGenerationRef.current === authority.runEpochGeneration &&
      navigationEpochRef.current === authority.navigationEpoch,
    [],
  );
  const captureDraftPaneAuthority = useCallback(
    (): DraftPaneAuthority => ({
      runEpochGeneration: runEpochGenerationRef.current,
      navigationEpoch: navigationEpochRef.current,
      committedRevision: paneCommitRevisionRef.current,
      draftGeneration: draftGenerationRef.current,
    }),
    [],
  );
  const draftAuthorityCanCommit = useCallback(
    (authority: DraftPaneAuthority) =>
      runEpochGenerationRef.current === authority.runEpochGeneration &&
      navigationEpochRef.current === authority.navigationEpoch &&
      draftGenerationRef.current === authority.draftGeneration &&
      committedPaneIdentityRef.current.kind === "draft" &&
      paneCommitRevisionRef.current === authority.committedRevision,
    [],
  );

  // Every session-scoped async action captures the selected view before await.
  // A later response may update that Session cache, but must never paint over a
  // different Session the user navigated to in the meantime.
  const captureViewOperation = () => capturePaneAuthority();
  // A mutation response may still update its own Session cache after ordinary
  // A -> B navigation, but never after a replacement has invalidated process
  // ownership. Keep this narrower than pane authority on purpose.
  const viewOperationIsInCurrentRun = (
    operation: ReturnType<typeof capturePaneAuthority>,
  ) => runEpochGenerationRef.current === operation.runEpochGeneration;
  const viewOperationIsCurrent = (
    operation: ReturnType<typeof capturePaneAuthority>,
  ) =>
    viewOperationIsInCurrentRun(operation) &&
    paneAuthorityCanCommit(operation) &&
    viewedSessionIdRef.current === operation.sessionId;

  /** The only coordinator gateway for an async continuation to paint a pane. */
  const commitPaneIfCurrent = (
    authority: PaneAuthoritySnapshot,
    action: Exclude<
      ConversationPaneAction,
      {
        type:
          | "COMMIT_BOOTSTRAP"
          | "COMMIT_VIEW"
          | "RESET_DRAFT"
          | "CLEAR_PANE"
          | "DRAFT_WORKSPACE_SELECTED";
      }
    >,
  ): boolean => {
    if (!paneAuthorityCanCommit(authority)) return false;
    dispatchPane(action);
    return true;
  };
  const commitDraftIfCurrent = (
    authority: DraftPaneAuthority,
    action: Extract<
      ConversationPaneAction,
      {
        type: "DRAFT_WORKSPACE_SELECTED" | "DRAFT_PROMPT_REJECTED";
      }
    >,
  ): boolean => {
    if (!draftAuthorityCanCommit(authority)) return false;
    dispatchPane(action);
    return true;
  };
  paneAuthorityDispatchRef.current = commitPaneIfCurrent;

  const recordUserTurnLifecycle = (
    phase: string,
    sessionId: string,
    turn: LocalUserTurn | undefined,
    promptId?: string,
    candidateCount?: number,
  ): void => {
    recordBrowserStateDiagnostic("projection", "user-turn-lifecycle", {
      sessionId,
      promptId,
      details: {
        userTurnPhase: phase,
        ...(turn?.serverPromptId || promptId ? { identityBound: true } : null),
        ...(typeof turn?.expectedTurnTotal === "number" ? { expectedTurnTotal: turn.expectedTurnTotal } : null),
        ...(typeof turn?.baselineTurnTotal === "number" ? { baselineTurnTotal: turn.baselineTurnTotal } : null),
        ...(typeof candidateCount === "number" ? { candidateCount } : null),
        projectionSource: phase === "optimistic-created" ? "optimistic" : "pane-commit",
      },
    });
  };

  /** Rehydrate a server-owned accepted turn after F5 without writing it to Pi. */
  const reconcileServerPendingPrompt = useCallback((view: SessionViewData): void => {
    const pending = view.pendingPrompt;
    if (!pending) return;
    const turns = localUserTurnsRef.current.get(view.session.id) || [];
    const existing = localTurnForPendingPrompt(turns, pending);
    const serverPromptId = pending.promptId || pending.message.piChatPromptId;
    const pendingPromptId = pending.id || pending.message.piChatPendingMessageId;
    if (existing) {
      bindLocalTurnPromptIdentity(existing, { serverPromptId, pendingPromptId });
      existing.queueState = "dispatched";
      existing.queueRetryPending = false;
      recordUserTurnLifecycle("server-reconciled", view.session.id, existing, serverPromptId);
      return;
    }
    // A view can beat HTTP acknowledgement while two identical local Prompts
    // are still pending. Content alone is intentionally ambiguous: rehydrating
    // another LocalUserTurn here would create the local+persisted duplicate this
    // reconciliation path is meant to prevent. The existing local turns remain
    // authoritative until their acknowledgement supplies the Server identity.
    if (hasLocalTurnForPendingPayload(turns, pending)) {
      recordUserTurnLifecycle("ambiguous-suppressed", view.session.id, undefined, serverPromptId, turns.filter((turn) => sameUserInstructionForDiagnostic(turn.message, pending.message)).length);
      return;
    }
    const message = { ...pending.message };
    const turn: LocalUserTurn = {
      sessionId: view.session.id,
      message,
      ...(serverPromptId ? { serverPromptId } : null),
      ...(pendingPromptId ? { pendingPromptId } : null),
      expectedTurnTotal: pending.expectedTurnTotal,
      baselineTurnTotal:
        typeof view.turnTotal === "number" && Number.isFinite(view.turnTotal)
          ? view.turnTotal
          : undefined,
      queueState: "dispatched",
      confirmByPosition: Array.isArray(message.content),
      renderedInTranscript: false,
    };
    bindLocalTurnPromptIdentity(turn, { serverPromptId, pendingPromptId });
    localUserTurnsRef.current.set(view.session.id, [...turns, turn]);
    recordUserTurnLifecycle("server-rehydrated", view.session.id, turn, serverPromptId);
  }, []);

  /** Rehydrate native Steers after F5 while keeping their server revision authoritative. */
  const reconcileServerPendingSteers = useCallback((view: SessionViewData): void => {
    if (!Array.isArray(view.pendingSteers)) return;
    const sessionId = view.session.id;
    const incomingRevision = typeof view.pendingSteerRevision === "number"
      ? view.pendingSteerRevision
      : 0;
    const previous = pendingSteerProjectionRef.current.get(sessionId);
    if (previous && incomingRevision < previous.revision) return;
    const items = view.pendingSteers.map((item) => ({ ...item }));
    pendingSteerProjectionRef.current.set(sessionId, {
      revision: incomingRevision,
      items,
    });
    const ids = new Set(items.map((item) => item.id));
    let turns = localUserTurnsRef.current.get(sessionId) || [];
    // A fresh server projection proves which hidden Steers are still waiting;
    // consumed ones must not remain as phantom local turns after a reload.
    for (const turn of [...turns]) {
      if (
        turn.revealOnMessageStart &&
        turn.queueState === "waiting" &&
        turn.queueId &&
        !ids.has(turn.queueId)
      )
        turns = removeLocalTurnAndRebase(turns, turn);
    }
    let expectedTurnTotal = nextLocalTurnTotal(view.messages, view.turnTotal, turns);
    const steeringBaseline =
      typeof view.turnTotal === "number" && Number.isFinite(view.turnTotal)
        ? view.turnTotal
        : undefined;
    for (const item of items) {
      const existing = turns.find((turn) => turn.queueId === item.id);
      if (existing) {
        existing.queueState = "waiting";
        existing.revealOnMessageStart = true;
        continue;
      }
      turns.push({
        sessionId,
        message: {
          role: "user",
          content: item.message,
          timestamp: item.createdAt,
        },
        expectedTurnTotal: expectedTurnTotal++,
        baselineTurnTotal: steeringBaseline,
        queueId: item.id,
        queueState: "waiting",
        revealOnMessageStart: true,
        renderedInTranscript: false,
      });
    }
    if (turns.length) localUserTurnsRef.current.set(sessionId, turns);
    else localUserTurnsRef.current.delete(sessionId);
    syncPendingSteers(sessionId, items);
  }, []);

  /**
   * Settle only IDs confirmed by Pi's native dequeue event. The browser-local
   * turns are a presentation cache; Pi's queue remains the authority for what
   * was actually withdrawn.
   */
  const applyDequeuedSteers = (sessionId: string, ids: string[]) => {
    if (!sessionId || !ids.length) return;
    const withdrawnIds = new Set(ids);
    const pending = localUserTurnsRef.current.get(sessionId) || [];
    const withdrawn = ids.flatMap((id) => {
      const turn = pending.find((candidate) => candidate.queueId === id);
      return turn ? [turn] : [];
    });
    let remaining = pending;
    for (const turn of withdrawn)
      remaining = removeLocalTurnAndRebase(remaining, turn);
    if (remaining.length) localUserTurnsRef.current.set(sessionId, remaining);
    else localUserTurnsRef.current.delete(sessionId);
    const pendingSteers = pendingSteersRef.current.get(sessionId) || [];
    const pendingById = new Map(pendingSteers.map((item) => [item.id, item]));
    syncPendingSteers(
      sessionId,
      pendingSteers.filter((item) => !withdrawnIds.has(item.id)),
    );
    setSteerDequeueingBySession((current) => {
      if (!current[sessionId]) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    if (!withdrawn.length) return;
    const restoredTurnTotal = Math.max(
      sourceTurnTotalsRef.current.get(sessionId) || 0,
      ...remaining.map((turn) => turn.expectedTurnTotal),
    );
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? { ...session, turnCount: restoredTurnTotal }
          : session,
      ),
    );
    if (viewedSessionIdRef.current === sessionId) {
      const withdrawnMessages = new Set(withdrawn.map((turn) => turn.message));
      commitPaneIfCurrent(capturePaneAuthority(sessionId), {
        type: "PROMPT_ACKNOWLEDGED",
        sessionId,
        messages: (current) =>
          current.filter((message) => !withdrawnMessages.has(message)),
      });
    }
    const sequence = ++draftRestorationIntentSequenceRef.current;
    const drafts = withdrawn.map((turn) =>
      promptDraftFromMessage(
        turn.message,
        pendingById.get(turn.queueId || "")?.message || "",
      ),
    );
    const expectedDraftRevision =
      steerDequeueExpectedDraftRevisionRef.current.get(sessionId) ??
      composerDraftRevisionsRef.current.get(
        composerDraftKeyId({ kind: "session", sessionId }),
      ) ??
      0;
    steerDequeueExpectedDraftRevisionRef.current.delete(sessionId);
    const key: ComposerDraftKey = { kind: "session", sessionId };
    const keyId = composerDraftKeyId(key);
    if (
      sequence >
      (appliedDraftRestorationSequencesRef.current.get(keyId) || 0)
    ) {
      appliedDraftRestorationSequencesRef.current.set(keyId, sequence);
      setRestoredComposerDrafts((current) => ({
        ...current,
        [keyId]: {
          key,
          revision: sequence,
          expectedDraftRevision,
          message: drafts.map((draft) => draft.message).filter(Boolean).join("\n\n"),
          images: drafts.flatMap((draft) => draft.images),
          prepend: true,
        },
      }));
    }
  };

  // Bootstrap owns application-wide metadata. Keep it separate from the selected
  // view so a refresh can restore a remembered cold Session without briefly
  // committing the Primary Runtime's blank draft to the timeline.
  const applySidebarInventory = useCallback(
    (data: {
      sessions: SessionSummary[];
      sessionsTotal?: number;
      sessionDirectories?: SessionDirectorySummary[];
    }) => {
      // A remembered JSONL view can win the startup race. A completed bootstrap
      // or the independent sidebar endpoint may establish the inventory, but a
      // single restored pane must never manufacture a one-row sidebar.
      sidebarInventoryReadyRef.current = true;
      setSidebarInventoryReady(true);
      for (const session of data.sessions) {
        if (
          typeof session.turnCount === "number" &&
          Number.isFinite(session.turnCount)
        )
          recordSourceTurnTotal(session.id, session.turnCount);
      }
      const replaceAfterTransportRecovery = transportRecoveryPendingRef.current;
      if (replaceAfterTransportRecovery) {
        transportRecoveryPendingRef.current = false;
        // A token may belong to a replacement service. Replace the base page
        // atomically instead of merging process-A rows into process-B.
        sessionRunningOverridesRef.current.clear();
        setSessions(reconcileOptimisticSessions(data.sessions));
      } else {
        commitSidebarSessions(data.sessions, { kind: "base" });
      }
      setSessionsTotal(
        optimisticSessionsTotal(
          data.sessions,
          data.sessionsTotal ?? data.sessions.length,
        ),
      );
      setSessionDirectories(data.sessionDirectories || []);
      // During a slow bootstrap, directory grouping needs a stable current cwd
      // to leave the restored Session's group open. The full bootstrap remains
      // authoritative and replaces this temporary JSONL-derived value later.
      setWorkspaceCwd((current) => {
        if (current) return current;
        const preferredId =
          viewedSessionIdRef.current || desiredSessionIdRef.current;
        return (
          data.sessions.find((session) => session.id === preferredId)?.cwd ||
          data.sessions[0]?.cwd ||
          current
        );
      });
    },
    [],
  );

  /**
   * A ready SSE frame only says Primary passed startup; it does not carry the
   * selected model's input shape. Release the provisional capability UI only
   * after a Bootstrap response has been committed for that same model.
   */
  const confirmPrimaryCapabilitySnapshot = useCallback(
    (data: BootstrapData, committedModel: ModelInfo | null | undefined) => {
      const readiness = data.primaryRuntime;
      const committedModelKey = modelCapabilityKey(committedModel);
      const modelKeys = [data.state.model, ...data.models]
        .map(modelCapabilityKey)
        .filter(Boolean);
      if (
        readiness?.status !== "ready" ||
        primaryRuntimeRef.current.status !== "ready" ||
        primaryRuntimeRef.current.generation !== readiness.generation ||
        !committedModelKey ||
        !modelKeys.includes(committedModelKey)
      )
        return;
      const snapshot = {
        generation: readiness.generation,
        modelKeys: [...new Set(modelKeys)],
      };
      publishPrimaryCapabilitySnapshot(snapshot);
    },
    [],
  );

  const applyBootstrapMetadata = useCallback(
    (data: BootstrapData) => {
      applySidebarInventory(data);
      const activeId =
        data.activeSessionId ||
        data.sessions.find((session) => session.active)?.id ||
        "";
      rememberConfirmedCommands(data.commands);
      setActiveSessionId(activeId);
      const hotIds = data.activeSessionIds || (activeId ? [activeId] : []);
      setActiveSessionIds(hotIds);
      viewCacheRef.current.setPinned(hotIds);
      // A recovering Runtime can briefly return an empty model inventory while
      // its selected Session model is already known. Retain the last usable
      // choices through that transient snapshot. A selected model alone is not
      // an inventory, so do not discard a previously selectable catalogue.
      const modelInventoryPending =
        typeof data.modelInventoryPending === "boolean"
          ? data.modelInventoryPending
          : data.primaryRuntime?.status !== "ready";
      setModelRuntimeSyncPending(data.modelRuntimeSyncPending === true);
      const discoveredModels = mergeModelCatalog([], data.models);
      if (!modelInventoryPending) {
        // A completed empty discovery is authoritative for this generation;
        // stale cached alternatives must not remain presented as current.
        setModels(
          discoveredModels.length
            ? discoveredModels
            : data.state.model
              ? mergeModelCatalog([], [data.state.model])
              : [],
        );
      } else if (discoveredModels.length) {
        // Startup-only custom models are useful immediately, but the Runtime
        // may still publish more choices once it is ready.
        setModels((current) => mergeModelCatalog(current, discoveredModels));
      } else if (data.state.model) {
        setModels((current) => mergeModelCatalog(current, [data.state.model!]));
      }
      setModelInventoryConfirmed(!modelInventoryPending);
      const workspaceEpoch =
        typeof data.workspaceEpoch === "string" ? data.workspaceEpoch : "";
      const workspaceRevision =
        typeof data.workspaceRevision === "number" &&
        Number.isFinite(data.workspaceRevision)
          ? data.workspaceRevision
          : 0;
      // Bootstrap may finish before EventSource connects. Record its process epoch
      // so the first ready frame from a replacement service is detectable.
      if (!runEpochRef.current && workspaceEpoch)
        runEpochRef.current = workspaceEpoch;
      if (
        !workspaceEpochRef.current ||
        workspaceEpoch === workspaceEpochRef.current
      ) {
        if (workspaceRevision >= workspaceRevisionRef.current) {
          workspaceEpochRef.current =
            workspaceEpoch || workspaceEpochRef.current;
          workspaceRevisionRef.current = workspaceRevision;
          setWorkspaceCwd(data.workspaceCwd);
        }
      }
      const identity = data.buildIdentity || webBuildIdentity;
      setServerBuildIdentity(identity);
      if (data.piVersion) setPiVersion(data.piVersion);
      setBuildIdentityMismatch(!buildIdentityMatches(identity));
      const readiness = data.primaryRuntime || {
        status: "starting" as const,
        generation: 0,
      };
      const acceptedReadiness = acceptPrimaryReadiness(
        primaryRuntimeRef.current,
        readiness,
      );
      publishPrimaryReadiness(acceptedReadiness);
      publishApplicationLifecycle(
        acceptApplicationLifecycle(
          applicationLifecycleRef.current,
          data.applicationLifecycle || "idle",
        ),
      );
    },
    [applySidebarInventory, rememberConfirmedCommands],
  );

  const applyBootstrap = useCallback(
    (
      data: BootstrapData,
      authority?: PaneAuthoritySnapshot,
      queueRequestRevision?: number,
    ) => {
      if (authority && !paneAuthorityCanCommit(authority)) {
        recordBrowserStateDiagnostic("projection", "bootstrap-rejected", {
          details: {
            authorityPresent: true,
            decisionReason: "stale-pane-authority",
          },
        });
        return;
      }
      const activeViewId =
        data.activeSessionId ||
        data.sessions.find((item) => item.active)?.id ||
        "";
      recordBrowserStateDiagnostic("projection", "bootstrap-received", {
        sessionId: activeViewId,
        details: {
          stateStreaming: data.state.isStreaming,
          hasLive: Boolean(data.liveMessage),
          toolActive: Boolean(data.toolStatus),
          queuePaused: data.queuePaused,
          queueLength: data.queue.length,
          sessionRunning:
            data.sessions.find((item) => item.id === activeViewId)?.running === true,
        },
      });
      recordBrowserStateDiagnostic("projection", "bootstrap-accepted", {
        sessionId: activeViewId,
        details: {
          authorityPresent: Boolean(authority),
          decisionReason: "accepted",
        },
      });
      const bootstrapProjection = activeViewId
        ? queueRequestRevision === undefined
          ? acceptQueueProjection(activeViewId, data.queue, data.queuePaused)
          : acceptQueueProjectionIfCurrent(
              activeViewId,
              queueRequestRevision,
              data.queue,
              data.queuePaused,
            )
        : { queue: data.queue, paused: data.queuePaused };
      const bootstrapQueue = bootstrapProjection.queue;
      const bootstrapSessions = data.sessions.map((session) =>
        session.id === activeViewId
          ? applySidebarQueueProjection(
              session,
              bootstrapQueue,
              bootstrapProjection.paused,
            )
          : session,
      );
      const activeViewSession = bootstrapSessions.find(
        (session) => session.id === activeViewId,
      );
      const sourceView = activeViewSession
        ? rememberSessionView({
            session: activeViewSession,
            state: data.state,
            messages: data.messages,
            forkOrigin: data.forkOrigin,
            messageTotal: data.messageTotal ?? data.messages.length,
            turnTotal: data.turnTotal,
            visibleTurnCount: data.visibleTurnCount,
            messagesTruncated: data.messagesTruncated === true,
            isActive: true,
            runtimeStatus: "active",
            isStreaming: data.state.isStreaming,
            liveMessage: data.liveMessage,
            toolStatus: data.toolStatus,
            stats: data.stats,
            queue: bootstrapQueue,
            queuePaused: bootstrapProjection.paused,
            commands: data.commands,
            pendingExtensionRequest: data.pendingExtensionRequest,
            pendingPrompt: data.pendingPrompt,
            pendingSteers: data.pendingSteers,
            pendingSteerRevision: data.pendingSteerRevision,
          })
        : null;
      if (sourceView) {
        reconcileServerPendingPrompt(sourceView);
        reconcileServerPendingSteers(sourceView);
      }
      reconcileQueuedAdmissions(activeViewId, sourceView?.queue || bootstrapQueue);
      const bootstrapLocalTurns = localUserTurnsRef.current.get(activeViewId) || [];
      promoteTurnsAbsentFromQueue(
        bootstrapLocalTurns,
        new Set(bootstrapQueue.map((item) => item.id)),
        Boolean(
          sourceView?.isStreaming
          || sourceView?.state.isStreaming
          || sourceView?.session.running
          || sourceView?.liveMessage
          || sourceView?.toolStatus,
        ),
        Boolean(activeViewId),
        cancellingQueueIdsRef.current.get(activeViewId),
      );
      const protectedTranscript = protectTranscriptWithLocalTurns(
        localUserTurnsRef.current.get(activeViewId),
        sourceView?.messages || data.messages,
        sourceView?.messageTotal ?? data.messageTotal,
        sourceView?.turnTotal ?? data.turnTotal,
        sourceView?.messagesTruncated ?? data.messagesTruncated === true,
        new Set(bootstrapQueue.map((item) => item.id)),
      );
      rememberConfirmedQueueDispatchIds(
        activeViewId,
        bootstrapLocalTurns,
        protectedTranscript.pendingTurns,
        sourceView?.messages || data.messages,
        sourceView?.turnTotal ?? data.turnTotal,
        sourceView?.messagesTruncated ?? data.messagesTruncated === true,
      );
      if (protectedTranscript.pendingTurns.length) {
        protectedTranscript.pendingTurns.forEach((turn) => {
          turn.renderedInTranscript = localTurnBelongsInTranscript(turn);
        });
        localUserTurnsRef.current.set(
          activeViewId,
          protectedTranscript.pendingTurns,
        );
      } else localUserTurnsRef.current.delete(activeViewId);
      applyBootstrapMetadata({
        ...data,
        sessions: bootstrapSessions,
        queue: bootstrapQueue,
        queuePaused: bootstrapProjection.paused,
      });
      if (activeViewId) updateGateMode(activeViewId, data.gateMode);
      if (!activeViewId) {
        // A boot with no restored Session is the same user intent as pressing
        // New: keep history in the sidebar, but make the writable default cwd
        // explicit before the first prompt. The Runtime state supplies the
        // default display; only an explicit control click creates a selection.
        commitPane({
          type: "RESET_DRAFT",
          model: data.state.model,
          thinkingLevel: data.state.thinkingLevel,
          draftWorkspaceCwd: data.workspaceCwd,
        });
        recordBrowserStateDiagnostic("projection", "bootstrap-committed", {
          details: { paneKind: "draft", decisionReason: "committed" },
        });
        confirmPrimaryCapabilitySnapshot(data, data.state.model);
        return;
      }
      const staged = pendingSessionPrefsRef.current.get(activeViewId);
      const committedModel =
        staged?.model !== undefined ? staged.model : data.state.model;
      commitPane({
        type: "COMMIT_BOOTSTRAP",
        pane: {
          ...emptyConversationPane(),
          identity: { kind: "session", sessionId: activeViewId },
          // Keep Runtime/JSONL facts separate from the Composer's desired
          // next-turn selection. Conversation metadata must never be painted
          // as if an unsubmitted Model/Thinking choice had already run.
          piState: data.state,
          messages: protectedTranscript.messages,
          forkOrigin: data.forkOrigin,
          messageTotal: protectedTranscript.messageTotal,
          turnTotal: protectedTranscript.turnTotal,
          runStartedAt: activeViewSession?.activity?.runStartedAt ?? null,
          lastRunDurationMs: activeViewSession?.activity?.lastRunDurationMs ?? null,
          visibleTurnCount:
            data.visibleTurnCount ??
            protectedTranscript.messages.filter(
              (message) => message.role === "user",
            ).length,
          messagesTruncated: data.messagesTruncated === true,
          stats: data.stats,
          liveMessage: sourceView?.liveMessage || data.liveMessage || null,
          // A starting/busy Runtime may return an empty command inventory. Do
          // not let a transient empty list wipe out already-confirmed slash
          // commands on a later refresh of the same committed Session.
          commands:
            data.commands.length
              ? data.commands
              : committedPaneIdentityRef.current.kind === "session" &&
                  committedPaneIdentityRef.current.sessionId === activeViewId
                ? committedPaneCommandsRef.current
                : [],
          queue: bootstrapQueue,
          queuePaused: bootstrapProjection.paused,
          toolStatus: data.toolStatus || "",
          extensionRequest: data.pendingExtensionRequest || null,
          runtimeStatus: "active",
          control: {
            controlOwner: data.controlOwner,
            controlledByThisWindow: data.controlledByThisWindow,
          },
        },
      });
      recordBrowserStateDiagnostic("projection", "bootstrap-committed", {
        sessionId: activeViewId,
        details: { paneKind: "session", decisionReason: "committed" },
      });
      confirmPrimaryCapabilitySnapshot(data, committedModel);
    },
    [
      applyBootstrapMetadata,
      confirmPrimaryCapabilitySnapshot,
      commitPane,
      reconcileServerPendingPrompt,
      reconcileServerPendingSteers,
      paneAuthorityCanCommit,
      updateGateMode,
    ],
  );

  const tryAutoAllowGate = useCallback(
    (
      request: ExtensionUiRequest,
      sessionId: string,
      authority: PaneAuthoritySnapshot,
      clearVisibleRequest = false,
    ): boolean => {
      const details =
        gateModesRef.current[sessionId] === "open"
          ? describeGateRequest(request)
          : null;
      if (!details || buildIdentityMismatch) return false;
      // A normalized Session view commits its own null request atomically. Only
      // a synchronous SSE request needs an immediate visible clear here.
      if (clearVisibleRequest)
        dispatchPane({
          type: "EXTENSION_REQUEST_CHANGED",
          sessionId,
          request: null,
        });
      void api
        .respondToExtension({
          id: request.id,
          value: details.allowValue,
          sessionId,
        })
        .then(() => {
          if (paneAuthorityCanCommit(authority))
            setNotice("已按放行模式自动允许受保护操作");
        })
        .catch((cause) => {
          if (paneAuthorityCanCommit(authority))
            setError(cause instanceof Error ? cause.message : String(cause));
        });
      return true;
    },
    [buildIdentityMismatch, paneAuthorityCanCommit],
  );

  /** Release an abort lease only for its owning Session (or explicitly all). */
  const clearStoppingForSession = useCallback(
    (sessionId?: string, operationToken?: symbol): boolean => {
      const leases = stoppingOperationTokensRef.current;
      if (!sessionId) {
        const hadLeases = leases.size > 0;
        leases.clear();
        if (hadLeases) setStoppingSessionIds([]);
        return hadLeases;
      }
      const currentToken = leases.get(sessionId);
      if (!currentToken || (operationToken && currentToken !== operationToken))
        return false;
      leases.delete(sessionId);
      setStoppingSessionIds((current) =>
        current.filter((candidate) => candidate !== sessionId),
      );
      return true;
    },
    [],
  );

  const applySessionView = useCallback(
    (
      view: SessionViewData,
      authority?: ReturnType<typeof capturePaneAuthority> | DraftPaneAuthority,
      queueRequestRevision?: number,
    ) => {
      recordBrowserStateDiagnostic("projection", "session-view-received", {
        sessionId: view.session.id,
        details: {
          viewSource: view.viewSource || "unknown",
          stateStreaming: view.state.isStreaming,
          viewStreaming: view.isStreaming,
          sessionRunning: view.session.running === true,
          hasLive: Boolean(view.liveMessage),
          toolActive: Boolean(view.toolStatus),
          queuePaused: view.queuePaused === true,
          queueLength: view.queue?.length || 0,
          authorityPresent: Boolean(authority),
        },
      });
      // A structural deletion is terminal. An already-resolved view continuation
      // must not recreate its cache, sidebar row, or selected pane.
      if (confirmedDeletedSessionIdsRef.current.has(view.session.id)) {
        recordBrowserStateDiagnostic("projection", "session-view-rejected", {
          sessionId: view.session.id,
          details: { decisionReason: "session-deleted" },
        });
        return;
      }
      // The coordinator, not the reducer, proves that this result still belongs
      // to the visible pane. Session ID alone cannot protect A → B → A.
      if (authority) {
        const paneAuthority = "sessionId" in authority;
        const allowed = paneAuthority
          ? paneAuthorityCanCommit(authority)
          : draftAuthorityCanCommit(authority);
        if (!allowed) {
          recordBrowserStateDiagnostic("projection", "session-view-rejected", {
            sessionId: view.session.id,
            details: {
              authorityPresent: true,
              decisionReason: paneAuthority
                ? "stale-pane-authority"
                : "stale-draft-authority",
            },
          });
          return;
        }
      }
      recordBrowserStateDiagnostic("projection", "session-view-accepted", {
        sessionId: view.session.id,
        details: {
          authorityPresent: Boolean(authority),
          decisionReason: "accepted",
        },
      });
      // A compaction_end or settlement frame is terminal for the preceding UI
      // phase. Hot-memory views may still contain both `isCompacting: true` and
      // the pre-compaction tool's terminal label; neither may relock the composer
      // or resurrect a misleading “bash completed” banner. A later agent/tool
      // start clears this fence before its new status is admitted.
      const normalizedView = completedCompactionSessionIdsRef.current.has(
        view.session.id,
      )
        ? {
            ...view,
            toolStatus: "",
            state: { ...view.state, isCompacting: false },
          }
        : view;
      // Cache the source view before adding local UI overlays. A cached overlay has
      // a synthetic turnTotal and must never confirm that its own user message was
      // persisted when the user switches away and returns.
      const queueProjection = queueProjectionForView(
        normalizedView.session.id,
        normalizedView.queue,
        normalizedView.queuePaused === true,
        queueRequestRevision,
      );
      const filteredQueue = queueProjection.queue;
      const queueFilteredView = queueProjection.known
        ? {
            ...normalizedView,
            session: applySidebarQueueProjection(
              normalizedView.session,
              filteredQueue,
              queueProjection.paused,
            ),
            queue: filteredQueue,
            queuePaused: queueProjection.paused,
          }
        : filteredQueue.length || queueProjection.paused
          ? {
              ...normalizedView,
              session: applySidebarQueueProjection(
                normalizedView.session,
                filteredQueue,
                queueProjection.paused,
              ),
              queue: filteredQueue,
              queuePaused: queueProjection.paused,
            }
          : normalizedView;
      const sourceView = viewCacheRef.current.remember(queueFilteredView);
      reconcileServerPendingPrompt(sourceView);
      reconcileServerPendingSteers(sourceView);
      // A normalized view is stronger than an earlier local abort intent. Do
      // not leave a completed Session with a stale stop lease.
      if (!sourceView.isStreaming)
        clearStoppingForSession(sourceView.session.id);
      // A committed pane reached through navigation is the browser-local
      // definition of having viewed its latest available reply. Background
      // reconcile/refresh of the already-open pane must not consume an unseen
      // marker before the user actually selects that conversation.
      if (sourceView.session.id !== viewedSessionIdRef.current) {
        terminalAssistantSessionIdsRef.current.delete(sourceView.session.id);
        setUnseenReplySessionIds((current) =>
          current.filter((id) => id !== sourceView.session.id),
        );
      }
      recordSourceTurnTotal(
        sourceView.session.id,
        sourceView.turnTotal ??
          sourceView.messages.filter((message) => message.role === "user")
            .length,
      );
      reconcileQueuedAdmissions(sourceView.session.id, sourceView.queue);
      const viewLocalTurns = localUserTurnsRef.current.get(sourceView.session.id) || [];
      // `queue` is optional on historical/read-only views. Missing means
      // unknown, not an authoritative empty queue; only an explicit array may
      // promote a locally admitted turn after a missed dispatch event.
      if (queueProjection.known)
        promoteTurnsAbsentFromQueue(
          viewLocalTurns,
          new Set(filteredQueue.map((item) => item.id)),
          Boolean(
            sourceView.isStreaming
            || sourceView.state.isStreaming
            || sourceView.session.running
            || sourceView.liveMessage
            || sourceView.toolStatus,
          ),
          queueProjection.known,
          cancellingQueueIdsRef.current.get(sourceView.session.id),
        );
      const protectedTranscript = protectTranscriptWithLocalTurns(
        localUserTurnsRef.current.get(sourceView.session.id),
        sourceView.messages,
        sourceView.messageTotal,
        sourceView.turnTotal,
        sourceView.messagesTruncated,
        queueProjection.known
          ? new Set(filteredQueue.map((item) => item.id))
          : undefined,
      );
      rememberConfirmedQueueDispatchIds(
        sourceView.session.id,
        viewLocalTurns,
        protectedTranscript.pendingTurns,
        sourceView.messages,
        sourceView.turnTotal,
        sourceView.messagesTruncated,
      );
      if (protectedTranscript.pendingTurns.length) {
        protectedTranscript.pendingTurns.forEach((turn) => {
          turn.renderedInTranscript = localTurnBelongsInTranscript(turn);
        });
        localUserTurnsRef.current.set(
          sourceView.session.id,
          protectedTranscript.pendingTurns,
        );
      } else localUserTurnsRef.current.delete(sourceView.session.id);
      const resolvedView = protectedTranscript.pendingTurns.length
        ? {
            ...sourceView,
            messages: protectedTranscript.messages,
            messageTotal: protectedTranscript.messageTotal,
            turnTotal: protectedTranscript.turnTotal,
          }
        : sourceView;
      // A view reports the Runtime-confirmed value only. A staged cold choice
      // remains a display/send preference and must never gain Gate authority.
      updateGateMode(sourceView.session.id, view.gateMode);
      const nextRuntimeStatus =
        resolvedView.runtimeStatus ||
        (resolvedView.isActive ? "active" : "view-only");
      // Same open-mode auto-allow path for pending requests restored via view/bootstrap.
      const pending = view.pendingExtensionRequest || null;
      const paneAuthority =
        authority && "sessionId" in authority
          ? authority
          : capturePaneAuthority(view.session.id);
      const extensionRequest =
        pending && !tryAutoAllowGate(pending, view.session.id, paneAuthority)
          ? pending
          : null;
      commitPane({
        type: "COMMIT_VIEW",
        pane: {
          ...emptyConversationPane(),
          identity: { kind: "session", sessionId: resolvedView.session.id },
          piState: {
            ...resolvedView.state,
            // A cold JSONL view can commit before the global sidebar inventory.
            // Keep its own identity metadata in the same atomic pane projection.
            sessionName: resolvedView.session.name,
          },
          messages: resolvedView.messages,
          forkOrigin: resolvedView.forkOrigin,
          messageTotal: resolvedView.messageTotal,
          turnTotal:
            resolvedView.turnTotal ??
            resolvedView.messages.filter((message) => message.role === "user")
              .length,
          visibleTurnCount:
            resolvedView.visibleTurnCount ??
            resolvedView.messages.filter((message) => message.role === "user")
              .length,
          messagesTruncated: resolvedView.messagesTruncated,
          runStartedAt: resolvedView.session.activity?.runStartedAt ?? null,
          lastRunDurationMs: resolvedView.session.activity?.lastRunDurationMs ?? null,
          stats: resolvedView.stats,
          liveMessage: resolvedView.liveMessage || null,
          // A partial refresh of the *currently committed* Session may omit
          // command discovery (or the busy Runtime returns an empty inventory).
          // Only an explicit non-empty list replaces the last confirmed one;
          // an empty array must never wipe out working slash completions.
          commands:
            resolvedView.commands?.length
              ? resolvedView.commands
              : committedPaneIdentityRef.current.kind === "session" &&
                  committedPaneIdentityRef.current.sessionId ===
                    resolvedView.session.id
                ? committedPaneCommandsRef.current
                : [],
          queue: resolvedView.queue || [],
          queuePaused: queueProjection.paused,
          toolStatus: resolvedView.toolStatus || "",
          extensionRequest,
          runtimeStatus: nextRuntimeStatus,
          control: {
            controlOwner:
              sourceView.controlOwner ?? sourceView.session.controlOwner,
            controlledByThisWindow:
              sourceView.controlledByThisWindow ??
              sourceView.session.controlledByThisWindow,
          },
          gateAvailableOverride:
            typeof view.gateAvailable === "boolean" ? view.gateAvailable : null,
        },
      });
      if (nextRuntimeStatus === "active")
        setRuntimeWarming(resolvedView.session.id, false);
      setPaneLoading((current) =>
        current?.sessionId === resolvedView.session.id ? null : current,
      );
      recordPaneCommit(resolvedView);
      recordBrowserStateDiagnostic("projection", "session-view-committed", {
        sessionId: resolvedView.session.id,
        details: {
          decisionReason: "committed",
          stateStreaming: resolvedView.state.isStreaming,
          viewStreaming: resolvedView.isStreaming,
          sessionRunning: resolvedView.session.running === true,
          hasLive: Boolean(resolvedView.liveMessage),
          toolActive: Boolean(resolvedView.toolStatus),
          queuePaused: queueProjection.paused,
          queueLength: resolvedView.queue?.length || 0,
          runtimeStatus: nextRuntimeStatus,
        },
      });
      // A blank New draft has no persisted user message and intentionally stays
      // out of sidebar history until its first successful prompt. A remembered
      // Session may restore before bootstrap; update an existing row, but do not
      // turn that one restored pane into a fake one-item sidebar. Addressed
      // Subagent transcripts are never ordinary inventory, even when non-empty.
      const isSubagentView = subagentAddressesRef.current.has(view.session.id);
      if (!isSubagentView && view.session.messageCount > 0) {
        const summary = applyLocalTurnCount(
          normalizeSessionRunning(view.session),
        );
        setSessions((current) => {
          const known = current.some((session) => session.id === summary.id);
          if (!known && !sidebarInventoryReadyRef.current) return current;
          return uniqueSessionSummaries(
            known
              ? current.map((session) =>
                  session.id === summary.id
                    ? { ...session, ...summary }
                    : session,
                )
              : [...current, summary],
          );
        });
      }
      if (!isSubagentView && view.isActive)
        setActiveSessionIds((current) => [
          ...new Set([...current, view.session.id]),
        ]);
    },
    [
      capturePaneAuthority,
      commitPane,
      tryAutoAllowGate,
      draftAuthorityCanCommit,
      paneAuthorityCanCommit,
      recordPaneCommit,
      reconcileServerPendingPrompt,
      reconcileServerPendingSteers,
      setRuntimeWarming,
      tryAutoAllowGate,
      updateGateMode,
      clearStoppingForSession,
    ],
  );

  const ensureHandshake = useCallback(
    (refreshEpoch: number, runEpochGeneration: number) => {
      const current = handshakeInFlightRef.current;
      if (
        current &&
        current.refreshEpoch === refreshEpoch &&
        current.runEpochGeneration === runEpochGeneration
      )
        return current.request;
      if (current) {
        // Keep the same service token generation, but prevent this refresh from
        // joining a promise whose authority closure belongs to an older refresh.
        api.detachHandshake();
        handshakeInFlightRef.current = null;
      }
      const request = api
        .handshake()
        .then((handshake) => {
          if (
            refreshEpochRef.current !== refreshEpoch ||
            runEpochGenerationRef.current !== runEpochGeneration
          )
            return false;
          api.acceptHandshake(handshake);
          setServerBuildIdentity(handshake.buildIdentity);
          setBuildIdentityMismatch(
            !buildIdentityMatches(handshake.buildIdentity),
          );
          return true;
        })
        .finally(() => {
          if (handshakeInFlightRef.current?.request === request)
            handshakeInFlightRef.current = null;
        });
      handshakeInFlightRef.current = {
        refreshEpoch,
        runEpochGeneration,
        request,
      };
      return request;
    },
    [],
  );

  const loadBootstrap = useCallback(() => {
    if (bootstrapInFlightRef.current) return bootstrapInFlightRef.current;
    // api.bootstrap() performs the lightweight handshake only for the real
    // transport. Keeping this seam direct preserves test/local adapters that
    // supply a complete authenticated bootstrap projection themselves.
    const request = api.bootstrap().finally(() => {
      if (bootstrapInFlightRef.current === request)
        bootstrapInFlightRef.current = null;
    });
    bootstrapInFlightRef.current = request;
    return request;
  }, []);

  const refresh = useCallback(async () => {
    const refreshAuthority: RefreshAuthority = {
      refreshEpoch: ++refreshEpochRef.current,
      runEpochGeneration: runEpochGenerationRef.current,
      navigationEpoch: navigationEpochRef.current,
    };
    const { refreshEpoch, runEpochGeneration, navigationEpoch } =
      refreshAuthority;
    const wantedId =
      desiredSessionIdRef.current ||
      viewedSessionIdRef.current ||
      rememberedSessionId();
    // Startup/reload may know the desired persisted Session before a pane has
    // committed. Establish intent before capturing authority for bootstrap.
    if (wantedId && !desiredSessionIdRef.current)
      desiredSessionIdRef.current = wantedId;
    const requestVersion = wantedId
      ? sessionEventVersionRef.current.get(wantedId) || 0
      : 0;
    const wantedQueueRequestRevision = wantedId
      ? queueProjectionRevisionRef.current.get(wantedId) || 0
      : 0;
    const queueRevisionSnapshot = new Map(queueProjectionRevisionRef.current);
    const bootstrapAuthority = wantedId
      ? capturePaneAuthority(wantedId)
      : undefined;
    let earlyViewRequest: Promise<SessionViewData> | null = null;
    let earlyViewAuthority: ReturnType<typeof capturePaneAuthority> | null =
      null;
    let earlyViewTimer: number | null = null;
    let earlySidebarInventoryTimer: number | null = null;
    // A rejected bootstrap must not suppress the independent JSONL fallback.
    // Only a successfully committed bootstrap makes its metadata redundant.
    let bootstrapSucceeded = false;
    const startEarlyHistoryView = () => {
      const currentInitialHistory = initialHistoryRef.current;
      if (
        !refreshAuthorityIsCurrent(refreshAuthority) ||
        bootstrapSucceeded ||
        !wantedId ||
        viewedSessionIdRef.current ||
        localDraftRef.current ||
        (currentInitialHistory?.id === wantedId &&
          currentInitialHistory.refreshEpoch === refreshEpoch &&
          currentInitialHistory.runEpochGeneration === runEpochGeneration)
      )
        return;
      desiredSessionIdRef.current = wantedId;
      earlyViewAuthority = capturePaneAuthority(wantedId);
      const requestQueueRevision =
        queueProjectionRevisionRef.current.get(wantedId) || 0;
      const request = ensureHandshake(refreshEpoch, runEpochGeneration)
        .then((accepted) => {
          if (!accepted) throw new Error("stale handshake");
          return fetchSessionView(wantedId);
        })
        .finally(() => {
          if (initialHistoryRef.current?.request === request)
            initialHistoryRef.current = null;
        });
      initialHistoryRef.current = {
        id: wantedId,
        refreshEpoch,
        runEpochGeneration,
        request,
      };
      earlyViewRequest = request;
      void request
        .then((view) => {
          if (
            !refreshAuthorityIsCurrent(refreshAuthority) ||
            desiredSessionIdRef.current !== wantedId ||
            localDraftRef.current ||
            confirmedDeletedSessionIdsRef.current.has(wantedId) ||
            !earlyViewAuthority ||
            !paneAuthorityCanCommit(earlyViewAuthority)
          )
            return;
          applySessionView(view, earlyViewAuthority, requestQueueRevision);
        })
        .catch(() => undefined);
    };
    const bootstrapRequest = loadBootstrap();
    // Normal reloads resolve bootstrap in a few milliseconds. Waiting briefly
    // prevents its Primary get_state from racing an unnecessary remembered view.
    // If startup is genuinely slow, cold JSONL still paints independently.
    if (wantedId && !viewedSessionIdRef.current && !localDraftRef.current)
      earlyViewTimer = window.setTimeout(
        startEarlyHistoryView,
        EARLY_HISTORY_VIEW_DELAY_MS,
      );
    // The sidebar is pure JSONL metadata and must not remain blank behind
    // bootstrap's model/command/stats probes. This endpoint never reads the
    // Primary Runtime, so it remains useful immediately after an app restart.
    earlySidebarInventoryTimer = window.setTimeout(() => {
      if (bootstrapSucceeded || sidebarInventoryReadyRef.current) return;
      void api
        .sessions(showAllSessionsRef.current)
        .then((result) => {
          if (
            refreshEpochRef.current !== refreshEpoch ||
            runEpochGenerationRef.current !== runEpochGeneration ||
            bootstrapSucceeded
          )
            return;
          applySidebarInventory({
            sessions: result.sessions,
            sessionsTotal: result.total,
            sessionDirectories: result.directories,
          });
        })
        .catch(() => undefined);
    }, EARLY_SIDEBAR_INVENTORY_DELAY_MS);
    let data: BootstrapData;
    try {
      data = await bootstrapRequest;
    } catch (cause) {
      // Browser requests remain uncancelled across handoff. A rejected A
      // bootstrap must not reach its old caller's error UI after B takes over.
      if (!refreshAuthorityIsCurrent(refreshAuthority)) return;
      throw cause;
    }
    // An old process request can resolve after a replacement ready has started
    // a newer refresh. It must not mark that new epoch bootstrapped or cancel
    // its independent history/sidebar fallback timers.
    if (!refreshAuthorityIsCurrent(refreshAuthority)) {
      recordBrowserStateDiagnostic("projection", "bootstrap-rejected", {
        details: {
          authorityPresent: true,
          decisionReason: "stale-refresh-authority",
        },
      });
      return;
    }
    bootstrapSucceeded = true;
    bootstrapCompletedRef.current = true;
    if (earlyViewTimer !== null) window.clearTimeout(earlyViewTimer);
    if (earlySidebarInventoryTimer !== null)
      window.clearTimeout(earlySidebarInventoryTimer);
    if (
      wantedId &&
      viewedSessionIdRef.current === wantedId &&
      (sessionEventVersionRef.current.get(wantedId) || 0) !== requestVersion
    ) {
      applyBootstrapMetadata(data);
      return;
    }
    // A local New draft intentionally has no Pi Session yet. Reconnect/bootstrap
    // may refresh global metadata, but must not replace its unsent composer.
    if (localDraftRef.current) {
      const activeQueueSessionId =
        data.activeSessionId ||
        data.sessions.find((session) => session.active)?.id ||
        "";
      const filteredActiveProjection = activeQueueSessionId
        ? acceptQueueProjectionIfCurrent(
            activeQueueSessionId,
            queueRevisionSnapshot.get(activeQueueSessionId) || 0,
            data.queue,
            data.queuePaused,
          )
        : { queue: data.queue, paused: data.queuePaused };
      const filteredActiveQueue = filteredActiveProjection.queue;
      const filteredData = activeQueueSessionId
        ? {
            ...data,
            sessions: data.sessions.map((session) =>
              session.id === activeQueueSessionId
                ? applySidebarQueueProjection(
                    session,
                    filteredActiveQueue,
                    filteredActiveProjection.paused,
                  )
                : session,
            ),
            queue: filteredActiveQueue,
          }
        : data;
      applyBootstrapMetadata(filteredData);
      // A local draft deliberately retains its own staged model. It may use the
      // refreshed capability snapshot only when it is the same model shape.
      confirmPrimaryCapabilitySnapshot(data, paneModelRef.current);
      setError((current) => (recoverableRefreshError(current) ? "" : current));
      return;
    }
    const activeId =
      data.activeSessionId ||
      data.sessions.find((session) => session.active)?.id ||
      "";
    if (wantedId && wantedId !== activeId) {
      if (activeId) {
        const activeProjection = acceptQueueProjectionIfCurrent(
          activeId,
          queueRevisionSnapshot.get(activeId) || 0,
          data.queue,
          data.queuePaused,
        );
        data = {
          ...data,
          sessions: data.sessions.map((session) =>
            session.id === activeId
              ? applySidebarQueueProjection(
                  session,
                  activeProjection.queue,
                  activeProjection.paused,
                )
              : session,
          ),
          queue: activeProjection.queue,
          queuePaused: activeProjection.paused,
        };
      }
      desiredSessionIdRef.current = wantedId;
      try {
        const viewVersion = sessionEventVersionRef.current.get(wantedId) || 0;
        const viewAuthority =
          earlyViewAuthority || capturePaneAuthority(wantedId);
        const view = await (earlyViewRequest || fetchSessionView(wantedId));
        if (
          !refreshAuthorityIsCurrent(refreshAuthority) ||
          desiredSessionIdRef.current !== wantedId ||
          !paneAuthorityCanCommit(viewAuthority)
        )
          return;
        if (
          (sessionEventVersionRef.current.get(wantedId) || 0) !== viewVersion
        ) {
          applyBootstrapMetadata(data);
          if (viewedSessionIdRef.current === wantedId)
            schedulePromptReconcile(
              wantedId,
              sessionEventVersionRef.current.get(wantedId) || 0,
            );
          return;
        }
        // Commit metadata and the wanted view together. Do not render the Primary
        // draft in between: EventSource readiness also calls refresh after F5.
        applyBootstrapMetadata(data);
        applySessionView(view, viewAuthority, wantedQueueRequestRevision);
        setError((current) =>
          recoverableRefreshError(current) ? "" : current,
        );
        return;
      } catch (cause) {
        if (!refreshAuthorityIsCurrent(refreshAuthority)) return;
        // A busy Runtime can make this best-effort view refresh time out. Keep the
        // already committed conversation painted; Bootstrap owns only global
        // metadata unless the server explicitly confirms the Session is gone.
        if (
          refreshFailureKeepsCommittedView(cause, viewedSessionIdRef.current)
        ) {
          applyBootstrapMetadata(data);
          throw cause;
        }
        if (
          !(cause instanceof Error) ||
          !cause.message.includes("会话不存在")
        ) {
          applyBootstrap(
            data,
            bootstrapAuthority,
            wantedQueueRequestRevision,
          );
          throw cause;
        }
        desiredSessionIdRef.current = activeId;
      }
    }
    if (bootstrapNeedsHistoryRecovery(data, activeId)) {
      // A just-started Primary may publish its Session identity before the
      // bootstrap has a readable message snapshot. Fetch the authoritative view
      // before allowing the partial bootstrap to paint as an empty conversation.
      desiredSessionIdRef.current = activeId;
      const historyAuthority =
        bootstrapAuthority?.sessionId === activeId
          ? bootstrapAuthority
          : capturePaneAuthority(activeId);
      const historyVersion =
        sessionEventVersionRef.current.get(activeId) || 0;
      const historyQueueRequestRevision =
        queueProjectionRevisionRef.current.get(activeId) || 0;
      try {
        const view = await fetchSessionView(activeId);
        if (
          !refreshAuthorityIsCurrent(refreshAuthority) ||
          desiredSessionIdRef.current !== activeId ||
          (sessionEventVersionRef.current.get(activeId) || 0) !== historyVersion ||
          !paneAuthorityCanCommit(historyAuthority)
        )
          return;
        if (view.session.id !== activeId)
          throw new Error("已保存对话恢复结果与当前 Session 不一致");
        applyBootstrapMetadata(data);
        applySessionView(view, historyAuthority, historyQueueRequestRevision);
        if (view.historyPending || view.reconcilePending || view.isStreaming)
          requestPromptReconcileRef.current(activeId);
        setError((current) => (recoverableRefreshError(current) ? "" : current));
        return;
      } catch {
        // Keep the successful bootstrap metadata, but the ConversationPane will
        // show a recovery state rather than the New welcome until history lands.
      }
      if (!refreshAuthorityIsCurrent(refreshAuthority)) return;
      applyBootstrap(data, historyAuthority, historyQueueRequestRevision);
      setError((current) => (recoverableRefreshError(current) ? "" : current));
      return;
    }
    applyBootstrap(data, bootstrapAuthority, wantedQueueRequestRevision);
    setError((current) => (recoverableRefreshError(current) ? "" : current));
  }, [
    applyBootstrap,
    applyBootstrapMetadata,
    applySessionView,
    applySidebarInventory,
    confirmPrimaryCapabilitySnapshot,
    capturePaneAuthority,
    ensureHandshake,
    fetchSessionView,
    loadBootstrap,
    paneAuthorityCanCommit,
    refreshAuthorityIsCurrent,
  ]);

  const startIdleRecovery = useCallback(
    (serverEpochChanged = false, refreshOnOrdinaryIdle = false) => {
      // Idle is authoritative lifecycle state even when the following bootstrap
      // is slow or rejected. Do not leave navigation and mutations locked on
      // stale maintenance state while JSONL fallback remains available.
      publishApplicationLifecycle("idle");
      setNotice("");
      const replacementBootstrapPending =
        replacementBootstrapPendingRef.current;
      const retryFailedInitialBootstrap =
        !bootstrapCompletedRef.current &&
        !initialReadyRecoveryRequestedRef.current;
      const needsRecovery =
        serverEpochChanged ||
        replacementBootstrapPending ||
        retryFailedInitialBootstrap;
      if (!needsRecovery && !refreshOnOrdinaryIdle) return;
      // A same-epoch ready can arrive while B's first bootstrap is pending. It
      // joins that request, so it must not consume the one retry reserved for a
      // later failed attempt.
      if (
        retryFailedInitialBootstrap &&
        !serverEpochChanged &&
        !replacementBootstrapPending &&
        bootstrapInFlightRef.current
      )
        return;
      // A replacement may first announce maintenance, so its later first idle
      // bootstrap remains distinct from this epoch's one failed-bootstrap retry.
      replacementBootstrapPendingRef.current = false;
      if (
        retryFailedInitialBootstrap &&
        !serverEpochChanged &&
        !replacementBootstrapPending
      )
        initialReadyRecoveryRequestedRef.current = true;
      void refresh()
        .then(async () => {
          const id = viewedSessionIdRef.current;
          if (!id) return;
          if (subagentAddressesRef.current.has(id)) {
            await rehydrateSubagentAddressChain(id).catch(() => undefined);
            return;
          }
          void api.markSessionViewed(id).catch(() => undefined);
        })
        .catch(reportBackgroundRefreshError);
    },
    [refresh, rehydrateSubagentAddressChain, reportBackgroundRefreshError],
  );

  const refreshSidebarSessions = useCallback(async () => {
    const runEpochGeneration = runEpochGenerationRef.current;
    if (sessionRefreshInFlightRef.current) {
      if (sessionRefreshGenerationRef.current === runEpochGeneration) {
        sessionRefreshRequestedRef.current = true;
        return;
      }
      // A replacement does not cancel browser requests. Detach A's coalescer so
      // B can read its own Session Index immediately; A's finally is ownership-guarded.
      sessionRefreshInFlightRef.current = false;
      sessionRefreshGenerationRef.current = null;
      sessionRefreshRequestedRef.current = false;
    }
    sessionRefreshInFlightRef.current = true;
    sessionRefreshGenerationRef.current = runEpochGeneration;
    try {
      const full = showAllSessionsRef.current;
      const fullBarrier = sidebarCommittedFullSequenceRef.current;
      const fullRequestSequence = full
        ? ++sidebarFullRequestSequenceRef.current
        : 0;
      const result = await api.sessions(
        full,
        full ? [] : sessionNavigationRef.current.pinnedSessionIds,
      );
      if (runEpochGenerationRef.current !== runEpochGeneration) return;
      for (const session of result.sessions) {
        if (
          typeof session.turnCount === "number" &&
          Number.isFinite(session.turnCount)
        )
          recordSourceTurnTotal(session.id, session.turnCount);
      }
      const committed = full
        ? commitSidebarSessions(result.sessions, {
            kind: "full",
            requestSequence: fullRequestSequence,
          })
        : commitSidebarSessions(result.sessions, {
            kind: "base",
            fullBarrier,
          });
      if (!committed) return;
      setSessionsTotal(
        optimisticSessionsTotal(
          result.sessions,
          result.total ?? result.sessions.length,
        ),
      );
      setSessionDirectories(result.directories || []);
    } catch (cause) {
      if (runEpochGenerationRef.current === runEpochGeneration) throw cause;
    } finally {
      if (sessionRefreshGenerationRef.current !== runEpochGeneration) return;
      sessionRefreshInFlightRef.current = false;
      sessionRefreshGenerationRef.current = null;
      if (sessionRefreshRequestedRef.current) {
        sessionRefreshRequestedRef.current = false;
        void refreshSidebarSessions().catch(reportBackgroundRefreshError);
      }
    }
  }, [reportBackgroundRefreshError]);

  const loadAllSessions = useCallback(async () => {
    const runEpochGeneration = runEpochGenerationRef.current;
    if (
      showAllSessionsRef.current ||
      loadAllSessionsGenerationRef.current === runEpochGeneration
    )
      return;
    loadAllSessionsGenerationRef.current = runEpochGeneration;
    const fullRequestSequence = ++sidebarFullRequestSequenceRef.current;
    setLoadingAllSessions(true);
    setError("");
    try {
      const result = await api.sessions(true);
      if (runEpochGenerationRef.current !== runEpochGeneration) return;
      for (const session of result.sessions) {
        if (
          typeof session.turnCount === "number" &&
          Number.isFinite(session.turnCount)
        )
          recordSourceTurnTotal(session.id, session.turnCount);
      }
      if (
        !commitSidebarSessions(result.sessions, {
          kind: "full",
          requestSequence: fullRequestSequence,
        })
      )
        return;
      setSessionsTotal(
        optimisticSessionsTotal(
          result.sessions,
          result.total ?? result.sessions.length,
        ),
      );
      setSessionDirectories(result.directories || []);
    } catch (cause) {
      if (runEpochGenerationRef.current === runEpochGeneration)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (loadAllSessionsGenerationRef.current !== runEpochGeneration) return;
      loadAllSessionsGenerationRef.current = null;
      setLoadingAllSessions(false);
    }
  }, []);

  const loadDirectorySessions = useCallback(
    async (cwd: string, renderedCount: number) => {
      const runEpochGeneration = runEpochGenerationRef.current;
      const fullBarrier = sidebarCommittedFullSequenceRef.current;
      const key = sidebarDirectoryKey(cwd);
      if (directoryLoadGenerationsRef.current.get(key) === runEpochGeneration)
        return;
      directoryLoadGenerationsRef.current.set(key, runEpochGeneration);
      setLoadingDirectoryKeys((current) => [...new Set([...current, key])]);
      try {
        const covered =
          directorySessionCoverageRef.current.get(key) ?? renderedCount;
        if (covered >= MAX_DIRECTORY_PREFIX_SIZE) {
          const fullRequestSequence = ++sidebarFullRequestSequenceRef.current;
          const result = await api.sessions(true);
          if (runEpochGenerationRef.current !== runEpochGeneration) return;
          if (
            !commitSidebarSessions(result.sessions, {
              kind: "full",
              requestSequence: fullRequestSequence,
            })
          )
            return;
          setSessionsTotal(
            optimisticSessionsTotal(
              result.sessions,
              result.total ?? result.sessions.length,
            ),
          );
          setSessionDirectories(result.directories || []);
          return;
        }
        const result = await api.directorySessions(cwd, covered + 15);
        if (runEpochGenerationRef.current !== runEpochGeneration) return;
        if (
          !commitSidebarSessions(result.sessions, {
            kind: "directory",
            cwd,
            fullBarrier,
          })
        )
          return;
        setSessionDirectories(result.directories || []);
      } catch (cause) {
        if (runEpochGenerationRef.current === runEpochGeneration)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (directoryLoadGenerationsRef.current.get(key) !== runEpochGeneration)
          return;
        directoryLoadGenerationsRef.current.delete(key);
        setLoadingDirectoryKeys((current) =>
          current.filter((candidate) => candidate !== key),
        );
      }
    },
    [],
  );

  const scheduleSidebarRefresh = useCallback(() => {
    const runEpochGeneration = runEpochGenerationRef.current;
    if (sessionRefreshTimerRef.current !== null)
      window.clearTimeout(sessionRefreshTimerRef.current);
    sessionRefreshTimerRef.current = window.setTimeout(() => {
      sessionRefreshTimerRef.current = null;
      if (runEpochGenerationRef.current !== runEpochGeneration) return;
      void refreshSidebarSessions().catch(reportBackgroundRefreshError);
    }, 180);
  }, [refreshSidebarSessions, reportBackgroundRefreshError]);

  useEffect(() => {
    refresh()
      .catch(reportBackgroundRefreshError)
      .finally(() => setLoading(false));
    return () => {
      if (sessionRefreshTimerRef.current !== null)
        window.clearTimeout(sessionRefreshTimerRef.current);
      for (const request of loadingEarlierRequestsRef.current.values())
        request.controller.abort();
      cancelPendingNavigation();
    };
  }, [cancelPendingNavigation, refresh, reportBackgroundRefreshError]);

  useEffect(() => {
    applyAppearance(appearance);
    saveAppearance(appearance);
  }, [appearance]);

  useEffect(() => saveSidebarOpen(sidebarOpen), [sidebarOpen]);
  useEffect(() => saveSidebarWidth(sidebarWidth), [sidebarWidth]);
  useEffect(
    () => saveSessionNavigationPreferences(sessionNavigation),
    [sessionNavigation],
  );
  useEffect(() => {
    if (!sidebarInventoryReady || showAllSessionsRef.current) return;
    const pinned = sessionNavigation.pinnedSessionIds.filter((id) =>
      /^[a-f0-9]{20}$/i.test(id),
    );
    if (!pinned.length) return;
    const loaded = new Set(sessions.map((session) => session.id));
    if (pinned.every((id) => loaded.has(id))) return;
    const attempt = `${runEpochGenerationRef.current}:${pinned.join(",")}`;
    if (pinnedInventoryAttemptRef.current === attempt) return;
    pinnedInventoryAttemptRef.current = attempt;
    void refreshSidebarSessions().catch(reportBackgroundRefreshError);
  }, [
    refreshSidebarSessions,
    reportBackgroundRefreshError,
    sessionNavigation.pinnedSessionIds,
    sessions,
    sidebarInventoryReady,
  ]);

  // EventSource reconnects after a server restart, but it cannot replay events
  // missed while disconnected. Keep transport ownership in usePiEventSource;
  // this component remains responsible only for translating events into UI state.
  const handleEventSourceReady = useCallback(
    (rawEvent: Event, source: EventSource) => {
      lastEventFrameAtRef.current = Date.now();
      // EventSource readiness proves transport only. Renew foreground presence
      // under the same visible-and-focused predicate as the lifecycle effect.
      if (document.visibilityState !== "hidden" && document.hasFocus())
        void api.renewPresence().catch(() => undefined);
      const ready = parseEventData(rawEvent);
      if (!ready) {
        recordSseRejectionDiagnostic({
          eventType: "unknown",
          decisionReason: "malformed-json",
        });
        return;
      }
      const readyRunEpoch =
        typeof ready.piChatRunEpoch === "string" ? ready.piChatRunEpoch : "";
      const serverEpochChanged = Boolean(
        readyRunEpoch &&
        runEpochRef.current &&
        readyRunEpoch !== runEpochRef.current,
      );
      if (serverEpochChanged) {
        // Bootstrap completion is scoped to the server epoch. A successful old
        // response cannot suppress one recovery retry for this replacement.
        bootstrapCompletedRef.current = false;
        initialReadyRecoveryRequestedRef.current = false;
        replacementBootstrapPendingRef.current = true;
        // The new ready frame proves this is a real process epoch change. A
        // transient token/SSE recovery below must not clear this live state until
        // that proof arrives; the full process-owned reset below is now safe.
        // All pre-handoff reads carry the old process token and metadata. They
        // remain uncancelled, but cannot be reused or commit into this epoch.
        runEpochGenerationRef.current += 1;
        // Abort and invalidate A's ordinary navigation before maintenance can
        // return. Authority generation still rejects uncancellable responses.
        cancelPendingNavigation();
        // Detach A's uncancellable Session Index work and its loading state.
        // B starts independent reads; late A finalizers cannot clear B ownership.
        if (sessionRefreshTimerRef.current !== null)
          window.clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = null;
        sessionRefreshInFlightRef.current = false;
        sessionRefreshGenerationRef.current = null;
        sessionRefreshRequestedRef.current = false;
        loadAllSessionsGenerationRef.current = null;
        directoryLoadGenerationsRef.current.clear();
        directorySessionCoverageRef.current.clear();
        pinnedInventoryAttemptRef.current = "";
        showAllSessionsRef.current = false;
        sidebarFullRequestSequenceRef.current = 0;
        sidebarCommittedFullSequenceRef.current = 0;
        setLoadingAllSessions(false);
        setLoadingDirectoryKeys([]);
        // A replacement can announce maintenance before its first idle frame.
        // Detach its bootstrap now, before the lifecycle branch can return.
        bootstrapInFlightRef.current = null;
        api.invalidateHandshake();
        handshakeInFlightRef.current = null;
        initialHistoryRef.current = null;
        draftWorkspacePickerTokenRef.current = null;
        workspaceDefaultPickerTokenRef.current = null;
        setWorkspacePicking(false);
        refreshOperationTokenRef.current = null;
        setRefreshing(false);
        clearStoppingForSession();
        resetProcessOwnedUiState();
        sidebarInventoryReadyRef.current = false;
        setSidebarInventoryReady(false);
        setSessions([]);
        setSessionsTotal(0);
        setSessionDirectories([]);
        // Primary readiness generations are local to one server process. Clear
        // A's high generation before B reports its own lower-generation state.
        const replacementReadiness = { status: "starting" as const, generation: 0 };
        publishPrimaryReadiness(replacementReadiness);
        publishPrimaryCapabilitySnapshot(null);
        setModelInventoryConfirmed(false);
        workspaceEpochRef.current =
          typeof ready.workspaceEpoch === "string"
            ? ready.workspaceEpoch
            : readyRunEpoch;
        workspaceRevisionRef.current = 0;
        runEpochRef.current = readyRunEpoch;
      } else if (readyRunEpoch && !runEpochRef.current) {
        // The first ready only discovers the initial epoch; it is not a
        // replacement and must not grant an additional recovery retry.
        runEpochRef.current = readyRunEpoch;
      }
      // Bootstrap can legitimately return while Primary is `starting`; the
      // browser opens SSE only after that first paint. The initial ready frame
      // therefore carries the exact state/capability already adopted by App —
      // it is never a signal to issue another bootstrap/get_state.
      const readyPrimary = ready.primaryRuntime as
        Partial<PrimaryRuntimeReadiness> | undefined;
      const readyNeedsMetadataRefresh =
        readyPrimary?.status === "ready" &&
        typeof readyPrimary.generation === "number" &&
        !readyPrimary.model &&
        (primaryRuntimeRef.current.status !== "ready" ||
          primaryRuntimeRef.current.generation !== readyPrimary.generation);
      if (
        readyPrimary &&
        (readyPrimary.status === "starting" ||
          readyPrimary.status === "ready" ||
          readyPrimary.status === "failed") &&
        typeof readyPrimary.generation === "number"
      ) {
        const incoming = readyPrimary as PrimaryRuntimeReadiness;
        const next = acceptPrimaryReadiness(primaryRuntimeRef.current, incoming);
        publishPrimaryReadiness(next);
        const acceptedReady =
          next.status === "ready" &&
          next.generation === incoming.generation &&
          incoming.status === "ready";
        if (acceptedReady && next.model) {
          rememberObservedModel(next.model);
          const target = localDraftRef.current
            ? { kind: "draft" as const }
            : next.sessionId
              ? { kind: "session" as const, sessionId: next.sessionId }
              : { kind: "draft" as const };
          const snapshot = {
            generation: next.generation,
            modelKeys: [modelCapabilityKey(next.model)].filter(Boolean),
          };
          publishPrimaryCapabilitySnapshot(snapshot);
          dispatchPane({
            type: "RUNTIME_SETTINGS_ADOPTED",
            target,
            state: {
              model: next.model,
              thinkingLevel: next.thinkingLevel,
            },
          });
        }
      }
      if (lifecycleFromEvent(ready) === "restarting") {
        publishApplicationLifecycle("restarting");
        setNotice("Pi Chat 正在构建并重启，暂时停止接收新操作…");
        source.close();
        handoffWaitRef.current ||= api
          .waitForApplicationHandoff()
          .then(() => window.location.reload())
          .catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause));
            handoffWaitRef.current = null;
          });
        return;
      }
      const readyLifecycle = lifecycleFromEvent(ready);
      if (readyLifecycle !== "idle") {
        publishApplicationLifecycle(readyLifecycle);
        if (readyLifecycle === "shutting-down") {
          source.close();
          setCloseComplete("application");
          window.setTimeout(() => window.close(), 40);
        } else {
          setNotice(
            readyLifecycle === "workspace-changing"
              ? "正在切换工作目录…"
              : "正在更新配置并重载 Runtime…",
          );
        }
        return;
      }
      // Readiness already includes the adopted selected-model capability. A
      // lightweight metadata refresh can still discover commands/stats/models;
      // the server reuses its adopted state and does not issue another get_state.
      startIdleRecovery(serverEpochChanged, readyNeedsMetadataRefresh);
    },
    [
      cancelPendingNavigation,
      clearStoppingForSession,
      recordSseRejectionDiagnostic,
      rememberObservedModel,
      resetProcessOwnedUiState,
      startIdleRecovery,
    ],
  );

  const handlePiEvent = useCallback(
    (rawEvent: Event, source: EventSource) => {
      lastEventFrameAtRef.current = Date.now();
      const admission = admitStreamEvent(rawEvent, runEpochRef.current);
      if (!admission.accepted) {
        recordSseRejectionDiagnostic({
          sessionId: admission.sessionId,
          runGeneration: admission.runGeneration,
          eventType: admission.eventType,
          decisionReason: admission.reason,
        });
        return;
      }
      const { event, type, sessionId: eventSessionId, runEpoch: eventRunEpoch, runGeneration: eventRunGeneration, terminalEvent } = admission.value;
      sseFloodCountRef.current = 0;
      if (type === "pi_chat_heartbeat") return;
      if (type === "pi_chat_sse_resync" || type === "pi_chat_oversized_event") {
        void refresh().catch(reportBackgroundRefreshError);
        return;
      }
      const eventRunStartedAt = finiteRunMetric(event.piChatRunStartedAt);
      const eventRunDurationMs = finiteRunMetric(event.piChatRunDurationMs);
      if (eventSessionId && typeof eventRunGeneration === "number") {
        const latest = sessionRunGenerationsRef.current.get(eventSessionId);
        const settled = settledRunGenerationsRef.current.get(eventSessionId);
        // A Pi turn is a monotonic lifecycle. Once a generation settles, every
        // non-terminal frame from it is stale, even if SSE/backpressure makes
        // it arrive after settlement. Explicit generation zero is valid before
        // the first agent_start; undefined means that no authority is known yet.
        if (latest !== undefined && eventRunGeneration < latest) {
          recordSseRejectionDiagnostic({
            sessionId: eventSessionId,
            runGeneration: eventRunGeneration,
            eventType: type || "unknown",
            decisionReason: "stale-run-generation",
          });
          return;
        }
        if (
          settled !== undefined
          && eventRunGeneration <= settled
          && type !== "agent_settled"
        ) {
          recordSseRejectionDiagnostic({
            sessionId: eventSessionId,
            runGeneration: eventRunGeneration,
            eventType: type || "unknown",
            decisionReason: "settled-run-generation",
          });
          return;
        }
        sessionRunGenerationsRef.current.set(
          eventSessionId,
          Math.max(latest ?? -1, eventRunGeneration),
        );
        if (type === "agent_settled")
          settledRunGenerationsRef.current.set(
            eventSessionId,
            Math.max(settled ?? -1, eventRunGeneration),
          );
      }
      // Only explicitly global frames may omit a Session ID. A malformed
      // session-scoped frame must never be interpreted as belonging to whatever
      // pane happens to be visible at that instant.
      if (isSessionScopedEvent(type) && !eventSessionId) {
        recordSseRejectionDiagnostic({
          eventType: type || "unknown",
          decisionReason: "missing-session",
        });
        return;
      }
      // A destination is no longer allowed to paint updates from the source
      // pane while navigation is in flight. Its events still update that pane's
      // cache, ready for an immediate return.
      const viewingEventSession =
        Boolean(eventSessionId) &&
        eventSessionId === viewedSessionIdRef.current &&
        viewedSessionIdRef.current === desiredSessionIdRef.current;
      /**
       * Session-status carries the same cumulative queue snapshot as the
       * dedicated queue event. Keep one projection path for both so a
       * coalesced/missed queue_dispatch cannot strand a local turn in FIFO.
       */
      const projectStatusQueue = (queue: QueuedPrompt[], paused: boolean): void => {
        if (!eventSessionId) return;
        const projection = acceptQueueProjection(
          eventSessionId,
          queue,
          paused,
          "event",
        );
        const currentQueue = projection.queue;
        const localTurns = localUserTurnsRef.current.get(eventSessionId) || [];
        for (const item of currentQueue)
          bindQueuedAdmission(
            localTurns,
            item.id,
            item.message,
            item.imageCount,
          );
        const promotedTurns = promoteTurnsAbsentFromQueue(
          localTurns,
          new Set(currentQueue.map((item) => item.id)),
          false,
          true,
          cancellingQueueIdsRef.current.get(eventSessionId),
        );
        const promotedForPane = viewingEventSession
          ? promotedTurns.filter((candidate) => !candidate.renderedInTranscript)
          : [];
        for (const promoted of promotedForPane)
          promoted.renderedInTranscript = true;
        if (promotedForPane.length) {
          if (viewingEventSession)
            dispatchPane({
              type: "QUEUE_UPDATED",
              sessionId: eventSessionId,
              queue: currentQueue,
              paused: projection.paused,
              messages: (current) => {
                let next = current;
                for (const promoted of promotedForPane) {
                  if (!next.includes(promoted.message))
                    next = [...next, promoted.message];
                }
                return next;
              },
            });
          requestPromptReconcileRef.current(eventSessionId);
        } else if (viewingEventSession) {
          dispatchPane({
            type: "QUEUE_UPDATED",
            sessionId: eventSessionId,
            queue: currentQueue,
            paused: projection.paused,
          });
        }
        setSessions((current) =>
          current.map((session) =>
            session.id === eventSessionId
              ? applySidebarQueueProjection(
                  session,
                  currentQueue,
                  projection.paused,
                )
              : session,
          ),
        );
        patchSessionCache(eventSessionId, {
          queue: currentQueue,
          queuePaused: projection.paused,
        });
      };
      if (
        event.piChatPromptId &&
        eventSessionId &&
        (type === "agent_start" ||
          type === "agent_settled" ||
          type === "pi_chat_process_error")
      ) {
        const observed = promptCoordinatorRef.current.observeServerLifecycle(
          String(event.piChatPromptId),
          type,
          eventRunGeneration,
          eventSessionId,
          runEpochRef.current,
        );
        if (observed?.phase === "settled" ||
          observed?.phase === "failed" ||
          observed?.phase === "aborted")
          promptCoordinatorRef.current.clearTerminal();
      }
      recordBrowserStateDiagnostic("sse", "admitted", {
        sessionId: eventSessionId,
        runGeneration: eventRunGeneration,
        details: {
          eventType: type || "unknown",
          viewing: viewingEventSession,
          navigationEpoch: navigationEpochRef.current,
        },
      });
      if (type === "pi_chat_prompt_retry_scheduled"
        || type === "pi_chat_prompt_retry_started"
        || type === "pi_chat_prompt_retry_exhausted"
        || type === "pi_chat_prompt_failed") {
        const retryAttempt = typeof event.retryAttempt === "number" ? event.retryAttempt : undefined;
        const retryAttempts = typeof event.retryAttempts === "number" ? event.retryAttempts : undefined;
        const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : undefined;
        const delayMs = typeof event.delayMs === "number" ? event.delayMs : undefined;
        const isRetryLifecycle = type === "pi_chat_prompt_retry_scheduled"
          || type === "pi_chat_prompt_retry_started"
          || type === "pi_chat_prompt_retry_exhausted";
        const serverPromptId = typeof event.piChatPromptId === "string"
          ? event.piChatPromptId
          : undefined;
        const retryPhase = type === "pi_chat_prompt_retry_scheduled"
          ? "scheduled" as const
          : type === "pi_chat_prompt_retry_started"
            ? "running" as const
            : "exhausted" as const;
        const observedRetry = isRetryLifecycle && serverPromptId && eventSessionId
          ? promptCoordinatorRef.current.observeRetry(
              serverPromptId,
              retryPhase,
              eventRunGeneration,
              eventSessionId,
              eventRunEpoch,
              retryAttempt,
              maxAttempts,
              delayMs,
            )
          : undefined;
        // Once a Server Prompt has a terminal lifecycle fact, a late retry frame
        // must not repaint the Pane. Identity-less legacy frames keep the old
        // projection path; identity-bearing frames require an active operation.
        const retryIdentityMatchesEvent = Boolean(
          observedRetry
          && eventSessionId
          && observedRetry.sessionId === eventSessionId
          && (!eventRunEpoch
            || !observedRetry.runEpoch
            || observedRetry.runEpoch === eventRunEpoch),
        );
        const projectRetry = !isRetryLifecycle
          || !serverPromptId
          || Boolean(
            observedRetry
            && retryIdentityMatchesEvent
            && !["settled", "failed", "aborted"].includes(observedRetry.phase),
          );
        const status = type === "pi_chat_prompt_retry_scheduled"
          ? `Pi 正在等待重试${retryAttempt !== undefined && maxAttempts !== undefined ? `（第 ${retryAttempt}/${maxAttempts} 次）` : "…"}`
          : type === "pi_chat_prompt_retry_started"
            ? `Pi 正在重试${retryAttempt !== undefined && retryAttempts !== undefined ? `（第 ${retryAttempt}/${retryAttempts} 次）` : "…"}`
            : type === "pi_chat_prompt_retry_exhausted"
              ? "Pi 原生重试已耗尽"
              : "Pi Prompt 执行失败";
        if (projectRetry && eventSessionId) {
          patchSessionCache(eventSessionId, { toolStatus: status, isStreaming: type !== "pi_chat_prompt_failed" });
          if (viewingEventSession)
            dispatchPane({ type: "TOOL_STATUS_UPDATED", sessionId: eventSessionId, status });
        }
        recordBrowserStateDiagnostic("retry", type, {
          sessionId: eventSessionId,
          runGeneration: eventRunGeneration,
          details: {
            retryAttempt,
            retryAttempts,
            maxAttempts,
            delayMs,
            provider: typeof event.provider === "string" ? event.provider : undefined,
            model: typeof event.model === "string" ? event.model : undefined,
            api: typeof event.api === "string" ? event.api : undefined,
          },
        });
      }
      if (type === "pi_chat_native_steering_dequeued") {
        const ids = Array.isArray(event.ids)
          ? event.ids.filter((id): id is string =>
              typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id),
            )
          : [];
        if (eventSessionId && ids.length) {
          const incomingRevision = typeof event.pendingSteerRevision === "number"
            ? event.pendingSteerRevision
            : 0;
          const previous = pendingSteerProjectionRef.current.get(eventSessionId);
          if (!previous || incomingRevision >= previous.revision) {
            pendingSteerProjectionRef.current.set(eventSessionId, {
              revision: incomingRevision,
              items: previous
                ? previous.items.filter((item) => !ids.includes(item.id))
                : [],
            });
            applyDequeuedSteers(eventSessionId, ids);
          }
        }
        return;
      }
      if (eventSessionId && invalidatesSessionViewVersion(type)) {
        sessionEventVersionRef.current.set(
          eventSessionId,
          (sessionEventVersionRef.current.get(eventSessionId) || 0) + 1,
        );
        lastSessionEventTypeRef.current.set(eventSessionId, type);
      }
      // View snapshots use stale-while-revalidate: retain them through streaming
      // and terminal events for instant navigation, then refresh in the background.
      // Only structural session mutations explicitly discard a snapshot below.
      if (type === "pi_chat_application_closing") {
        source.close();
        setManagementSection(null);
        setCloseComplete("application");
        window.setTimeout(() => window.close(), 40);
      } else if (type === "agent_start") {
        if (eventSessionId) {
          completedCompactionSessionIdsRef.current.delete(eventSessionId);
          releasePromptBusy(eventSessionId, eventRunGeneration, eventRunEpoch);
          sessionRunningOverridesRef.current.set(eventSessionId, true);
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? applySidebarRunningOverride(session, true)
                : session,
            ),
          );
          patchSessionCache(eventSessionId, {
            isStreaming: true,
            toolStatus: WAITING_FOR_PI_STATUS,
            state: { isStreaming: true },
          });
          // A queue-dispatch frame may be coalesced or missed while the socket
          // is recovering. Once Pi proves execution has started, reconcile only
          // the affected Session view so an already-running prompt cannot remain
          // stranded in the waiting queue UI.
          const knownQueue = latestQueueProjectionRef.current.get(eventSessionId);
          if (knownQueue?.queue.length) {
            const queueRequestRevision =
              queueProjectionRevisionRef.current.get(eventSessionId) || 0;
            const requestVersion =
              sessionEventVersionRef.current.get(eventSessionId) || 0;
            const authority = capturePaneAuthority(eventSessionId);
            void fetchSessionView(eventSessionId)
              .then((view) => {
                if (
                  (sessionEventVersionRef.current.get(eventSessionId) || 0) ===
                  requestVersion
                )
                  applySessionView(view, authority, queueRequestRevision);
              })
              .catch(() => undefined);
          }
        }
        if (viewingEventSession) {
          setRuntimeWarming(eventSessionId, false);
          dispatchPane({
            type: "AGENT_STARTED",
            sessionId: eventSessionId,
            toolStatus: WAITING_FOR_PI_STATUS,
            ...(eventRunStartedAt !== undefined ? { runStartedAt: eventRunStartedAt } : null),
          });
        }
      } else if (type === "compaction_start") {
        if (eventSessionId) {
          completedCompactionSessionIdsRef.current.delete(eventSessionId);
          patchSessionCache(eventSessionId, {
            state: { isCompacting: true },
          });
        }
        if (viewingEventSession) {
          const reason = String(event.reason || "");
          dispatchPane({
            type: "COMPACTION_STARTED",
            sessionId: eventSessionId,
            status:
              reason === "overflow"
                ? "上下文溢出，正在自动压缩…"
                : "正在压缩上下文…",
          });
        }
      } else if (type === "compaction_end") {
        if (eventSessionId) {
          completedCompactionSessionIdsRef.current.add(eventSessionId);
          patchSessionCache(eventSessionId, {
            toolStatus: "",
            state: { isCompacting: false },
          });
        }
        if (viewingEventSession) {
          dispatchPane({
            type: "COMPACTION_FINISHED",
            sessionId: eventSessionId,
          });
          const errorMessage =
            typeof event.errorMessage === "string" ? event.errorMessage : "";
          if (errorMessage) setError(errorMessage);
          else if (event.aborted === false) {
            setNotice("上下文压缩完成");
            // Refresh usage/history in the background. Never surface a 65s view
            // timeout here — compaction often ends while the model turn continues,
            // and a busy RPC used to paint a false-red error long after success.
            const requestVersion =
              sessionEventVersionRef.current.get(eventSessionId) || 0;
            const queueRequestRevision =
              queueProjectionRevisionRef.current.get(eventSessionId) || 0;
            const authority = capturePaneAuthority(eventSessionId);
            void fetchSessionView(eventSessionId)
              .then((view) => {
                if (
                  paneAuthorityCanCommit(authority) &&
                  (sessionEventVersionRef.current.get(eventSessionId) || 0) ===
                    requestVersion
                )
                  applySessionView(view, authority, queueRequestRevision);
              })
              .catch(() => undefined);
          }
        }
      } else if (
        type === "message_start"
        || type === "message_update"
        || type === MESSAGE_CHECKPOINT_EVENT
        || type === MESSAGE_DELTA_EVENT
      ) {
        const rawMessage =
          event.message && typeof event.message === "object"
            ? (event.message as PiMessage)
            : null;
        const nativeSteeringConsumed =
          (event as { nativeSteeringConsumed?: boolean }).nativeSteeringConsumed === true;
        const nativeSteeringId =
          typeof (event as { nativeSteeringId?: unknown }).nativeSteeringId === "string" &&
          /^[a-f0-9-]{36}$/i.test((event as { nativeSteeringId: string }).nativeSteeringId)
            ? (event as { nativeSteeringId: string }).nativeSteeringId
            : undefined;
        if (type === "message_start" && eventSessionId)
          streamingWireProjectionsRef.current.delete(eventSessionId);
        if (type === "message_start" && rawMessage?.role === "user" && eventSessionId) {
          const localTurns = localUserTurnsRef.current.get(eventSessionId) || [];
          // Only a server-verified native steer consumption may reveal a hidden
          // local Steer turn. Pi dequeues the steering message before forwarding
          // this message_start, so an ordinary prompt sharing the same text can
          // never be mistaken for a consumed Steer.
          const consumed = nativeSteeringConsumed
            ? consumeLocalSteeringTurn(localTurns, rawMessage, nativeSteeringId)
            : undefined;
          if (consumed) {
            const acceptedTurnTotal = consumed.expectedTurnTotal;
            setSessions((current) =>
              current.map((session) =>
                session.id === eventSessionId &&
                acceptedTurnTotal > (session.turnCount || 0)
                  ? { ...session, turnCount: acceptedTurnTotal }
                  : session,
              ),
            );
          }
          if (consumed || nativeSteeringId) {
            const consumedId = consumed?.queueId || nativeSteeringId;
            syncPendingSteers(
              eventSessionId,
              consumedId
                ? (pendingSteersRef.current.get(eventSessionId) || []).filter(
                    (item) => item.id !== consumedId,
                  )
                : [],
            );
          }
          if (consumed && viewingEventSession) {
            consumed.renderedInTranscript = true;
            dispatchPane({
              type: "PROMPT_ACKNOWLEDGED",
              sessionId: eventSessionId,
              messages: (current) =>
                current.includes(consumed.message)
                  ? current
                  : [...current, consumed.message],
            });
          }
        }

        let assistant: PiMessage | null = null;
        let streamStart = type === "message_start";
        if (type === MESSAGE_CHECKPOINT_EVENT) {
          const checkpoint = decodeStreamingCheckpoint(event);
          if (!checkpoint || !eventSessionId) {
            recordSseRejectionDiagnostic({
              sessionId: eventSessionId,
              runGeneration: eventRunGeneration,
              eventType: type,
              decisionReason: "malformed-critical-event",
            });
            return;
          }
          const projection = {
            message: checkpoint.message,
            sequence: checkpoint.piChatSequence,
          };
          streamingWireProjectionsRef.current.set(eventSessionId, projection);
          assistant = projection.message;
          streamStart = checkpoint.piChatStreamStart === true;
        } else if (type === MESSAGE_DELTA_EVENT) {
          const projection = eventSessionId
            ? applyStreamingDelta(
                streamingWireProjectionsRef.current.get(eventSessionId),
                event,
              )
            : null;
          if (!projection || !eventSessionId) {
            recordSseRejectionDiagnostic({
              sessionId: eventSessionId,
              runGeneration: eventRunGeneration,
              eventType: type,
              decisionReason: "stream-sequence-gap",
            });
            if (eventSessionId)
              streamingWireProjectionsRef.current.delete(eventSessionId);
            if (viewingEventSession) clearPendingLiveMessage();
            source.close();
            const now = Date.now();
            const previousRecovery = eventSessionId
              ? streamGapRecoveriesRef.current.get(eventSessionId)
              : undefined;
            const count = previousRecovery && now - previousRecovery.at < 30_000
              ? previousRecovery.count + 1
              : 1;
            if (eventSessionId)
              streamGapRecoveriesRef.current.set(eventSessionId, { at: now, count });
            const delay = count === 1
              ? 0
              : Math.min(30_000, 1_000 * 2 ** Math.min(count - 2, 5));
            if (sseReconnectTimerRef.current !== null)
              window.clearTimeout(sseReconnectTimerRef.current);
            sseReconnectTimerRef.current = window.setTimeout(() => {
              sseReconnectTimerRef.current = null;
              setEventSourceGeneration((generation) => generation + 1);
            }, delay);
            void refresh().catch(reportBackgroundRefreshError);
            return;
          }
          streamingWireProjectionsRef.current.set(eventSessionId, projection);
          streamGapRecoveriesRef.current.delete(eventSessionId);
          assistant = withStreamingAppendHints(
            projection.message,
            projection.sequence,
            event.operations as StreamingMessageAppend[],
          );
        } else {
          assistant = assistantMessage(event);
          if (assistant && eventSessionId)
            streamingWireProjectionsRef.current.delete(eventSessionId);
        }

        let rejectedPostTerminalAssistantUpdate = false;
        if (assistant && eventSessionId && typeof eventRunGeneration === "number") {
          if (streamStart) {
            // A new assistant start is the only browser-visible boundary that
            // reopens a stream after its prior canonical terminal. This keeps
            // tool-use continuations in the same Pi generation valid.
            if (
              terminalAssistantStreamGenerationsRef.current.get(eventSessionId) ===
              eventRunGeneration
            )
              terminalAssistantStreamGenerationsRef.current.delete(eventSessionId);
          } else if (
            terminalAssistantStreamGenerationsRef.current.get(eventSessionId) ===
              eventRunGeneration
          ) {
            rejectedPostTerminalAssistantUpdate = true;
            recordSseRejectionDiagnostic({
              sessionId: eventSessionId,
              runGeneration: eventRunGeneration,
              eventType: type,
              decisionReason: "post-assistant-terminal",
            });
          }
        }
        if (assistant && eventSessionId && !rejectedPostTerminalAssistantUpdate) {
          releasePromptBusy(eventSessionId, eventRunGeneration, eventRunEpoch);
          updateLiveSessionCache(eventSessionId, assistant);
          if (typeof eventRunGeneration === "number")
            streamDiagnosticsRef.current?.receive(
              { sessionId: eventSessionId, runGeneration: eventRunGeneration },
              viewingEventSession,
              viewingEventSession
                && document.visibilityState === "visible"
                && document.hasFocus(),
            );
        }
        // Only the selected destination is allowed to turn an SSE draft into a
        // React update. Off-screen panes retain their latest draft in cache.
        if (assistant && !rejectedPostTerminalAssistantUpdate && viewingEventSession)
          scheduleLiveMessage({
            message: assistant,
            authority: capturePaneAuthority(eventSessionId),
            runGeneration: eventRunGeneration ?? -1,
          });
      } else if (type === "message_end" && terminalEvent) {
        if (eventSessionId) {
          streamingWireProjectionsRef.current.delete(eventSessionId);
          streamGapRecoveriesRef.current.delete(eventSessionId);
        }
        const terminal = terminalEvent.message;
        if (terminalEvent.terminalKind === "assistant") {
          if (eventSessionId)
            releasePromptBusy(
              eventSessionId,
              eventRunGeneration,
              eventRunEpoch,
            );
          // The server owns terminal repair. Cancel a pending browser throttle,
          // but never substitute its local draft for the canonical terminal.
          if (viewingEventSession) clearPendingLiveMessage();
          if (eventSessionId) {
            terminalAssistantSessionIdsRef.current.add(eventSessionId);
            if (typeof eventRunGeneration === "number")
              terminalAssistantStreamGenerationsRef.current.set(
                eventSessionId,
                eventRunGeneration,
              );
            appendTerminalSessionCache(eventSessionId, terminal);
          }
          if (viewingEventSession) {
            dispatchPane({
              type: "TERMINAL_MESSAGE_COMMITTED",
              sessionId: eventSessionId,
              message: terminal,
            });
            if (typeof eventRunGeneration === "number")
              streamDiagnosticsRef.current?.terminalAssistantCommitted({
                sessionId: eventSessionId,
                runGeneration: eventRunGeneration,
              });
            // A final assistant message normally precedes agent_settled by only
            // one frame. If that lifecycle frame is lost, verify the hot
            // Runtime after the normal grace instead of leaving Stop/Queue
            // painted forever. Tool-call assistant terminals are not final.
            if (!assistantMessageRequestsTool(terminal))
              requestPromptReconcileRef.current(eventSessionId);
          }
        } else {
          // User message_end is a transport echo of the prompt. The sender's
          // LocalUserTurn and the later JSONL view already own that row; caching
          // this echo can duplicate it when Pi assigns a nearby timestamp.
          if (terminalEvent.terminalKind !== "user-echo" && eventSessionId)
            appendTerminalSessionCache(eventSessionId, terminal);
          if (viewingEventSession && terminalEvent.terminalKind === "tool-result")
            dispatchPane({
              type: "TOOL_RESULT_COMMITTED",
              sessionId: eventSessionId,
              message: terminal,
            });
        }
      } else if (type === "tool_execution_start") {
        const toolName = String(event.toolName || "unknown");
        const status = `正在运行工具：${toolName}`;
        if (eventSessionId)
          completedCompactionSessionIdsRef.current.delete(eventSessionId);
        if (eventSessionId && toolName === "ask_user_question") {
          const questionnaire = parseAskQuestionnaire(event.toolCallId, event.args);
          if (questionnaire)
            dispatchAskQuestionnaire({
              type: "OPEN",
              sessionId: eventSessionId,
              questionnaire,
            });
        }
        if (eventSessionId) {
          // A tool invocation is authoritative active-turn evidence even when a
          // lagging get_state snapshot or a missed agent_start painted idle.
          releasePromptBusy(eventSessionId, eventRunGeneration, eventRunEpoch);
          sessionRunningOverridesRef.current.set(eventSessionId, true);
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? applySidebarRunningOverride(session, true)
                : session,
            ),
          );
          patchSessionCache(eventSessionId, {
            isStreaming: true,
            toolStatus: status,
            state: { isStreaming: true, isCompacting: false },
          });
        }
        if (viewingEventSession)
          dispatchPane({
            type: "AGENT_STARTED",
            sessionId: eventSessionId,
            toolStatus: status,
            ...(eventRunStartedAt !== undefined ? { runStartedAt: eventRunStartedAt } : null),
          });
      } else if (type === "tool_execution_end") {
        if (eventSessionId && String(event.toolName || "") === "ask_user_question")
          dispatchAskQuestionnaire({
            type: "CLOSE_IF_MATCH",
            sessionId: eventSessionId,
            toolCallId: String(event.toolCallId || ""),
          });
        const status = `${String(event.toolName || "工具")} ${event.isError ? "执行失败" : "已完成，Pi 正在继续…"}`;
        // A terminal compaction frame invalidates the preceding tool phase. If
        // its delayed tool terminal arrives afterward, retain the running fact
        // but do not repaint that obsolete tool label. A genuine later tool has
        // already cleared this fence in tool_execution_start.
        const staleAcrossCompletedCompaction = Boolean(
          eventSessionId &&
            completedCompactionSessionIdsRef.current.has(eventSessionId),
        );
        // Current servers attach a run generation. If that generation had
        // already settled, the event fence above returned before this branch;
        // otherwise this tool frame proves the turn is still active. Preserve
        // the older-server fallback without reviving an explicitly idle pane.
        const sessionStillRunning = Boolean(
          eventSessionId &&
            (typeof eventRunGeneration === "number" ||
              sessionRunningOverridesRef.current.get(eventSessionId) !== false),
        );
        if (eventSessionId && sessionStillRunning) {
          releasePromptBusy(eventSessionId, eventRunGeneration, eventRunEpoch);
          sessionRunningOverridesRef.current.set(eventSessionId, true);
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? applySidebarRunningOverride(session, true)
                : session,
            ),
          );
          // A completed tool proves that the turn continues, but says nothing
          // about a following auto-compaction. Only compaction_start/end own
          // the compaction fact; do not clear a newer compaction projection.
          const cacheCompacting =
            viewCacheRef.current.get(eventSessionId)?.state.isCompacting ===
            true;
          patchSessionCache(eventSessionId, {
            isStreaming: true,
            // A preceding compaction_start owns the visible phase until its
            // matching terminal event; a delayed tool terminal is stale for
            // that field even though it still proves the turn remains active.
            ...(cacheCompacting || staleAcrossCompletedCompaction
              ? null
              : { toolStatus: status }),
            state: { isStreaming: true },
          });
        }
        const paneCompacting =
          viewedSessionIdRef.current === eventSessionId &&
          paneStateRef.current.isCompacting === true;
        if (
          viewingEventSession &&
          sessionStillRunning &&
          !paneCompacting &&
          !staleAcrossCompletedCompaction
        )
          dispatchPane({
            type: "TOOL_STATUS_UPDATED",
            sessionId: eventSessionId,
            status,
          });
      } else if (type === "pi_chat_native_steering_cleared") {
        if (eventSessionId) {
          const incomingRevision = typeof event.pendingSteerRevision === "number"
            ? event.pendingSteerRevision
            : 0;
          const previousProjection = pendingSteerProjectionRef.current.get(eventSessionId);
          if (previousProjection && incomingRevision < previousProjection.revision)
            return;
          pendingSteerProjectionRef.current.set(eventSessionId, {
            revision: incomingRevision,
            items: [],
          });
          const pending = localUserTurnsRef.current.get(eventSessionId) || [];
          const remaining = removePendingSteeringTurns(pending);
          syncPendingSteers(eventSessionId, []);
          if (remaining.length)
            localUserTurnsRef.current.set(eventSessionId, remaining);
          else localUserTurnsRef.current.delete(eventSessionId);
          const droppedCount = Number(event.droppedCount || 0);
          if (viewingEventSession) {
            dispatchPane({
              type: "PROMPT_ACKNOWLEDGED",
              sessionId: eventSessionId,
              messages: (current) =>
                current.filter(
                  (message) =>
                    !pending.some(
                      (turn) =>
                        turn.revealOnMessageStart &&
                        turn.queueState === "waiting" &&
                        turn.message === message,
                    ),
                ),
            });
          }
          // An accepted Steer can be dropped when Pi settles or crashes before
          // consuming it. Never let that be silent, including when the user is
          // currently viewing another Session.
          if (droppedCount > 0) {
            const message = steeringClearedMessage(
              String(event.reason || "cleared"),
            );
            if (viewingEventSession) setError(message);
            else
              unreadSteeringDropMessagesRef.current.set(
                eventSessionId,
                message,
              );
          }
        }
      } else if (type === "agent_settled") {
        if (eventSessionId) {
          streamingWireProjectionsRef.current.delete(eventSessionId);
          streamGapRecoveriesRef.current.delete(eventSessionId);
        }
        if (eventSessionId)
          dispatchAskQuestionnaire({
            type: "CLOSE_SESSION",
            sessionId: eventSessionId,
          });
        if (eventSessionId && clearStoppingForSession(eventSessionId)) {
          setNotice((current) =>
            current === "已发送停止请求，Pi 正在结束当前操作" ? "" : current,
          );
        }
        if (eventSessionId)
          releasePromptBusy(
            eventSessionId,
            eventRunGeneration,
            eventRunEpoch,
            true,
          );
        const completedAssistantReply =
          eventSessionId &&
          terminalAssistantSessionIdsRef.current.delete(eventSessionId);
        if (eventSessionId) {
          const settledMessages = viewCacheRef.current.get(eventSessionId)?.messages || (viewingEventSession ? pane.messages : []);
          const assistantMessages = settledMessages.filter((message) => message.role === "assistant");
          const visibleAssistantMessages = assistantMessages.filter((message) => {
            if (typeof message.content === "string") return Boolean(message.content.trim());
            return Array.isArray(message.content) && message.content.some(
              (block) => block.type === "text" && Boolean(block.text?.trim()),
            );
          });
          if (!completedAssistantReply && visibleAssistantMessages.length === 0) {
            recordBrowserStateDiagnostic("projection", "assistant-settlement-gap", {
              sessionId: eventSessionId,
              runGeneration: eventRunGeneration,
              details: {
                settlementSource: "agent-settled",
                messageCount: settledMessages.length,
                assistantCount: assistantMessages.length,
                visibleAssistantCount: visibleAssistantMessages.length,
                eventType: lastSessionEventTypeRef.current.get(eventSessionId) || "unknown",
                projectionSource: "sse",
              },
            });
          }
        }
        if (completedAssistantReply && !viewingEventSession) {
          setUnseenReplySessionIds((current) =>
            current.includes(eventSessionId)
              ? current
              : [...current, eventSessionId],
          );
        }
        if (eventSessionId) {
          clearEmptyQueuePause(eventSessionId);
          // Settlement is terminal even if the user navigated away before this
          // SSE frame arrived; always release the owning stop lease.
          completedCompactionSessionIdsRef.current.add(eventSessionId);
          clearStoppingForSession(eventSessionId);
          sessionRunningOverridesRef.current.set(eventSessionId, false);
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? settleSidebarActivity(session)
                : session,
            ),
          );
          patchSessionCache(eventSessionId, {
            isStreaming: false,
            liveMessage: undefined,
            toolStatus: "",
            sessionActivity: settledPaneActivity(
              viewCacheRef.current.get(eventSessionId)?.session.activity,
              eventRunDurationMs,
            ),
            state: { isStreaming: false, isCompacting: false },
          });
        }
        if (eventSessionId && typeof eventRunGeneration === "number")
          streamDiagnosticsRef.current?.terminal({
            sessionId: eventSessionId,
            runGeneration: eventRunGeneration,
          });
        if (viewingEventSession) {
          clearPromptReconcileTimer();
          dispatchPane({
            type: "AGENT_SETTLED",
            sessionId: eventSessionId,
            ...(eventRunDurationMs !== undefined ? { runDurationMs: eventRunDurationMs } : null),
          });
          // A post-compaction turn has now persisted its new usage snapshot.
          const requestVersion =
            sessionEventVersionRef.current.get(eventSessionId) || 0;
          const queueRequestRevision =
            queueProjectionRevisionRef.current.get(eventSessionId) || 0;
          const authority = capturePaneAuthority(eventSessionId);
          void fetchSessionView(eventSessionId)
            .then((view) => {
              if (
                paneAuthorityCanCommit(authority) &&
                (sessionEventVersionRef.current.get(eventSessionId) || 0) ===
                  requestVersion
              )
                applySessionView(view, authority, queueRequestRevision);
            })
            .catch(() => undefined);
        }
        scheduleSidebarRefresh();
      } else if (type === "pi_chat_active_session_changed") {
        const ids = activeSessionIdsFromEvent(event.activeSessionIds);
        setActiveSessionIds(ids);
        viewCacheRef.current.setPinned(ids);
        setSessions((current) => applyActiveSessionIds(current, ids));
        const id = typeof event.sessionId === "string" ? event.sessionId : "";
        if (id === viewedSessionIdRef.current && !ids.includes(id))
          dispatchPane({
            type: "RUNTIME_STATUS_CHANGED",
            sessionId: id,
            status: "view-only",
          });
        scheduleSidebarRefresh();
      } else if (type === "pi_chat_primary_runtime_status") {
        const readiness = event.primaryRuntime as
          Partial<PrimaryRuntimeReadiness> | undefined;
        if (
          readiness &&
          (readiness.status === "starting" ||
            readiness.status === "ready" ||
            readiness.status === "failed") &&
          typeof readiness.generation === "number"
        ) {
          const incoming = readiness as PrimaryRuntimeReadiness;
          const current = primaryRuntimeRef.current;
          const next = acceptPrimaryReadiness(current, incoming);
          const acceptedTransition =
            next.generation !== current.generation ||
            next.status !== current.status ||
            next.error !== current.error;
          if (acceptedTransition) {
            publishPrimaryReadiness(next);
            // A new startup or failure invalidates the preceding generation's
            // ModelInfo.input assertion before a later ready can paint.
            if (next.status !== "ready") {
              publishPrimaryCapabilitySnapshot(null);
              // Fast is Runtime-generation state. Clear the old visible/cache
              // projection as soon as a Primary replacement starts; a later
              // current-generation extension event may explicitly re-enable it.
              const previousPrimarySessionId = current.sessionId || "";
              const resetFastSessionId =
                next.sessionId || previousPrimarySessionId;
              if (resetFastSessionId) {
                patchSessionCache(resetFastSessionId, {
                  state: { fastModeActive: false },
                });
                if (viewedSessionIdRef.current === resetFastSessionId)
                  dispatchPane({
                    type: "FAST_MODE_CHANGED",
                    sessionId: resetFastSessionId,
                    active: false,
                  });
              }
            }
            // Ready is now an adopted state/capability snapshot, not a request
            // to issue another bootstrap/get_state. Update only the exact
            // visible Primary pane or local draft; cold/Secondary panes keep
            // their independent Session state.
            if (next.status === "ready" && next.model) {
              rememberObservedModel(next.model);
              const target = localDraftRef.current
                ? { kind: "draft" as const }
                : next.sessionId
                  ? { kind: "session" as const, sessionId: next.sessionId }
                  : { kind: "draft" as const };
              dispatchPane({
                type: "RUNTIME_SETTINGS_ADOPTED",
                target,
                state: {
                  model: next.model,
                  thinkingLevel: next.thinkingLevel,
                },
              });
            }
          }
          // Commands, stats, and the complete model catalogue remain Bootstrap
          // metadata. This refresh is safe after atomic adoption because the
          // server no longer sends a second get_state for an adopted child.
          if (incoming.status === "ready")
            void refresh().catch(reportBackgroundRefreshError);
        }
      } else if (type === "pi_chat_workspace_changed") {
        const cwd = typeof event.cwd === "string" ? event.cwd : "";
        const workspaceEpoch =
          typeof event.workspaceEpoch === "string"
            ? event.workspaceEpoch
            : runEpochRef.current;
        const workspaceRevision =
          typeof event.workspaceRevision === "number" &&
          Number.isFinite(event.workspaceRevision)
            ? event.workspaceRevision
            : workspaceRevisionRef.current + 1;
        if (
          cwd &&
          (!workspaceEpochRef.current ||
            workspaceEpoch === workspaceEpochRef.current) &&
          workspaceRevision >= workspaceRevisionRef.current
        ) {
          workspaceEpochRef.current =
            workspaceEpoch || workspaceEpochRef.current;
          workspaceRevisionRef.current = workspaceRevision;
          setWorkspaceCwd(cwd);
        }
      } else if (type === "pi_chat_models_updated") {
        const nextModels = Array.isArray(event.models)
          ? mergeModelCatalog([], event.models as ModelInfo[])
          : [];
        setModels(nextModels);
        saveModelCatalog(nextModels);
        setModelRuntimeSyncPending(event.runtimeSync === "waiting-for-runtime-reload");
        setNotice(
          event.runtimeSync === "waiting-for-runtime-reload"
            ? "模型配置已更新；当前请求继续使用旧 Runtime，新请求将在 Runtime 刷新后应用。"
            : "模型目录已更新。",
        );
      } else if (type === "pi_chat_application_lifecycle") {
        const lifecycle = acceptApplicationLifecycle(
          applicationLifecycleRef.current,
          event.lifecycle || "idle",
        );
        if (lifecycle !== "idle") cancelPendingNavigation();
        if (lifecycle === "resources-reloading" && !resourceReloadActiveRef.current) {
          resourceReloadActiveRef.current = true;
          resetResourceReloadTransientState();
        } else if (lifecycle === "idle") {
          resourceReloadActiveRef.current = false;
        }
        publishApplicationLifecycle(lifecycle);
        if (lifecycle === "restarting")
          setNotice("Pi Chat 正在构建并重启，暂时停止接收新操作…");
        else if (lifecycle === "workspace-changing")
          setNotice("正在切换工作目录…");
        else if (lifecycle === "resources-reloading")
          setNotice("正在更新配置并重载 Runtime…");
        else if (lifecycle === "models-refreshing")
          setNotice("正在刷新模型目录…");
        else if (lifecycle === "idle") {
          startIdleRecovery(false, true);
        }
      } else if (type === "pi_chat_reloaded") {
        // Older servers may emit the reload marker without a preceding
        // lifecycle frame. Treat it as the same Runtime replacement boundary.
        if (!resourceReloadActiveRef.current) {
          resourceReloadActiveRef.current = true;
          resetResourceReloadTransientState();
        }
        setNotice("配置已更新，正在确认新的 Pi Runtime…");
      } else if (type === "pi_chat_sessions_changed") {
        // Prompt admission and streaming creation events are frequent. Retain the
        // old snapshot so returning to a running Session paints immediately; its
        // background view request then merges the current live draft. Only a
        // structural mutation makes the cached view semantically invalid.
        const structuralAction = String(event.action || "");
        const structuralSessionId =
          typeof event.sessionId === "string" ? event.sessionId : "";
        if (
          structuralSessionId &&
          ["deleted", "renamed"].includes(structuralAction)
        ) {
          viewCacheRef.current.forget(structuralSessionId);
          if (structuralAction === "deleted") {
            completedCompactionSessionIdsRef.current.delete(structuralSessionId);
            const wasViewed = finalizeDeletedSession(structuralSessionId);
            selectDeletionFallback(
              structuralSessionId,
              sessionsRef.current.filter(
                (session) => session.id !== structuralSessionId,
              ),
              wasViewed,
            );
          }
          // A renamed SSE has no resulting name; await authoritative metadata.
        }
        scheduleSidebarRefresh();
      } else if (type === "pi_chat_queue_update") {
        // Queue updates are complete server snapshots. A malformed frame must
        // not be interpreted as an empty queue, or every accepted local turn
        // would temporarily fall outside both the queue and transcript.
        if (!Array.isArray(event.queue)) {
          recordSseRejectionDiagnostic({
            sessionId: eventSessionId,
            runGeneration: eventRunGeneration,
            eventType: type,
            decisionReason: "malformed-queue-snapshot",
          });
          return;
        }
        const currentProjection = acceptQueueProjection(
          eventSessionId,
          event.queue as unknown as QueuedPrompt[],
          event.paused === true,
          "event",
        );
        const currentQueue = currentProjection.queue;
        const admittedId =
          typeof event.admittedId === "string" ? event.admittedId : "";
        const admitted = admittedId
          ? currentQueue.find((item) => item.id === admittedId)
          : undefined;
        const localTurns = eventSessionId
          ? localUserTurnsRef.current.get(eventSessionId) || []
          : [];
        const turn = admitted
          ? bindQueuedAdmission(
              localTurns,
              admitted.id,
              admitted.message,
              admitted.imageCount,
            )
          : undefined;
        const removeAdmittedTurn = Boolean(turn?.renderedInTranscript);
        if (turn) turn.renderedInTranscript = false;
        // The queue snapshot itself is authoritative evidence that an ordinary
        // queued item has left the waiting FIFO. This handles a lost
        // queue_dispatch frame during SSE reconnect/backpressure. Native Steers
        // and queue-error retries remain hidden until their own authority says
        // they may be revealed.
        const promotedTurns = promoteTurnsAbsentFromQueue(
          localTurns,
          new Set(currentQueue.map((item) => item.id)),
          false,
          true,
          cancellingQueueIdsRef.current.get(eventSessionId),
        );
        const promotedForPane = viewingEventSession
          ? promotedTurns.filter((candidate) => !candidate.renderedInTranscript)
          : [];
        for (const promoted of promotedForPane)
          promoted.renderedInTranscript = true;
        const messagePatch =
          (removeAdmittedTurn && Boolean(turn)) || promotedForPane.length
            ? (current: PiMessage[]) => {
                let next = removeAdmittedTurn && turn
                  ? current.filter((candidate) => candidate !== turn.message)
                  : current;
                for (const promoted of promotedForPane) {
                  if (!next.includes(promoted.message))
                    next = [...next, promoted.message];
                }
                return next;
              }
            : undefined;
        if (eventSessionId)
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? applySidebarQueueProjection(
                    session,
                    currentQueue,
                    currentProjection.paused,
                  )
                : session,
            ),
          );
        if (eventSessionId)
          patchSessionCache(eventSessionId, {
            queue: currentQueue,
            queuePaused: currentProjection.paused,
          });
        if (viewingEventSession)
          dispatchPane({
            type: "QUEUE_UPDATED",
            sessionId: eventSessionId,
            queue: currentQueue,
            paused: currentProjection.paused,
            messages: messagePatch,
            pendingUserMessage: turn
              ? (current) => (current === turn.message ? null : current)
              : undefined,
          });
        if (eventSessionId && viewingEventSession && promotedTurns.length)
          requestPromptReconcileRef.current(eventSessionId);
      } else if (type === "pi_chat_queue_dispatch") {
        const dispatchedId = typeof event.id === "string" ? event.id : "";
        const dispatchProjection = eventSessionId
          ? acceptQueueProjection(
              eventSessionId,
              (
                latestQueueProjectionRef.current.get(eventSessionId)?.queue ||
                viewCacheRef.current.get(eventSessionId)?.queue ||
                []
              ).filter((item) => item.id !== dispatchedId),
              latestQueueProjectionRef.current.get(eventSessionId)?.paused ||
                viewCacheRef.current.get(eventSessionId)?.queuePaused === true,
              "event",
            )
          : { queue: [], paused: false };
        if (eventSessionId) {
          patchSessionCache(eventSessionId, {
            queue: dispatchProjection.queue,
            queuePaused: dispatchProjection.paused,
          });
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? applySidebarQueueProjection(
                    session,
                    dispatchProjection.queue,
                    dispatchProjection.paused,
                  )
                : session,
            ),
          );
        }
        const dispatchedMessage =
          typeof event.message === "string" ? event.message : "";
        const imageCount =
          typeof event.imageCount === "number" &&
          Number.isFinite(event.imageCount)
            ? event.imageCount
            : 0;
        const localTurns = eventSessionId
          ? localUserTurnsRef.current.get(eventSessionId) || []
          : [];
        const displaySettings = displaySettingsFromEvent(
          event.settings,
          paneStateRef.current.model,
        );
        if (eventSessionId && Object.keys(displaySettings).length) {
          patchSessionCache(eventSessionId, { state: displaySettings });
          if (viewingEventSession)
            dispatchPane({
              type: "RUNTIME_SETTINGS_ADOPTED",
              target: { kind: "session", sessionId: eventSessionId },
              state: displaySettings,
            });
        }
        // Dispatch can beat the enqueue HTTP acknowledgement. Bind its queue ID to the
        // already-protected local turn before considering an observer fallback.
        const cancelling = eventSessionId
          ? cancellingQueueIdsRef.current.get(eventSessionId)
          : undefined;
        if (cancelling && dispatchedId) {
          cancelling.delete(dispatchedId);
          if (!cancelling.size)
            cancellingQueueIdsRef.current.delete(eventSessionId);
        }
        const knownLocally = bindQueuedDispatch(
          localTurns,
          dispatchedId,
          dispatchedMessage,
          imageCount,
        );
        if (knownLocally) {
          knownLocally.queueState = "dispatched";
          if (viewingEventSession) {
            const shouldAppend = !knownLocally.renderedInTranscript;
            if (shouldAppend) knownLocally.renderedInTranscript = true;
            dispatchPane({
              type: "QUEUE_DISPATCHED",
              sessionId: eventSessionId,
              queue: dispatchProjection.queue,
              pendingUserMessage: (current) =>
                current === knownLocally.message ? null : current,
              messages: shouldAppend
                ? (current) =>
                    current.includes(knownLocally.message)
                      ? current
                      : [...current, knownLocally.message]
                : undefined,
            });
          }
        }
        if (eventSessionId && !knownLocally) {
          const confirmedIds = confirmedQueueDispatchIdsRef.current.get(eventSessionId);
          const wasAlreadyConfirmed = Boolean(
            dispatchedId && confirmedIds?.has(dispatchedId),
          );
          if (wasAlreadyConfirmed && confirmedIds) {
            confirmedIds.delete(dispatchedId);
            if (!confirmedIds.size)
              confirmedQueueDispatchIdsRef.current.delete(eventSessionId);
          }
          if (wasAlreadyConfirmed) {
            // The authoritative view already contained this turn and removed
            // its local admission. A late dispatch is only a transport echo;
            // never create a second synthetic bubble for it.
            if (viewingEventSession)
              dispatchPane({
                type: "QUEUE_DISPATCHED",
                sessionId: eventSessionId,
                queue: dispatchProjection.queue,
              });
          } else {
          const queuedText =
            dispatchedMessage ||
            (imageCount > 0 ? `请查看附加的 ${imageCount} 张图片` : "队列消息");
          const message = userMessage(queuedText, []);
          const source = viewCacheRef.current.get(eventSessionId);
          const turn: LocalUserTurn = {
            sessionId: eventSessionId,
            message,
            expectedTurnTotal: nextLocalTurnTotal(
              source?.messages || [],
              source?.turnTotal ??
                sourceTurnTotalsRef.current.get(eventSessionId),
              localTurns,
            ),
            baselineTurnTotal: authoritativeTurnTotal(eventSessionId),
            queueId: dispatchedId || undefined,
            queueState: "dispatched",
            confirmByPosition: imageCount > 0,
            renderedInTranscript: viewingEventSession,
          };
          localUserTurnsRef.current.set(eventSessionId, [...localTurns, turn]);
          if (viewingEventSession)
            dispatchPane({
              type: "QUEUE_DISPATCHED",
              sessionId: eventSessionId,
              queue: dispatchProjection.queue,
              messages: (current) => [...current, message],
            });
          }
        }
        if (eventSessionId)
          patchSessionCache(eventSessionId, {
            state: { isStreaming: true },
            isStreaming: true,
          });
      } else if (type === "pi_chat_prompt_delivery_uncertain") {
        if (viewingEventSession)
          setNotice(
            "消息已交给 Pi，正在确认执行状态；请勿重复发送",
          );
      } else if (type === "pi_chat_queue_error") {
        const eventQueue = Array.isArray(event.queue)
          ? (event.queue as unknown as QueuedPrompt[])
          : latestQueueProjectionRef.current.get(eventSessionId)?.queue ||
            viewCacheRef.current.get(eventSessionId)?.queue ||
            [];
        const currentProjection = acceptQueueProjection(
          eventSessionId,
          eventQueue,
          event.paused === true ||
            latestQueueProjectionRef.current.get(eventSessionId)?.paused === true,
          "event",
        );
        const currentQueue = currentProjection.queue;
        const failedId = typeof event.id === "string" ? event.id : "";
        const queuedIds = new Set(currentQueue.map((item) => item.id));
        if (failedId) queuedIds.add(failedId);
        const localTurns = eventSessionId
          ? localUserTurnsRef.current.get(eventSessionId) || []
          : [];
        const failedRenderedTurns = new Set<PiMessage>();
        for (const turn of localTurns) {
          if (!turn.queueId || !queuedIds.has(turn.queueId)) continue;
          turn.queueState = "waiting";
          if (turn.queueId === failedId) turn.queueRetryPending = true;
          if (turn.renderedInTranscript) failedRenderedTurns.add(turn.message);
          turn.renderedInTranscript = false;
        }
        if (eventSessionId) {
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? applySidebarQueueProjection(
                    session,
                    currentQueue,
                    currentProjection.paused,
                  )
                : session,
            ),
          );
          patchSessionCache(eventSessionId, {
            queue: currentQueue,
            queuePaused: currentProjection.paused,
            state: { isStreaming: false },
            isStreaming: false,
            liveMessage: undefined,
            toolStatus: "",
          });
        }
        if (viewingEventSession) {
          dispatchPane({
            type: "QUEUE_FAILED",
            sessionId: eventSessionId,
            queue: currentQueue,
            paused: currentProjection.paused,
            messages: (current) =>
              current.filter(
                (candidate) => !failedRenderedTurns.has(candidate),
              ),
            pendingUserMessage: null,
          });
          const message = String(event.error || "队列消息发送失败");
          const incidentId =
            typeof event.incidentId === "string" &&
            /^PC-[A-Z0-9_-]{8}$/.test(event.incidentId)
              ? event.incidentId
              : "";
          setError(
            incidentId ? `${message}（事件 ID：${incidentId}）` : message,
          );
        }
      } else if (type === "pi_chat_fast_mode_changed") {
        const active = event.active === true;
        if (eventSessionId)
          patchSessionCache(eventSessionId, {
            state: { fastModeActive: active },
          });
        if (viewingEventSession)
          dispatchPane({
            type: "FAST_MODE_CHANGED",
            sessionId: eventSessionId,
            active,
          });
      } else if (type === "extension_ui_request") {
        const request = event as unknown as ExtensionUiRequest;
        if (["select", "confirm", "input", "editor"].includes(request.method)) {
          if (eventSessionId) {
            setSessions((current) =>
              current.map((session) =>
                session.id === eventSessionId
                  ? { ...session, pendingConfirmation: true }
                  : session,
              ),
            );
            patchSessionCache(eventSessionId, {
              pendingExtensionRequest: request,
            });
          }
          // UI "放行" can outlive a Pi RPC restart (extension state resets to strict).
          // Auto-allow Gate confirms so the top-right mode remains authoritative.
          if (viewingEventSession) {
            const sessionId = eventSessionId || viewedSessionIdRef.current;
            const authority = sessionId
              ? capturePaneAuthority(sessionId)
              : null;
            if (
              !authority ||
              !tryAutoAllowGate(request, sessionId, authority, true)
            )
              dispatchPane({
                type: "EXTENSION_REQUEST_CHANGED",
                sessionId,
                request,
              });
          }
        } else if (request.method === "notify") {
          const mode = gateModeFromNotice(request.message);
          if (mode && eventSessionId) {
            updateGateMode(eventSessionId, mode);
            if (pendingGateModesRef.current.get(eventSessionId) === mode)
              stageGateMode(eventSessionId, undefined);
          }
          if (viewingEventSession) setNotice(request.message || "Pi 通知");
        }
      } else if (type === "pi_chat_gate_mode_changed") {
        const mode = event.mode;
        if (eventSessionId && (mode === "strict" || mode === "open")) {
          updateGateMode(eventSessionId, mode);
          if (pendingGateModesRef.current.get(eventSessionId) === mode)
            stageGateMode(eventSessionId, undefined);
        }
      } else if (type === "pi_chat_session_control_changed") {
        const id = typeof event.sessionId === "string" ? event.sessionId : "";
        const owner =
          typeof event.controlOwner === "string"
            ? event.controlOwner
            : undefined;
        const controlledByThisWindow = event.controlledByThisWindow === true;
        if (id)
          patchSessionCache(id, {
            controlOwner: owner,
            controlledByThisWindow,
          });
        if (id === viewedSessionIdRef.current)
          dispatchPane({
            type: "CONTROL_UPDATED",
            sessionId: id,
            control: { controlOwner: owner, controlledByThisWindow },
          });
        if (id)
          setSessions((current) =>
            current.map((session) =>
              session.id === id
                ? { ...session, controlOwner: owner, controlledByThisWindow }
                : session,
            ),
          );
      } else if (type === "pi_chat_extension_request_resolved") {
        if (viewingEventSession)
          dispatchPane({
            type: "EXTENSION_REQUEST_RESOLVED",
            sessionId: eventSessionId,
            requestId: String(event.id || ""),
          });
        if (eventSessionId) {
          patchSessionCache(eventSessionId, {
            pendingExtensionRequest: undefined,
          });
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? { ...session, pendingConfirmation: false }
                : session,
            ),
          );
        }
      } else if (type === "extension_error") {
        if (viewingEventSession)
          setError(String(event.error || "扩展执行失败"));
      } else if (type === "pi_chat_session_status") {
        const activity = event.activity as
          Partial<SessionActivityState> | undefined;
        if (
          eventSessionId &&
          activity &&
          [
            "idle",
            "queued",
            "dispatching",
            "running",
            "paused",
            "failed",
          ].includes(String(activity.execution)) &&
          typeof activity.awaitingConfirmation === "boolean"
        ) {
          const next = activity as SessionActivityState;
          applySessionActivity(eventSessionId, next);
          if (Array.isArray(event.queue))
            projectStatusQueue(
              event.queue as unknown as QueuedPrompt[],
              event.paused === true,
            );
          if (viewingEventSession) {
            dispatchPane({
              type: "RUN_TIMING_UPDATED",
              sessionId: eventSessionId,
              ...(finiteRunMetric(next.runStartedAt) !== undefined
                ? { runStartedAt: finiteRunMetric(next.runStartedAt) }
                : ["idle", "queued", "failed"].includes(String(next.execution))
                  ? { runStartedAt: null }
                  : null),
              ...(finiteRunMetric(next.lastRunDurationMs) !== undefined
                ? { lastRunDurationMs: finiteRunMetric(next.lastRunDurationMs) }
                : null),
            });
          }
          const streaming =
            next.execution === "running" || next.execution === "dispatching";
          const terminalActivity =
            next.execution === "idle" ||
            next.execution === "queued" ||
            next.execution === "failed";
          // `queued` closes the preceding visible turn but is not a settled
          // generation: the scheduler can dispatch the next FIFO item under
          // the same generation before its agent_start advances the counter.
          // Marking queued as settled rejects that dispatch's queue snapshot.
          const settledActivity =
            next.execution === "idle" || next.execution === "failed";
          if (settledActivity && typeof eventRunGeneration === "number")
            settledRunGenerationsRef.current.set(
              eventSessionId,
              Math.max(
                settledRunGenerationsRef.current.get(eventSessionId) || 0,
                eventRunGeneration,
              ),
            );
          // `paused` means the follow-up queue is paused; the current Pi turn
          // may still be running while abort settles. It is not terminal proof.
          if (terminalActivity) {
            clearStoppingForSession(eventSessionId);
            clearEmptyQueuePause(eventSessionId);
          }
          patchSessionCache(eventSessionId, terminalActivity
            ? {
                isStreaming: false,
                liveMessage: undefined,
                toolStatus: "",
                state: { isStreaming: false, isCompacting: false },
              }
            : streaming
              ? {
                  isStreaming: true,
                  state: { isStreaming: true },
                }
              : {});
          if (terminalActivity) {
            releasePromptBusy(
              eventSessionId,
              eventRunGeneration,
              eventRunEpoch,
              true,
            );
          }
          if (viewingEventSession && terminalActivity) {
            clearPendingLiveMessage();
            dispatchPane({
              type: "AGENT_SETTLED",
              sessionId: eventSessionId,
              ...(eventRunDurationMs !== undefined ? { runDurationMs: eventRunDurationMs } : null),
            });
            // This activity fallback is used when message_end/agent_settled was
            // missed. Reconcile persisted history through the same generation
            // and pane-authority barriers instead of permanently discarding the
            // last live draft with no terminal replacement.
            const requestVersion =
              sessionEventVersionRef.current.get(eventSessionId) || 0;
            const queueRequestRevision =
              queueProjectionRevisionRef.current.get(eventSessionId) || 0;
            const authority = capturePaneAuthority(eventSessionId);
            void fetchSessionView(eventSessionId)
              .then((view) => {
                const versionUnchanged =
                  (sessionEventVersionRef.current.get(eventSessionId) || 0) ===
                  requestVersion;
                if (!versionUnchanged) return;
                if (paneAuthorityCanCommit(authority))
                  applySessionView(view, authority, queueRequestRevision);
                else rememberSessionView(view);
              })
              .catch(() => undefined);
          }
          if (terminalActivity && typeof eventRunGeneration === "number")
            streamDiagnosticsRef.current?.terminal({
              sessionId: eventSessionId,
              runGeneration: eventRunGeneration,
            });
        } else if (eventSessionId && typeof event.running === "boolean") {
          // Older servers still publish this partial event during a rolling update.
          const running = event.running === true;
          if (!running && typeof eventRunGeneration === "number")
            settledRunGenerationsRef.current.set(
              eventSessionId,
              Math.max(
                settledRunGenerationsRef.current.get(eventSessionId) || 0,
                eventRunGeneration,
              ),
            );
          if (!running) {
            clearStoppingForSession(eventSessionId);
            clearEmptyQueuePause(eventSessionId);
          }
          sessionRunningOverridesRef.current.set(eventSessionId, running);
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? applySidebarRunningOverride(session, running)
                : session,
            ),
          );
          patchSessionCache(eventSessionId, {
            isStreaming: running,
            ...(running
              ? null
              : {
                  liveMessage: undefined,
                  toolStatus: "",
                }),
            state: {
              isStreaming: running,
              ...(running ? null : { isCompacting: false }),
            },
          });
          if (!running)
            releasePromptBusy(
              eventSessionId,
              eventRunGeneration,
              eventRunEpoch,
              true,
            );
          if (!running) {
            patchSessionCache(eventSessionId, {
              sessionActivity: settledPaneActivity(
                viewCacheRef.current.get(eventSessionId)?.session.activity,
                eventRunDurationMs,
              ),
            });
          }
          if (viewingEventSession && !running) {
            clearPendingLiveMessage();
            dispatchPane({
              type: "AGENT_SETTLED",
              sessionId: eventSessionId,
              ...(eventRunDurationMs !== undefined ? { runDurationMs: eventRunDurationMs } : null),
            });
            const requestVersion =
              sessionEventVersionRef.current.get(eventSessionId) || 0;
            const queueRequestRevision =
              queueProjectionRevisionRef.current.get(eventSessionId) || 0;
            const authority = capturePaneAuthority(eventSessionId);
            void fetchSessionView(eventSessionId)
              .then((view) => {
                const versionUnchanged =
                  (sessionEventVersionRef.current.get(eventSessionId) || 0) ===
                  requestVersion;
                if (!versionUnchanged) return;
                if (paneAuthorityCanCommit(authority))
                  applySessionView(view, authority, queueRequestRevision);
                else rememberSessionView(view);
              })
              .catch(() => undefined);
          }
          if (!running && typeof eventRunGeneration === "number")
            streamDiagnosticsRef.current?.terminal({
              sessionId: eventSessionId,
              runGeneration: eventRunGeneration,
            });
        }
      } else if (type === "pi_chat_process_recovered") {
        if (eventSessionId) {
          completedCompactionSessionIdsRef.current.delete(eventSessionId);
          // Recovery itself is authoritative enough to remove an old red
          // projection. The following session-status frame refines this short
          // optimistic activity to the recovered Runtime's exact queue/run state.
          const previous = sessionsRef.current.find(
            (session) => session.id === eventSessionId,
          );
          const activity: SessionActivityState = {
            execution: previous?.running
              ? "running"
              : previous?.queued
                ? "queued"
                : "idle",
            awaitingConfirmation: previous?.pendingConfirmation === true,
          };
          sessionRunningOverridesRef.current.set(
            eventSessionId,
            activity.execution === "running",
          );
          setFailedSessionIds((current) =>
            current.filter((id) => id !== eventSessionId),
          );
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? {
                    ...session,
                    activity,
                    pendingConfirmation: activity.awaitingConfirmation,
                  }
                : session,
            ),
          );
          patchSessionCache(eventSessionId, { sessionActivity: activity });
        }
      } else if (type === "pi_chat_process_error") {
        if (eventSessionId) {
          streamingWireProjectionsRef.current.delete(eventSessionId);
          streamGapRecoveriesRef.current.delete(eventSessionId);
        }
        if (eventSessionId)
          dispatchAskQuestionnaire({
            type: "CLOSE_SESSION",
            sessionId: eventSessionId,
          });
        if (eventSessionId) {
          completedCompactionSessionIdsRef.current.delete(eventSessionId);
          clearStoppingForSession(eventSessionId);
          releasePromptBusy(
            eventSessionId,
            eventRunGeneration,
            eventRunEpoch,
            true,
          );
          terminalAssistantSessionIdsRef.current.delete(eventSessionId);
          sessionRunningOverridesRef.current.set(eventSessionId, false);
          setFailedSessionIds((current) => [
            ...new Set([...current, eventSessionId]),
          ]);
          const errorText =
            typeof event.error === "string" && event.error.trim()
              ? event.error.trim()
              : undefined;
          const incidentId =
            typeof event.incidentId === "string" &&
            /^PC-[A-Z0-9_-]{8}$/.test(event.incidentId)
              ? event.incidentId
              : undefined;
          // A Runtime failure keeps its reason in this Session's transcript, not
          // only in the five-second toast that the user cannot revisit. The text
          // matches the toast's fallback so an empty frame still names the cause.
          recordLocalFailure(
            eventSessionId,
            errorText || "Pi RPC 已退出",
            incidentId || undefined,
          );
          const error = errorText
            ? incidentId
              ? `${errorText}（事件 ID：${incidentId}）`
              : errorText
            : undefined;
          const activity: SessionActivityState = {
            execution: "failed",
            awaitingConfirmation: false,
            ...(eventRunDurationMs !== undefined ? { lastRunDurationMs: eventRunDurationMs } : null),
            ...(error ? { error } : null),
          };
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? {
                    ...session,
                    running: false,
                    pendingConfirmation: false,
                    activity,
                  }
                : session,
            ),
          );
          patchSessionCache(eventSessionId, {
            isStreaming: false,
            liveMessage: undefined,
            toolStatus: "",
            runtimeStatus: "view-only",
            sessionActivity: activity,
            state: { isStreaming: false, isCompacting: false },
          });
        }
        if (eventSessionId && typeof eventRunGeneration === "number")
          streamDiagnosticsRef.current?.terminal({
            sessionId: eventSessionId,
            runGeneration: eventRunGeneration,
          });
        if (viewingEventSession) {
          clearPromptReconcileTimer();
          dispatchPane({
            type: "PROCESS_FAILED",
            sessionId: eventSessionId,
            ...(eventRunDurationMs !== undefined ? { runDurationMs: eventRunDurationMs } : null),
          });
          const message =
            Number(event.nativeSteeringDroppedCount || 0) > 0
              ? steeringClearedMessage("process-error")
              : String(event.error || "Pi RPC 已退出");
          const incidentId =
            typeof event.incidentId === "string" &&
            /^PC-[A-Z0-9_-]{8}$/.test(event.incidentId)
              ? event.incidentId
              : "";
          setError(
            incidentId ? `${message}（事件 ID：${incidentId}）` : message,
          );
          // A process error can race an accepted queue admission before its
          // queue/dispatch frame reaches this browser. Reconcile the durable
          // Session instead of leaving a local turn dependent on navigation.
          requestPromptReconcileRef.current(eventSessionId);
        }
      }
    },
    [
      applySessionView,
      cancelPendingNavigation,
      clearPendingLiveMessage,
      drainPendingLiveMessage,
      refresh,
      reportBackgroundRefreshError,
      recordSseRejectionDiagnostic,
      rememberObservedModel,
      scheduleLiveMessage,
      scheduleSidebarRefresh,
      setRuntimeWarming,
      startIdleRecovery,
      releasePromptBusy,
      tryAutoAllowGate,
      updateGateMode,
      clearStoppingForSession,
      resetResourceReloadTransientState,
    ],
  );

  const handleEventSourceError = useCallback(
    (source: EventSource) => {
      source.close();
      if (applicationLifecycleRef.current === "restarting") {
        handoffWaitRef.current ||= api
          .waitForApplicationHandoff()
          .then(() => window.location.reload())
          .catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause));
            handoffWaitRef.current = null;
          });
        return;
      }
      setError("与 Pi Chat 服务的事件连接已断开，正在重新连接；当前任务状态待确认…");
      const retainedSessionId = viewedSessionIdRef.current || desiredSessionIdRef.current;
      const retainedSession = retainedSessionId
        ? sessionsRef.current.find((session) => session.id === retainedSessionId)
        : undefined;
      const retainedTurnActive = Boolean(
        retainedSession?.running
        || paneStateRef.current.isStreaming,
      );
      recoveringConnectionRef.current ||= api
        .recoverConnection()
        .then(() => {
          recoveringConnectionRef.current = null;
          // Recovery may have crossed a service/token boundary without an SSE
          // ready frame. Invalidate old refresh commits and process-owned UI
          // leases before bootstrapping with the newly accepted transport token.
          runEpochGenerationRef.current += 1;
          // A newly accepted transport token may belong to a replacement service
          // even when the old socket closed before delivering its changed epoch.
          // Detach every process-A sidebar scope before B's base inventory can
          // otherwise merge with retained full/directory rows from A.
          if (sessionRefreshTimerRef.current !== null)
            window.clearTimeout(sessionRefreshTimerRef.current);
          sessionRefreshTimerRef.current = null;
          sessionRefreshInFlightRef.current = false;
          sessionRefreshGenerationRef.current = null;
          sessionRefreshRequestedRef.current = false;
          loadAllSessionsGenerationRef.current = null;
          directoryLoadGenerationsRef.current.clear();
          directorySessionCoverageRef.current.clear();
          pinnedInventoryAttemptRef.current = "";
          showAllSessionsRef.current = false;
          sidebarFullRequestSequenceRef.current = 0;
          sidebarCommittedFullSequenceRef.current = 0;
          setLoadingAllSessions(false);
          setLoadingDirectoryKeys([]);
          sidebarInventoryReadyRef.current = false;
          setSidebarInventoryReady(false);
          transportRecoveryPendingRef.current = true;
          // Keep the last visible turn while the replacement token is being
          // verified. If the turn really ended, fresh bootstrap authority will
          // replace this temporary row and clear the pane normally.
          setSessions(retainedSession ? [
            retainedTurnActive
              ? applySidebarRunningOverride(retainedSession, true)
              : retainedSession,
          ] : []);
          setSessionsTotal(retainedSession ? 1 : 0);
          setSessionDirectories([]);
          // Drop only the transient interactive question. Streaming wire,
          // queue, local-turn and pane activity remain usable until a new ready
          // frame proves a process-epoch replacement.
          dispatchAskQuestionnaire({ type: "RESET" });
          if (retainedSession && retainedTurnActive)
            sessionRunningOverridesRef.current.set(retainedSession.id, true);
          setError("");
          bootstrapInFlightRef.current = null;
          handshakeInFlightRef.current = null;
          initialHistoryRef.current = null;
          refreshOperationTokenRef.current = null;
          setRefreshing(false);
          clearStoppingForSession();
          draftWorkspacePickerTokenRef.current = null;
          workspaceDefaultPickerTokenRef.current = null;
          setWorkspacePicking(false);
          setError("");
          setEventSourceGeneration((generation) => generation + 1);
          return refresh();
        })
        .catch((cause) => {
          reportBackgroundRefreshError(cause);
          recoveringConnectionRef.current = null;
        });
    },
    [clearStoppingForSession, refresh, reportBackgroundRefreshError],
  );

  const handleOversizedEventSourceFrame = useCallback(
    (source: EventSource) => {
      source.close();
      lastEventFrameAtRef.current = Date.now();
      sseFloodCountRef.current += 1;
      const delay = Math.min(
        30_000,
        1_000 * 2 ** Math.min(sseFloodCountRef.current - 1, 5),
      );
      if (sseReconnectTimerRef.current !== null)
        window.clearTimeout(sseReconnectTimerRef.current);
      void refresh().catch(reportBackgroundRefreshError);
      sseReconnectTimerRef.current = window.setTimeout(() => {
        sseReconnectTimerRef.current = null;
        setEventSourceGeneration((generation) => generation + 1);
      }, delay);
    },
    [refresh, reportBackgroundRefreshError],
  );

  const eventsUrl = useCallback(() => api.eventsUrl(), []);
  usePiEventSource({
    enabled: !loading,
    generation: eventSourceGeneration,
    url: eventsUrl,
    onReady: handleEventSourceReady,
    onPi: handlePiEvent,
    onError: handleEventSourceError,
    onOversized: handleOversizedEventSourceFrame,
  });

  useEffect(() => {
    if (loading) return;
    // SSE proves only that a socket exists. A renderer must be both visible and
    // focused to retain foreground write control; Edge can keep a minimized or
    // restored PWA page "visible" while another window is the real foreground.
    const isForeground = () =>
      document.visibilityState !== "hidden" && document.hasFocus();
    let foregroundCloseIntent = false;
    let lastSuccessfulPresenceRenewalAt = 0;
    let presenceRenewalInFlight: Promise<unknown> | null = null;
    const renewPresence = (force = false) => {
      if (!isForeground()) return;
      const now = Date.now();
      // Lifecycle events should remain responsive, while the watchdog only
      // renews when the previous successful lease is getting old. Coalescing
      // both in-flight and recently successful renewals avoids duplicate
      // presence writes without weakening foreground recovery.
      if (!force && now - lastSuccessfulPresenceRenewalAt < 7_000) return;
      if (presenceRenewalInFlight) return;
      presenceRenewalInFlight = api.renewPresence()
        .then(() => { lastSuccessfulPresenceRenewalAt = Date.now(); })
        .catch(() => undefined)
        .finally(() => { presenceRenewalInFlight = null; });
    };
    const relinquishPresence = () => {
      if (isForeground()) return;
      void api.relinquishPresence().catch(() => undefined);
    };
    // Native dialogs and ordinary task switching trigger blur. Keep the lease
    // until hidden/pagehide or its TTL instead of immediately dropping control.
    const pausePresenceRenewal = () => undefined;
    const resume = (event?: Event, forceRenewal = true) => {
      if (!isForeground()) {
        // A genuine close/reload commonly becomes hidden between beforeunload
        // and unload. Preserve its last fresh foreground lease until the close
        // beacon is sent; ordinary backgrounding has no latch and relinquishes.
        if (!foregroundCloseIntent) relinquishPresence();
        return;
      }
      foregroundCloseIntent = false;
      renewPresence(forceRenewal);
      // Chromium may preserve a half-open EventSource while a standalone PWA is
      // frozen. A real visibility/pageshow resume always gets a fresh socket;
      // focus/online/watchdog only reconnect after a missed heartbeat window.
      if (
        !shouldReconnectEventSource(
          event?.type,
          document.visibilityState,
          lastEventFrameAtRef.current,
          Date.now(),
        )
      )
        return;
      lastEventFrameAtRef.current = Date.now();
      setEventSourceGeneration((generation) => generation + 1);
      void refresh().catch(reportBackgroundRefreshError);
    };
    renewPresence();
    const watchdog = window.setInterval(() => resume(undefined, false), 10_000);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    const latchWindowClose = () => {
      // beforeunload can be cancelled, so latch only; a surviving pageshow/focus
      // clears this value. The later unload beacon is the actual close intent.
      foregroundCloseIntent = isForeground();
    };
    const signalWindowClose = () => {
      // pagehide/unload alone can mean PWA discard. Without a foreground latch,
      // remove only the page record and keep the local service alive.
      api.signalWindowClose(foregroundCloseIntent);
      foregroundCloseIntent = false;
    };
    window.addEventListener("blur", pausePresenceRenewal);
    window.addEventListener("beforeunload", latchWindowClose);
    window.addEventListener("unload", signalWindowClose);
    return () => {
      window.clearInterval(watchdog);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("blur", pausePresenceRenewal);
      window.removeEventListener("beforeunload", latchWindowClose);
      window.removeEventListener("unload", signalWindowClose);
    };
  }, [loading, refresh, reportBackgroundRefreshError]);

  useEffect(
    () => () => {
      clearPromptReconcileTimer();
      if (sseReconnectTimerRef.current !== null)
        window.clearTimeout(sseReconnectTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (loading || !viewedSessionId) return;
    if (!subagentAddressesRef.current.has(viewedSessionId))
      void api.markSessionViewed(viewedSessionId).catch(() => undefined);
    const steeringDrop =
      unreadSteeringDropMessagesRef.current.get(viewedSessionId);
    if (steeringDrop) {
      unreadSteeringDropMessagesRef.current.delete(viewedSessionId);
      setError(steeringDrop);
    }
  }, [loading, viewedSessionId]);

  useLayoutEffect(() => {
    const timeline = scrollRef.current;
    if (!timeline) return;
    // React has now committed this pane to the same timeline element. Keep a
    // separate painted identity because commitPane updates the synchronous
    // authority mirror before the old DOM is replaced; late scroll events in
    // that interval still belong to the old pane.
    paintedPaneIdentityRef.current = pane.identity;
    // RESET_DRAFT can replace one blank pane with another while both have the
    // same Session ID (`""`) and the same message arrays. Treat the committed
    // pane identity as a real navigation boundary so New never inherits the
    // previous Session's scrollTop.
    if (pane.identity.kind === "draft") {
      timeline.scrollTop = timeline.scrollHeight;
      stickToBottomRef.current = true;
      armBottomLayoutIntent(timeline);
      pendingScrollRestoreRef.current = "";
      scrollMemoryFenceRef.current = null;
      return;
    }
    const sessionId = pendingScrollRestoreRef.current;
    if (pane.identity.kind !== "session" || !sessionId || sessionId !== viewedSessionId) {
      if (pane.identity.kind === "session" && stickToBottomRef.current)
        armBottomLayoutIntent(timeline);
      return;
    }
    const target = scrollMemoryRef.current.target(
      sessionId,
      timeline.scrollHeight,
      timeline.clientHeight,
    );
    timeline.scrollTop = target.top;
    stickToBottomRef.current = target.stickToBottom;
    if (target.stickToBottom) armBottomLayoutIntent(timeline);
    else clearBottomLayoutIntent();
    pendingScrollRestoreRef.current = "";
    scrollMemoryFenceRef.current = null;
  }, [pane.identity, viewedSessionId, messages]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    // Tool status updates are deliberately excluded: they are frequent during streaming
    // and must never start a new scroll animation. Recheck inside rAF in case the user
    // scrolled into history between React commit and layout.
    requestAnimationFrame(() => {
      const timeline = scrollRef.current;
      if (!timeline || !stickToBottomRef.current) return;
      timeline.scrollTo({ top: timeline.scrollHeight, behavior: "auto" });
      const intent = bottomLayoutIntentRef.current;
      if (intent?.revision === paneCommitRevisionRef.current)
        intent.lastTop = timeline.scrollTop;
    });
  }, [pane.identity, messages, liveMessage]);

  useEffect(() => {
    const timeline = scrollRef.current;
    if (!timeline) return;
    let frame: number | null = null;
    const keepAtBottomAfterLayout = () => {
      if (!stickToBottomRef.current || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const current = scrollRef.current;
        if (current !== timeline || !stickToBottomRef.current) return;
        current.scrollTop = current.scrollHeight;
        const intent = bottomLayoutIntentRef.current;
        if (intent?.revision === paneCommitRevisionRef.current)
          intent.lastTop = current.scrollTop;
      });
    };
    const inner = timeline.querySelector<HTMLElement>(".timeline-inner") || timeline;
    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(keepAtBottomAfterLayout)
      : null;
    resizeObserver?.observe(inner);
    timeline.addEventListener("load", keepAtBottomAfterLayout, true);
    keepAtBottomAfterLayout();
    const fontsReady = timeline.ownerDocument.fonts?.ready;
    fontsReady?.then(keepAtBottomAfterLayout).catch(() => undefined);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      timeline.removeEventListener("load", keepAtBottomAfterLayout, true);
    };
  }, [pane.identity]);

  useEffect(() => {
    if (!error && !notice) return;
    const timer = window.setTimeout(() => {
      setError("");
      setNotice("");
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [error, notice]);

  const loadingEarlierRequestsRef = useRef(
    new Map<
      string,
      { token: symbol; navigationEpoch: number; controller: AbortController }
    >(),
  );
  const loadEarlierTurns = useCallback(async () => {
    const id = viewedSessionIdRef.current;
    const navigationEpoch = navigationEpochRef.current;
    const authority = capturePaneAuthority(id);
    const existingRequest = loadingEarlierRequestsRef.current.get(id);
    if (
      !id ||
      !messagesTruncated ||
      existingRequest?.navigationEpoch === navigationEpoch
    )
      return;
    const timeline = scrollRef.current;
    const previousHeight = timeline?.scrollHeight || 0;
    const requestedTurns = Math.min(10_000, visibleTurnCount + 10);
    const requestToken = Symbol(id);
    const controller = new AbortController();
    loadingEarlierRequestsRef.current.set(id, {
      token: requestToken,
      navigationEpoch,
      controller,
    });
    setLoadingEarlierRevision((current) => current + 1);
    setError("");
    stickToBottomRef.current = false;
    try {
      const requestVersion = sessionEventVersionRef.current.get(id) || 0;
      const queueRequestRevision =
        queueProjectionRevisionRef.current.get(id) || 0;
      const requestStartRevision = viewCacheRef.current.revisionFor(id);
      let view: SessionViewData;
      try {
        // A normal hot-runtime view also probes state, stats, and commands. Those
        // RPC reads can queue behind a long tool turn, leaving this button looking
        // permanently busy although the parsed in-memory history is already ready.
        // Prefer the RPC-free hot-memory snapshot, then use the JSONL-only view for
        // cold/reclaimed Sessions or an incomplete hot history.
        view = await fetchSessionView(id, requestedTurns, {
          fast: true,
          signal: controller.signal,
        });
        const visible = view.visibleTurnCount ?? 0;
        if (
          view.historyPending ||
          (view.turnTotal ?? 0) < turnTotal ||
          (view.messagesTruncated && visible <= visibleTurnCount)
        )
          throw new ApiRequestError(
            "热会话历史尚未就绪",
            409,
            "HOT_VIEW_UNAVAILABLE",
          );
      } catch (cause) {
        if (
          !(cause instanceof ApiRequestError) ||
          cause.code !== "HOT_VIEW_UNAVAILABLE"
        )
          throw cause;
        view = await fetchSessionView(id, requestedTurns, {
          signal: controller.signal,
        });
      }
      if (!paneAuthorityCanCommit(authority)) {
        recordBrowserStateDiagnostic("projection", "session-view-rejected", {
          sessionId: id,
          details: {
            authorityPresent: true,
            decisionReason: "stale-pane-authority",
          },
        });
        return;
      }
      // Events received while a historical page is loading are already held in
      // the pane cache. Do not discard a successful page merely because a live
      // status/tool frame arrived; merge it through the cache below instead.
      const eventVersion = sessionEventVersionRef.current.get(id) || 0;
      const loadedView =
        eventVersion === requestVersion
          ? view
          : viewCacheRef.current.mergeNavigation(view, requestStartRevision);
      applySessionView(loadedView, authority, queueRequestRevision);
      requestAnimationFrame(() => {
        if (!paneAuthorityCanCommit(authority)) return;
        const element = scrollRef.current;
        if (element)
          element.scrollTop = Math.max(
            0,
            element.scrollHeight - previousHeight,
          );
      });
    } catch (cause) {
      const currentRequest = loadingEarlierRequestsRef.current.get(id);
      if (
        !controller.signal.aborted &&
        currentRequest?.token === requestToken &&
        currentRequest.navigationEpoch === navigationEpoch &&
        paneAuthorityCanCommit(authority)
      ) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (loadingEarlierRequestsRef.current.get(id)?.token === requestToken) {
        loadingEarlierRequestsRef.current.delete(id);
        setLoadingEarlierRevision((current) => current + 1);
      }
    }
  }, [
    applySessionView,
    capturePaneAuthority,
    messagesTruncated,
    paneAuthorityCanCommit,
    turnTotal,
    visibleTurnCount,
  ]);

  const rememberCurrentScroll = () => {
    const element = scrollRef.current;
    // Scroll DOM and visibleTurnCount belong to the pane currently painted in
    // the DOM. Do not use the synchronous authority mirror here: during A → B,
    // that mirror already points to B while A can still be the painted
    // timeline. This keeps late scroll events tied to the actual pane geometry.
    const identity = paintedPaneIdentityRef.current;
    const sessionId = identity.kind === "session" ? identity.sessionId : "";
    if (!element || !sessionId) return;
    scrollMemoryRef.current.remember(
      sessionId,
      element.scrollTop,
      element.scrollHeight,
      element.clientHeight,
      visibleTurnCount,
    );
  };

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    // setPaneLoading() replaces the source transcript with a short loading pane.
    // Chromium emits a scroll event for that geometry change; it must not turn
    // the transient loading position into the Session's remembered position.
    if (scrollMemoryFenceRef.current) return;
    if (pendingScrollRestoreRef.current === viewedSessionIdRef.current) return;
    const bottomIntent = bottomLayoutIntentRef.current;
    if (bottomIntent?.revision === paneCommitRevisionRef.current) {
      if (Math.abs(element.scrollTop - bottomIntent.lastTop) <= BOTTOM_THRESHOLD) {
        // A layout/image/font reflow kept the same bottom anchor. Retain the
        // intent and let the layout observer move to the new max position.
        bottomIntent.lastTop = element.scrollTop;
        stickToBottomRef.current = true;
        return;
      }
      // A large delta is an explicit reading change, not a browser reflow.
      clearBottomLayoutIntent();
    }
    stickToBottomRef.current = isAtBottom(
      element.scrollTop,
      element.scrollHeight,
      element.clientHeight,
    );
    rememberCurrentScroll();
  };

  const clearConversationNavigationTarget = () => {
    conversationNavigationTargetRef.current = null;
    clearBottomLayoutIntent();
  };

  const navigateConversation = (
    direction: "top" | "previous" | "next" | "bottom",
  ) => {
    const timeline = scrollRef.current;
    if (!timeline) return;
    if (direction === "top") {
      clearBottomLayoutIntent();
      stickToBottomRef.current = false;
      conversationNavigationTargetRef.current = 0;
      timeline.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (direction === "bottom") {
      stickToBottomRef.current = true;
      conversationNavigationTargetRef.current = timeline.scrollHeight;
      armBottomLayoutIntent(timeline);
      timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
      return;
    }
    const timelineTop = timeline.getBoundingClientRect().top;
    const offsets = [
      ...timeline.querySelectorAll<HTMLElement>(".message-user"),
    ].map(
      (message) =>
        message.getBoundingClientRect().top - timelineTop + timeline.scrollTop,
    );
    const currentAnchor =
      conversationNavigationTargetRef.current ?? timeline.scrollTop + 14;
    const target = adjacentUserMessageOffset(offsets, currentAnchor, direction);
    if (target !== null) {
      clearBottomLayoutIntent();
      stickToBottomRef.current = false;
      conversationNavigationTargetRef.current = target;
      timeline.scrollTo({ top: Math.max(0, target - 14), behavior: "smooth" });
    }
  };

  const schedulePromptReconcile = (
    sessionId: string,
    eventVersion = sessionEventVersionRef.current.get(sessionId) || 0,
    failedAttempts = 0,
  ): void => {
    clearPromptReconcileTimer();
    const scheduler = promptReconcileSchedulerRef.current;
    const handle = scheduler.set(() => {
      promptReconcileTimerRef.current = null;
      if (viewedSessionIdRef.current !== sessionId) return;
      const latestVersion = sessionEventVersionRef.current.get(sessionId) || 0;
      if (latestVersion !== eventVersion) {
        schedulePromptReconcile(sessionId, latestVersion);
        return;
      }
      const authority = capturePaneAuthority(sessionId);
      const queueRequestRevision =
        queueProjectionRevisionRef.current.get(sessionId) || 0;
      void fetchSessionView(sessionId)
        .then((view) => {
          if (!paneAuthorityCanCommit(authority)) return;
          const completedVersion =
            sessionEventVersionRef.current.get(sessionId) || 0;
          if (completedVersion !== latestVersion) {
            schedulePromptReconcile(sessionId, completedVersion);
            return;
          }
          const reconciledView = acceptAuthoritativeIdleSessionView(view);
          applySessionView(reconciledView, authority, queueRequestRevision);
          const unresolvedLocalTurn = (
            localUserTurnsRef.current.get(sessionId) || []
          ).some((turn) => {
            if (turn.revealOnMessageStart) return false;
            if (
              turn.queueState === "waiting" &&
              turn.queueId &&
              Array.isArray(reconciledView.queue) &&
              reconciledView.queue.some((item) => item.id === turn.queueId)
            )
              return false;
            return true;
          });
          if (
            reconciledView.isStreaming ||
            (unresolvedLocalTurn && failedAttempts < 4)
          )
            schedulePromptReconcile(
              sessionId,
              completedVersion,
              reconciledView.isStreaming ? 0 : failedAttempts + 1,
            );
        })
        .catch((cause) => {
          if (!paneAuthorityCanCommit(authority)) return;
          // Background reconcile must not paint a red timeout while Pi is still
          // compacting or running tools. SSE agent_settled will refresh the view.
          if (failedAttempts < 4)
            schedulePromptReconcile(
              sessionId,
              latestVersion,
              failedAttempts + 1,
            );
          else {
            const message =
              cause instanceof Error ? cause.message : String(cause);
            if (!/请求超时|RPC 请求超时/.test(message)) setError(message);
          }
        });
    }, 4_000);
    promptReconcileTimerRef.current = { scheduler, handle };
  };
  requestPromptReconcileRef.current = (sessionId) =>
    schedulePromptReconcile(sessionId);

  const send = async (
    message: string,
    images: PromptImage[],
    delivery: PromptDelivery = "queue",
    requestedTargetSessionId = "",
  ) => {
    if (buildIdentityMismatch) return;
    const steering = delivery === "steer";
    if (requestedTargetSessionId && steering)
      throw new Error("子代理视图不能向父对话发送 Steer 消息");
    if (steering && !state.isStreaming)
      throw new Error("当前对话已不再运行，无法发送 Steer 消息");
    setError("");
    stickToBottomRef.current = true;
    const initialSessionId =
      requestedTargetSessionId ||
      viewedSessionIdRef.current ||
      (localDraftRef.current ? LOCAL_DRAFT_BUSY_ID : "");
    let busySessionId = initialSessionId;
    let finishSessionBusy = beginSessionBusy(busySessionId);
    const moveSessionBusyTo = (sessionId: string) => {
      if (!sessionId || sessionId === busySessionId) return;
      finishSessionBusy();
      busySessionId = sessionId;
      finishSessionBusy = beginSessionBusy(busySessionId);
    };
    const alreadyStreaming = state.isStreaming;
    const willQueueLocally =
      !steering && (alreadyStreaming || queuePaused || displayedQueue.length > 0);
    const previousToolStatus = toolStatus;
    const optimisticMessage =
      !steering &&
      !message.startsWith("/") &&
      (Boolean(state.isCompacting) || !willQueueLocally)
        ? userMessage(message, images)
        : null;
    const localTurn = optimisticMessage || userMessage(message, images);
    let targetSessionId = requestedTargetSessionId || viewedSessionIdRef.current;
    let promptQueueProjectionRevision = targetSessionId
      ? queueProjectionRevisionRef.current.get(targetSessionId) || 0
      : 0;
    const promptRunEpochGeneration = runEpochGenerationRef.current;
    const promptOperationIsInCurrentRun = () =>
      runEpochGenerationRef.current === promptRunEpochGeneration;
    let promptAuthority: ReturnType<typeof capturePaneAuthority> | null =
      targetSessionId && targetSessionId === viewedSessionIdRef.current
        ? capturePaneAuthority(targetSessionId)
        : null;
    let promptDraftAuthority: DraftPaneAuthority | null = targetSessionId
      ? null
      : captureDraftPaneAuthority();
    // Prompt acknowledgements and failures are both asynchronous pane facts.
    // A matching Session ID is not enough after A → B → A. The first New
    // submission begins in a draft, so it uses the matching draft token until
    // its atomic Session commit creates a session authority.
    const promptPaneIsCurrent = () =>
      promptAuthority
        ? paneAuthorityCanCommit(promptAuthority)
        : Boolean(
            promptDraftAuthority &&
            draftAuthorityCanCommit(promptDraftAuthority),
          );
    let protectedLocalTurn: LocalUserTurn | null = null;
    let promptBusyRelease: (() => void) | null = null;
    let promptAcceptedByEvent = false;
    let promptTerminalByEvent = false;
    let promptSubmitted = false;
    let promptOperationId = crypto.randomUUID();
    let serverPromptId: string | null = null;
    const protectLocalPrompt = (turn: PiMessage | null = localTurn) => {
      // A child transcript never receives optimistic parent turns, queue rows,
      // or Runtime projections. The server remains the sole parent authority
      // until that parent is explicitly viewed.
      if (
        !turn ||
        !targetSessionId ||
        targetSessionId !== viewedSessionIdRef.current ||
        protectedLocalTurn
      )
        return protectedLocalTurn;
      const pending = localUserTurnsRef.current.get(targetSessionId) || [];
      const nextLocalTurn: LocalUserTurn = {
        sessionId: targetSessionId,
        message: turn,
        promptOperationId,
        expectedTurnTotal: nextLocalTurnTotal(messages, turnTotal, pending),
        baselineTurnTotal: authoritativeTurnTotal(targetSessionId),
        queueState:
          (willQueueLocally || steering) && !message.startsWith("/")
            ? "waiting"
            : undefined,
        ...(steering
          ? { revealOnMessageStart: true, queueId: crypto.randomUUID() }
          : null),
        confirmByPosition: images.length > 0,
      };
      protectedLocalTurn = nextLocalTurn;
      localUserTurnsRef.current.set(targetSessionId, [
        ...pending,
        nextLocalTurn,
      ]);
      recordUserTurnLifecycle("optimistic-created", targetSessionId, nextLocalTurn);
      return nextLocalTurn;
    };
    const localTurnEntry = (): LocalUserTurn | undefined => {
      if (!targetSessionId) return undefined;
      const turns = localUserTurnsRef.current.get(targetSessionId) || [];
      return turns.find(
        (turn) =>
          turn.promptOperationId === promptOperationId
          || (serverPromptId && turn.serverPromptId === serverPromptId)
          || turn.message === localTurn,
      );
    };
    dispatchPane({
      type: "PROMPT_STARTED",
      target: targetSessionId
        ? { kind: "session", sessionId: targetSessionId }
        : { kind: "draft" },
      pendingUserMessage: optimisticMessage,
    });
    try {
      const command = /^\/(new|compact|abort)(?:\s+([\s\S]*))?$/.exec(message);
      if (command?.[1] === "new") {
        createSession();
        return;
      }
      if (command?.[1] === "compact") {
        if (localDraftRef.current)
          throw new Error("新对话尚未发送消息，无需压缩上下文");
        const authority = captureViewOperation();
        if (runtimeStatus !== "active") {
          dispatchPane({
            type: "RUNTIME_STATUS_CHANGED",
            sessionId: authority.sessionId,
            status: "restoring",
          });
          const queueRequestRevision =
            queueProjectionRevisionRef.current.get(authority.sessionId) || 0;
          const view = await api.activateSession(viewedSessionId);
          if (!viewOperationIsInCurrentRun(authority)) return;
          viewCacheRef.current.forget(view.session.id);
          if (viewOperationIsCurrent(authority))
            applySessionView(view, authority, queueRequestRevision);
          else {
            const projection = queueProjectionForView(
              view.session.id,
              view.queue,
              view.queuePaused === true,
              queueRequestRevision,
            );
            rememberSessionView(
              projection.known || projection.queue.length || projection.paused
                ? {
                    ...view,
                    queue: projection.queue,
                    queuePaused: projection.paused,
                  }
                : view,
            );
          }
        }
        await api.compact(command[2] || "", authority.sessionId);
        if (!viewOperationIsInCurrentRun(authority)) return;
        await refresh();
        if (viewOperationIsCurrent(authority)) setNotice("上下文压缩完成");
        return;
      }
      if (command?.[1] === "abort") {
        await stopGeneration();
        return;
      }

      // ModelInfo.input is advisory metadata only. Prompt delivery owns the
      // transport boundary; upstream Pi/model handling decides whether the
      // selected provider can interpret attached images.

      // Capture one immutable selection with the send operation. The visible
      // Composer may change while a cold Runtime warms, but that later choice
      // belongs to a later prompt and must not rewrite this one.
      const prefsKey = localDraftRef.current
        ? DRAFT_PREFS_KEY
        : targetSessionId;
      const staged = pendingSessionPrefsRef.current.get(prefsKey);
      // A draft has no Runtime-confirmed Gate state yet. Capture its explicit
      // local intent with this first request without promoting it to authority.
      const capturedDraftGateMode = localDraftRef.current
        ? pendingGateModesRef.current.get(DRAFT_PREFS_KEY)
        : undefined;
      const capturedSelection = staged
        ? {
            ...staged,
            ...(staged.model ? { model: { ...staged.model } } : null),
          }
        : undefined;
      const capturedPromptSettings = promptSettingsForSelection(
        capturedSelection,
      );
      if (capturedSelection?.model && modelInventoryConfirmed) {
        const route = validateSelectedRoute(
          models,
          capturedSelection.model.provider,
          capturedSelection.model.id,
          capturedSelection.model.api,
        );
        if (!route.ok) {
          setError(
            `当前模型路由无效：${capturedSelection.model.provider}/${capturedSelection.model.id}`
            + (capturedSelection.model.api ? `（${capturedSelection.model.api}）` : "")
            + " 不在当前 Runtime 的模型目录中，请重新选择模型。",
          );
          return;
        }
      }
      let initialPromptResult: Awaited<ReturnType<typeof api.prompt>> | null =
        null;
      if (localDraftRef.current) {
        const draftAuthority = captureDraftPaneAuthority();
        dispatchPane({
          type: "PROMPT_PREPARING",
          target: { kind: "draft" },
          status: WAITING_FOR_PI_STATUS,
        });
        // Once the combined mutation is written its outcome may be unknown;
        // retain the protected local bubble until SSE/JSONL proves otherwise.
        promptSubmitted = true;
        const clearViewedRequest = clearViewedPromiseRef.current;
        await clearViewedRequest;
        if (clearViewedPromiseRef.current === clearViewedRequest)
          clearViewedPromiseRef.current = null;
        if (!promptOperationIsInCurrentRun()) return;
        // One host transaction owns the empty draft through model/thinking/Gate
        // setup and prompt acceptance. Do not expose three extra browser round
        // trips after the dedicated Runtime has just cold-started.
        const submitNewSession =
          api.submitNewSession ||
          (async (input: {
            cwd?: string;
            message: string;
            images: PromptImage[];
            model?: ModelInfo | null;
            thinkingLevel?: ThinkingLevel;
            gateMode?: GateMode;
          }) => {
            const view = await api.newSession(input.cwd);
            if (!promptOperationIsInCurrentRun())
              throw new Error("服务已切换，已取消旧进程的新对话提交");
            const promptResult = await api.prompt(
              input.message,
              input.images,
              view.session.id,
              input.gateMode,
              "queue",
              promptSettingsForSelection(capturedSelection),
            );
            return {
              sessionId: view.session.id,
              session: view.session,
              state: view.state,
              gateMode: view.gateMode || "strict",
              accepted: true as const,
              queued: false as const,
              ...(promptResult.promptId ? { promptId: promptResult.promptId } : null),
              ...(promptResult.deliveryUncertain
                ? { deliveryUncertain: true }
                : null),
            };
          });
        const initial = await submitNewSession({
          cwd: draftWorkspaceCwd || workspaceCwd,
          message,
          images,
          // PiState supplies the displayed default only. Creating a new
          // Runtime must mutate Model/Thinking solely for an explicit Composer
          // selection captured with this first prompt.
          model: capturedSelection?.model,
          thinkingLevel: capturedSelection?.thinkingLevel,
          gateMode: capturedDraftGateMode,
        });
        if (!promptOperationIsInCurrentRun()) return;
        targetSessionId = initial.sessionId;
        if (initial.promptId) {
          promptCoordinatorRef.current.adoptAccepted(
            {
              promptId: promptOperationId,
              sessionId: targetSessionId,
              navigationEpoch: navigationEpochRef.current,
              runEpoch: runEpochRef.current,
              runtimeGeneration: sessionRunGenerationsRef.current.get(targetSessionId),
              delivery: steering ? "steer" : "queue",
            },
            initial.deliveryUncertain ? { type: "uncertain" } : { type: "run" },
          );
        }
        // The draft's own failure reason is resolved once its first message is
        // accepted; the Session that now exists keeps its own entries.
        setLocalFailures((current) => forgetLocalFailuresForSession(current, DRAFT_FAILURE_SCOPE));
        promptQueueProjectionRevision =
          queueProjectionRevisionRef.current.get(targetSessionId) || 0;
        moveSessionBusyTo(targetSessionId);
        protectLocalPrompt();
        const stillViewingDraft = draftAuthorityCanCommit(draftAuthority);
        const initialView: SessionViewData = {
          session: initial.session,
          state: initial.state,
          messages: [],
          messageTotal: 0,
          turnTotal: 0,
          visibleTurnCount: 0,
          messagesTruncated: false,
          isActive: true,
          runtimeStatus: "active",
          isStreaming: true,
          queue: [],
          queuePaused: false,
          gateMode: initial.gateMode,
        };
        if (stillViewingDraft) {
          applySessionView(initialView, draftAuthority);
          promptAuthority = capturePaneAuthority(targetSessionId);
          promptDraftAuthority = null;
          commitPaneIfCurrent(promptAuthority, {
            type: "PROMPT_PREPARING",
            target: { kind: "session", sessionId: targetSessionId },
            status: WAITING_FOR_PI_STATUS,
            clearPending: true,
          });
        } else rememberSessionView(initialView);
        // A choice made after Send started remains the draft's newer revision;
        // move it to the just-created ordinary target instead of dropping it.
        // A replacement New owns a newer draft authority and must keep its own
        // selection: an old async first-send completion may not touch it.
        if (draftAuthorityCanCommit(draftAuthority)) {
          const newestDraftSelection = pendingSessionPrefsRef.current.get(
            DRAFT_PREFS_KEY,
          );
          if (
            newestDraftSelection &&
            newestDraftSelection.revision !== capturedSelection?.revision
          ) {
            pendingSessionPrefsRef.current.set(
              targetSessionId,
              newestDraftSelection,
            );
            setComposerSelectionRevision((revision) => revision + 1);
          }
          pendingSessionPrefsRef.current.delete(DRAFT_PREFS_KEY);
          saveSessionComposerSelections(pendingSessionPrefsRef.current);
          // A Gate click after Send belongs to the next turn, just like a
          // newer Model/Thinking choice. Move only a distinct local intent;
          // the first request's captured value is already being confirmed.
          const newestDraftGateMode = pendingGateModesRef.current.get(
            DRAFT_PREFS_KEY,
          );
          if (
            newestDraftGateMode &&
            newestDraftGateMode !== capturedDraftGateMode
          )
            pendingGateModesRef.current.set(
              targetSessionId,
              newestDraftGateMode,
            );
          // This intent was fulfilled atomically by the initial request. The
          // returned mode remains unconfirmed until the server response/SSE
          // projection below; do not write it to gateModesRef.
          pendingGateModesRef.current.delete(DRAFT_PREFS_KEY);
          setComposerSelectionRevision((revision) => revision + 1);
          setPendingGateModes(Object.fromEntries(pendingGateModesRef.current));
        }
        // Preserve the ordinary acknowledgement/optimistic-turn path below;
        // only the transport setup was collapsed into this first request.
        initialPromptResult = initial;
        promptQueueProjectionRevision =
          queueProjectionRevisionRef.current.get(targetSessionId) || 0;
      } else if (runtimeStatus !== "active") {
        const activationAuthority = capturePaneAuthority(targetSessionId);
        dispatchPane({
          type: "PROMPT_PREPARING",
          target: { kind: "session", sessionId: targetSessionId },
          status: WAITING_FOR_PI_STATUS,
          runtimeStatus: "restoring",
        });
        protectLocalPrompt();
        promptAuthority = activationAuthority;
        // Warming establishes only Runtime capability. The exact captured
        // selection is applied by the server together with this prompt.
        const ready = await warmSessionRuntime(targetSessionId);
        if (!promptOperationIsInCurrentRun()) return;
        const activationIsCurrent = applyWarmReadiness(
          targetSessionId,
          ready,
          activationAuthority,
        );
        if (activationIsCurrent)
          commitPaneIfCurrent(activationAuthority, {
            type: "PROMPT_PREPARING",
            target: { kind: "session", sessionId: targetSessionId },
            status: WAITING_FOR_PI_STATUS,
            // Runtime readiness is not prompt acknowledgement. Keep the local
            // user bubble visible until PROMPT_ACKNOWLEDGED atomically moves it
            // into messages (or a definite rejection removes it).
          });
      } else if (!alreadyStreaming && promptAuthority) {
        commitPaneIfCurrent(promptAuthority, {
          type: "PROMPT_PREPARING",
          target: { kind: "session", sessionId: targetSessionId },
          status: WAITING_FOR_PI_STATUS,
        });
      }

      promptBusyRelease = () => {
        finishSessionBusy();
      };
      if (!alreadyStreaming)
        promptBusyReleasesRef.current.set(targetSessionId, {
          epoch: runEpochRef.current,
          afterGeneration:
            sessionRunGenerationsRef.current.get(targetSessionId) || 0,
          release: promptBusyRelease,
          markAccepted: () => {
            promptAcceptedByEvent = true;
          },
          markTerminal: () => {
            promptTerminalByEvent = true;
          },
        });
      const eventVersionBeforePrompt =
        sessionEventVersionRef.current.get(targetSessionId) || 0;
      // Protect the prompt across every asynchronous refresh until a JSONL view
      // confirms the additional user turn. This also covers active Sessions,
      // which have no Runtime-start view to pass through above.
      const admittedLocalTurn = protectLocalPrompt();
      promptSubmitted = true;
      const requestedGateMode =
        pendingGateModesRef.current.get(targetSessionId) ??
        gateModesRef.current[targetSessionId];
      if (!promptOperationIsInCurrentRun()) return;
      if (!initialPromptResult) promptOperationId = crypto.randomUUID();
      if (admittedLocalTurn && promptOperationId)
        admittedLocalTurn.promptOperationId = promptOperationId;
      const result =
        initialPromptResult ||
        await promptCoordinatorRef.current.admit(
          {
            promptId: promptOperationId!,
            sessionId: targetSessionId,
            navigationEpoch: navigationEpochRef.current,
            runEpoch: runEpochRef.current,
            runtimeGeneration: sessionRunGenerationsRef.current.get(targetSessionId),
            delivery: steering ? "steer" : "queue",
          },
          () => steering
            ? api.prompt(
                message,
                images,
                targetSessionId,
                requestedGateMode,
                "steer",
                undefined,
                admittedLocalTurn?.queueId,
              )
            : capturedPromptSettings
              ? api.prompt(
                  message,
                  images,
                  targetSessionId,
                  requestedGateMode,
                  "queue",
                  capturedPromptSettings,
                )
              : api.prompt(
                  message,
                  images,
                  targetSessionId,
                  requestedGateMode,
                ),
          {
            phaseForResult: (admission) => admission.deliveryUncertain
              ? { type: "uncertain" }
              : admission.queued
                ? { type: "queue" }
                : { type: "run" },
            phaseForError: (cause) => {
              const resultPending = resultPendingError(cause);
              const explicitClientRejection =
                cause instanceof ApiRequestError &&
                cause.status >= 400 &&
                cause.status < 500 &&
                !resultPending;
              const outcomeUnknown =
                resultPending ||
                (promptSubmitted &&
                  (promptAcceptedByEvent ||
                    promptTerminalByEvent ||
                    !explicitClientRejection));
              return outcomeUnknown ? { type: "uncertain" } : { type: "fail" };
            },
          },
        );
      if (promptOperationId && result.promptId) {
        serverPromptId = result.promptId;
        const boundOperation = promptCoordinatorRef.current.bindServerPromptId(
          promptOperationId,
          result.promptId,
        );
        if (["settled", "failed", "aborted"].includes(boundOperation.phase))
          promptCoordinatorRef.current.clearTerminal();
      }
      if (
        targetSessionId &&
        !result.queued &&
        !result.steered &&
        capturedSelection &&
        promptPaneIsCurrent()
      ) {
        const displaySettings = {
          ...(capturedSelection.model ? { model: capturedSelection.model } : null),
          ...(capturedSelection.thinkingLevel
            ? { thinkingLevel: capturedSelection.thinkingLevel }
            : null),
        };
        patchSessionCache(targetSessionId, { state: displaySettings });
        commitPaneIfCurrent(promptAuthority!, {
          type: "RUNTIME_SETTINGS_ADOPTED",
          target: { kind: "session", sessionId: targetSessionId },
          state: displaySettings,
        });
      }
      // This Session-scoped selection remains the Composer's next-normal-turn
      // default after admission, matching a persistent Model chooser. The
      // immutable captured object above still prevents a later click from
      // rewriting this already-admitted prompt.
      // HTTP acceptance can mean the prompt was queued, before Gate reaches its
      // dispatch boundary. First reconcile its Session-local admission even if
      // a refresh/navigation committed a newer pane while this response was in
      // flight. In particular, losing the old pane authority must never drop a
      // queue ID and strand a waiting local turn outside both Queue and history.
      // Only the later DOM/notice writes are pane-authority guarded.
      if (result.extension && protectedLocalTurn) {
        const pending = localUserTurnsRef.current.get(targetSessionId) || [];
        const remaining = removeLocalTurnAndRebase(pending, protectedLocalTurn);
        if (remaining.length)
          localUserTurnsRef.current.set(targetSessionId, remaining);
        else localUserTurnsRef.current.delete(targetSessionId);
        protectedLocalTurn = null;
      }
      const acceptedLocalTurn = localTurnEntry();
      if (acceptedLocalTurn && !result.steered) {
        const serverPromptId =
          typeof result.promptId === "string"
            ? result.promptId
            : result.queued && typeof result.id === "string"
              ? result.id
              : undefined;
        if (serverPromptId) {
          bindLocalTurnPromptIdentity(acceptedLocalTurn, { serverPromptId });
          recordUserTurnLifecycle("identity-bound", targetSessionId, acceptedLocalTurn, serverPromptId);
        }
      }
      const promptNavigationIsCurrent = Boolean(
        promptAuthority &&
        promptAuthority.navigationEpoch === navigationEpochRef.current &&
        viewedSessionIdRef.current === targetSessionId &&
        desiredSessionIdRef.current === targetSessionId,
      );
      // Bind the server queue ID as Session-scoped bookkeeping even when the
      // acknowledgement crossed navigation. Pane authority still fences the
      // visible projection below, but dropping this binding would strand an
      // accepted waiting turn without a recoverable queue identity.
      if (
        result.queued &&
        acceptedLocalTurn &&
        typeof result.id === "string"
      )
        markLocalTurnQueued(acceptedLocalTurn, result.id);
      const acknowledgedProjection = result.queue && promptNavigationIsCurrent
        ? (() => {
            const currentRevision =
              queueProjectionRevisionRef.current.get(targetSessionId) || 0;
            if (currentRevision === promptQueueProjectionRevision)
              return {
                ...acceptQueueProjection(
                  targetSessionId,
                  result.queue,
                  queuePaused,
                  "ack",
                ),
                accepted: true,
              };
            const current = latestQueueProjectionRef.current.get(
              targetSessionId,
            ) || { queue: [], paused: queuePaused };
            // A fresh SSE/mutation queue snapshot is stronger than this older
            // HTTP response. A view snapshot, however, may simply be the old
            // empty queue read that raced the acknowledgement, so retain the
            // historical recovery path for that source only.
            const source = queueProjectionSourceRef.current.get(targetSessionId);
            if (source === "event" || source === "mutation")
              return { ...current, accepted: false };
            if (!result.queued || typeof result.id !== "string")
              return { ...current, accepted: false };
            const acknowledgedTurn = localTurnEntry();
            if (
              acknowledgedTurn?.queueId === result.id &&
              acknowledgedTurn.queueState === "dispatched"
            )
              return { ...current, accepted: false };
            const admitted = result.queue.find((item) => item.id === result.id);
            if (!admitted) return { ...current, accepted: false };
            if (current.queue.some((item) => item.id === admitted.id))
              return { ...current, accepted: false };
            return {
              ...acceptQueueProjection(
                targetSessionId,
                [...current.queue, admitted],
                current.paused,
                "ack",
              ),
              accepted: true,
            };
          })()
        : undefined;
      const acknowledgedQueue = acknowledgedProjection?.accepted
        ? acknowledgedProjection.queue
        : undefined;
      let promotedAcknowledgedTurns: LocalUserTurn[] = [];
      if (
        result.steered &&
        acceptedLocalTurn?.queueState === "waiting" &&
        acceptedLocalTurn.queueId
      ) {
        syncPendingSteers(targetSessionId, [
          ...(pendingSteersRef.current.get(targetSessionId) || []),
          {
            id: acceptedLocalTurn.queueId,
            message: message || "请查看这些图片。",
            imageCount: images.length,
            createdAt: Date.now(),
          },
        ]);
      } else if (
        result.queued &&
        acceptedLocalTurn &&
        typeof result.id === "string"
      ) {
        // Dispatch SSE may beat this acknowledgement. Never demote a turn that
        // the scheduler has already started into the waiting-only queue UI.
        // A newer complete queue projection can prove that this acknowledged
        // item has already left the FIFO even when queue_dispatch was lost.
        const currentProjection = latestQueueProjectionRef.current.get(targetSessionId);
        if (
          currentProjection &&
          !currentProjection.queue.some((item) => item.id === result.id)
        )
          promotedAcknowledgedTurns = promoteTurnsAbsentFromQueue(
            localUserTurnsRef.current.get(targetSessionId) || [],
            new Set(currentProjection.queue.map((item) => item.id)),
            false,
            true,
            cancellingQueueIdsRef.current.get(targetSessionId),
          );
      } else if (!result.extension && !result.steered && acceptedLocalTurn) {
        acceptedLocalTurn.queueState = "dispatched";
      }
      if (!result.extension && !result.steered && acceptedLocalTurn) {
        const acceptedTurnTotal = acceptedLocalTurn.expectedTurnTotal;
        setSessions((current) =>
          current.map((session) =>
            session.id === targetSessionId &&
            acceptedTurnTotal > (session.turnCount || 0)
              ? { ...session, turnCount: acceptedTurnTotal }
              : session,
          ),
        );
      }
      const promotedAcknowledgedForPane = promptPaneIsCurrent()
        ? promotedAcknowledgedTurns.filter(
            (candidate) => !candidate.renderedInTranscript,
          )
        : [];
      for (const promoted of promotedAcknowledgedForPane)
        promoted.renderedInTranscript = true;
      // A prompt acknowledgement that crossed a real navigation boundary must
      // not schedule a background reconcile against the later pane. The later
      // A view owns its own authority and will reconcile the Session on entry;
      // allowing the stale chain to schedule here can retain a deferred React
      // update after unmount (and can repeatedly poll a stale test/consumer).
      if (targetSessionId && promotedAcknowledgedTurns.length && promptNavigationIsCurrent)
        requestPromptReconcileRef.current(targetSessionId);
      // A late acknowledgement is useful for Session reconciliation, but it
      // must not write into a later A pane after A → B → A. Queue state is
      // Session-owned: after a same-Session view commit (e.g. an SSE-driven
      // refresh snapshot taken before the acknowledgement) the ack is the only
      // authority and must restore the queue. After a real navigation the
      // newer view is authoritative, so the stale ack must stay inert.
      if (!promptPaneIsCurrent()) {
        if (
          result.queued &&
          acknowledgedQueue?.length &&
          promptAuthority?.navigationEpoch === navigationEpochRef.current &&
          viewedSessionIdRef.current === targetSessionId &&
          desiredSessionIdRef.current === targetSessionId
        ) {
          patchSessionCache(targetSessionId, {
            queue: acknowledgedQueue,
            queuePaused: acknowledgedProjection?.paused,
          });
          const currentAuthority = capturePaneAuthority(targetSessionId);
          commitPaneIfCurrent(currentAuthority, {
            type: "PROMPT_ACKNOWLEDGED",
            sessionId: targetSessionId,
            queue: acknowledgedQueue,
            toolStatus: previousToolStatus,
          });
          setSessions((current) =>
            current.map((session) =>
              session.id === targetSessionId
                ? applySidebarQueueProjection(session, acknowledgedQueue)
                : session,
            ),
          );
        }
        scheduleSidebarRefresh();
        return;
      }
      if (result.extension) {
        commitPaneIfCurrent(promptAuthority!, {
          type: "PROMPT_ACKNOWLEDGED",
          sessionId: targetSessionId,
          isStreaming: result.isStreaming,
          toolStatus: alreadyStreaming ? previousToolStatus : "",
        });
        const gateMode =
          result.command === "gate" ? gateModeFromCommand(message) : null;
        if (gateMode && targetSessionId)
          updateGateMode(targetSessionId, gateMode);
        setNotice(
          extensionExecutionNotice(
            message,
            result.command || "extension",
            result.description
              ? [
                  ...composerCommands,
                  {
                    name: result.command || "extension",
                    description: result.description,
                    source: "extension",
                  },
                ]
              : composerCommands,
          ),
        );
      } else if (result.steered) {
        protectLocalPrompt(localTurn);
        commitPaneIfCurrent(promptAuthority!, {
          type: "PROMPT_ACKNOWLEDGED",
          sessionId: targetSessionId,
          isStreaming: true,
          toolStatus: previousToolStatus,
        });
        setNotice(
          result.deliveryUncertain
            ? "Steer 已交给 Pi，正在确认执行状态；请勿重复发送"
            : "Steer 已送达 Pi",
        );
      } else if (result.queued) {
        // A waiting prompt belongs only in PromptQueue. The dispatch event is
        // the single transition that makes its local user bubble visible.
        const queuedTurn = localTurnEntry();
        if (acknowledgedQueue)
          patchSessionCache(targetSessionId, {
            queue: acknowledgedQueue,
            queuePaused: acknowledgedProjection?.paused,
          });
        const removeQueuedTurn =
          queuedTurn?.queueState === "waiting" &&
          queuedTurn.renderedInTranscript;
        if (removeQueuedTurn) queuedTurn.renderedInTranscript = false;
        // A dispatch event can beat this HTTP acknowledgement. In that race the
        // response contains the old enqueue snapshot, so SSE remains authoritative.
        const acknowledgementMessages =
          removeQueuedTurn || promotedAcknowledgedForPane.length
            ? (current: PiMessage[]) => {
                let next = removeQueuedTurn
                  ? current.filter(
                      (candidate) => candidate !== queuedTurn!.message,
                    )
                  : current;
                for (const promoted of promotedAcknowledgedForPane) {
                  if (!next.includes(promoted.message))
                    next = [...next, promoted.message];
                }
                return next;
              }
            : undefined;
        commitPaneIfCurrent(promptAuthority!, {
          type: "PROMPT_ACKNOWLEDGED",
          sessionId: targetSessionId,
          ...(acknowledgementMessages
            ? { messages: acknowledgementMessages }
            : null),
          ...(acknowledgedQueue && queuedTurn?.queueState !== "dispatched"
            ? { queue: acknowledgedQueue }
            : null),
          toolStatus: alreadyStreaming ? previousToolStatus : "",
        });
        if (acknowledgedQueue)
          setSessions((current) =>
            current.map((session) =>
              session.id === targetSessionId
                ? applySidebarQueueProjection(session, acknowledgedQueue)
                : session,
            ),
          );
        setNotice(
          queuedTurn?.queueState === "dispatched"
            ? "队列消息已开始执行"
            : "消息已加入队列",
        );
      } else {
        const eventVersionAfterPrompt =
          sessionEventVersionRef.current.get(targetSessionId) || 0;
        const terminalEvent =
          lastSessionEventTypeRef.current.get(targetSessionId);
        const settledBeforeAcknowledgement =
          promptTerminalByEvent ||
          (eventVersionAfterPrompt > eventVersionBeforePrompt &&
            (terminalEvent === "agent_settled" ||
              terminalEvent === "pi_chat_process_error"));
        if (settledBeforeAcknowledgement) {
          // A very fast turn can settle before the prompt HTTP acknowledgement.
          // Commit the local bubble before waiting for its final JSONL view.
          protectLocalPrompt(localTurn);
          commitPaneIfCurrent(promptAuthority!, {
            type: "PROMPT_ACKNOWLEDGED",
            sessionId: targetSessionId,
            messages: (current) =>
              appendLocalTurnOnce(current, localTurnEntry()),
          });
          try {
            const requestVersion =
              sessionEventVersionRef.current.get(targetSessionId) || 0;
            const queueRequestRevision =
              queueProjectionRevisionRef.current.get(targetSessionId) || 0;
            const view = await fetchSessionView(targetSessionId);
            if (
              promptAuthority &&
              paneAuthorityCanCommit(promptAuthority) &&
              (sessionEventVersionRef.current.get(targetSessionId) || 0) ===
                requestVersion
            )
              applySessionView(
                view,
                promptAuthority,
                queueRequestRevision,
              );
          } catch {
            // History already includes the optimistic user turn; a busy view RPC
            // must not turn a completed prompt into a red timeout banner.
          }
        } else {
          // A reconnect/view refresh may already have moved the protected local
          // overlay into `messages` while this HTTP acknowledgement was pending.
          // Do not create a duplicate user bubble in that race.
          protectLocalPrompt(localTurn);
          commitPaneIfCurrent(promptAuthority!, {
            type: "PROMPT_ACKNOWLEDGED",
            sessionId: targetSessionId,
            messages: (current) =>
              appendLocalTurnOnce(current, localTurnEntry()),
            isStreaming: true,
            toolStatus: WAITING_FOR_PI_STATUS,
          });
          schedulePromptReconcile(targetSessionId);
        }
        if (result.deliveryUncertain)
          setNotice("消息已交给 Pi，正在确认执行状态；请勿重复发送");
      }
    } catch (cause) {
      // Transport failure recovery has two ownership layers: the local admission
      // belongs to its Session even if a same-Session refresh committed a newer
      // pane while the request was in flight; only rendering/error presentation
      // belongs to a particular pane revision. Never strand a running-turn
      // admission as hidden `waiting` merely because its old pane token expired.
      const localEntry = localTurnEntry();
      const resultPending = resultPendingError(cause);
      // Whether this failure is definite is decided before anything is recorded:
      // a request that may still be executing must not leave a permanent failure
      // card under a running turn.
      const explicitClientRejection =
        cause instanceof ApiRequestError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        !resultPending;
      const outcomeUnknown =
        resultPending ||
        (promptSubmitted &&
          (promptAcceptedByEvent ||
            promptTerminalByEvent ||
            !explicitClientRejection));
      {
        // A failed upstream call never becomes an assistant message, so its reason
        // is kept in the transcript instead of only in the five-second toast.
        // Input validation stays a toast: the composer already explains it. A
        // steer keeps the composer's own surface, and a failure whose outcome is
        // unknown may still complete, so neither is recorded here.
        const failureText = cause instanceof Error ? cause.message : String(cause);
        const failureStatus = cause instanceof ApiRequestError ? cause.status : undefined;
        const failureCode = cause instanceof ApiRequestError ? cause.code : undefined;
        // A New draft's first message fails before the client learns the Session
        // id, so its reason is kept under the draft scope and shown in that pane.
        const scope = targetSessionId || (localDraftRef.current ? DRAFT_FAILURE_SCOPE : "");
        // Whether the *reason* is definite is decided by the server's own signal,
        // not by the broader client retention heuristic above: a returned 5xx is a
        // definite failure, while only a written-but-unanswered RPC is ambiguous.
        // A turn that SSE already proved accepted keeps running without a card, and
        // if it fails later Pi persists the attempt, which renders on its own.
        // Deliberate: a steer keeps the composer's own pending/steer surface, and
        // only an ordinary prompt that produced no assistant message needs a card.
        const failureIsDefinite =
          !resultPending &&
          !(cause instanceof ApiRequestError && cause.outcomeUnknown) &&
          !(promptAcceptedByEvent && !promptTerminalByEvent);
        if (scope && failureIsDefinite && !steering
          && isTranscriptWorthyFailure(failureText, failureStatus, failureCode))
          recordLocalFailure(
            scope,
            failureText,
            cause instanceof ApiRequestError ? cause.incidentId : undefined,
          );
      }
      if (modelUnavailableError(cause)) {
        // The Runtime rejected this Model, so the staged selection can never be
        // applied to this Session by retrying the same prompt. Dropping it makes
        // the pane fall back to the Runtime-confirmed Model instead of failing
        // every later prompt the same way.
        pendingSessionPrefsRef.current.delete(targetSessionId || DRAFT_PREFS_KEY);
        saveSessionComposerSelections(pendingSessionPrefsRef.current);
        setComposerSelectionRevision((revision) => revision + 1);
      }
      const stoppedSteerRejection = authoritativeStoppedSteerRejection(
        cause,
        steering,
      );
      let rejectionMessages:
        PiMessage[] | ((current: PiMessage[]) => PiMessage[]) | undefined;
      if (localEntry && outcomeUnknown) {
        // The request body reached the prompt endpoint, but its acknowledgement
        // may have been lost after Pi accepted it. Native steering remains hidden
        // until Pi consumes it at message_start; ordinary prompts are already
        // executing and therefore remain visible while JSONL catches up.
        if (!steering) {
          localEntry.queueState = "dispatched";
          rejectionMessages = (current) =>
            appendLocalTurnOnce(current, localEntry);
          schedulePromptReconcile(targetSessionId);
        }
      } else if (localEntry) {
        const pending = localUserTurnsRef.current.get(targetSessionId) || [];
        const remaining = removeLocalTurnAndRebase(pending, localEntry);
        if (remaining.length)
          localUserTurnsRef.current.set(targetSessionId, remaining);
        else localUserTurnsRef.current.delete(targetSessionId);
        viewCacheRef.current.forget(targetSessionId);
        if (localEntry.renderedInTranscript)
          rejectionMessages = (current) =>
            current.filter((candidate) => candidate !== localEntry.message);
      }
      // A stale A failure must never surface after A → B → A. A same-session
      // refresh is different: it only changes the pane revision, and must not
      // strand this Session-owned admission offscreen while reconciliation is
      // still pending.
      const sameSessionRefreshAuthority =
        promptAuthority &&
        promptAuthority.navigationEpoch === navigationEpochRef.current &&
        viewedSessionIdRef.current === targetSessionId &&
        desiredSessionIdRef.current === targetSessionId
          ? capturePaneAuthority(targetSessionId)
          : null;
      const failureAuthority =
        promptAuthority && paneAuthorityCanCommit(promptAuthority)
          ? promptAuthority
          : sameSessionRefreshAuthority;
      if (stoppedSteerRejection) {
        sessionRunningOverridesRef.current.set(targetSessionId, false);
        setSessions((current) =>
          current.map((session) =>
            session.id === targetSessionId
              ? settleSidebarActivity(session)
              : session,
          ),
        );
        patchSessionCache(targetSessionId, {
          isStreaming: false,
          liveMessage: undefined,
          toolStatus: "",
          state: { isStreaming: false, isCompacting: false },
        });
        releasePromptBusy(targetSessionId, undefined, undefined, true);
        clearStoppingForSession(targetSessionId);
      }
      const visibleFailure = failureAuthority
        ? commitPaneIfCurrent(failureAuthority, {
            type: "PROMPT_REJECTED",
            sessionId: targetSessionId,
            ...(rejectionMessages ? { messages: rejectionMessages } : null),
            ...(stoppedSteerRejection ? { isStreaming: false } : null),
            toolStatus:
              stoppedSteerRejection ||
              (!state.isStreaming && !promptAcceptedByEvent)
                ? ""
                : undefined,
          })
        : Boolean(
            promptDraftAuthority &&
            commitDraftIfCurrent(promptDraftAuthority, {
              type: "DRAFT_PROMPT_REJECTED",
            }),
          );
      if (!promptPaneIsCurrent()) scheduleSidebarRefresh();
      if (visibleFailure) {
        const messageText =
          cause instanceof Error ? cause.message : String(cause);
        if (resultPending) setNotice(messageText);
        else setError(messageText);
      }
      if (visibleFailure && stoppedSteerRejection) {
        clearPendingLiveMessage();
        const requestVersion =
          sessionEventVersionRef.current.get(targetSessionId) || 0;
        const queueRequestRevision =
          queueProjectionRevisionRef.current.get(targetSessionId) || 0;
        const authority = capturePaneAuthority(targetSessionId);
        void fetchSessionView(targetSessionId)
          .then((view) => {
            if (
              (sessionEventVersionRef.current.get(targetSessionId) || 0) !==
              requestVersion
            )
              return;
            if (paneAuthorityCanCommit(authority))
              applySessionView(view, authority, queueRequestRevision);
            else rememberSessionView(view);
          })
          .catch(() => undefined);
        scheduleSidebarRefresh();
      }
      // Rendering remains pane-authority guarded, but the editor-owned pump
      // must learn every definite rejection so it can retain the originating
      // scoped snapshot even when the user has navigated elsewhere.
      if (!outcomeUnknown) throw cause;
    } finally {
      if (promptOperationId && !serverPromptId)
        promptCoordinatorRef.current.delete(promptOperationId);
      if (
        promptBusyRelease &&
        promptBusyReleasesRef.current.get(targetSessionId)?.release ===
          promptBusyRelease
      )
        promptBusyReleasesRef.current.delete(targetSessionId);
      finishSessionBusy();
    }
  };

  const stopGeneration = async () => {
    if (buildIdentityMismatch) return;
    // Child transcript identity is read-only. This guard is deliberately in
    // the mutation path as well as the renderer so a stale button/event cannot
    // abort a child Runtime or claim child control.
    if (subagentAddressesRef.current.has(viewedSessionIdRef.current)) return;
    const operation = captureViewOperation();
    if (stoppingOperationTokensRef.current.has(operation.sessionId)) return;
    const operationToken = Symbol("stop-generation");
    stoppingOperationTokensRef.current.set(operation.sessionId, operationToken);
    setStoppingSessionIds((current) =>
      current.includes(operation.sessionId)
        ? current
        : [...current, operation.sessionId],
    );
    setError("");
    let abortPending = false;
    try {
      const result = await api.abort(operation.sessionId);
      if (!viewOperationIsInCurrentRun(operation)) return;
      if (result.abortPending) {
        abortPending = true;
        commitPaneIfCurrent(operation, {
          type: "PROMPT_PREPARING",
          target: { kind: "session", sessionId: operation.sessionId },
          status: "已发送停止请求，正在等待当前操作结束…",
        });
        setNotice("已发送停止请求，Pi 正在结束当前操作");
        return;
      }
      patchSessionCache(operation.sessionId, {
        state: { isStreaming: result.isStreaming },
        isStreaming: result.isStreaming,
        queuePaused: result.queuePaused,
        ...(result.isStreaming
          ? null
          : { liveMessage: undefined, toolStatus: "" }),
      });
      if (!result.isStreaming) {
        clearStoppingForSession(operation.sessionId, operationToken);
        sessionRunningOverridesRef.current.set(operation.sessionId, false);
        setSessions((current) =>
          current.map((session) =>
            session.id === operation.sessionId
              ? settleSidebarActivity(session)
              : session,
          ),
        );
      }
      if (
        !commitPaneIfCurrent(operation, {
          type: "STOP_COMPLETED",
          sessionId: operation.sessionId,
          isStreaming: result.isStreaming,
          queuePaused: result.queuePaused,
        })
      )
        return;
      if (!result.isStreaming) {
        // Never await full bootstrap/refresh here: while the worker is still
        // draining after abort, get_messages/bootstrap can hang for the full
        // API timeout and leave the UI stuck on "停止中…".
        scheduleSidebarRefresh();
        const requestVersion =
          sessionEventVersionRef.current.get(operation.sessionId) || 0;
        const queueRequestRevision =
          queueProjectionRevisionRef.current.get(operation.sessionId) || 0;
        void fetchSessionView(operation.sessionId)
          .then((view) => {
            if (
              viewOperationIsCurrent(operation) &&
              (sessionEventVersionRef.current.get(operation.sessionId) || 0) ===
                requestVersion
            )
              applySessionView(view, operation, queueRequestRevision);
            else {
              const projection = queueProjectionForView(
                operation.sessionId,
                view.queue,
                view.queuePaused === true,
                queueRequestRevision,
              );
              rememberSessionView(
                projection.known || projection.queue.length || projection.paused
                  ? {
                      ...view,
                      queue: projection.queue,
                      queuePaused: projection.paused,
                    }
                  : view,
              );
            }
          })
          .catch(() => undefined);
      }
      setNotice(
        result.queuePaused
          ? "已停止；队列保持暂停，可撤销或继续"
          : "已停止生成",
      );
    } catch (cause) {
      if (viewOperationIsCurrent(operation))
        setError(cause instanceof Error ? cause.message : String(cause));
      if (viewOperationIsCurrent(operation)) throw cause;
    } finally {
      if (!abortPending && viewOperationIsInCurrentRun(operation))
        clearStoppingForSession(operation.sessionId, operationToken);
    }
  };

  const viewSession = async (id: string, navigationName?: string) => {
    if (confirmedDeletedSessionIdsRef.current.has(id)) return;
    if (id === viewedSessionIdRef.current && desiredSessionIdRef.current === id)
      return;
    // Consume the green marker at selection time. The settled running override
    // already rejects an older view snapshot, while a newer agent_start remains
    // authoritative and must keep its blue spinner.
    if (unseenReplySessionIds.includes(id)) {
      terminalAssistantSessionIdsRef.current.delete(id);
      setUnseenReplySessionIds((current) =>
        current.filter((sessionId) => sessionId !== id),
      );
    }
    // Snapshot exactly what the user is leaving, including a cumulative SSE
    // assistant draft. Returning to a running Session can then paint this first
    // frame immediately instead of waiting on its busy Pi Runtime.
    const leavingId = viewedSessionIdRef.current;
    // Drain the 50ms throttled A update before selecting B; otherwise the old
    // pane can commit one more expensive Markdown render after the click.
    const pendingLeavingLive = drainPendingLiveMessage();
    if (leavingId && pendingLeavingLive)
      updateLiveSessionCache(leavingId, pendingLeavingLive.message);
    const leavingSession = sessions.find((session) => session.id === leavingId);
    if (leavingId && leavingSession && !localDraftRef.current) {
      // `messages` may contain local user overlays. Preserve the cache's original
      // transcript and update only the transient Runtime/SSE fields here.
      refreshSessionCache(leavingId, {
        session: leavingSession,
        state,
        isActive: activeSessionIds.includes(leavingId),
        runtimeStatus: runtimeStatus === "draft" ? "active" : runtimeStatus,
        isStreaming: state.isStreaming,
        liveMessage: liveMessage || undefined,
        toolStatus,
        stats,
        queue,
        queuePaused,
        commands,
        pendingExtensionRequest: extensionRequest || undefined,
        ...(gateAvailableOverride !== null
          ? { gateAvailable: gateAvailableOverride }
          : null),
        ...viewControl,
      });
    }
    rememberCurrentScroll();
    const rememberedTurns = scrollMemoryRef.current.turns(id);
    cancelPendingNavigation(false);
    for (const request of loadingEarlierRequestsRef.current.values())
      request.controller.abort();
    const navigation = sessionNavigationCoordinatorRef.current!.begin(
      id,
      window.performance.now(),
    );
    const { epoch, controller } = navigation;
    // Fence scroll-memory writes for the entire source→target replacement. The
    // source position was snapshotted above; all subsequent scroll events until
    // the target layout commit describe transitional/loading geometry.
    scrollMemoryFenceRef.current = { epoch, targetSessionId: id };
    const navigationAuthority = capturePaneAuthority(id);
    setViewSwitching(true);
    setError("");
    // Keep the current conversation visible until the destination view has
    // arrived. This avoids a blank timeline while an active Session is waiting
    // for a Gate confirmation or its runtime is answering state requests.
    const cached = withLatestQueueProjection(viewCacheRef.current.get(id));
    const cachedTurns = cached?.visibleTurnCount ?? cached?.turnTotal ?? 0;
    if (cached && (!rememberedTurns || cachedTurns >= rememberedTurns)) {
      if (
        navigationEpochRef.current !== epoch ||
        desiredSessionIdRef.current !== id
      )
        return;
      pendingScrollRestoreRef.current = id;
      // Commit telemetry at the selection point as well as through the normal
      // view applicator: background reconciliation must never obscure a cache hit.
      recordPaneCommit({ ...cached, viewSource: "browser-cache" });
      applySessionView(
        { ...cached, viewSource: "browser-cache" },
        navigationAuthority,
      );
      // A cache hit just committed a new pane revision. Its follow-up read must
      // capture that revision, never reuse the old source-pane authority.
      const reconcileAuthority = capturePaneAuthority(id);
      // A returned pane joins an already-running warm with its own authority.
      // It receives only a capability upgrade, never the old warm snapshot.
      joinWarmPane(id, reconcileAuthority);
      // This cached navigation supersedes any older in-flight cold request.
      setViewSwitching(false);
      // Cache/history navigation stays JSONL-only. Runtime preparation happens
      // only when the user performs an explicit write or control operation.
      // Stable cold JSONL panes need no immediate reread. Reconcile only when
      // Runtime/SSE state says the cached transcript may be incomplete, or when
      // the data-only pane is old enough that disk changes may have occurred.
      const needsReconcile = Boolean(
        cached.historyPending ||
        cached.reconcilePending ||
        cached.isStreaming ||
        cached.runtimeStatus === "active" ||
        Date.now() - cached.cachedAt >= 15_000,
      );
      if (!needsReconcile) return;
      const requestVersion = sessionEventVersionRef.current.get(id) || 0;
      const queueRequestRevision =
        queueProjectionRevisionRef.current.get(id) || 0;
      void fetchSessionView(id, rememberedTurns, { signal: controller.signal })
        .then((view) => {
          if (confirmedDeletedSessionIdsRef.current.has(id)) {
            recordBrowserStateDiagnostic("projection", "session-view-rejected", {
              sessionId: id,
              details: { decisionReason: "session-deleted" },
            });
            return;
          }
          if (!paneAuthorityCanCommit(reconcileAuthority)) {
            recordBrowserStateDiagnostic("projection", "session-view-rejected", {
              sessionId: id,
              details: {
                authorityPresent: true,
                decisionReason: "stale-pane-authority",
              },
            });
            return;
          }
          if (
            (sessionEventVersionRef.current.get(id) || 0) !== requestVersion
          ) {
            schedulePromptReconcile(
              id,
              sessionEventVersionRef.current.get(id) || 0,
            );
            return;
          }
          const reconciledView = acceptAuthoritativeIdleSessionView(view);
          // An empty busy-runtime read may update transient state, but cached
          // terminal leases are not evidence that JSONL persisted those rows.
          // Patch the already-painted cache without promoting its transcript into
          // the authoritative branch; a later non-empty view performs confirmation.
          if (!reconciledView.messages.length && cached.messages.length) {
            const projection = Array.isArray(reconciledView.queue)
              ? acceptQueueProjectionIfCurrent(
                  id,
                  queueRequestRevision,
                  reconciledView.queue,
                  reconciledView.queuePaused === true,
                )
              : undefined;
            const patched = refreshSessionCache(
              id,
              projection
                ? {
                    ...reconciledView,
                    queue: projection.queue,
                    queuePaused: projection.paused,
                  }
                : (() => {
                    const {
                      queue: _unknownQueue,
                      queuePaused: _unknownPaused,
                      ...withoutQueueAuthority
                    } = reconciledView;
                    return withoutQueueAuthority;
                  })(),
            );
            if (patched)
              applySessionView(
                patched,
                reconcileAuthority,
                queueProjectionRevisionRef.current.get(id) || 0,
              );
          } else
            applySessionView(
              reconciledView,
              reconcileAuthority,
              queueRequestRevision,
            );
        })
        .catch(() => undefined);
      return;
    }
    // Preserve the reading grid and composer layout while the first target view
    // arrives. The loading pane replaces only Timeline content, so the prior
    // conversation cannot masquerade as the target and no empty-state reflow occurs.
    setPaneLoading({
      sessionId: id,
      name: navigationName || sessions.find((session) => session.id === id)?.name || "对话",
    });
    // The source pane remains committed while this target view loads. Its
    // Runtime projection must not be overwritten with the target's status.
    try {
      const queueRequestRevision =
        queueProjectionRevisionRef.current.get(id) || 0;
      const requestStartRevision = viewCacheRef.current.revisionFor(id);
      const hot = activeSessionIds.includes(id);
      let view: SessionViewData;
      try {
        view = await fetchSessionView(id, rememberedTurns, {
          fast: hot,
          signal: controller.signal,
        });
      } catch (cause) {
        // A hot worker can race its own reclaim. Only this explicit server code
        // may fall back to the read-only path; auth/network/server failures stay
        // visible instead of causing an unexpected second expensive request.
        if (
          !(cause instanceof ApiRequestError) ||
          cause.code !== "HOT_VIEW_UNAVAILABLE"
        )
          throw cause;
        view = await fetchSessionView(id, rememberedTurns, {
          signal: controller.signal,
        });
      }
      if (confirmedDeletedSessionIdsRef.current.has(id)) {
        recordBrowserStateDiagnostic("projection", "session-view-rejected", {
          sessionId: id,
          details: { decisionReason: "session-deleted" },
        });
        return;
      }
      if (!paneAuthorityCanCommit(navigationAuthority)) {
        recordBrowserStateDiagnostic("projection", "session-view-rejected", {
          sessionId: id,
          details: {
            authorityPresent: true,
            decisionReason: "stale-pane-authority",
          },
        });
        return;
      }
      pendingScrollRestoreRef.current = id;
      const committed = viewCacheRef.current.mergeNavigation(
        view,
        requestStartRevision,
      );
      applySessionView(committed, navigationAuthority, queueRequestRevision);
      joinWarmPane(id, capturePaneAuthority(id));
      // Cold history remains view-only after navigation. Explicit mutation or
      // control intent will acquire its dedicated Runtime when needed.
      if (
        (view.historyPending || view.reconcilePending || view.isStreaming) &&
        viewedSessionIdRef.current === id
      )
        schedulePromptReconcile(id);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        if (scrollMemoryFenceRef.current?.epoch === epoch)
          scrollMemoryFenceRef.current = null;
        return;
      }
      if (navigationEpochRef.current === epoch) {
        navigationStartedAtRef.current.delete(epoch);
        setPaneLoading(null);
        desiredSessionIdRef.current = viewedSessionIdRef.current;
        setError(cause instanceof Error ? cause.message : String(cause));
        if (scrollMemoryFenceRef.current?.epoch === epoch)
          scrollMemoryFenceRef.current = null;
      }
    } finally {
      sessionNavigationCoordinatorRef.current!.finish(epoch, controller);
      if (navigationEpochRef.current === epoch) setViewSwitching(false);
    }
  };

  const openSubagentSession = (
    parentSessionId: string,
    childSessionId: string,
    label: string,
  ) => {
    subagentAddressesRef.current.delete(childSessionId);
    subagentAddressesRef.current.set(childSessionId, { parentSessionId, label });
    while (subagentAddressesRef.current.size > 64) {
      const oldest = subagentAddressesRef.current.keys().next().value;
      if (typeof oldest !== "string") break;
      subagentAddressesRef.current.delete(oldest);
    }
    viewCacheRef.current.forget(childSessionId);
    void viewSession(childSessionId, label);
  };

  /** Breadcrumbs only contain server-verified parent edges retained above. */
  const navigateSubagentAncestor = (sessionId: string, label: string) => {
    if (!/^[a-f0-9]{20}$/.test(sessionId)) return;
    void viewSession(sessionId, label);
  };

  const createSession = () => {
    if (buildIdentityMismatch) return;
    cancelPendingNavigation();
    rememberCurrentScroll();
    pendingScrollRestoreRef.current = "";
    // New is a local blank composer only. Starting a Secondary Pi process here
    // made a no-op UI action block on cold RPC startup and stale draft probes.
    navigationEpochRef.current += 1;
    refreshEpochRef.current += 1;
    setViewSwitching(false);
    // A New draft supersedes its per-draft picker, but not the independent
    // global default picker. This draft keeps the default captured below;
    // a completed global choice applies only to later drafts.
    draftWorkspacePickerTokenRef.current = null;
    if (!workspaceDefaultPickerTokenRef.current) setWorkspacePicking(false);
    clearPromptReconcileTimer();
    const previousViewedSessionId = viewedSessionIdRef.current;
    // Each New displays the current Runtime default. It does not inherit an
    // old Composer intent: only an explicit selection belongs to its next send.
    pendingSessionPrefsRef.current.delete(DRAFT_PREFS_KEY);
    saveSessionComposerSelections(pendingSessionPrefsRef.current);
    pendingGateModesRef.current.delete(DRAFT_PREFS_KEY);
    setComposerSelectionRevision((revision) => revision + 1);
    setPendingGateModes(Object.fromEntries(pendingGateModesRef.current));
    // Each New starts from the current application default. Choosing a folder
    // below changes only this draft, never an already-running Session.
    commitPane({
      type: "RESET_DRAFT",
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      draftWorkspaceCwd: workspaceCwd,
    });
    stickToBottomRef.current = true;
    setError("");
    setNotice("已新建独立会话");
    // Keep the request asynchronous so New remains instant, but retain its
    // promise: first Send must not let a delayed clear unpin the new Runtime.
    clearViewedPromiseRef.current = previousViewedSessionId
      && !subagentAddressesRef.current.has(previousViewedSessionId)
      ? api.clearSessionViewed(previousViewedSessionId).catch(() => undefined)
      : null;
  };

  /**
   * Apply shared warm readiness to one caller's exact pane. The Session-scoped
   * warm promise has no display authority: each joiner brings its own token so
   * an A → B → A revisit can upgrade the newer A pane without accepting the
   * first A caller's stale completion.
   */
  function applyWarmReadiness(
    sessionId: string,
    ready: SessionRuntimeReadyData,
    authority: PaneAuthoritySnapshot,
    capabilityOnly = false,
  ) {
    const state = capabilityOnly
      ? { isStreaming: ready.state.isStreaming }
      : ready.state;
    // A returned pane has a newer view projection than the shared warm
    // request. Capability-only mode therefore never copies old model/thinking
    // facts into it.
    return commitPaneIfCurrent(authority, {
      type: "RUNTIME_READY",
      sessionId,
      state,
    });
  }

  function joinWarmPane(sessionId: string, authority: PaneAuthoritySnapshot) {
    const warm = warmingRuntimeStartsRef.current.get(sessionId);
    if (!warm) return;
    void warm
      .then((ready) => {
        applyWarmReadiness(sessionId, ready, authority, true);
      })
      .catch((cause) => {
        if (
          !commitPaneIfCurrent(authority, {
            type: "RUNTIME_FAILED",
            sessionId,
          })
        )
          return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }

  /**
   * Start a dedicated Session Runtime without turning a JSONL pane into a full
   * RPC view. This coalesced promise records Session cache/readiness facts only;
   * callers separately decide whether the result still owns their visible pane.
   */
  const warmSessionRuntime = useCallback(
    (sessionId: string): Promise<SessionRuntimeReadyData> => {
      if (!sessionId) return Promise.reject(new Error("会话标识无效"));
      const existing = warmingRuntimeStartsRef.current.get(sessionId);
      if (existing) return existing;
      const runEpochGeneration = runEpochGenerationRef.current;
      setRuntimeWarming(sessionId, true);
      const start = api
        .warmSession(sessionId)
        .then((ready) => {
          if (runEpochGenerationRef.current !== runEpochGeneration)
            return ready;
          const cacheState = ready.state;
          // Warming does not apply a staged Gate choice. Keep the runtime's
          // confirmed mode separate so an unconfirmed "open" cannot auto-allow.
          updateGateMode(sessionId, ready.gateMode);
          refreshSessionCache(sessionId, {
            state: cacheState,
            isActive: true,
            runtimeStatus: "active",
            isStreaming: ready.state.isStreaming,
            gateMode: ready.gateMode,
          });
          return ready;
        })
        .finally(() => {
          if (
            warmingRuntimeStartsRef.current.get(sessionId) === start &&
            runEpochGenerationRef.current === runEpochGeneration
          ) {
            warmingRuntimeStartsRef.current.delete(sessionId);
            setRuntimeWarming(sessionId, false);
          }
        });
      warmingRuntimeStartsRef.current.set(sessionId, start);
      return start;
    },
    [refreshSessionCache, setRuntimeWarming, updateGateMode],
  );

  const composerTargetForViewedSession = () => {
    // Background-child records are never normal Runtime targets. Follow only
    // server-derived direct-parent edges until reaching the verified ordinary
    // ancestor; malformed/cyclic retained addresses fail closed.
    let target = viewedSessionIdRef.current;
    const visited = new Set<string>();
    while (target && subagentAddressesRef.current.has(target)) {
      if (visited.has(target)) return "";
      visited.add(target);
      const parentSessionId = subagentAddressesRef.current.get(target)?.parentSessionId;
      if (!parentSessionId || visited.has(parentSessionId)) return "";
      target = parentSessionId;
    }
    return target;
  };

  const stageComposerSelection = (
    key: string,
    patch: Pick<SessionComposerSelection, "model" | "thinkingLevel">,
  ) => {
    if (!key) return undefined;
    const next = stageSessionComposerSelection(
      pendingSessionPrefsRef.current.get(key),
      patch,
    );
    pendingSessionPrefsRef.current.set(key, next);
    // Persist the click synchronously as browser-local intent so an immediate
    // F5 cannot race React's post-commit storage effect.
    saveSessionComposerSelections(pendingSessionPrefsRef.current);
    // This value is only a render invalidator. The selection itself remains
    // session-keyed in the ref so navigation never aliases one target's choice
    // onto another target's Composer.
    setComposerSelectionRevision((revision) => revision + 1);
    return next;
  };

  const stageSessionPref = (patch: Pick<
    SessionComposerSelection,
    "model" | "thinkingLevel"
  >) => {
    const key = localDraftRef.current
      ? DRAFT_PREFS_KEY
      : composerTargetForViewedSession();
    return stageComposerSelection(key, patch);
  };

  const changeModel = (provider: string, modelId: string, api?: string) => {
    if (buildIdentityMismatch || !provider || !modelId) return;
    const model = models.find(
      (candidate) =>
        candidate.provider === provider && candidate.id === modelId
        && (api ? candidate.api === api : true),
    );
    const viewed = viewedSessionIdRef.current;
    const targetSessionId = composerTargetForViewedSession();
    const childOriginated = Boolean(
      viewed && targetSessionId && viewed !== targetSessionId,
    );
    // A child transcript is read-only. Do not let its controls mutate the
    // verified ordinary parent selection, even through a programmatic call.
    if (childOriginated) {
      setNotice("子代理对话为只读，不能修改模型设置");
      return;
    }
    if (!model) return;
    stageSessionPref({ model });
    setError("");
  };

  const changeThinking = (level: ThinkingLevel) => {
    if (buildIdentityMismatch) return;
    const viewed = viewedSessionIdRef.current;
    const targetSessionId = composerTargetForViewedSession();
    const childOriginated = Boolean(
      viewed && targetSessionId && viewed !== targetSessionId,
    );
    // A child transcript is read-only. Do not let its controls mutate the
    // verified ordinary parent selection, even through a programmatic call.
    if (childOriginated) {
      setNotice("子代理对话为只读，不能修改思考强度");
      return;
    }
    stageSessionPref({ thinkingLevel: level });
    setError("");
  };

  const selectDraftWorkspace = (cwd: string) => {
    const selected = cwd.trim();
    if (workspacePicking || !localDraftRef.current || !selected) return;
    const authority = captureDraftPaneAuthority();
    setError("");
    commitDraftIfCurrent(authority, {
      type: "DRAFT_WORKSPACE_SELECTED",
      cwd: selected,
    });
    setNotice(`新对话将使用工作目录：${selected}`);
  };

  const pickDraftWorkspace = async () => {
    if (workspacePicking || !localDraftRef.current) return;
    const authority = captureDraftPaneAuthority();
    const token = Symbol("draft-workspace-picker");
    draftWorkspacePickerTokenRef.current = token;
    setWorkspacePicking(true);
    setError("");
    setNotice("请在弹出的 Windows 窗口中浏览并选择新对话工作目录");
    try {
      const result = await api.pickDraftWorkspace();
      if (
        draftWorkspacePickerTokenRef.current !== token ||
        !draftAuthorityCanCommit(authority) ||
        result.cancelled ||
        !result.cwd
      )
        return;
      commitDraftIfCurrent(authority, {
        type: "DRAFT_WORKSPACE_SELECTED",
        cwd: result.cwd,
      });
      setNotice(`新对话将使用工作目录：${result.cwd}`);
    } catch (cause) {
      if (
        draftWorkspacePickerTokenRef.current === token &&
        draftAuthorityCanCommit(authority)
      )
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (draftWorkspacePickerTokenRef.current === token) {
        draftWorkspacePickerTokenRef.current = null;
        setWorkspacePicking(false);
      }
    }
  };

  const pickDefaultWorkspace = async () => {
    if (workspacePicking || mutationBlocked) return;
    const runEpochGeneration = runEpochGenerationRef.current;
    const token = Symbol("default-workspace-picker");
    workspaceDefaultPickerTokenRef.current = token;
    setWorkspacePicking(true);
    setError("");
    setNotice("请在弹出的 Windows 窗口中选择默认工作路径");
    try {
      const result = await api.pickWorkspace();
      if (
        workspaceDefaultPickerTokenRef.current !== token ||
        runEpochGenerationRef.current !== runEpochGeneration ||
        result.cancelled ||
        !result.cwd
      )
        return;
      // This is global metadata only. A pending draft can have its own selected
      // cwd, and an existing Runtime always keeps its immutable Session cwd.
      const workspaceEpoch =
        typeof result.workspaceEpoch === "string"
          ? result.workspaceEpoch
          : runEpochRef.current;
      const workspaceRevision =
        typeof result.workspaceRevision === "number" &&
        Number.isFinite(result.workspaceRevision)
          ? result.workspaceRevision
          : workspaceRevisionRef.current + 1;
      if (
        (!workspaceEpochRef.current ||
          workspaceEpoch === workspaceEpochRef.current) &&
        workspaceRevision >= workspaceRevisionRef.current
      ) {
        workspaceEpochRef.current = workspaceEpoch || workspaceEpochRef.current;
        workspaceRevisionRef.current = workspaceRevision;
        setWorkspaceCwd(result.cwd);
      }
      setNotice(`以后新建的对话将使用工作目录：${result.cwd}`);
    } catch (cause) {
      if (workspaceDefaultPickerTokenRef.current === token)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (workspaceDefaultPickerTokenRef.current === token) {
        workspaceDefaultPickerTokenRef.current = null;
        setWorkspacePicking(false);
      }
    }
  };

  const reconcileSessionMutation = async (
    sessionId: string,
    kind: "rename" | "delete",
    expectedName?: string,
  ) => {
    const fullRequestSequence = ++sidebarFullRequestSequenceRef.current;
    const result = await api.sessions(true, [], true);
    const session = result.sessions.find((item) => item.id === sessionId);
    const outcome =
      kind === "rename"
        ? session?.name === expectedName
          ? "committed"
          : session
            ? "not-committed"
            : "absent"
        : session
          ? "not-committed"
          : "committed";
    return { outcome, result, fullRequestSequence } as const;
  };

  const applySessionListSnapshot = (result: {
    sessions: SessionSummary[];
    total: number;
    directories?: SessionDirectorySummary[];
  }, fullRequestSequence: number) => {
    if (
      !commitSidebarSessions(result.sessions, {
        kind: "full",
        requestSequence: fullRequestSequence,
      })
    )
      return false;
    setSessionsTotal(optimisticSessionsTotal(result.sessions, result.total));
    if (result.directories) setSessionDirectories(result.directories);
    return true;
  };

  /**
   * Delete terminal state is stronger than an ordinary list refresh: once an
   * authoritative source says a Session is gone, no older request may restore
   * its row or cached pane. Keep every Session-keyed projection cleanup here;
   * otherwise a long-lived tab retains image payloads, promises, generations,
   * and stale recovery markers forever after repeated deletes.
   */
  const clearDeletedSessionProjection = (sessionId: string): void => {
    if (!sessionId) return;
    const keyId = composerDraftKeyId({ kind: "session", sessionId });
    localUserTurnsRef.current.delete(sessionId);
    pendingSteersRef.current.delete(sessionId);
    gateModesRef.current = Object.fromEntries(
      Object.entries(gateModesRef.current).filter(([id]) => id !== sessionId),
    );
    pendingGateModesRef.current.delete(sessionId);
    pendingSessionPrefsRef.current.delete(sessionId);
    saveSessionComposerSelections(pendingSessionPrefsRef.current);
    setComposerSelectionRevision((revision) => revision + 1);
    composerDraftRevisionsRef.current.delete(keyId);
    appliedDraftRestorationSequencesRef.current.delete(keyId);
    steerDequeueExpectedDraftRevisionRef.current.delete(sessionId);
    cancelledQueueIdsRef.current.delete(sessionId);
    cancellingQueueIdsRef.current.delete(sessionId);
    queueProjectionRevisionRef.current.delete(sessionId);
    queueProjectionSourceRef.current.delete(sessionId);
    confirmedQueueDispatchIdsRef.current.delete(sessionId);
    latestQueueProjectionRef.current.delete(sessionId);
    queueMutationSequenceRef.current.delete(sessionId);
    appliedQueueMutationSequenceRef.current.delete(sessionId);
    sessionEventVersionRef.current.delete(sessionId);
    sessionRunGenerationsRef.current.delete(sessionId);
    settledRunGenerationsRef.current.delete(sessionId);
    lastSessionEventTypeRef.current.delete(sessionId);
    sourceTurnTotalsRef.current.delete(sessionId);
    sessionRunningOverridesRef.current.delete(sessionId);
    terminalAssistantSessionIdsRef.current.delete(sessionId);
    terminalAssistantStreamGenerationsRef.current.delete(sessionId);
    streamingWireProjectionsRef.current.delete(sessionId);
    streamGapRecoveriesRef.current.delete(sessionId);
    unreadSteeringDropMessagesRef.current.delete(sessionId);
    diagnosticSidebarRowsRef.current.delete(sessionId);
    for (const key of diagnosticSseRejectionAtRef.current.keys())
      if (key.startsWith(`${sessionId}:`)) diagnosticSseRejectionAtRef.current.delete(key);
    warmingSessionIdsRef.current.delete(sessionId);
    const promptBusyLease = promptBusyReleasesRef.current.get(sessionId);
    if (promptBusyLease) {
      promptBusyLease.markTerminal();
      promptBusyLease.release();
      promptBusyReleasesRef.current.delete(sessionId);
    }
    busySessionCountsRef.current.delete(sessionId);
    stoppingOperationTokensRef.current.delete(sessionId);
    for (const childId of [...subagentAddressesRef.current.keys()]) {
      if (childId === sessionId || subagentAddressesRef.current.get(childId)?.parentSessionId === sessionId)
        subagentAddressesRef.current.delete(childId);
    }
    viewCacheRef.current.forget(sessionId);
    scrollMemoryRef.current.forget(sessionId);
    streamDiagnosticsRef.current?.deleteSession(sessionId);
    setPendingSteersBySession(Object.fromEntries(pendingSteersRef.current));
    setGateModes({ ...gateModesRef.current });
    setPendingGateModes(Object.fromEntries(pendingGateModesRef.current));
    setSteerDequeueingBySession((current) => {
      if (!current[sessionId]) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setComposerPendingByScope((current) => {
      if (!(keyId in current)) return current;
      const next = { ...current };
      delete next[keyId];
      return next;
    });
    setWarmingSessionIds([...warmingSessionIdsRef.current]);
    setBusySessionIds([...busySessionCountsRef.current.keys()]);
    setStoppingSessionIds((current) => current.filter((id) => id !== sessionId));
    setFailedSessionIds((current) => current.filter((id) => id !== sessionId));
    setUnseenReplySessionIds((current) => current.filter((id) => id !== sessionId));
    setActiveSessionIds((current) => current.filter((id) => id !== sessionId));
    setCopyingSessionIds((current) => current.filter((id) => id !== sessionId));
    setRestoredComposerDrafts((current) => {
      if (!(keyId in current)) return current;
      const next = { ...current };
      delete next[keyId];
      return next;
    });
  };

  const finalizeDeletedSession = (sessionId: string) => {
    const wasVisible = sessionId === viewedSessionIdRef.current;
    const desiredSessionId = desiredSessionIdRef.current;
    const wasViewed = wasVisible || sessionId === desiredSessionId;
    // A delete may settle after the user has already selected a live replacement.
    // Cancel only navigation to the deleted ID; preserve that newer destination.
    if (sessionId === desiredSessionId) cancelPendingNavigation();
    if (wasVisible) {
      clearPendingLiveMessage();
      pendingScrollRestoreRef.current = "";
      viewedSessionIdRef.current = "";
      if (desiredSessionIdRef.current === sessionId)
        desiredSessionIdRef.current = "";
      commitPane({ type: "CLEAR_PANE" });
    }
    optimisticRenamesRef.current.delete(sessionId);
    optimisticDeletesRef.current.delete(sessionId);
    confirmedDeletedSessionIdsRef.current.add(sessionId);
    // Keep a bounded tombstone set for already-resolved late continuations;
    // process-epoch invalidation remains the stronger long-term fence.
    while (confirmedDeletedSessionIdsRef.current.size > 512) {
      const oldest = confirmedDeletedSessionIdsRef.current.values().next().value;
      if (typeof oldest !== "string") break;
      confirmedDeletedSessionIdsRef.current.delete(oldest);
    }
    clearDeletedSessionProjection(sessionId);
    forgetComposerKey(composerDraftKeyId({ kind: "session", sessionId }));
    setSessionNavigation((current) => ({
      ...current,
      pinnedSessionIds: current.pinnedSessionIds.filter(
        (id) => id !== sessionId,
      ),
    }));
    setSessions((current) =>
      current.filter((session) => session.id !== sessionId),
    );
    syncMutatingSessionIds();
    return wasViewed;
  };

  const selectDeletionFallback = (
    deletedId: string,
    sessionsAfterDeletion: SessionSummary[],
    wasViewed: boolean,
  ) => {
    // Only replace a pane that was still selected when terminal deletion was
    // established; never override a newer user selection or local draft.
    if (!wasViewed) return;
    // A completed user navigation must win over deletion fallback. A deleted
    // visible pane has already been cleared to empty refs by finalization.
    if (
      (viewedSessionIdRef.current &&
        viewedSessionIdRef.current !== deletedId) ||
      (desiredSessionIdRef.current && desiredSessionIdRef.current !== deletedId)
    )
      return;
    const replacement = sessionsAfterDeletion.find(
      (session) => session.id !== deletedId,
    );
    if (replacement) void viewSession(replacement.id);
    else createSession();
  };

  /** Resolve only operations proven by a full authoritative Session inventory. */
  const reconcilePendingSessionMutations = async () => {
    const runEpochGeneration = runEpochGenerationRef.current;
    const fullRequestSequence = ++sidebarFullRequestSequenceRef.current;
    const result = await api.sessions(true, [], true);
    if (
      runEpochGenerationRef.current !== runEpochGeneration ||
      fullRequestSequence < sidebarCommittedFullSequenceRef.current
    )
      return false;
    let confirmed = false;
    const absentRenames: Array<{ id: string; wasViewed: boolean }> = [];
    for (const [id, pending] of optimisticRenamesRef.current) {
      const session = result.sessions.find((item) => item.id === id);
      if (session?.name === pending.name) {
        optimisticRenamesRef.current.delete(id);
        confirmed = true;
      } else if (!session) {
        absentRenames.push({ id, wasViewed: finalizeDeletedSession(id) });
        confirmed = true;
      }
    }
    for (const id of optimisticDeletesRef.current.keys()) {
      if (!result.sessions.some((session) => session.id === id)) {
        finalizeDeletedSession(id);
        confirmed = true;
      }
    }
    if (confirmed) syncMutatingSessionIds();
    applySessionListSnapshot(result, fullRequestSequence);
    for (const absent of absentRenames)
      selectDeletionFallback(absent.id, result.sessions, absent.wasViewed);
    return true;
  };

  const refreshManually = async () => {
    const runEpochGeneration = runEpochGenerationRef.current;
    const operationToken = Symbol("manual-refresh");
    refreshOperationTokenRef.current = operationToken;
    setRefreshing(true);
    setError("");
    try {
      const [metadataResult, inventoryResult] = await Promise.allSettled([
        refresh(),
        reconcilePendingSessionMutations(),
      ]);
      if (runEpochGenerationRef.current !== runEpochGeneration) return;
      if (inventoryResult.status === "rejected") throw inventoryResult.reason;
      if (
        inventoryResult.value &&
        refreshOperationTokenRef.current === operationToken
      )
        setNotice("会话已刷新");
      if (metadataResult.status === "rejected") {
        const cause = metadataResult.reason;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } catch (cause) {
      if (
        refreshOperationTokenRef.current === operationToken &&
        runEpochGenerationRef.current === runEpochGeneration
      )
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (refreshOperationTokenRef.current === operationToken) {
        refreshOperationTokenRef.current = null;
        setRefreshing(false);
      }
    }
  };

  const restartPi = async () => {
    // A mismatched bundle has stale browser state by definition. Let the server
    // make the final quiescence decision rather than trapping recovery behind a
    // possibly stale sidebar activity projection.
    if (
      busy ||
      lifecycleBlocked ||
      (!buildIdentityMismatch &&
        (anySessionRunning ||
          anySessionQueued ||
          anySessionPendingConfirmation))
    )
      return;
    if (
      !window.confirm(
        "完整重启 Pi Chat 并应用本地更新？\n\n将结束 Pi Chat 服务及其所有 Pi RPC 会话进程，重新构建当前工作目录，然后启动全新的 Pi Chat。已保存的前端、服务端、内置组件与本地配置更新都会生效；聊天记录不会删除。\n\n会重新加载当前电脑上已经保存的 Pi Chat、扩展和配置改动。正在生成、排队或等待确认时无法执行。",
      )
    )
      return;
    cancelPendingNavigation();
    setBusy(true);
    setError("");
    setNotice("正在结束 Pi Chat 进程、构建本地更新并启动全新服务…");
    try {
      await api.restart();
      // Wait for a different startup token so this and every observing window
      // reload only after the replacement listener is actually ready.
      await api.waitForApplicationHandoff();
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const shutdownPiChat = async () => {
    // See restartPi: only the server's live quiescence check is authoritative
    // when this Web bundle no longer agrees with that server.
    if (
      busy ||
      lifecycleBlocked ||
      (!buildIdentityMismatch &&
        (anySessionRunning ||
          anySessionQueued ||
          anySessionPendingConfirmation))
    )
      return;
    if (
      !window.confirm(
        "关闭全部 Pi Chat？\n\n将先检查所有窗口中的对话。只要任一对话仍在执行、排队或等待确认，就不会关闭。\n\n确认空闲后，将关闭所有浏览器/PWA 窗口、本地服务和全部 Pi RPC。聊天记录和设置会保留。",
      )
    )
      return;
    setBusy(true);
    setError("");
    setNotice("正在检查全部对话并关闭 Pi Chat…");
    try {
      await api.shutdown();
      setManagementSection(null);
      setCloseComplete("application");
      window.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const exportStateDiagnostics = async () => {
    if (diagnosticsBusy) return;
    setDiagnosticsBusy(true);
    setError("");
    try {
      recordBrowserStateDiagnostic("diagnostic", "export-requested", {
        sessionId: viewedSessionIdRef.current,
      });
      streamDiagnosticsRef.current?.checkpoint();
      diagnosticCheckpointRef.current();
      const server = await api.stateDiagnosticSnapshot();
      const bundle: StateDiagnosticExportBundle = {
        schemaVersion: 4,
        generatedAt: new Date().toISOString(),
        warning:
          "仅含最近五分钟的脱敏结构状态；服务端与当前浏览器页面各自保持本地顺序，时间戳不代表跨进程绝对顺序。",
        server,
        browser: browserStateDiagnosticSnapshot(),
      };
      const filename = downloadStateDiagnosticBundle(bundle);
      setNotice(`诊断已导出：${filename}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const copySessionToNew = (
    source: SessionSummary,
    persistedMessageId?: string,
  ) => {
    if (
      buildIdentityMismatch ||
      mutationBlocked ||
      copyingSessionIds.includes(source.id) ||
      optimisticRenamesRef.current.has(source.id) ||
      optimisticDeletesRef.current.has(source.id)
    )
      return;
    const runEpochGeneration = runEpochGenerationRef.current;
    const navigationEpoch = navigationEpochRef.current;
    const restorationSequence = persistedMessageId
      ? ++draftRestorationIntentSequenceRef.current
      : 0;
    setCopyingSessionIds((current) => [...new Set([...current, source.id])]);
    setError("");
    setNotice(
      persistedMessageId
        ? "正在从该消息创建新对话…"
        : "正在复制对话…",
    );
    const request = persistedMessageId
      ? api.forkSession(source.id, persistedMessageId)
      : api.cloneSession(source.id);
    let retainCopyGuard = false;
    void request
      .then((result) => {
        if (runEpochGenerationRef.current !== runEpochGeneration) return;
        setSessions((current) => [
          result.session,
          ...current.filter((session) => session.id !== result.session.id),
        ]);
        setSessionsTotal((current) =>
          sessionsRef.current.some((session) => session.id === result.session.id)
            ? current
            : current + 1,
        );
        if (result.editorText !== undefined || result.editorImages?.length) {
          const key: ComposerDraftKey = {
            kind: "session",
            sessionId: result.session.id,
          };
          const keyId = composerDraftKeyId(key);
          if (
            restorationSequence >
            (appliedDraftRestorationSequencesRef.current.get(keyId) || 0)
          ) {
            appliedDraftRestorationSequencesRef.current.set(
              keyId,
              restorationSequence,
            );
            setRestoredComposerDrafts((current) => ({
              ...current,
              [keyId]: {
                key,
                revision: restorationSequence,
                expectedDraftRevision:
                  composerDraftRevisionsRef.current.get(keyId) || 0,
                message: result.editorText || "",
                images: result.editorImages || [],
              },
            }));
          }
        }
        setNotice(result.warning || (
          persistedMessageId
            ? "已在新对话中分叉，可修改原消息后发送"
            : "已复制为新对话"
        ));
        void refreshSidebarSessions().catch(reportBackgroundRefreshError);
        if (navigationEpochRef.current === navigationEpoch)
          void viewSession(result.session.id, result.session.name);
      })
      .catch((cause) => {
        if (runEpochGenerationRef.current !== runEpochGeneration) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        const committedOrUncertain = /结果尚未确认|新对话已创建|请勿重复|不要重复/.test(message);
        retainCopyGuard = committedOrUncertain;
        setError(committedOrUncertain
          ? message
          : `${persistedMessageId ? "分叉" : "复制"}新对话失败：${message}`);
        if (committedOrUncertain) void refreshSidebarSessions().catch(reportBackgroundRefreshError);
      })
      .finally(() => {
        if (runEpochGenerationRef.current !== runEpochGeneration) return;
        if (!retainCopyGuard) setCopyingSessionIds((current) =>
          current.filter((sessionId) => sessionId !== source.id),
        );
      });
  };

  const confirmCloneSession = () => {
    const dialog = sessionDialog;
    if (!dialog || dialog.mode !== "clone") return;
    setSessionDialog(null);
    copySessionToNew(dialog.session);
  };

  const confirmForkSession = () => {
    const dialog = sessionDialog;
    if (!dialog || dialog.mode !== "fork") return;
    setSessionDialog(null);
    copySessionToNew(dialog.session, dialog.persistedMessageId);
  };

  const renameSession = (name: string) => {
    if (buildIdentityMismatch) return;
    const dialog = sessionDialog;
    if (!dialog || dialog.mode !== "rename") return;
    const sessionId = dialog.session.id;
    if (
      optimisticRenamesRef.current.has(sessionId) ||
      optimisticDeletesRef.current.has(sessionId)
    )
      return;
    const previousName = dialog.session.name;
    const runEpochGeneration = runEpochGenerationRef.current;
    const token = ++optimisticSessionMutationTokenRef.current;
    optimisticRenamesRef.current.set(sessionId, { token, previousName, name });
    syncMutatingSessionIds();
    setSessionDialog(null);
    setError("");
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId ? { ...session, name } : session,
      ),
    );
    refreshSessionCache(sessionId, {
      session: { ...dialog.session, name },
    });
    void api
      .renameSession(sessionId, name)
      .then(() => {
        if (optimisticRenamesRef.current.get(sessionId)?.token !== token)
          return;
        if (runEpochGenerationRef.current !== runEpochGeneration) {
          void reconcilePendingSessionMutations().catch(() => undefined);
          return;
        }
        optimisticRenamesRef.current.delete(sessionId);
        syncMutatingSessionIds();
        // `set_session_name` is the mutation authority. Sidebar/session views
        // refresh asynchronously through the renamed SSE event, so never make
        // a running rename wait for a full Bootstrap projection.
        setNotice("对话已重命名");
      })
      .catch(async (cause) => {
        const pending = optimisticRenamesRef.current.get(sessionId);
        if (!pending || pending.token !== token) return;
        if (runEpochGenerationRef.current !== runEpochGeneration) {
          void reconcilePendingSessionMutations().catch(() => undefined);
          return;
        }
        try {
          const { outcome, result, fullRequestSequence } =
            await reconcileSessionMutation(sessionId, "rename", name);
          if (
            optimisticRenamesRef.current.get(sessionId)?.token !== token ||
            runEpochGenerationRef.current !== runEpochGeneration ||
            fullRequestSequence < sidebarCommittedFullSequenceRef.current
          ) {
            if (runEpochGenerationRef.current !== runEpochGeneration)
              void reconcilePendingSessionMutations().catch(() => undefined);
            return;
          }
          if (outcome === "committed") {
            optimisticRenamesRef.current.delete(sessionId);
            syncMutatingSessionIds();
            applySessionListSnapshot(result, fullRequestSequence);
            setNotice("对话已重命名");
            return;
          }
          if (outcome === "absent") {
            const wasViewed = finalizeDeletedSession(sessionId);
            applySessionListSnapshot(result, fullRequestSequence);
            selectDeletionFallback(sessionId, result.sessions, wasViewed);
            setError("重命名未完成：对话已不存在或已被删除");
            return;
          }
          if (outcome === "not-committed") {
            const definiteRejection =
              cause instanceof ApiRequestError &&
              cause.status >= 400 &&
              cause.status < 500 &&
              !resultPendingError(cause);
            if (definiteRejection) {
              optimisticRenamesRef.current.delete(sessionId);
              syncMutatingSessionIds();
              applySessionListSnapshot(result, fullRequestSequence);
              setError(`重命名失败，已恢复原名称：${cause.message}`);
              return;
            }
            // A fresh JSONL snapshot is not a completion barrier for the
            // original request: the server may still be finishing its RPC and
            // index refresh after the HTTP response was lost. Keep the local
            // name and mutation guard until positive terminal evidence arrives.
            applySessionListSnapshot(result, fullRequestSequence);
          }
        } catch {
          // Transport is still indeterminate; retain the local intent and guard.
        }
        if (optimisticRenamesRef.current.get(sessionId)?.token !== token)
          return;
        if (runEpochGenerationRef.current !== runEpochGeneration) {
          void reconcilePendingSessionMutations().catch(() => undefined);
          return;
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(`重命名结果尚未确认，请刷新页面后核对：${message}`);
      });
  };

  const deleteSession = () => {
    if (buildIdentityMismatch) return;
    const dialog = sessionDialog;
    if (!dialog || dialog.mode !== "delete") return;
    const deleting = dialog.session;
    const deletingId = deleting.id;
    if (
      optimisticRenamesRef.current.has(deletingId) ||
      optimisticDeletesRef.current.has(deletingId)
    )
      return;
    const index = sessions.findIndex((session) => session.id === deletingId);
    const wasViewed =
      deletingId === desiredSessionIdRef.current ||
      deletingId === viewedSessionIdRef.current;
    const replacement = wasViewed
      ? sessions.find((session) => session.id !== deletingId)
      : undefined;
    const runEpochGeneration = runEpochGenerationRef.current;
    const token = ++optimisticSessionMutationTokenRef.current;
    optimisticDeletesRef.current.set(deletingId, {
      token,
      session: deleting,
      index,
      sessionsTotal,
      wasViewed,
    });
    streamDiagnosticsRef.current?.deleteSession(deletingId);
    // Session ids are path-derived, so a conversation created later can reuse the
    // id of a deleted one; retained failure cards must not survive the delete.
    setLocalFailures((current) => forgetLocalFailuresForSession(current, deletingId));
    syncMutatingSessionIds();
    if (wasViewed) cancelPendingNavigation();
    setSessionDialog(null);
    setError("");
    setSessions((current) =>
      current.filter((session) => session.id !== deletingId),
    );
    setSessionsTotal((current) => Math.max(0, current - 1));
    if (wasViewed) {
      if (replacement) void viewSession(replacement.id);
      else createSession();
    }
    void api
      .deleteSession(deletingId)
      .then((data) => {
        if (optimisticDeletesRef.current.get(deletingId)?.token !== token)
          return;
        if (runEpochGenerationRef.current !== runEpochGeneration) {
          void reconcilePendingSessionMutations().catch(() => undefined);
          return;
        }
        const finalizedViewed = finalizeDeletedSession(deletingId);
        // Do not replace a newer user selection or local draft while the request settled.
        applyBootstrapMetadata(data);
        selectDeletionFallback(deletingId, data.sessions, finalizedViewed);
        setNotice("对话已删除");
      })
      .catch(async (cause) => {
        const pending = optimisticDeletesRef.current.get(deletingId);
        if (!pending || pending.token !== token) return;
        if (runEpochGenerationRef.current !== runEpochGeneration) {
          void reconcilePendingSessionMutations().catch(() => undefined);
          return;
        }
        try {
          const { outcome, result, fullRequestSequence } =
            await reconcileSessionMutation(deletingId, "delete");
          if (
            optimisticDeletesRef.current.get(deletingId)?.token !== token ||
            runEpochGenerationRef.current !== runEpochGeneration ||
            fullRequestSequence < sidebarCommittedFullSequenceRef.current
          ) {
            if (runEpochGenerationRef.current !== runEpochGeneration)
              void reconcilePendingSessionMutations().catch(() => undefined);
            return;
          }
          if (outcome === "committed") {
            const finalizedViewed = finalizeDeletedSession(deletingId);
            applySessionListSnapshot(result, fullRequestSequence);
            selectDeletionFallback(
              deletingId,
              result.sessions,
              finalizedViewed,
            );
            setNotice("对话已删除");
            return;
          }
          if (outcome === "not-committed") {
            const definiteRejection =
              cause instanceof ApiRequestError &&
              cause.status >= 400 &&
              cause.status < 500 &&
              !resultPendingError(cause);
            if (definiteRejection) {
              optimisticDeletesRef.current.delete(deletingId);
              syncMutatingSessionIds();
              applySessionListSnapshot(result, fullRequestSequence);
              setError(`删除失败，已恢复对话显示：${cause.message}`);
              return;
            }
            // Presence in a fresh inventory does not prove a timed-out delete
            // failed; unlink/index refresh may still be in flight. Keep the row
            // hidden and guarded until absence or a structural SSE proves the
            // terminal outcome.
            applySessionListSnapshot(result, fullRequestSequence);
          }
        } catch {
          // Transport is still indeterminate; retain the local intent and guard.
        }
        if (optimisticDeletesRef.current.get(deletingId)?.token !== token)
          return;
        if (runEpochGenerationRef.current !== runEpochGeneration) {
          void reconcilePendingSessionMutations().catch(() => undefined);
          return;
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(`删除结果尚未确认，请刷新页面后核对：${message}`);
      });
  };

  const changeGate = async (mode: GateMode) => {
    const viewed = viewedSessionIdRef.current;
    const sessionId = composerTargetForViewedSession();
    if (buildIdentityMismatch) return;
    // A local New draft has no Runtime yet. Stage only its desired first-turn
    // Gate value; the initial-submit FIFO applies it before the user prompt.
    if (localDraftRef.current) {
      stageGateMode(DRAFT_PREFS_KEY, mode);
      setNotice(`已选择 ${mode === "open" ? "放行" : "严格"}，发送时生效`);
      return;
    }
    if (!sessionId) return;
    const childOriginated = Boolean(viewed && viewed !== sessionId);
    // A child transcript is read-only. A child-originated Gate choice must
    // never be staged as a parent preference; reject it explicitly instead.
    if (childOriginated) {
      setNotice("子代理对话为只读，不能修改文件权限模式");
      return;
    }
    // A cold history pane and local preparation stage Gate for the target
    // prompt instead of issuing an unauthorized command against a Runtime the
    // pane does not own. Staging is local and never blocked by an in-flight
    // settings request.
    if (runtimeStatus !== "active" || state.isCompacting) {
      stageGateMode(sessionId, mode);
      setNotice(`已选择 ${mode === "open" ? "放行" : "严格"}，发送时生效`);
      return;
    }
    // An explicit active-Runtime choice supersedes any cold staged intent. Do
    // this before issuing /gate so an older staged value cannot later override
    // a confirmed opposite command in UI, prompt payload, or auto-allow logic.
    stageGateMode(sessionId, undefined);
    // An active Runtime still requires its own confirmation before browser UI
    // may change a security-sensitive Gate setting.
    await send(`/gate ${mode}`, []);
  };

  const respondToExtension = async (body: {
    id?: string;
    cancelled?: boolean;
    confirmed?: boolean;
    value?: string;
  }): Promise<boolean> => {
    if (buildIdentityMismatch) return false;
    const submittedRequest = extensionRequest;
    if (!submittedRequest) return false;
    const sessionId =
      submittedRequest.piChatSessionId || viewedSessionIdRef.current;
    if (!sessionId) {
      setError("确认请求缺少会话标识，已拒绝发送");
      return false;
    }
    if (subagentAddressesRef.current.has(sessionId)) {
      setError("子代理对话为只读，不能提交扩展或问卷确认");
      return false;
    }
    const retryRequest = (candidate: ExtensionUiRequest | null | undefined) => {
      if (
        candidate &&
        (candidate.method === "input" || candidate.method === "editor") &&
        typeof body.value === "string"
      ) return { ...candidate, prefill: body.value };
      return candidate || null;
    };
    // A response failure can arrive after A → B → A. Keep its recovery bound
    // to the exact pane that submitted the confirmation, not just its ID.
    const extensionAuthority = capturePaneAuthority(sessionId);
    dispatchPane({
      type: "EXTENSION_REQUEST_CHANGED",
      sessionId,
      request: null,
    });
    try {
      await api.respondToExtension({
        ...body,
        id: submittedRequest.id,
        sessionId,
      });
      return true;
    } catch (cause) {
      let acceptedDespiteFailure = false;
      // Re-read the authoritative pending request. This distinguishes a real
      // delivery failure from a lost HTTP response after Pi already accepted it.
      try {
        const view = await fetchSessionView(sessionId);
        acceptedDespiteFailure =
          !view.pendingExtensionRequest ||
          view.pendingExtensionRequest.id !== submittedRequest.id;
        commitPaneIfCurrent(extensionAuthority, {
          type: "EXTENSION_REQUEST_CHANGED",
          sessionId,
          request: retryRequest(view.pendingExtensionRequest),
        });
      } catch {
        commitPaneIfCurrent(extensionAuthority, {
          type: "EXTENSION_REQUEST_CHANGED",
          sessionId,
          request: retryRequest(submittedRequest),
        });
      }
      if (paneAuthorityCanCommit(extensionAuthority))
        setError(cause instanceof Error ? cause.message : String(cause));
      return acceptedDespiteFailure;
    }
  };

  const loadingEarlier =
    loadingEarlierRequestsRef.current.get(viewedSessionId)?.navigationEpoch ===
    navigationEpochRef.current;
  const anySessionRunning = sessions.some((session) => session.running);
  const anySessionPendingConfirmation = sessions.some(
    (session) => session.pendingConfirmation,
  );
  const anySessionQueued = sessions.some((session) => session.queued);
  const lifecycleBlocked = applicationLifecycle !== "idle";
  const mutationBlocked = lifecycleBlocked || buildIdentityMismatch;
  // The initial pane has no Session identity until bootstrap commits one. Keep
  // the provisional `session:none` Composer partition read-only so an early
  // keystroke cannot disappear when the authoritative Session arrives. This
  // does not block an already identified Session while its Runtime prepares.
  const initialPaneUnresolved = loading && pane.identity.kind === "none";
  // A mismatched Web bundle may never change Session/Runtime state, but its two
  // lifecycle recovery actions remain available. Their endpoint remains guarded
  // by the server's live quiescence barrier; stale browser sidebar state must
  // not deadlock the only recovery route.
  const recoveryActionBlocked = lifecycleBlocked;
  const globalMutationBlocked =
    mutationBlocked ||
    anySessionRunning ||
    anySessionQueued ||
    anySessionPendingConfirmation;
  // A complete queue snapshot can arrive before its dispatch frame, and a
  // reconnect can miss that frame altogether. Keep a waiting local admission
  // visible as a synthetic queue row until authoritative code promotes or
  // removes it; localUserTurns is never allowed to become an invisible state.
  const localQueueFallback = viewedSessionId
    ? (localUserTurnsRef.current.get(viewedSessionId) || [])
        .filter((turn) => !turn.revealOnMessageStart)
        .map(queuedPromptFromLocalTurn)
        .filter((item): item is QueuedPrompt => Boolean(item))
        .filter((item) => !queue.some((current) => current.id === item.id))
    : [];
  const displayedQueue = localQueueFallback.length
    ? [...queue, ...localQueueFallback]
    : queue;
  const composerQueueMode =
    state.isStreaming || queuePaused || displayedQueue.length > 0;
  // A stop request belongs to one Session. A stale/local abort intent must
  // never paint a stop button (or disable Send) after this pane has settled.
  const stoppingCurrentSession =
    stoppingSessionIds.includes(viewedSessionId) && state.isStreaming;
  const viewedSession = sessions.find(
    (session) => session.id === viewedSessionId,
  );
  const subagentComposerAddress = subagentAddressesRef.current.get(viewedSessionId);
  const viewingSubagentSession = Boolean(subagentComposerAddress);
  /** A child transcript is read-only; normal messages use its verified ordinary ancestor. */
  const composerTargetSessionId = composerTargetForViewedSession();
  // The bottom controls show the selection for the *next* ordinary prompt.
  // PiState remains a historical/Runtime projection for the transcript.
  const composerSelectionKey = localDraft
    ? DRAFT_PREFS_KEY
    : composerTargetSessionId;
  const composerSelection = composerSelectionKey
    ? pendingSessionPrefsRef.current.get(composerSelectionKey)
    : undefined;
  const composerState = useMemo(
    () => composerStateForSelection(state, composerSelection),
    [state, composerSelection, composerSelectionRevision],
  );
  // A selected Runtime model can arrive before the complete catalogue. Keep it
  // as a temporary option so the control remains usable and can be reconciled
  // when the next authoritative model inventory arrives.
  const composerModels = useMemo(() => {
    const selected = composerState.model;
    if (
      !selected ||
      models.some(
        (candidate) =>
          candidate.provider === selected.provider && candidate.id === selected.id,
      )
    )
      return models;
    return [selected, ...models];
  }, [composerState.model, models]);
  const currentSessionBusy = busySessionIds.includes(
    viewedSessionId || (localDraft ? LOCAL_DRAFT_BUSY_ID : ""),
  );
  // Once Pi has authoritatively started generating, the composer may accept a
  // follow-up into the queue even if the first HTTP acknowledgement is late.
  // This busy lease remains the submission/admission barrier; it is deliberately
  // separate from the user-visible Runtime preparation label below.
  const currentSessionBusyBeforeStreaming = currentSessionBusy && !state.isStreaming;
  const currentSessionRuntimePreparing = runtimePreparationForDisplay({
    localDraft,
    runtimeStatus,
    warming: Boolean(
      viewedSessionId && warmingSessionIds.includes(viewedSessionId),
    ),
    primaryStatus: primaryRuntime.status,
    draftSubmissionBusy: localDraft && currentSessionBusyBeforeStreaming,
  });
  // Content partitions use the ordinary prompt target. An empty unindexed
  // Primary is therefore a Session partition even though it renders the New
  // presentation; only an actual local Draft receives a New generation key.
  const composerDraftKey: ComposerDraftKey = localDraft
    ? { kind: "new", generation: draftGenerationRef.current }
    : {
        kind: "session",
        sessionId: composerTargetSessionId || viewedSessionId || "none",
      };
  const composerSubmissionScope = composerDraftKeyId(composerDraftKey);
  const composerHasContent = composerContentByScope[composerSubmissionScope] === true;
  const composerSubmissionPending = composerPendingByScope[composerSubmissionScope] || 0;
  const composerSubmissionPaused =
    !mutationBlocked &&
    (viewSwitching ||
      currentSessionBusyBeforeStreaming ||
      (viewingSubagentSession && !composerTargetSessionId));
  const waitingForPiMessage = composerWaitStatus({
    isStreaming: state.isStreaming,
    pendingSubmissions: composerSubmissionPending,
    viewSwitching,
    runtimePreparing: currentSessionRuntimePreparing,
    compacting: Boolean(state.isCompacting),
    subagentTargetUnavailable:
      viewingSubagentSession && !composerTargetSessionId,
  });
  // An empty active Primary (indexed or not) is still the New presentation.
  // Preserve its real Session authority, but never fall through to a saved
  // conversation empty-state layout.
  const emptyPrimaryDraftPresentation = Boolean(
    viewedSessionId &&
      viewedSessionId === activeSessionId &&
      (viewedSession?.messageCount || 0) === 0 &&
      messages.length === 0 &&
      messageTotal === 0 &&
      turnTotal === 0 &&
      (state.messageCount || 0) === 0 &&
      !state.isStreaming,
  );
  const newConversationPresentation =
    localDraft || emptyPrimaryDraftPresentation;
  const sidebarViewBlocked = sidebarNavigationBlocked(
    loading,
    lifecycleBlocked,
  );
  const conversationName = newConversationPresentation
    ? "新对话"
    : viewedSession?.name || state.sessionName || "已保存对话";
  const loadingSession = paneLoading
    ? sessions.find((session) => session.id === paneLoading.sessionId)
    : undefined;
  const conversationWorkspace =
    loadingSession?.cwd || viewedSession?.cwd || workspaceCwd;
  const draftWorkspaceOptions = recentSessionWorkspaces([
    ...sessionDirectories.map((directory) => ({
      cwd: directory.cwd,
      updatedAt: directory.lastUserPromptAt,
      lastUserPromptAt: directory.lastUserPromptAt,
    })),
    ...sessions,
  ]);
  const displayedConversationName = paneLoading?.name || conversationName;
  const topBarSessionId = paneLoading?.sessionId || viewedSessionId;
  // Files must bind one coherent Session/cwd pair during navigation. A local
  // draft or addressed Subagent view has no persisted Workspace authority.
  const inspectorSessionId = localDraft || viewingSubagentSession ? "" : topBarSessionId;
  /** Build a bounded root-to-leaf child path exclusively from verified parent edges. */
  const subagentBreadcrumb = (() => {
    if (!topBarSessionId || !subagentAddressesRef.current.has(topBarSessionId))
      return undefined;
    const trail: Array<{ sessionId: string; label: string }> = [];
    const visited = new Set<string>();
    let cursor = topBarSessionId;
    while (cursor) {
      if (visited.has(cursor) || trail.length >= 64) return undefined;
      visited.add(cursor);
      const address = subagentAddressesRef.current.get(cursor);
      if (address) {
        trail.push({ sessionId: cursor, label: address.label || "子代理" });
        cursor = address.parentSessionId;
        continue;
      }
      const parent = sessions.find((session) => session.id === cursor);
      trail.push({
        sessionId: cursor,
        label: parent?.name || (cursor === viewedSessionId ? conversationName : "父对话"),
      });
      break;
    }
    return trail.length > 1 ? trail.reverse() : undefined;
  })();
  // Gate is a verified Pi Chat system component, not an optional entry in
  // Pi's transient command inventory. A cold/starting Runtime may legitimately
  // return commands: [], which must disable controls when necessary—not make
  // the permission-mode selector disappear.
  const primaryRuntimeMessage =
    primaryRuntime.status === "starting"
      ? "Pi 正在准备；可继续编辑消息和设置，发送会在 Runtime ready 后继续。"
      : primaryRuntime.status === "failed"
        ? `Pi 当前不可用；仍可阅读历史并继续编辑消息和设置，发送会在恢复后继续。${primaryRuntime.error ? ` ${primaryRuntime.error}` : ""}${primaryRuntime.incidentId ? `（事件 ID：${primaryRuntime.incidentId}）` : ""}`
        : "";
  // Existing dedicated Secondary Runtimes remain independently configurable if
  // Primary later fails. For the selected Primary, a failed Runtime is still
  // actionable: the next model/thinking/prompt request is the server's
  // single-flight recovery trigger, so do not leave the UI permanently locked.
  const primarySettingsUnavailable =
    viewedSessionId === activeSessionId && primaryRuntime.status === "starting";
  // An existing Secondary can keep working while Primary starts or recovers.
  // ModelInfo.input is retained as advisory UI metadata only: a ready SSE or
  // Bootstrap snapshot may be incomplete, but neither may block prompt delivery.
  const primaryCapabilityRelevant =
    localDraft ||
    viewedSessionId === activeSessionId ||
    runtimeStatus !== "active";
  const stagedPrimaryPreference = pendingSessionPrefsRef.current.get(
    localDraft
      ? DRAFT_PREFS_KEY
      : primaryRuntime.sessionId || viewedSessionId,
  );
  const selectedPrimaryModel =
    stagedPrimaryPreference?.model !== undefined
      ? stagedPrimaryPreference.model
      : state.model;
  const primaryCapabilityConfirmed =
    primaryRuntime.status === "ready" &&
    ((Object.prototype.hasOwnProperty.call(primaryRuntime, "model") &&
      modelCapabilityKey(primaryRuntime.model) ===
        modelCapabilityKey(selectedPrimaryModel)) ||
      (primaryCapabilitySnapshot?.generation === primaryRuntime.generation &&
        primaryCapabilitySnapshot.modelKeys.includes(
          modelCapabilityKey(selectedPrimaryModel),
        )));
  const primaryRuntimeUnavailable =
    primaryCapabilityRelevant && primaryRuntime.status !== "ready";
  const primaryCapabilityPending =
    primaryCapabilityRelevant && !primaryCapabilityConfirmed;
  const primarySessionFailed = false;
  const gateAvailable = gateAvailableOverride ?? true;
  // A staged value can describe the next prompt in a cold history pane, but
  // never alters gateModesRef, which is the only authority for auto-allow.
  const gateSelectionKey = localDraft
    ? DRAFT_PREFS_KEY
    : composerTargetSessionId;
  const confirmedGateMode =
    pendingGateModes[gateSelectionKey] ?? gateModes[gateSelectionKey];
  // A local New draft has no existing Runtime whose prior open mode could be
  // hidden, so strict is its explicit security default. Existing Sessions keep
  // an absent projection distinct from a confirmed strict mode.
  const gateMode = confirmedGateMode ?? (localDraft ? "strict" : undefined);
  const effectiveControl = { ...viewedSession, ...viewControl };
  const observing = Boolean(
    effectiveControl.controlOwner && !effectiveControl.controlledByThisWindow,
  );
  const dequeuePendingSteers = () => {
    const operation = captureViewOperation();
    const draftKey: ComposerDraftKey = {
      kind: "session",
      sessionId: operation.sessionId,
    };
    steerDequeueExpectedDraftRevisionRef.current.set(
      operation.sessionId,
      composerDraftRevisionsRef.current.get(composerDraftKeyId(draftKey)) || 0,
    );
    setSteerDequeueingBySession((current) => ({
      ...current,
      [operation.sessionId]: true,
    }));
    void api.dequeueSteers(operation.sessionId).then((result) => {
      if (!viewOperationIsInCurrentRun(operation)) return;
      applyDequeuedSteers(
        operation.sessionId,
        result.items.map((item) => item.id),
      );
      if (
        result.count === 0 &&
        (pendingSteersRef.current.get(operation.sessionId)?.length || 0) > 0 &&
        viewOperationIsCurrent(operation)
      )
        setError("这些 Steer 已不在 Pi 的原生等待队列中，未伪装为撤回成功");
    }).catch((cause) => {
      if (viewOperationIsCurrent(operation))
        setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      setSteerDequeueingBySession((current) => {
        if (!current[operation.sessionId]) return current;
        const next = { ...current };
        delete next[operation.sessionId];
        return next;
      });
    });
  };

  const cancelQueuedPrompt = (item: QueuedPrompt) => {
    const operation = captureViewOperation();
    draftRestorationIntentSequenceRef.current += 1;
    const cancellationSequence = draftRestorationIntentSequenceRef.current;
    const cancellationDraftKey: ComposerDraftKey = {
      kind: "session",
      sessionId: operation.sessionId,
    };
    const expectedDraftRevision =
      composerDraftRevisionsRef.current.get(composerDraftKeyId(cancellationDraftKey)) || 0;
    const queueProjectionRevision =
      queueProjectionRevisionRef.current.get(operation.sessionId) || 0;
    const mutationSequence =
      (queueMutationSequenceRef.current.get(operation.sessionId) || 0) + 1;
    queueMutationSequenceRef.current.set(operation.sessionId, mutationSequence);
    const pendingAtCancellation =
      localUserTurnsRef.current.get(operation.sessionId) || [];
    const localCancelledAtCancellation = pendingAtCancellation.find(
      (turn) => turn.queueId === item.id,
    );
    const cancellingIds =
      cancellingQueueIdsRef.current.get(operation.sessionId) || new Set<string>();
    cancellingIds.add(item.id);
    cancellingQueueIdsRef.current.set(operation.sessionId, cancellingIds);
    void api
      .cancelQueued(item.id, operation.sessionId)
      .then((result) => {
        if (!viewOperationIsInCurrentRun(operation)) return;
        if (confirmedDeletedSessionIdsRef.current.has(operation.sessionId))
          return;
        const pending =
          localUserTurnsRef.current.get(operation.sessionId) || [];
        const cancelling = cancellingQueueIdsRef.current.get(operation.sessionId);
        if (cancelling) {
          cancelling.delete(item.id);
          if (!cancelling.size)
            cancellingQueueIdsRef.current.delete(operation.sessionId);
        }
        const cancelled =
          pending.find((turn) => turn.queueId === item.id) ||
          localCancelledAtCancellation;
        const remaining = cancelled
          ? removeLocalTurnAndRebase(pending, cancelled)
          : pending;
        if (remaining.length)
          localUserTurnsRef.current.set(operation.sessionId, remaining);
        else localUserTurnsRef.current.delete(operation.sessionId);
        const cancelledIds =
          cancelledQueueIdsRef.current.get(operation.sessionId) || new Set<string>();
        cancelledIds.add(item.id);
        cancelledQueueIdsRef.current.set(operation.sessionId, cancelledIds);
        const queueProjectionChanged =
          (queueProjectionRevisionRef.current.get(operation.sessionId) || 0) !==
          queueProjectionRevision;
        const appliedMutationSequence =
          appliedQueueMutationSequenceRef.current.get(operation.sessionId) || 0;
        const mutationIsNewestSuccess =
          mutationSequence > appliedMutationSequence;
        if (mutationIsNewestSuccess)
          appliedQueueMutationSequenceRef.current.set(
            operation.sessionId,
            mutationSequence,
          );
        const currentProjection =
          latestQueueProjectionRef.current.get(operation.sessionId) || {
            queue: viewCacheRef.current.get(operation.sessionId)?.queue || [],
            paused:
              viewCacheRef.current.get(operation.sessionId)?.queuePaused === true,
          };
        const latestProjection =
          queueProjectionChanged || !mutationIsNewestSuccess
            ? currentProjection
            : { queue: result.queue, paused: result.paused };
        const authoritativeProjection = {
          queue: filterCancelledQueue(
            operation.sessionId,
            latestProjection.queue,
          ),
          paused: latestProjection.paused,
        };

        latestQueueProjectionRef.current.set(
          operation.sessionId,
          authoritativeProjection,
        );
        queueProjectionSourceRef.current.set(operation.sessionId, "mutation");
        if (!queueProjectionChanged)
          advanceQueueProjectionRevision(operation.sessionId);
        const authoritativeQueue = authoritativeProjection.queue;
        setSessions((current) =>
          current.map((session) =>
            session.id === operation.sessionId
              ? applySidebarQueueProjection(session, authoritativeQueue)
              : session,
          ),
        );
        if (cancelled) {
          const restoredTurnTotal = Math.max(
            sourceTurnTotalsRef.current.get(operation.sessionId) || 0,
            cancelled.expectedTurnTotal - 1,
            ...remaining.map((turn) => turn.expectedTurnTotal),
          );
          setSessions((current) =>
            current.map((session) =>
              session.id === operation.sessionId
                ? { ...session, turnCount: restoredTurnTotal }
                : session,
            ),
          );
        }
        patchSessionCache(operation.sessionId, {
          queue: authoritativeQueue,
          queuePaused: authoritativeProjection.paused,
        });
        const restored = cancelled
          ? promptDraftFromMessage(cancelled.message, item.message)
          : { message: item.message, images: [] };
        commitPaneIfCurrent(operation, {
          type: "QUEUE_UPDATED",
          sessionId: operation.sessionId,
          queue: authoritativeQueue,
          paused: authoritativeProjection.paused,
          messages: cancelled?.renderedInTranscript
            ? (current) =>
                current.filter((message) => message !== cancelled.message)
            : undefined,
        });
        // Composer restoration is Session-keyed state. The server normally
        // broadcasts the post-cancel queue before the DELETE response arrives,
        // which advances the Pane revision and makes the click's old authority
        // stale. Do not lose the user's message merely because that truthful
        // queue frame won the race; a newer editor revision still wins in the
        // Composer reducer below.
        // HTTP completions may arrive out of click order. The latest successful
        // cancellation wins the Composer, never whichever response finishes last.
        const restorationKeyId = composerDraftKeyId(cancellationDraftKey);
        if (
          cancellationSequence >
          (appliedDraftRestorationSequencesRef.current.get(restorationKeyId) || 0)
        ) {
          appliedDraftRestorationSequencesRef.current.set(
            restorationKeyId,
            cancellationSequence,
          );
          setRestoredComposerDrafts((current) => ({
            ...current,
            [restorationKeyId]: {
              key: cancellationDraftKey,
              revision: cancellationSequence,
              expectedDraftRevision,
              ...restored,
            },
          }));
        }
      })
      .catch((cause) => {
        if (viewOperationIsCurrent(operation))
          setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  const resumeQueuedPrompt = () => {
    const operation = captureViewOperation();
    const queueProjectionRevision =
      queueProjectionRevisionRef.current.get(operation.sessionId) || 0;
    const mutationSequence =
      (queueMutationSequenceRef.current.get(operation.sessionId) || 0) + 1;
    queueMutationSequenceRef.current.set(operation.sessionId, mutationSequence);
    void api
      .resumeQueue(operation.sessionId)
      .then((result) => {
        if (!viewOperationIsInCurrentRun(operation)) return;
        const appliedMutationSequence =
          appliedQueueMutationSequenceRef.current.get(operation.sessionId) || 0;
        if (mutationSequence < appliedMutationSequence) return;
        appliedQueueMutationSequenceRef.current.set(
          operation.sessionId,
          mutationSequence,
        );
        const currentProjection = latestQueueProjectionRef.current.get(
          operation.sessionId,
        );
        const projectionChanged =
          (queueProjectionRevisionRef.current.get(operation.sessionId) || 0) !==
          queueProjectionRevision;
        const resumedProjection = projectionChanged && currentProjection
          ? acceptQueueProjection(
              operation.sessionId,
              currentProjection.queue,
              result.paused,
              "mutation",
            )
          : acceptQueueProjection(
              operation.sessionId,
              result.queue,
              result.paused,
              "mutation",
            );
        patchSessionCache(operation.sessionId, {
          queue: resumedProjection.queue,
          queuePaused: resumedProjection.paused,
        });
        setSessions((current) =>
          current.map((session) =>
            session.id === operation.sessionId
              ? applySidebarQueueProjection(
                  session,
                  resumedProjection.queue,
                  resumedProjection.paused,
                )
              : session,
          ),
        );
        commitPaneIfCurrent(operation, {
          type: "QUEUE_UPDATED",
          sessionId: operation.sessionId,
          queue: resumedProjection.queue,
          paused: resumedProjection.paused,
        });
      })
      .catch((cause) => {
        if (viewOperationIsCurrent(operation))
          setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  const diagnosticSidebarRows = useMemo(
    () => sessions.flatMap((session) => {
      const execution = session.activity?.execution ||
        (session.running ? "running" : session.queued ? "queued" : "idle");
      const interesting =
        session.id === viewedSessionId ||
        execution !== "idle" ||
        session.pendingConfirmation === true ||
        Boolean(session.controlOwner);
      if (!interesting) return [];
      const controlledByThisWindow = session.controlledByThisWindow === true;
      const foreignOwnerPresent = Boolean(
        session.controlOwner && !controlledByThisWindow,
      );
      return [{
        sessionId: session.id,
        execution,
        running: session.running === true,
        queued: session.queued === true,
        pendingConfirmation: session.pendingConfirmation === true,
        controlledByThisWindow,
        foreignOwnerPresent,
        viewed: session.id === viewedSessionId,
        signature: [
          execution,
          session.running === true,
          session.queued === true,
          session.pendingConfirmation === true,
          controlledByThisWindow,
          foreignOwnerPresent,
          session.id === viewedSessionId,
        ].join(":"),
      }];
    }),
    [sessions, viewedSessionId],
  );
  const diagnosticSidebarSignature = diagnosticSidebarRows
    .map((row) => `${row.sessionId}:${row.signature}`)
    .join("|");
  const diagnosticHasLive = Boolean(liveMessage);
  const diagnosticControlledByThisWindow =
    effectiveControl.controlledByThisWindow === true;
  const diagnosticForeignOwnerPresent = Boolean(
    effectiveControl.controlOwner && !diagnosticControlledByThisWindow,
  );
  const diagnosticUiDetails = {
    paneKind: pane.identity.kind,
    stateStreaming: state.isStreaming,
    compacting: state.isCompacting === true,
    hasLive: diagnosticHasLive,
    toolActive: Boolean(toolStatus),
    promptStarting,
    runtimeStatus,
    queuePaused,
    queueLength: queue.length,
    transcriptCount: messages.length,
    sidebarRows: sessions.length,
    sidebarRunning: viewedSession?.running === true,
    sidebarQueued: viewedSession?.queued === true,
    sidebarExecution: viewedSession?.activity?.execution || "none",
    sidebarRunningCount: sessions.filter((session) => session.running).length,
    sidebarQueuedCount: sessions.filter((session) => session.queued).length,
    sidebarFailedCount: sessions.filter((session) => session.activity?.execution === "failed").length,
    sidebarPausedCount: sessions.filter((session) => session.activity?.execution === "paused").length,
    sidebarConfirmationCount: sessions.filter((session) => session.pendingConfirmation).length,
    sidebarForeignOwnerCount: sessions.filter((session) =>
      Boolean(session.controlOwner && session.controlledByThisWindow !== true),
    ).length,
    observing,
    controlledByThisWindow: diagnosticControlledByThisWindow,
    foreignOwnerPresent: diagnosticForeignOwnerPresent,
    authorityPresent: Boolean(effectiveControl.controlOwner),
    composerQueueVisible: composerQueueMode,
    composerSteerEligible: state.isStreaming,
    composerStopVisible: state.isStreaming,
    composerSendVisible: !composerQueueMode,
    composerDisabled: mutationBlocked,
    stopping: stoppingCurrentSession,
  };
  const recordDiagnosticProjection = (force: boolean): void => {
    const uiSignature = JSON.stringify([viewedSessionId, diagnosticUiDetails]);
    if (force || diagnosticUiSignatureRef.current !== uiSignature) {
      diagnosticUiSignatureRef.current = uiSignature;
      recordBrowserStateDiagnostic("projection", "ui-state", {
        sessionId: viewedSessionId,
        details: diagnosticUiDetails,
      });
    }

    const previousRows = diagnosticSidebarRowsRef.current;
    const nextRows = new Map<string, string>();
    const allSessionIds = new Set(sessions.map((session) => session.id));
    for (const row of diagnosticSidebarRows) {
      nextRows.set(row.sessionId, row.signature);
      if (!force && previousRows.get(row.sessionId) === row.signature) continue;
      recordBrowserStateDiagnostic("projection", "sidebar-session", {
        sessionId: row.sessionId,
        details: {
          found: true,
          sidebarExecution: row.execution,
          sidebarRunning: row.running,
          sidebarQueued: row.queued,
          pendingConfirmation: row.pendingConfirmation,
          controlledByThisWindow: row.controlledByThisWindow,
          foreignOwnerPresent: row.foreignOwnerPresent,
          viewed: row.viewed,
        },
      });
    }
    if (!force) {
      for (const sessionId of previousRows.keys()) {
        if (nextRows.has(sessionId)) continue;
        recordBrowserStateDiagnostic("projection", "sidebar-session", {
          sessionId,
          details: {
            found: allSessionIds.has(sessionId),
            sidebarExecution: "idle",
            sidebarRunning: false,
            sidebarQueued: false,
            pendingConfirmation: false,
            controlledByThisWindow: false,
            foreignOwnerPresent: false,
            viewed: false,
          },
        });
      }
    }
    diagnosticSidebarRowsRef.current = nextRows;
  };
  diagnosticCheckpointRef.current = () => recordDiagnosticProjection(true);

  const diagnosedUserTurnProjectionRef = useRef("");
  useEffect(() => {
    const duplicates = diagnoseVisibleUserTurnDuplicates(
      messages,
      viewedSessionId ? (localUserTurnsRef.current.get(viewedSessionId) || []) : [],
      turnTotal,
    );
    for (const duplicate of duplicates) {
      const signature = [
        viewedSessionId,
        duplicate.kind,
        duplicate.contentHash,
        duplicate.pairCount,
        pane.identity.sessionId,
        paneCommitRevisionRef.current,
      ].join(":");
      if (diagnosedUserTurnProjectionRef.current === signature) continue;
      diagnosedUserTurnProjectionRef.current = signature;
      recordBrowserStateDiagnostic("projection", "user-turn-duplicate", {
        sessionId: viewedSessionId,
        details: {
          duplicateKind: duplicate.kind,
          duplicateCount: duplicate.messageCount,
          duplicatePairCount: duplicate.pairCount,
          localTurnCount: duplicate.localTurnCount,
          localRowCount: duplicate.localRowCount,
          persistedCount: duplicate.persistedCount,
          identityCount: duplicate.identityCount,
          persistedAfterBaselineCount: duplicate.persistedAfterBaselineCount,
          adjacent: duplicate.adjacent,
          sourceGeneration: paneCommitRevisionRef.current,
          projectionSource: "pane-commit",
        },
      });
    }
  }, [messages, pane.identity.sessionId, viewedSessionId]);

  useEffect(() => {
    recordDiagnosticProjection(false);
  }, [
    composerQueueMode,
    currentSessionBusyBeforeStreaming,
    currentSessionRuntimePreparing,
    diagnosticSidebarSignature,
    effectiveControl.controlOwner,
    effectiveControl.controlledByThisWindow,
    diagnosticHasLive,
    loading,
    messages.length,
    mutationBlocked,
    observing,
    viewingSubagentSession,
    pane.identity.kind,
    primaryRuntimeUnavailable,
    promptStarting,
    queue.length,
    queuePaused,
    runtimeStatus,
    sessions.length,
    state.isCompacting,
    state.isStreaming,
    stoppingCurrentSession,
    toolStatus,
    viewedSession?.activity?.execution,
    viewedSession?.queued,
    viewedSession?.running,
    viewedSessionId,
    viewSwitching,
  ]);

  const composerControls = (
    <ComposerControls
      state={composerState}
      models={composerModels}
      modelInventoryPending={!modelInventoryConfirmed}
      stats={stats}
      disabled={mutationBlocked || viewingSubagentSession}
      gateAvailable={gateAvailable}
      gateMode={gateMode}
      primaryUnavailable={false}
      onGate={(mode) => void changeGate(mode)}
      onModel={(provider, id, api) => void changeModel(provider, id, api)}
      onThinking={(level) => void changeThinking(level)}
    />
  );

  const composerNotices = (
    <>
      {buildIdentityMismatch && (
        <div className="primary-runtime-status is-failed" role="status">
          网页与服务版本不一致，普通操作已暂停。请刷新页面；若仍存在，可在左侧使用“完整重启”，或在设置中关闭
          Pi Chat 后重新打开。
        </div>
      )}
      {primaryRuntimeMessage && (
        <div
          className={`primary-runtime-status is-${primaryRuntime.status}`}
          role="status"
        >
          {primaryRuntimeMessage}
        </div>
      )}
      {(error || notice) && (
        <div className={`app-toast ${error ? "error" : ""}`} role="status">
          {error || notice}
        </div>
      )}
    </>
  );

  if (closeComplete) {
    const applicationClosed = closeComplete === "application";
    return (
      <main className="shutdown-screen">
        <span className="shutdown-mark">
          <PiMarkIcon />
        </span>
        <h1>{applicationClosed ? "Pi Chat 已关闭" : "当前窗口已退出"}</h1>
        <p>
          {applicationClosed
            ? "本地服务和会话进程已经结束。现在可以关闭此窗口。"
            : "其他 Pi Chat 窗口仍在运行。现在可以关闭此窗口。"}
        </p>
        <button type="button" onClick={() => window.close()}>
          关闭窗口
        </button>
      </main>
    );
  }

  const sessionDialogSource = sessionDialog
    ? sessions.find((session) => session.id === sessionDialog.session.id) || sessionDialog.session
    : null;
  const sessionDialogCopyBlocked = Boolean(
    sessionDialog &&
    (sessionDialog.mode === "clone" || sessionDialog.mode === "fork") &&
    (mutationBlocked ||
      copyingSessionIds.includes(sessionDialog.session.id) ||
      sessionDialogSource?.running ||
      sessionDialogSource?.queued ||
      sessionDialogSource?.pendingConfirmation ||
      sessionDialogSource?.messageCount === 0),
  );

  return (
    <AppShell
      diffSidebarOpen={diffSidebarOpen}
      diffSidebarWidth={diffSidebarWidth}
    >
      <SessionInventory
        sessions={sessions}
        sessionsTotal={sessionsTotal}
        sessionDirectories={sessionDirectories}
        inventoryReady={sidebarInventoryReady}
        loadingAllSessions={loadingAllSessions}
        loadingDirectoryKeys={loadingDirectoryKeys}
        viewedSessionId={viewedSessionId}
        workspaceCwd={workspaceCwd}
        workspaceEpoch={workspaceEpochRef.current}
        workspaceRevision={workspaceRevisionRef.current}
        open={sidebarOpen}
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
        newDisabled={mutationBlocked}
        refreshDisabled={loading || refreshing}
        restartDisabled={
          loading ||
          busy ||
          refreshing ||
          (buildIdentityMismatch
            ? recoveryActionBlocked
            : globalMutationBlocked)
        }
        copyDisabled={mutationBlocked}
        viewBusy={sidebarViewBlocked}
        refreshing={refreshing}
        pinnedSessionIds={sessionNavigation.pinnedSessionIds}
        pinnedDirectoryKeys={sessionNavigation.pinnedDirectoryKeys}
        collapsedDirectoryKeys={sessionNavigation.collapsedDirectoryKeys}
        expandedDirectoryKeys={sessionNavigation.expandedDirectoryKeys}
        failedSessionIds={failedSessionIds}
        unseenReplySessionIds={unseenReplySessionIds}
        mutatingSessionIds={[
          ...new Set([...mutatingSessionIds, ...copyingSessionIds]),
        ]}
        onClose={() => setSidebarOpen(false)}
        onCollapse={() => setSidebarOpen(false)}
        onNew={() => void createSession()}
        onRefresh={() => void refreshManually()}
        onLoadAllSessions={() => void loadAllSessions()}
        onLoadDirectory={(cwd, offset) =>
          void loadDirectorySessions(cwd, offset)
        }
        onRestart={() => void restartPi()}
        onView={(id) => {
          if (window.matchMedia?.("(max-width: 760px)").matches)
            setSidebarOpen(false);
          void viewSession(id);
        }}
        onTogglePin={(sessionId) => {
          pinnedInventoryAttemptRef.current = "";
          setSessionNavigation((current) => ({
            ...current,
            pinnedSessionIds: togglePinnedSession(
              current.pinnedSessionIds,
              sessionId,
            ),
          }));
        }}
        onToggleDirectoryPin={(cwd) =>
          setSessionNavigation((current) => ({
            ...current,
            pinnedDirectoryKeys: togglePinnedDirectory(
              current.pinnedDirectoryKeys,
              cwd,
            ),
          }))
        }
        onSetDirectoryCollapsed={(cwd, collapsed) =>
          setSessionNavigation((current) => {
            const key = normalizeCwdKey(cwd);
            if (!key) return current;
            return collapsed
              ? {
                  ...current,
                  collapsedDirectoryKeys: [
                    ...new Set([...current.collapsedDirectoryKeys, key]),
                  ],
                  expandedDirectoryKeys: current.expandedDirectoryKeys.filter(
                    (value) => value !== key,
                  ),
                }
              : {
                  ...current,
                  collapsedDirectoryKeys: current.collapsedDirectoryKeys.filter(
                    (value) => value !== key,
                  ),
                  expandedDirectoryKeys: [
                    ...new Set([...current.expandedDirectoryKeys, key]),
                  ],
                };
          })
        }
        onClone={(session) => setSessionDialog({ mode: "clone", session })}
        onRename={(session) => setSessionDialog({ mode: "rename", session })}
        onDelete={(session) => setSessionDialog({ mode: "delete", session })}
      />
      {!sidebarOpen && (
        <button
          type="button"
          className="sidebar-restore"
          onClick={() => setSidebarOpen(true)}
          title="展开会话栏"
          aria-label="展开会话栏"
        >
          <ChevronRightIcon />
        </button>
      )}
      <ConversationPane
        topBar={{
          sessionId: topBarSessionId,
          conversationName: displayedConversationName,
          workspacePath: conversationWorkspace,
          buildIdentity: buildIdentityMismatch
            ? `Web ${buildIdentityLabel(webBuildIdentity)}；服务 ${buildIdentityLabel(serverBuildIdentity)}`
            : `构建 ${buildIdentityLabel(serverBuildIdentity)}`,
          settingsOpen: managementSection !== null,
          onOpenSettings: () =>
            setManagementSection((current) => (current ? null : "settings")),
          diffSidebarOpen,
          onToggleDiffSidebar: () => setDiffSidebarOpen((open) => !open),
          onOpenSubagentSession: openSubagentSession,
          subagentBreadcrumb,
          onNavigateSubagentAncestor: navigateSubagentAncestor,
        }}
        timelineRef={scrollRef}
        onScroll={onScroll}
        onClearNavigation={clearConversationNavigationTarget}
        loading={loading}
        viewedSessionId={viewedSessionId}
        paneLoading={paneLoading}
        messages={messages}
        forkOrigin={pane.forkOrigin}
        onOpenForkSource={() => {
          const origin = pane.forkOrigin;
          if (!origin?.sourceAvailable || viewSwitching) return;
          void viewSession(origin.sourceSessionId, origin.sourceName);
        }}
        pendingUserMessage={pendingUserMessage}
        localFailures={withoutPersistedFailure(
          localFailures.filter((entry) =>
            entry.sessionId === (localDraft ? DRAFT_FAILURE_SCOPE : viewedSessionId),
          ),
          messages,
        )}
        liveMessage={liveMessage}
        localDraft={localDraft}
        composerHasContent={composerHasContent}
        suppressNewWelcome={lifecycleBlocked}
        newConversationPresentation={newConversationPresentation}
        waitingForPiMessage={waitingForPiMessage}
        draftWorkspaceCwd={draftWorkspaceCwd}
        workspaceCwd={conversationWorkspace}
        workspacePicking={workspacePicking}
        draftWorkspaceOptions={draftWorkspaceOptions}
        onSelectDraftWorkspace={selectDraftWorkspace}
        onPickDraftWorkspace={() => void pickDraftWorkspace()}
        messagesTruncated={messagesTruncated}
        visibleTurnCount={visibleTurnCount}
        turnTotal={turnTotal}
        messageTotal={messageTotal}
        runStartedAt={runStartedAt}
        lastRunDurationMs={lastRunDurationMs}
        loadingEarlier={loadingEarlier}
        onLoadEarlier={() => void loadEarlierTurns()}
        state={state}
        toolStatus={toolStatus}
        onForkUserMessage={(message) => {
          if (!viewedSession || !message.piChatPersistedMessageId) return;
          const text = forkableUserMessageText(message);
          const imageCount = Array.isArray(message.content)
            ? message.content.filter((block) => block.type === "image").length
            : 0;
          if (!text && imageCount === 0) return;
          setSessionDialog({
            mode: "fork",
            session: viewedSession,
            persistedMessageId: message.piChatPersistedMessageId,
            messagePreview: forkMessagePreview(text, imageCount),
          });
        }}
        forkUserMessageDisabled={Boolean(
          !viewedSession ||
          localDraft ||
          viewingSubagentSession ||
          mutationBlocked ||
          state.isStreaming ||
          state.isCompacting ||
          displayedQueue.length > 0 ||
          queuePaused ||
          extensionRequest ||
          copyingSessionIds.includes(viewedSessionId),
        )}
        onNavigate={navigateConversation}
        sessionControl={{
          observing: viewingSubagentSession ? false : observing,
        }}
        promptQueue={{
          queue: displayedQueue,
          paused: queuePaused,
          busy:
            currentSessionBusyBeforeStreaming ||
            viewSwitching ||
            mutationBlocked ||
            viewingSubagentSession,
          onCancel: cancelQueuedPrompt,
          onResume: resumeQueuedPrompt,
        }}
        pendingSteers={{
          items: pendingSteersBySession[viewedSessionId] || [],
          dequeueing: steerDequeueingBySession[viewedSessionId] === true,
          onDequeue: dequeuePendingSteers,
        }}
        chatInput={{
          streaming: viewingSubagentSession ? false : composerQueueMode,
          activelyStreaming: viewingSubagentSession ? false : state.isStreaming,
          stopping: viewingSubagentSession ? false : stoppingCurrentSession,
          // Editing is independent from runtime preparation, compaction, and
          // foreign control. Only the initial unaddressed pane is blocked so
          // bootstrap cannot replace a provisional `session:none` draft.
          disabled: mutationBlocked || initialPaneUnresolved,
          disabledPlaceholder: buildIdentityMismatch
            ? "网页与服务构建不一致；请刷新页面后再提交操作"
            : lifecycleBlocked
              ? "Pi Chat 正在执行全局维护，暂时不能提交新操作"
              : initialPaneUnresolved
                ? "正在恢复已保存的对话，请稍候…"
                : undefined,
          acceptsImages:
            !viewingSubagentSession &&
            composerState.model?.input?.includes("image") === true,
          imageInputPending:
            !viewingSubagentSession && primaryCapabilityPending,
          restoredDraft: restoredComposerDrafts[composerDraftKeyId(composerDraftKey)] || null,
          onDraftRevisionChange: (key, revision, hasContent) => {
            const keyId = composerDraftKeyId(key);
            composerDraftRevisionsRef.current.set(keyId, revision);
            setComposerContentByScope((current) =>
              current[keyId] === hasContent
                ? current
                : { ...current, [keyId]: hasContent },
            );
          },
          draftKey: composerDraftKey,
          forgottenComposerKeys,
          submissionScope: composerSubmissionScope,
          submissionTargetSessionId: composerTargetSessionId || undefined,
          allowFollowupSubmissions: true,
          submissionPaused: composerSubmissionPaused,
          onSubmissionPendingChange: updateComposerPending,
          commands: composerCommands,
          controls: composerControls,
          notices: composerNotices,
          onSend: async (message, images, delivery, snapshotTargetSessionId) => {
            const targetSessionId = snapshotTargetSessionId || "";
            if (
              viewingSubagentSession &&
              (!targetSessionId ||
                delivery !== "queue" ||
                message.startsWith("/"))
            )
              throw new Error("子代理视图仅支持向已验证父对话发送普通消息");
            return send(message, images, delivery, targetSessionId);
          },
          onPickLocalFiles: async () => (await api.pickLocalFiles()).paths,
          onReadClipboardFiles: async (files) => (await api.clipboardLocalFiles(files)).paths,
          onError: setError,
          onAbort: stopGeneration,
        }}
      />
      {managementSection && <Suspense fallback={null}>
      <ManagementPanel
        section={managementSection}
        appearance={appearance}
        workspaceCwd={workspaceCwd}
        workspacePicking={workspacePicking}
        workspaceDisabled={mutationBlocked}
        models={models}
        modelRuntimeSyncPending={modelRuntimeSyncPending}
        state={state}
        busy={busy || globalMutationBlocked}
        shutdownBlocked={
          busy ||
          (buildIdentityMismatch
            ? recoveryActionBlocked
            : globalMutationBlocked)
        }
        diagnosticsBusy={diagnosticsBusy}
        buildIdentity={serverBuildIdentity}
        webBuildIdentity={webBuildIdentity}
        piVersion={piVersion}
        primaryRuntime={primaryRuntime}
        onClose={() => setManagementSection(null)}
        onAppearance={setAppearance}
        onPickWorkspace={() => void pickDefaultWorkspace()}
        onModel={(provider, id, api) => void changeModel(provider, id, api)}
        onModelsChanged={(data) => {
          setModels(data.models);
          setModelRuntimeSyncPending(data.modelRuntimeSyncPending === true);
          saveModelCatalog(data.models);
          dispatchPane({ type: "RUNTIME_SETTINGS_ADOPTED", target: localDraftRef.current ? { kind: "draft" } : { kind: "session", sessionId: viewedSessionIdRef.current }, state: { model: data.state.model } });
        }}
        onExportDiagnostics={exportStateDiagnostics}
        onShutdown={() => void shutdownPiChat()}
      />
      </Suspense>}
      <SessionDialog
        state={sessionDialog}
        busy={sessionActionBusy}
        disabled={buildIdentityMismatch || sessionDialogCopyBlocked}
        onClose={() => setSessionDialog(null)}
        onRename={(name) => void renameSession(name)}
        onClone={() => confirmCloneSession()}
        onFork={() => confirmForkSession()}
        onDelete={() => void deleteSession()}
      />
      {!viewingSubagentSession && Object.entries(askQuestionnaires).map(([askSessionId, questionnaire]) => (
        <AskQuestionnaireDialog
          key={`${askSessionId}:${questionnaire.toolCallId}`}
          plan={questionnaire}
          request={askSessionId === viewedSessionId ? extensionRequest : null}
          visible={askSessionId === viewedSessionId}
          disabled={buildIdentityMismatch}
          onRespond={respondToExtension}
          onFallback={() => dispatchAskQuestionnaire({
            type: "CLOSE_IF_MATCH",
            sessionId: askSessionId,
            toolCallId: questionnaire.toolCallId,
          })}
        />
      ))}
      {!viewingSubagentSession && !askQuestionnaires[viewedSessionId] && (
        <ExtensionDialog
          request={extensionRequest}
          sessionId={viewedSessionId}
          continuationPending={toolStatus === "正在运行工具：ask_user_question"}
          disabled={buildIdentityMismatch}
          onRespond={(body) => void respondToExtension(body)}
        />
      )}
      <Suspense fallback={null}>
      <EditDiffSidebar
        open={diffSidebarOpen}
        width={diffSidebarWidth}
        sessionId={inspectorSessionId}
        workspacePath={conversationWorkspace}
        workspaceActivityRevision={workspaceActivityRevision}
        listWorkspaceFiles={api.workspaceFiles}
        readWorkspaceFile={api.workspaceFile}
        onOpenChange={setDiffSidebarOpen}
        onWidthChange={setDiffSidebarWidth}
      />
      </Suspense>
    </AppShell>
  );
}
