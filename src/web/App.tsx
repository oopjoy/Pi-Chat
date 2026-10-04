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
import { createPromptSubmitController } from "./application/prompt-submit-controller";
import {
  buildProtectedLocalTurn,
  classifyPromptFailure,
  capturePromptSelection,
  createPromptSubmitFlow,
  draftIntentAfterSubmit,
  prepareRestoringPrompt,
  pendingSteerFromAcknowledgement,
  planAcknowledgedQueueProjection,
  planAcknowledgedTurn,
  promptAcknowledgementKind,
  promptSettledBeforeAcknowledgement,
  promptPreparationRoute,
  submitNewDraftPrompt,
} from "./application/prompt-submit-flow";
import { createSessionNavigationActions } from "./application/session-navigation-actions";
import { createSessionNavigationFlow } from "./application/session-navigation-flow";
import { createSessionBootstrapFlow } from "./application/session-bootstrap-flow";
import { createSessionViewApplicator } from "./application/session-view-applicator";
import { createBootstrapCommit } from "./application/bootstrap-commit";
import { createNewDraft } from "./application/session-draft-actions";
import { applyWarmReadiness, joinWarmPane as joinWarmPaneFlow, warmSessionRuntime as warmSessionRuntimeFlow } from "./application/session-runtime-warm";
import { createStreamReadyHandler } from "./application/stream-ready-effects";
import { createHistoryPaginationFlow } from "./application/history-pagination-flow";
import { createStreamErrorHandler, createOversizedEventHandler } from "./application/stream-error-effects";
import { createPiEventHandler } from "./application/pi-event-handler";
import { createStopGeneration } from "./application/stop-generation-flow";
import { createPromptSendFlow } from "./application/prompt-send-flow";
import { createSessionManagementActions } from "./application/session-management-actions";
import { createComposerSettingsActions } from "./application/composer-settings-actions";
import { createQueueActions } from "./application/queue-actions";
import { AppView } from "./application/app-view";
import { useSessionProjectionFlows } from "./application/session-projection-flows";
import { useAppPresentationState } from "./application/app-presentation-state";
import { useSessionProjectionState } from "./application/session-projection-state";
import { reconcileServerPendingPrompt as reconcileServerPendingPromptFlow, reconcileServerPendingSteers as reconcileServerPendingSteersFlow } from "./application/server-pending-projection";
import { reconcileSessionInventory } from "./application/session-inventory-reconciliation";
import {
  deriveActiveSessionChangedEffect,
  deriveApplicationLifecycleEffect,
  deriveExtensionRequestResolvedEffect,
  deriveFastModeChangedEffect,
  deriveGateModeChangedEffect,
  derivePromptDeliveryUncertainEffect,
  derivePromptRetryEffect,
  deriveQueueDispatchEffect,
  deriveQueueErrorEffect,
  deriveQueueSnapshotEffect,
  deriveSessionControlChangedEffect,
  deriveSessionMutationEffect,
  deriveWorkspaceChangedEffect,
  planQueueErrorTurns,
} from "./application/stream-event-effects";
import {
  reconcileIdleSessionView,
  sessionViewConfirmsIdle,
} from "./application/session-reconciliation";
import { reconcileSpecialPromptAcknowledgement } from "./application/prompt-submit-reconciliation";
import { applyExtensionUiRequestEffect } from "./application/stream-extension-effects";
import { prepareSessionViewCommit } from "./application/session-view-commit";
import { applyQueueErrorEffect, applyQueueSnapshotEffect, applyQueueUpdateEffect } from "./application/stream-queue-effects";
import { applyQueueDispatchEffect } from "./application/stream-queue-dispatch-effects";
import {
  applyNativeSteeringClearEffect,
  applyNativeSteeringDequeueEffect,
  type PendingSteerProjection,
} from "./application/stream-native-steering-effects";
import { reconcileQueuedPromptAcknowledgement } from "./application/prompt-queued-acknowledgement";
import {
  planPromptFailureLocalTurn,
  reconcilePromptFailureRecord,
  reconcileStoppedSteerFailure,
  shouldClearModelSelectionOnFailure,
} from "./application/prompt-failure-reconciliation";
import { presentPromptFailure } from "./application/prompt-failure-presentation";
import { reconcileOrdinaryPromptAcknowledgement } from "./application/prompt-ordinary-acknowledgement";
import { reconcileStalePromptAcknowledgement } from "./application/prompt-stale-acknowledgement";
import { adoptDraftSessionView } from "./application/prompt-draft-adoption";
import {
  applySidebarQueueProjection,
  applySidebarRunningOverride,
  settleSidebarActivity,
} from "./application/session-summary-reconciliation";
import {
  canCommitDraftPaneAuthority,
  canCommitPaneAuthority,
  type DraftPaneAuthority,
  type PaneAuthority,
  type PaneAuthoritySnapshot,
} from "./application/pane-authority";
import {
  SessionViewCacheWriter,
  type SessionViewCacheWriteAuthority,
} from "./application/session-view-cache-writer";
import type { PrimaryCapabilitySnapshot } from "./application/runtime-readiness";
import {
  RuntimeProjectionWriter,
  type RuntimeProjectionWriteAuthority,
} from "./application/runtime-projection-writer";
import {
  ActiveSessionProjectionWriter,
  type ActiveSessionDraftAuthority,
  type ActiveSessionProjectionAuthority,
  type ActiveSessionViewAuthority,
} from "./application/active-session-projection-writer";
import {
  ModelCatalogueRevisionGate,
  type ModelCatalogueAuthority,
} from "./application/model-catalogue-revision-gate";
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
  modelSelectionPatch,
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
const MAX_CONFIRMED_DISPATCH_IDS_PER_SESSION = 64;
const MAX_CONFIRMED_DISPATCH_SESSIONS = 128;
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

/** Refresh metadata is valid only in this page, process, and navigation epoch. */
type RefreshAuthority = Pick<
  PaneAuthority,
  "runEpochGeneration" | "cacheGeneration" | "navigationEpoch"
> & Pick<RuntimeProjectionWriteAuthority, "runtimeProjectionGeneration">
  & Pick<
    ActiveSessionProjectionAuthority,
    "activeSessionProjectionGeneration" | "activeSessionFullRevision"
  > & ModelCatalogueAuthority & {
  refreshEpoch: number;
};
type SessionViewCommitAuthority = PaneAuthoritySnapshot
  & ActiveSessionViewAuthority;
type DraftSessionViewCommitAuthority = DraftPaneAuthority
  & ActiveSessionDraftAuthority;
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
  const modelCatalogueRevisionGateRef =
    useRef<ModelCatalogueRevisionGate | null>(null);
  if (!modelCatalogueRevisionGateRef.current)
    modelCatalogueRevisionGateRef.current = new ModelCatalogueRevisionGate();
  const modelCatalogueRevisionGate = modelCatalogueRevisionGateRef.current;
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
  const runEpochRef = useRef("");
  /** Increments only on a real replacement, invalidating old async projections. */
  const runEpochGenerationRef = useRef(0);
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
  const runtimeProjectionWriterRef =
    useRef<RuntimeProjectionWriter | null>(null);
  if (!runtimeProjectionWriterRef.current)
    runtimeProjectionWriterRef.current = new RuntimeProjectionWriter(
      {
        readiness: setPrimaryRuntime,
        capability: setPrimaryCapabilitySnapshot,
        lifecycle: setApplicationLifecycle,
      },
      () => runEpochGenerationRef.current,
    );
  const runtimeProjectionWriter = runtimeProjectionWriterRef.current;
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
  const schedulePromptReconcileRef = useRef<(sessionId: string, eventVersion?: number, failedAttempts?: number) => void>(() => undefined);
  const sseReconnectTimerRef = useRef<number | null>(null);
  const sseFloodCountRef = useRef(0);
  const clearViewedPromiseRef = useRef<Promise<unknown> | null>(null);
  const resourceReloadActiveRef = useRef(false);
  const handoffWaitRef = useRef<Promise<void> | null>(null);
  const sessionRefreshTimerRef = useRef<number | null>(null);
  const sessionRefreshInFlightRef = useRef(false);
  const sessionRefreshGenerationRef = useRef<number | null>(null);
  const sessionRefreshRequestedRef = useRef(false);
  /** A structural Session mutation upgrades a coalesced refresh to a full scan. */
  const sessionRefreshRequestedFullRef = useRef(false);
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
  const promptSubmitControllerRef = useRef(
    createPromptSubmitController({ promptCoordinator: promptCoordinatorRef.current }),
  );
  const promptSubmitFlowRef = useRef(
    createPromptSubmitFlow({
      controller: promptSubmitControllerRef.current,
      isResultPending: resultPendingError,
      isExplicitClientRejection: (error, resultPending) =>
        error instanceof ApiRequestError
        && error.status >= 400
        && error.status < 500
        && !resultPending,
    }),
  );
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
  /** Queue or Browser-operation IDs whose user turn was already confirmed by a persisted view. */
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
  const {
    viewCacheRef,
    confirmedDeletedSessionIdsRef,
    viewCacheWriterRef,
    viewCacheWriter,
    activeSessionProjectionWriterRef,
    activeSessionProjectionWriter,
    prepareSessionViewCacheWrite,
    commitSessionViewCache,
    refreshSessionCache,
    refreshSessionCacheForAuthority,
    patchSessionCache,
    patchSessionCacheForAuthority,
    updateLiveSessionCache,
    reconcileQueuedAdmissions,
    appendTerminalSessionCache,
    withLatestQueueProjection,
    pendingSteersBySession,
    setPendingSteersBySession,
    pendingSteersRef,
    pendingSteerProjectionRef,
    syncPendingSteers,
    gateModes,
    setGateModes,
    gateModesRef,
    updateGateMode,
    failedSessionIds,
    setFailedSessionIds,
    applySessionActivity,
  } = useSessionProjectionState({
    ActiveSessionProjectionWriter,
    SessionViewCache,
    SessionViewCacheWriter,
    advanceQueueProjectionRevision,
    applyActiveSessionIds,
    bindQueuedAdmission,
    filterCancelledQueue,
    latestQueueProjectionRef,
    localUserTurnsRef,
    queueProjectionSourceRef,
    runEpochGenerationRef,
    sessionRunningOverridesRef,
    sessions,
    sessionsRef,
    setActiveSessionIds,
    setSessions,
  });
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
    const confirmedClientOperationIds = before.flatMap((turn) =>
      turn.promptOperationId
      && !pendingSet.has(turn)
      && transcriptConfirmsLocalTurn(
        turn,
        messages,
        turnTotal,
        messagesTruncated,
      )
        ? [turn.promptOperationId]
        : [],
    );
    const persistedPromptIds = messages.flatMap((message) =>
      message.role === "user"
      && message.piChatPersistedMessageId
      && message.piChatPromptId
        ? [message.piChatPromptId]
        : [],
    );
    if (!confirmed.length && !confirmedClientOperationIds.length && !persistedPromptIds.length) return;
    const existingIds = confirmedQueueDispatchIdsRef.current.get(sessionId);
    if (existingIds) confirmedQueueDispatchIdsRef.current.delete(sessionId);
    const ids = existingIds || new Set<string>();
    for (const turn of confirmed) {
      if (!turn.queueId) continue;
      ids.add(turn.queueId);
    }
    for (const operationId of confirmedClientOperationIds) ids.add(operationId);
    // A persisted Prompt identity is also an exact tombstone when its HTTP
    // queue acknowledgement (and therefore local queueId binding) lost the
    // race to this view. A delayed queue_dispatch must not synthesize it again.
    for (const promptId of persistedPromptIds) ids.add(promptId);
    // This is only a late-event fence; keep it bounded and let a matching
    // dispatch consume each entry.
    while (ids.size > MAX_CONFIRMED_DISPATCH_IDS_PER_SESSION)
      ids.delete(ids.values().next().value!);
    confirmedQueueDispatchIdsRef.current.set(sessionId, ids);
    while (
      confirmedQueueDispatchIdsRef.current.size
      > MAX_CONFIRMED_DISPATCH_SESSIONS
    )
      confirmedQueueDispatchIdsRef.current.delete(
        confirmedQueueDispatchIdsRef.current.keys().next().value!,
      );
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
  const bootstrapInFlightRef = useRef<{
    request: Promise<BootstrapData>;
    runEpochGeneration: number;
    cacheGeneration: number;
    runtimeProjectionGeneration: number;
    activeSessionProjectionGeneration: number;
    activeSessionFullRevision: number;
    modelCatalogueGeneration: number;
  } | null>(null);
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
    viewCacheWriter.clearForReplacement();
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
    // Browser requests are uncancellable. Detach the pre-reload coalescer so
    // the next refresh cannot grant its held bootstrap new cache authority.
    // The old request still settles only its stale refresh caller, while its
    // ownership-guarded finally cannot clear the post-reload request.
    bootstrapInFlightRef.current = null;
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
    viewCacheWriter.clearForReplacement();
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
    runtimeProjectionWriter.resetForResourceReload();
    activeSessionProjectionWriter.resetForReplacement();
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
    const reconciled = reconcileIdleSessionView(view);
    return {
      ...reconciled,
      session: settleSidebarActivity(reconciled.session),
    };
  };
  const reconcileSessionInventoryCurrent = (incoming: SessionSummary[]) => {
    const cachedQueues = new Map<string, { queue: QueuedPrompt[]; paused: boolean }>();
    for (const session of incoming) {
      const cached = viewCacheRef.current.get(session.id);
      if (cached && Array.isArray(cached.queue))
        cachedQueues.set(session.id, {
          queue: cached.queue,
          paused: cached.queuePaused === true,
        });
    }
    return reconcileSessionInventory(incoming, {
      runningOverrides: sessionRunningOverridesRef.current,
      queueProjections: latestQueueProjectionRef.current,
      cachedQueues,
      cancelledQueueIds: cancelledQueueIdsRef.current,
      sourceTurnTotals: sourceTurnTotalsRef.current,
      localTurnTotal: (sessionId) => Math.max(
        0,
        ...(localUserTurnsRef.current.get(sessionId) || []).map((turn) => turn.expectedTurnTotal),
      ),
      deletedSessionIds: new Set([
        ...optimisticDeletesRef.current.keys(),
        ...confirmedDeletedSessionIdsRef.current,
      ]),
      optimisticRenames: optimisticRenamesRef.current,
    });
  };
  const reconcileOptimisticSessions = (incoming: SessionSummary[]) =>
    reconcileSessionInventoryCurrent(incoming);
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
    (
      sessionId = viewedSessionIdRef.current,
    ): SessionViewCommitAuthority => ({
      sessionId,
      desiredSessionId: desiredSessionIdRef.current,
      ...viewCacheWriter.captureAuthority(runEpochGenerationRef.current),
      ...activeSessionProjectionWriter.captureViewAuthority(
        runEpochGenerationRef.current,
        sessionId,
      ),
      navigationEpoch: navigationEpochRef.current,
      committedRevision: paneCommitRevisionRef.current,
      committedIdentity: committedPaneIdentityRef.current,
      draftGeneration: draftGenerationRef.current,
    }),
    [],
  );
  const paneAuthorityCanCommit = useCallback(
    (authority: PaneAuthoritySnapshot) => canCommitPaneAuthority(authority, {
      sessionId: viewedSessionIdRef.current,
      desiredSessionId: desiredSessionIdRef.current,
      ...viewCacheWriter.captureAuthority(runEpochGenerationRef.current),
      navigationEpoch: navigationEpochRef.current,
      committedRevision: paneCommitRevisionRef.current,
      committedIdentity: committedPaneIdentityRef.current,
      draftGeneration: draftGenerationRef.current,
    }),
    [],
  );
  const draftAuthorityCanCommit = useCallback(
    (authority: DraftPaneAuthority) => canCommitDraftPaneAuthority(authority, {
      ...viewCacheWriter.captureAuthority(runEpochGenerationRef.current),
      navigationEpoch: navigationEpochRef.current,
      committedRevision: paneCommitRevisionRef.current,
      committedIdentity: committedPaneIdentityRef.current,
      draftGeneration: draftGenerationRef.current,
    }),
    [],
  );
  const refreshAuthorityIsCurrent = useCallback(
    (authority: RefreshAuthority) =>
      refreshEpochRef.current === authority.refreshEpoch &&
      viewCacheWriter.isCurrent(authority) &&
      runtimeProjectionWriter.isCurrent(authority) &&
      activeSessionProjectionWriter.isCurrent(authority) &&
      navigationEpochRef.current === authority.navigationEpoch,
    [],
  );
  const captureDraftPaneAuthority = useCallback(
    (): DraftSessionViewCommitAuthority => ({
      ...viewCacheWriter.captureAuthority(runEpochGenerationRef.current),
      ...activeSessionProjectionWriter.captureDraftAuthority(
        runEpochGenerationRef.current,
      ),
      navigationEpoch: navigationEpochRef.current,
      committedRevision: paneCommitRevisionRef.current,
      draftGeneration: draftGenerationRef.current,
    }),
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
  ) => viewCacheWriter.isCurrent(operation);
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

  const reconcileServerPendingPrompt = useCallback((view: SessionViewData): void =>
    reconcileServerPendingPromptFlow({
      turns: (id) => localUserTurnsRef.current.get(id) || [],
      storeTurns: (id, turns) => localUserTurnsRef.current.set(id, turns),
      deleteTurns: (id) => localUserTurnsRef.current.delete(id),
      recordLifecycle: recordUserTurnLifecycle,
      pendingSteerProjection: (id) => pendingSteerProjectionRef.current.get(id),
      commitSteerProjection: (id, projection) => pendingSteerProjectionRef.current.set(id, projection),
      syncSteers: syncPendingSteers,
    }, view), []);

  const reconcileServerPendingSteers = useCallback((view: SessionViewData): void =>
    reconcileServerPendingSteersFlow({
      turns: (id) => localUserTurnsRef.current.get(id) || [],
      storeTurns: (id, turns) => localUserTurnsRef.current.set(id, turns),
      deleteTurns: (id) => localUserTurnsRef.current.delete(id),
      recordLifecycle: recordUserTurnLifecycle,
      pendingSteerProjection: (id) => pendingSteerProjectionRef.current.get(id),
      commitSteerProjection: (id, projection) => pendingSteerProjectionRef.current.set(id, projection),
      syncSteers: syncPendingSteers,
    }, view), []);

  /**
   * Apply a native dequeue only after its server revision. The effect owns the
   * local-turn transaction; App remains the one owner of refs, Pane, Sidebar,
   * and Composer draft state through its ports.
   */
  const applyDequeuedSteers = (sessionId: string, ids: string[], revision = 0) =>
    applyNativeSteeringDequeueEffect({ sessionId, ids, revision }, {
      projection: (id) => pendingSteerProjectionRef.current.get(id),
      commitProjection: (id, projection: PendingSteerProjection) =>
        pendingSteerProjectionRef.current.set(id, projection),
      localTurns: (id) => localUserTurnsRef.current.get(id) || [],
      storeLocalTurns: (id, turns) => {
        if (turns.length) localUserTurnsRef.current.set(id, turns);
        else localUserTurnsRef.current.delete(id);
      },
      pendingSteers: (id) => pendingSteersRef.current.get(id) || [],
      syncPendingSteers,
      clearDequeueing: (id) => setSteerDequeueingBySession((current) => {
        if (!current[id]) return current;
        const next = { ...current };
        delete next[id];
        return next;
      }),
      sourceTurnTotal: (id) => sourceTurnTotalsRef.current.get(id) || 0,
      updateTurnTotal: (id, turnCount) => setSessions((current) =>
        current.map((session) =>
          session.id === id ? { ...session, turnCount } : session,
        ),
      ),
      removeVisibleTurns: (id, messages) => {
        if (viewedSessionIdRef.current !== id) return;
        commitPaneIfCurrent(capturePaneAuthority(id), {
          type: "PROMPT_ACKNOWLEDGED",
          sessionId: id,
          messages: (current) => current.filter((message) => !messages.has(message)),
        });
      },
      restoreComposerDrafts: (id, withdrawn, pendingById) => {
        const sequence = ++draftRestorationIntentSequenceRef.current;
        const drafts = withdrawn.map((turn) =>
          promptDraftFromMessage(
            turn.message,
            pendingById.get(turn.queueId || "")?.message || "",
          ),
        );
        const expectedDraftRevision =
          steerDequeueExpectedDraftRevisionRef.current.get(id) ??
          composerDraftRevisionsRef.current.get(
            composerDraftKeyId({ kind: "session", sessionId: id }),
          ) ??
          0;
        steerDequeueExpectedDraftRevisionRef.current.delete(id);
        const key: ComposerDraftKey = { kind: "session", sessionId: id };
        const keyId = composerDraftKeyId(key);
        if (sequence <= (appliedDraftRestorationSequencesRef.current.get(keyId) || 0))
          return;
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
      },
    });

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
    (
      data: BootstrapData,
      committedModel: ModelInfo | null | undefined,
      authority: RuntimeProjectionWriteAuthority,
    ) => {
      runtimeProjectionWriter.confirmBootstrapCapability({
        readiness: data.primaryRuntime,
        committedModelKey: modelCapabilityKey(committedModel),
        modelKeys: [data.state.model, ...data.models]
          .map(modelCapabilityKey)
          .filter(Boolean),
      }, authority);
    },
    [],
  );

  const applyBootstrapMetadata = useCallback(
    (
      data: BootstrapData,
      authority?: RuntimeProjectionWriteAuthority
        & ActiveSessionProjectionAuthority
        & ModelCatalogueAuthority,
    ) => {
      applySidebarInventory(data);
      if (authority) {
        const readiness = data.primaryRuntime || {
          status: "starting" as const,
          generation: 0,
        };
        runtimeProjectionWriter.commitBootstrap(
          {
            readiness,
            lifecycle:
              data.applicationLifecycle === undefined
                ? "idle"
                : data.applicationLifecycle,
          },
          authority,
        );
      }
      const activeId =
        data.activeSessionId ||
        data.sessions.find((session) => session.active)?.id ||
        "";
      rememberConfirmedCommands(data.commands);
      if (authority) {
        setActiveSessionId(activeId);
        const hotIds = data.activeSessionIds || (activeId ? [activeId] : []);
        activeSessionProjectionWriter.commitBootstrap(hotIds, authority);
      }
      if (
        modelCatalogueRevisionGate.admitBootstrap(
          data.modelCatalogueRevision,
          authority,
        )
      ) {
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
      }
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
    },
    [applySidebarInventory, rememberConfirmedCommands],
  );

  const applyBootstrap = useCallback(createBootstrapCommit({
    paneAuthorityCanCommit,
    recordRejected: (reason: string) => recordBrowserStateDiagnostic("projection", "bootstrap-rejected", {
      details: { authorityPresent: true, decisionReason: reason },
    }),
    recordReceived: (sessionId: string, data: BootstrapData) => recordBrowserStateDiagnostic("projection", "bootstrap-received", {
      sessionId,
      details: {
        stateStreaming: data.state.isStreaming,
        hasLive: Boolean(data.liveMessage),
        toolActive: Boolean(data.toolStatus),
        queuePaused: data.queuePaused,
        queueLength: data.queue.length,
        sessionRunning: data.sessions.find((item) => item.id === sessionId)?.running === true,
      },
    }),
    recordAccepted: (sessionId: string, authority: any) => recordBrowserStateDiagnostic("projection", "bootstrap-accepted", {
      sessionId,
      details: { authorityPresent: Boolean(authority), decisionReason: "accepted" },
    }),
    confirmedDeleted: () => confirmedDeletedSessionIdsRef.current,
    acceptQueueProjection,
    acceptQueueProjectionIfCurrent,
    commitSessionViewCache,
    reconcileServerPendingPrompt,
    reconcileServerPendingSteers,
    reconcileQueuedAdmissions,
    localTurns: (id: string) => localUserTurnsRef.current.get(id) || [],
    promoteTurnsAbsentFromQueue,
    cancellingQueueIds: (id: string) => cancellingQueueIdsRef.current.get(id),
    protectTranscriptWithLocalTurns,
    rememberConfirmedQueueDispatchIds,
    localTurnBelongsInTranscript,
    storeLocalTurns: (id: string, turns: any[]) => localUserTurnsRef.current.set(id, turns),
    deleteLocalTurns: (id: string) => localUserTurnsRef.current.delete(id),
    applyBootstrapMetadata,
    updateGateMode,
    commitPane,
    recordCommitted: (id: string) => recordBrowserStateDiagnostic("projection", "bootstrap-committed", {
      ...(id && id !== "draft" ? { sessionId: id } : null),
      details: { paneKind: id === "draft" ? "draft" : "session", decisionReason: "committed" },
    }),
    confirmPrimaryCapabilitySnapshot,
    stagedPreference: (id: string) => pendingSessionPrefsRef.current.get(id),
    committedPaneCommandsFor: (id: string) => committedPaneIdentityRef.current.kind === "session" && committedPaneIdentityRef.current.sessionId === id ? committedPaneCommandsRef.current : [],
  }), [
    applyBootstrapMetadata, confirmPrimaryCapabilitySnapshot, commitPane,
    reconcileServerPendingPrompt, reconcileServerPendingSteers,
    paneAuthorityCanCommit, updateGateMode,
  ]);

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

  const loadingEarlierRequestsRef = useRef(
    new Map<
      string,
      { token: symbol; navigationEpoch: number; controller: AbortController }
    >(),
  );

  const {
    applySessionView,
    ensureHandshake,
    loadBootstrap,
    refresh,
    startIdleRecovery,
    refreshSidebarSessions,
    loadAllSessions,
    loadDirectorySessions,
    scheduleSidebarRefresh
  } = useSessionProjectionFlows({
    EARLY_HISTORY_VIEW_DELAY_MS, EARLY_SIDEBAR_INVENTORY_DELAY_MS, MAX_DIRECTORY_PREFIX_SIZE, acceptQueueProjectionIfCurrent,
    activeSessionIds, activeSessionProjectionWriter, api, appearance,
    applyAppearance, applyBootstrap, applyBootstrapMetadata, applySidebarInventory,
    applySidebarQueueProjection, bootstrapCompletedRef, bootstrapInFlightRef, buildIdentityMatches,
    cancelPendingNavigation, cancellingQueueIdsRef, capturePaneAuthority, clearStoppingForSession,
    commitPane, commitSessionViewCache, commitSidebarSessions, committedPaneCommandsRef,
    committedPaneIdentityRef, completedCompactionSessionIdsRef, confirmPrimaryCapabilitySnapshot, confirmedDeletedSessionIdsRef,
    createSessionBootstrapFlow, createSessionViewApplicator, desiredSessionIdRef, directoryLoadGenerationsRef,
    directorySessionCoverageRef, draftAuthorityCanCommit, fetchSessionView, handshakeInFlightRef,
    initialHistoryRef, initialReadyRecoveryRequestedRef, loadAllSessionsGenerationRef, loadingEarlierRequestsRef,
    localDraftRef, localTurnBelongsInTranscript, localUserTurnsRef, modelCatalogueRevisionGate,
    navigationEpochRef, optimisticSessionsTotal, paneAuthorityCanCommit, paneModelRef,
    pinnedInventoryAttemptRef, promoteTurnsAbsentFromQueue, protectTranscriptWithLocalTurns, queueProjectionForView,
    queueProjectionRevisionRef, reconcileQueuedAdmissions, reconcileServerPendingPrompt, reconcileServerPendingSteers,
    reconcileSessionInventoryCurrent, recordBrowserStateDiagnostic, recordPaneCommit, recordSourceTurnTotal,
    recoverableRefreshError, refreshAuthorityIsCurrent, refreshEpochRef, rehydrateSubagentAddressChain,
    rememberConfirmedQueueDispatchIds, rememberedSessionId, replacementBootstrapPendingRef, reportBackgroundRefreshError,
    requestPromptReconcileRef, runEpochGenerationRef, runtimeProjectionWriter, saveAppearance,
    saveSessionNavigationPreferences, saveSidebarOpen, saveSidebarWidth, schedulePromptReconcileRef,
    sessionEventVersionRef, sessionNavigation, sessionNavigationRef, sessionRefreshGenerationRef,
    sessionRefreshInFlightRef, sessionRefreshRequestedFullRef, sessionRefreshRequestedRef, sessionRefreshTimerRef,
    sessions, setBuildIdentityMismatch, setError, setLoading,
    setLoadingAllSessions, setLoadingDirectoryKeys, setNotice, setPaneLoading,
    setRuntimeWarming, setServerBuildIdentity, setSessionDirectories, setSessions,
    setSessionsTotal, setUnseenReplySessionIds, showAllSessionsRef, sidebarCommittedFullSequenceRef,
    sidebarDirectoryKey, sidebarFullRequestSequenceRef, sidebarInventoryReady, sidebarInventoryReadyRef,
    sidebarOpen, sidebarWidth, subagentAddressesRef, terminalAssistantSessionIdsRef,
    tryAutoAllowGate, uniqueSessionSummaries, updateGateMode, useCallback,
    useEffect, viewCacheWriter, viewedSessionIdRef,
  });

  const sessionManagementActionsRef = useRef<Pick<ReturnType<typeof createSessionManagementActions>, "finalizeDeletedSession" | "selectDeletionFallback"> | null>(null);
  const finalizeDeletedSession = (...args: any[]) =>
    (sessionManagementActionsRef.current?.finalizeDeletedSession as any)?.(...args);
  const selectDeletionFallback = (...args: any[]) =>
    (sessionManagementActionsRef.current?.selectDeletionFallback as any)?.(...args);

  const handleEventSourceReady = useCallback(createStreamReadyHandler({
    noteEventFrame: () => { lastEventFrameAtRef.current = Date.now(); },
    rejectSse: recordSseRejectionDiagnostic,
    runEpoch: () => runEpochRef.current,
    resetBootstrapRecovery: () => {
      bootstrapCompletedRef.current = false;
      initialReadyRecoveryRequestedRef.current = false;
      replacementBootstrapPendingRef.current = true;
    },
    advanceRunEpochGeneration: () => { runEpochGenerationRef.current += 1; },
    cancelPendingNavigation,
    detachSessionRefreshWork: () => {
      if (sessionRefreshTimerRef.current !== null) window.clearTimeout(sessionRefreshTimerRef.current);
      sessionRefreshTimerRef.current = null;
      sessionRefreshInFlightRef.current = false;
      sessionRefreshGenerationRef.current = null;
      sessionRefreshRequestedRef.current = false;
      sessionRefreshRequestedFullRef.current = false;
      loadAllSessionsGenerationRef.current = null;
      directoryLoadGenerationsRef.current.clear();
      directorySessionCoverageRef.current.clear();
      pinnedInventoryAttemptRef.current = "";
      showAllSessionsRef.current = false;
      sidebarFullRequestSequenceRef.current = 0;
      sidebarCommittedFullSequenceRef.current = 0;
      setLoadingAllSessions(false);
      setLoadingDirectoryKeys([]);
    },
    detachBootstrapAndHandshake: () => {
      bootstrapInFlightRef.current = null;
      api.invalidateHandshake();
      handshakeInFlightRef.current = null;
      initialHistoryRef.current = null;
    },
    resetDraftPickers: () => {
      draftWorkspacePickerTokenRef.current = null;
      workspaceDefaultPickerTokenRef.current = null;
      setWorkspacePicking(false);
    },
    resetRefreshState: () => { refreshOperationTokenRef.current = null; setRefreshing(false); },
    clearStopping: () => clearStoppingForSession(),
    resetProcessOwnedUiState,
    resetSidebarInventory: () => {
      sidebarInventoryReadyRef.current = false;
      setSidebarInventoryReady(false);
      setSessions([]);
      setSessionsTotal(0);
      setSessionDirectories([]);
    },
    resetRuntimeProjection: () => runtimeProjectionWriter.resetForProcessReplacement(),
    resetActiveSessionProjection: () => activeSessionProjectionWriter.resetForReplacement(),
    resetModelCatalogue: () => { modelCatalogueRevisionGate.resetForProcessReplacement(); setModelInventoryConfirmed(false); },
    resetWorkspaceEpoch: (epoch: string) => { workspaceEpochRef.current = epoch; workspaceRevisionRef.current = 0; runEpochRef.current = epoch; },
    setRunEpoch: (epoch: string) => { runEpochRef.current = epoch; },
    currentReadiness: () => runtimeProjectionWriter.currentReadiness(),
    localDraft: () => Boolean(localDraftRef.current),
    observeTransportReady: (incoming: PrimaryRuntimeReadiness) => runtimeProjectionWriter.observeTransportReady(incoming).next,
    rememberObservedModel,
    modelCapabilityKey,
    publishReadyCapability: (snapshot: any) => runtimeProjectionWriter.publishReadyCapability(snapshot),
    dispatchPane,
    observeLifecycle: (lifecycle: ApplicationLifecycle) => runtimeProjectionWriter.observeLifecycle(lifecycle),
    setNotice,
    resourceReloadActive: () => resourceReloadActiveRef.current,
    setResourceReloadActive: () => { resourceReloadActiveRef.current = true; },
    resetResourceReloadTransientState,
    setCloseComplete,
    waitForHandoff: () => {
      handoffWaitRef.current ||= api.waitForApplicationHandoff().then(() => window.location.reload()).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        handoffWaitRef.current = null;
      });
    },
    clearResourceReloadActive: () => { resourceReloadActiveRef.current = false; },
    startIdleRecovery,
  }), [
    cancelPendingNavigation, clearStoppingForSession, recordSseRejectionDiagnostic,
    rememberObservedModel, resetProcessOwnedUiState, resetResourceReloadTransientState,
    startIdleRecovery,
  ]);

  const handlePiEvent = useCallback(createPiEventHandler({
    MESSAGE_CHECKPOINT_EVENT,
    MESSAGE_DELTA_EVENT,
    WAITING_FOR_PI_STATUS,
    acceptQueueProjection,
    activeSessionProjectionWriter,
    admitStreamEvent,
    appendTerminalSessionCache,
    applyDequeuedSteers,
    applyExtensionUiRequestEffect,
    applyNativeSteeringClearEffect,
    applyQueueDispatchEffect,
    applyQueueErrorEffect,
    applyQueueSnapshotEffect,
    applyQueueUpdateEffect,
    applySessionActivity,
    applySessionView,
    applySidebarQueueProjection,
    applySidebarRunningOverride,
    applyStreamingDelta,
    assistantMessage,
    assistantMessageRequestsTool,
    authoritativeTurnTotal,
    bindQueuedAdmission,
    bindQueuedDispatch,
    cancelPendingNavigation,
    cancellingQueueIdsRef,
    capturePaneAuthority,
    clearEmptyQueuePause,
    clearPendingLiveMessage,
    clearPromptReconcileTimer,
    clearStoppingForSession,
    commitSessionViewCache,
    completedCompactionSessionIdsRef,
    confirmedQueueDispatchIdsRef,
    consumeLocalSteeringTurn,
    decodeStreamingCheckpoint,
    deriveActiveSessionChangedEffect,
    deriveApplicationLifecycleEffect,
    deriveExtensionRequestResolvedEffect,
    deriveFastModeChangedEffect,
    deriveGateModeChangedEffect,
    derivePromptDeliveryUncertainEffect,
    derivePromptRetryEffect,
    deriveQueueDispatchEffect,
    deriveQueueErrorEffect,
    deriveQueueSnapshotEffect,
    deriveSessionControlChangedEffect,
    deriveSessionMutationEffect,
    deriveWorkspaceChangedEffect,
    desiredSessionIdRef,
    dispatchAskQuestionnaire,
    dispatchPane,
    displaySettingsFromEvent,
    fetchSessionView,
    finalizeDeletedSession: (...args: any[]) => (finalizeDeletedSession as any)(...args),
    finiteRunMetric,
    gateModeFromNotice,
    invalidatesSessionViewVersion,
    isSessionScopedEvent,
    lastEventFrameAtRef,
    lastSessionEventTypeRef,
    latestQueueProjectionRef,
    localDraftRef,
    localUserTurnsRef,
    mergeModelCatalog,
    messages,
    modelCatalogueRevisionGate,
    navigationEpochRef,
    pane,
    paneAuthorityCanCommit,
    paneStateRef,
    parseAskQuestionnaire,
    patchSessionCache,
    pendingGateModesRef,
    pendingSteerProjectionRef,
    pendingSteersRef,
    promoteTurnsAbsentFromQueue,
    promptControllerRef: promptSubmitControllerRef,
    queue,
    queueProjectionRevisionRef,
    recordBrowserStateDiagnostic,
    recordLocalFailure,
    recordSseRejectionDiagnostic,
    refresh,
    releasePromptBusy,
    rememberObservedModel,
    reportBackgroundRefreshError,
    requestPromptReconcileRef,
    resetResourceReloadTransientState,
    resourceReloadActiveRef,
    runEpochRef,
    runtimeProjectionWriter,
    saveModelCatalog,
    scheduleLiveMessage,
    scheduleSidebarRefresh,
    selectDeletionFallback: (...args: any[]) => (selectDeletionFallback as any)(...args),
    sessionEventVersionRef,
    sessionRunGenerationsRef,
    sessionRunningOverridesRef,
    sessionsRef,
    setCloseComplete,
    setError,
    setEventSourceGeneration,
    setFailedSessionIds,
    setManagementSection,
    setModelRuntimeSyncPending,
    setModels,
    setNotice,
    setRuntimeWarming,
    setSessions,
    setUnseenReplySessionIds,
    setWorkspaceCwd,
    settleSidebarActivity,
    settledPaneActivity,
    settledRunGenerationsRef,
    sourceTurnTotalsRef,
    sseFloodCountRef,
    sseReconnectTimerRef,
    stageGateMode,
    startIdleRecovery,
    state,
    steeringClearedMessage,
    streamDiagnosticsRef,
    streamGapRecoveriesRef,
    streamingWireProjectionsRef,
    syncPendingSteers,
    terminalAssistantSessionIdsRef,
    terminalAssistantStreamGenerationsRef,
    tryAutoAllowGate,
    unreadSteeringDropMessagesRef,
    updateGateMode,
    updateLiveSessionCache,
    viewCacheRef,
    viewCacheWriter,
    viewedSessionIdRef,
    withStreamingAppendHints,
    workspaceEpochRef,
    workspaceRevisionRef,
  }),
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

  const handleEventSourceError = useCallback(createStreamErrorHandler({
    currentLifecycle: () => runtimeProjectionWriter.currentLifecycle(),
    waitForHandoff: () => {
      handoffWaitRef.current ||= api.waitForApplicationHandoff().then(() => window.location.reload()).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        handoffWaitRef.current = null;
      });
    },
    setError,
    viewedSessionId: () => viewedSessionIdRef.current,
    desiredSessionId: () => desiredSessionIdRef.current,
    sessions: () => sessionsRef.current,
    paneStreaming: () => paneStateRef.current.isStreaming,
    recoveringConnection: () => recoveringConnectionRef.current,
    setRecoveringConnection: (promise: Promise<void>) => { recoveringConnectionRef.current = promise; },
    clearRecoveringConnection: () => { recoveringConnectionRef.current = null; },
    advanceRunEpochGeneration: () => { runEpochGenerationRef.current += 1; },
    resetProcessProjection: () => {
      runtimeProjectionWriter.resetForProcessReplacement();
      activeSessionProjectionWriter.resetForReplacement();
      modelCatalogueRevisionGate.resetForProcessReplacement();
      setModelInventoryConfirmed(false);
    },
    resetInventory: () => {
      sessionRefreshTimerRef.current && window.clearTimeout(sessionRefreshTimerRef.current);
      sessionRefreshTimerRef.current = null;
      sessionRefreshInFlightRef.current = false;
      sessionRefreshGenerationRef.current = null;
      sessionRefreshRequestedRef.current = false;
      sessionRefreshRequestedFullRef.current = false;
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
    },
    setTransportRecoveryPending: (value: boolean) => { transportRecoveryPendingRef.current = value; },
    retainSession: (session: any, active: boolean) => {
      setSessions(session ? [active ? applySidebarRunningOverride(session, true) : session] : []);
      setSessionsTotal(session ? 1 : 0);
      setSessionDirectories([]);
      if (session && active) sessionRunningOverridesRef.current.set(session.id, true);
    },
    resetAskAndTransientUi: () => {
      dispatchAskQuestionnaire({ type: "RESET" });
      bootstrapInFlightRef.current = null;
      handshakeInFlightRef.current = null;
      initialHistoryRef.current = null;
      refreshOperationTokenRef.current = null;
      setRefreshing(false);
      clearStoppingForSession();
      draftWorkspacePickerTokenRef.current = null;
      workspaceDefaultPickerTokenRef.current = null;
      setWorkspacePicking(false);
    },
    bumpEventSourceGeneration: () => setEventSourceGeneration((generation) => generation + 1),
    refresh,
    reportBackgroundRefreshError,
  }), [clearStoppingForSession, refresh, reportBackgroundRefreshError]);

  const handleOversizedEventSourceFrame = useCallback(createOversizedEventHandler({
    noteEventFrame: () => { lastEventFrameAtRef.current = Date.now(); },
    incrementFloodCount: () => ++sseFloodCountRef.current,
    clearReconnectTimer: () => {
      if (sseReconnectTimerRef.current !== null) window.clearTimeout(sseReconnectTimerRef.current);
      sseReconnectTimerRef.current = null;
    },
    refresh,
    reportBackgroundRefreshError,
    setReconnectTimer: (timer: number) => { sseReconnectTimerRef.current = timer; },
    bumpEventSourceGeneration: () => setEventSourceGeneration((generation) => generation + 1),
  }), [refresh, reportBackgroundRefreshError]);

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

  const loadEarlierTurns = useCallback(createHistoryPaginationFlow({
    viewedSessionId: () => viewedSessionIdRef.current,
    navigationEpoch: () => navigationEpochRef.current,
    capturePaneAuthority,
    loadingRequest: (id: string) => loadingEarlierRequestsRef.current.get(id),
    messagesTruncated: () => messagesTruncated,
    visibleTurnCount: () => visibleTurnCount,
    scrollElement: () => scrollRef.current,
    setLoadingRequest: (id: string, value: any) => loadingEarlierRequestsRef.current.set(id, value),
    bumpLoadingRevision: () => setLoadingEarlierRevision((current) => current + 1),
    setError,
    setStickToBottom: (value: boolean) => { stickToBottomRef.current = value; },
    sessionEventVersion: (id: string) => sessionEventVersionRef.current.get(id) || 0,
    queueProjectionRevision: (id: string) => queueProjectionRevisionRef.current.get(id) || 0,
    viewCacheRevision: (id: string) => viewCacheRef.current.revisionFor(id),
    fetchSessionView,
    turnTotal: () => turnTotal,
    paneAuthorityCanCommit,
    recordRejected: (id: string, reason: string) => recordBrowserStateDiagnostic("projection", "session-view-rejected", { sessionId: id, details: { authorityPresent: true, decisionReason: reason } }),
    mergeNavigationView: (view: SessionViewData, revision: number, authority: any) => viewCacheWriter.mergeNavigation(view, revision, authority),
    applySessionView,
    deleteLoadingRequest: (id: string) => loadingEarlierRequestsRef.current.delete(id),
  }), [applySessionView, capturePaneAuthority, messagesTruncated, paneAuthorityCanCommit, turnTotal, visibleTurnCount]);

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
  schedulePromptReconcileRef.current = schedulePromptReconcile;

  const stopGeneration = createStopGeneration({
    api,
    applySessionView,
    buildIdentityMismatch,
    captureViewOperation,
    clearStoppingForSession,
    commitPaneIfCurrent,
    commitSessionViewCache,
    fetchSessionView,
    patchSessionCacheForAuthority,
    queueProjectionForView,
    queueProjectionRevisionRef,
    scheduleSidebarRefresh,
    sessionEventVersionRef,
    sessionRunningOverridesRef,
    setError,
    setNotice,
    setSessions,
    setStoppingSessionIds,
    settleSidebarActivity,
    stoppingOperationTokensRef,
    subagentAddressesRef,
    viewOperationIsCurrent,
    viewOperationIsInCurrentRun,
    viewedSessionIdRef,
  });

  const viewSession = createSessionNavigationFlow({
    confirmedDeleted: () => confirmedDeletedSessionIdsRef.current,
    viewedSessionId: () => viewedSessionIdRef.current,
    desiredSessionId: () => desiredSessionIdRef.current,
    unseenReplyIds: () => unseenReplySessionIds,
    consumeUnseenReply: (id: string) => {
      terminalAssistantSessionIdsRef.current.delete(id);
      setUnseenReplySessionIds((current) => current.filter((sessionId) => sessionId !== id));
    },
    drainPendingLiveMessage,
    updateLiveSessionCache,
    sessions: () => sessions,
    hasLocalDraft: () => Boolean(localDraftRef.current),
    refreshSessionCache,
    currentState: () => state,
    activeSessionIds: () => activeSessionIds,
    currentRuntimeStatus: () => runtimeStatus,
    currentLiveMessage: () => liveMessage,
    currentToolStatus: () => toolStatus,
    currentStats: () => stats,
    currentQueue: () => queue,
    currentQueuePaused: () => queuePaused,
    currentCommands: () => commands,
    currentExtensionRequest: () => extensionRequest,
    gateAvailableOverride: () => gateAvailableOverride,
    currentViewControl: () => viewControl,
    rememberCurrentScroll,
    scrollTurns: (id: string) => scrollMemoryRef.current.turns(id),
    cancelPendingNavigation,
    abortLoadingEarlierRequests: () => {
      for (const request of loadingEarlierRequestsRef.current.values()) request.controller.abort();
    },
    beginNavigation: (id: string, now: number) => sessionNavigationCoordinatorRef.current!.begin(id, now),
    setScrollMemoryFence: (fence: { epoch: number; targetSessionId: string }) => { scrollMemoryFenceRef.current = fence; },
    capturePaneAuthority,
    setViewSwitching,
    setError,
    withLatestQueueProjection,
    cachedView: (id: string) => viewCacheRef.current.get(id),
    navigationEpoch: () => navigationEpochRef.current,
    setPendingScrollRestore: (id: string) => { pendingScrollRestoreRef.current = id; },
    recordPaneCommit,
    applySessionView,
    joinWarmPane,
    sessionEventVersion: (id: string) => sessionEventVersionRef.current.get(id) || 0,
    queueProjectionRevision: (id: string) => queueProjectionRevisionRef.current.get(id) || 0,
    fetchSessionView,
    recordRejectedView: (id: string, reason: string) => recordBrowserStateDiagnostic(
      "projection", "session-view-rejected", {
        sessionId: id,
        details: {
          ...(reason === "stale-pane-authority" ? { authorityPresent: true } : null),
          decisionReason: reason,
        },
      },
    ),
    paneAuthorityCanCommit,
    schedulePromptReconcile,
    acceptAuthoritativeIdleSessionView,
    acceptQueueProjectionIfCurrent,
    refreshSessionCacheForAuthority,
    setPaneLoading,
    viewCacheRevision: (id: string) => viewCacheRef.current.revisionFor(id),
    mergeNavigationView: (view: SessionViewData, revision: number, authority: SessionViewCommitAuthority) =>
      viewCacheWriter.mergeNavigation(view, revision, authority),
    isSubagent: (id: string) => subagentAddressesRef.current.has(id),
    scrollMemoryFence: () => scrollMemoryFenceRef.current,
    clearScrollMemoryFence: () => { scrollMemoryFenceRef.current = null; },
    clearNavigationStartedAt: (epoch: number) => { navigationStartedAtRef.current.delete(epoch); },
    setDesiredSessionId: (id: string) => { desiredSessionIdRef.current = id; },
    finishNavigation: (epoch: number, controller: AbortController) =>
      sessionNavigationCoordinatorRef.current!.finish(epoch, controller),
  });

  const sessionNavigationActions = createSessionNavigationActions({
    addresses: subagentAddressesRef.current,
    forgetCurrent: (sessionId) => viewCacheWriter.forgetCurrent(sessionId),
    navigate: (sessionId, label) => {
      void viewSession(sessionId, label);
    },
  });
  const openSubagentSession = sessionNavigationActions.openSubagentSession;
  /** Breadcrumbs only contain server-verified parent edges retained above. */
  const navigateSubagentAncestor = sessionNavigationActions.navigateSubagentAncestor;

  // Child JSONL is read-only and has no Pi Chat Runtime/SSE owner. Poll only
  // while its verified address is selected; each response must still pass the
  // full pane authority check (including A → B → A and process replacement).
  useEffect(() => {
    const address = subagentAddressesRef.current.get(viewedSessionId);
    if (!address) return;
    let cancelled = false;
    let inFlight = false;
    const refreshChild = async () => {
      if (cancelled || inFlight || viewedSessionIdRef.current !== viewedSessionId) return;
      inFlight = true;
      const authority = capturePaneAuthority(viewedSessionId);
      try {
        const view = await fetchSessionView(viewedSessionId);
        if (!cancelled && paneAuthorityCanCommit(authority))
          applySessionView(view, authority);
      } catch {
        // A transient child/status read cannot replace the last valid pane.
      } finally {
        inFlight = false;
      }
    };
    let timer: number | null = null;
    const schedule = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => {
        timer = null;
        void refreshChild().finally(schedule);
      }, 2_000);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        if (timer === null) void refreshChild().finally(schedule);
      } else if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (document.visibilityState === "visible") schedule();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [viewedSessionId, fetchSessionView, applySessionView]);

  const createSession = () => createNewDraft({
    buildIdentityMismatch: () => buildIdentityMismatch,
    cancelPendingNavigation,
    viewedSessionId: () => viewedSessionIdRef.current,
    rememberCurrentScroll,
    clearPendingScrollRestore: () => { pendingScrollRestoreRef.current = ""; },
    advanceNavigationEpoch: () => { navigationEpochRef.current += 1; },
    advanceRefreshEpoch: () => { refreshEpochRef.current += 1; },
    setViewSwitching,
    cancelDraftWorkspacePicker: () => {
      draftWorkspacePickerTokenRef.current = null;
      if (!workspaceDefaultPickerTokenRef.current) setWorkspacePicking(false);
    },
    clearPromptReconcileTimer,
    clearDraftPreferences: () => {
      pendingSessionPrefsRef.current.delete(DRAFT_PREFS_KEY);
      saveSessionComposerSelections(pendingSessionPrefsRef.current);
      pendingGateModesRef.current.delete(DRAFT_PREFS_KEY);
      setComposerSelectionRevision((revision) => revision + 1);
      setPendingGateModes(Object.fromEntries(pendingGateModesRef.current));
    },
    currentModel: () => state.model,
    currentThinkingLevel: () => state.thinkingLevel,
    workspaceCwd: () => workspaceCwd,
    resetDraftComposer: (input: any) => commitPane({ type: "RESET_DRAFT", ...input }),
    stickToBottom: () => { stickToBottomRef.current = true; },
    setError,
    setNotice,
    clearViewedPreviousSession: (previousViewedSessionId: string) => {
      clearViewedPromiseRef.current = previousViewedSessionId && !subagentAddressesRef.current.has(previousViewedSessionId)
        ? api.clearSessionViewed(previousViewedSessionId).catch(() => undefined)
        : null;
    },
  });

  /**
   * Apply shared warm readiness to one caller's exact pane. The Session-scoped
   * warm promise has no display authority: each joiner brings its own token so
   * an A → B → A revisit can upgrade the newer A pane without accepting the
   * first A caller's stale completion.
   */
  const applyWarmReadinessForPane = (sessionId: string, ready: SessionRuntimeReadyData, authority: PaneAuthoritySnapshot, capabilityOnly = false) =>
    applyWarmReadiness({ commitPaneIfCurrent }, sessionId, ready, authority, capabilityOnly);
  function joinWarmPane(sessionId: string, authority: PaneAuthoritySnapshot): void {
    joinWarmPaneFlow({ warmingRuntime: (id: string) => warmingRuntimeStartsRef.current.get(id), commitPaneIfCurrent, setError }, sessionId, authority);
  }
  const warmSessionRuntime = useCallback(
    (sessionId: string): Promise<SessionRuntimeReadyData> => warmSessionRuntimeFlow({
      warmingRuntime: (id: string) => warmingRuntimeStartsRef.current.get(id),
      setRuntimeWarming,
      runEpochGeneration: () => runEpochGenerationRef.current,
      captureCacheAuthority: (generation: number) => viewCacheWriter.captureAuthority(generation),
      cacheAuthorityIsCurrent: (authority: SessionViewCacheWriteAuthority) => viewCacheWriter.isCurrent(authority),
      apiWarmSession: (id: string) => api.warmSession(id),
      updateGateMode,
      refreshSessionCacheForAuthority,
      clearWarmingRuntime: (id: string) => warmingRuntimeStartsRef.current.delete(id),
      setWarmingRuntime: (id: string, promise: Promise<SessionRuntimeReadyData>) => warmingRuntimeStartsRef.current.set(id, promise),
    }, sessionId),
    [refreshSessionCacheForAuthority, setRuntimeWarming, updateGateMode],
  );

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

  const send = createPromptSendFlow({
    ApiRequestError, DRAFT_FAILURE_SCOPE, DRAFT_PREFS_KEY, LOCAL_DRAFT_BUSY_ID,
    WAITING_FOR_PI_STATUS, acceptQueueProjection, adoptDraftSessionView, api,
    appendLocalTurnOnce, applySessionView, applySidebarQueueProjection, applyWarmReadinessForPane,
    authoritativeStoppedSteerRejection, authoritativeTurnTotal, beginSessionBusy, bindLocalTurnPromptIdentity,
    buildIdentityMismatch, buildProtectedLocalTurn, cancellingQueueIdsRef, captureDraftPaneAuthority,
    capturePaneAuthority, capturePromptSelection, captureViewOperation, classifyPromptFailure,
    clearPendingLiveMessage, clearStoppingForSession, clearViewedPromiseRef, commitDraftIfCurrent,
    commitPaneIfCurrent, commitSessionViewCache, composerCommands, createSession,
    desiredSessionIdRef, dispatchPane, displayedQueue, draftAuthorityCanCommit,
    draftIntentAfterSubmit, draftWorkspaceCwd, fetchSessionView, forgetLocalFailuresForSession,
    gateModeFromCommand, gateModesRef, isTranscriptWorthyFailure, lastSessionEventTypeRef,
    latestQueueProjectionRef, localDraftRef, localUserTurnsRef, markLocalTurnQueued,
    messages, modelInventoryConfirmed, modelUnavailableError, models,
    navigationEpochRef, paneAuthorityCanCommit, patchSessionCacheForAuthority, pendingGateModesRef,
    pendingSessionPrefsRef, pendingSteerFromAcknowledgement, pendingSteersRef, planAcknowledgedQueueProjection,
    planAcknowledgedTurn, planPromptFailureLocalTurn, prepareRestoringPrompt, presentPromptFailure,
    promoteTurnsAbsentFromQueue, promptAcknowledgementKind, promptBusyReleasesRef, promptPreparationRoute,
    promptSubmitControllerRef, promptSubmitFlowRef, queuePaused, queueProjectionForView,
    queueProjectionRevisionRef, queueProjectionSourceRef, reconcileOrdinaryPromptAcknowledgement, reconcilePromptFailureRecord,
    reconcileQueuedPromptAcknowledgement, reconcileSpecialPromptAcknowledgement, reconcileStalePromptAcknowledgement, reconcileStoppedSteerFailure,
    recordLocalFailure, recordUserTurnLifecycle, refresh, releasePromptBusy,
    removeLocalTurnAndRebase, requestPromptReconcileRef, resultPendingError, runEpochGenerationRef,
    runEpochRef, runtimeStatus, saveSessionComposerSelections, schedulePromptReconcile,
    scheduleSidebarRefresh, sessionEventVersionRef, sessionRunGenerationsRef, sessionRunningOverridesRef,
    setComposerSelectionRevision, setError, setLocalFailures, setNotice,
    setPendingGateModes, setSessions, settleSidebarActivity, shouldClearModelSelectionOnFailure,
    state, stickToBottomRef, stopGeneration, submitNewDraftPrompt,
    syncPendingSteers, toolStatus, turnTotal, updateGateMode,
    userMessage, validateSelectedRoute, viewCacheWriter, viewOperationIsCurrent,
    viewOperationIsInCurrentRun, viewedSessionId, viewedSessionIdRef, warmSessionRuntime,
    workspaceCwd,
  });

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
  const {
    composerTargetForViewedSession,
    stageComposerSelection,
    stageSessionPref,
    changeModel,
    changeThinking,
    selectDraftWorkspace,
    pickDraftWorkspace,
    pickDefaultWorkspace,
    changeGate,
    respondToExtension,
    loadingEarlier
  } = createComposerSettingsActions({
    DRAFT_PREFS_KEY, api, buildIdentityMismatch, captureDraftPaneAuthority,
    capturePaneAuthority, commitDraftIfCurrent, commitPaneIfCurrent, dispatchPane,
    draftAuthorityCanCommit, draftWorkspacePickerTokenRef, extensionRequest, fetchSessionView,
    loadingEarlierRequestsRef, localDraftRef, modelSelectionPatch, models,
    mutationBlocked, navigationEpochRef, paneAuthorityCanCommit, pendingSessionPrefsRef,
    runEpochGenerationRef, runEpochRef, runtimeStatus, saveSessionComposerSelections,
    send, setComposerSelectionRevision, setError, setNotice,
    setWorkspaceCwd, setWorkspacePicking, stageGateMode, stageSessionComposerSelection,
    state, subagentAddressesRef, viewedSessionId, viewedSessionIdRef,
    workspaceDefaultPickerTokenRef, workspaceEpochRef, workspacePicking, workspaceRevisionRef,
  });

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
    () => composerStateForSelection(state, composerSelection, models),
    [state, composerSelection, composerSelectionRevision, models],
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
  const {
    dequeuePendingSteers,
    cancelQueuedPrompt,
    resumeQueuedPrompt
  } = createQueueActions({
    acceptQueueProjection, advanceQueueProjectionRevision, api, appliedDraftRestorationSequencesRef,
    appliedQueueMutationSequenceRef, applyDequeuedSteers, applySidebarQueueProjection, cancelledQueueIdsRef,
    cancellingQueueIdsRef, captureViewOperation, commitPaneIfCurrent, composerDraftKeyId,
    composerDraftRevisionsRef, confirmedDeletedSessionIdsRef, draftRestorationIntentSequenceRef, filterCancelledQueue,
    latestQueueProjectionRef, localUserTurnsRef, patchSessionCacheForAuthority, pendingSteersRef,
    promptDraftFromMessage, queueMutationSequenceRef, queueProjectionRevisionRef, queueProjectionSourceRef,
    removeLocalTurnAndRebase, setError, setRestoredComposerDrafts, setSessions,
    setSteerDequeueingBySession, sourceTurnTotalsRef, steerDequeueExpectedDraftRevisionRef, viewCacheRef,
    viewOperationIsCurrent, viewOperationIsInCurrentRun,
  });

  const {
    diagnosticSidebarRows,
    diagnosticSidebarSignature,
    diagnosticHasLive,
    diagnosticControlledByThisWindow,
    diagnosticForeignOwnerPresent,
    diagnosticUiDetails,
    recordDiagnosticProjection,
    diagnosedUserTurnProjectionRef,
    composerControls,
    composerNotices,
    sessionDialogSource,
    sessionDialogCopyBlocked,
    reconcileSessionMutation,
    applySessionListSnapshot,
    clearDeletedSessionProjection,
    finalizeDeletedSession: finalizeDeletedSessionAction,
    selectDeletionFallback: selectDeletionFallbackAction,
    reconcilePendingSessionMutations,
    refreshManually,
    restartPi,
    shutdownPiChat,
    exportStateDiagnostics,
    copySessionToNew,
    confirmCloneSession,
    confirmForkSession,
    renameSession,
    deleteSession,
  } = useAppPresentationState({
    ApiRequestError, api, ComposerControls, PiMarkIcon,
    activeSessionProjectionWriter, anySessionPendingConfirmation, anySessionQueued, anySessionRunning,
    appliedDraftRestorationSequencesRef, appliedQueueMutationSequenceRef, applyBootstrapMetadata, browserStateDiagnosticSnapshot,
    buildIdentityMismatch, busy, busySessionCountsRef, cancelPendingNavigation,
    cancelledQueueIdsRef, cancellingQueueIdsRef, changeGate, changeModel,
    changeThinking, clearPendingLiveMessage, closeComplete, commitPane,
    commitSidebarSessions, composerDraftKeyId, composerDraftRevisionsRef, composerModels,
    composerQueueMode, composerState, confirmedDeletedSessionIdsRef, confirmedQueueDispatchIdsRef,
    copyingSessionIds, createSession, createSessionManagementActions, currentSessionBusyBeforeStreaming,
    currentSessionRuntimePreparing, desiredSessionIdRef, diagnoseVisibleUserTurnDuplicates, diagnosticCheckpointRef,
    diagnosticSidebarRowsRef, diagnosticSseRejectionAtRef, diagnosticUiSignatureRef, diagnosticsBusy,
    downloadStateDiagnosticBundle, draftRestorationIntentSequenceRef, effectiveControl, error,
    forgetComposerKey, forgetLocalFailuresForSession, gateAvailable, gateMode,
    gateModesRef, lastSessionEventTypeRef, latestQueueProjectionRef, lifecycleBlocked,
    liveMessage, loading, localUserTurnsRef, messages,
    modelInventoryConfirmed, mutationBlocked, navigationEpochRef, notice,
    observing, optimisticDeletesRef, optimisticRenamesRef, optimisticSessionMutationTokenRef,
    optimisticSessionsTotal, pane, paneCommitRevisionRef, pendingGateModesRef,
    pendingScrollRestoreRef, pendingSessionPrefsRef, pendingSteersRef, primaryRuntime,
    primaryRuntimeMessage, primaryRuntimeUnavailable, promptBusyReleasesRef, promptStarting,
    queue, queueMutationSequenceRef, queuePaused, queueProjectionRevisionRef,
    queueProjectionSourceRef, recordBrowserStateDiagnostic, refresh, refreshOperationTokenRef,
    refreshSessionCache, refreshSidebarSessions, reportBackgroundRefreshError, resultPendingError,
    runEpochGenerationRef, runtimeStatus, saveSessionComposerSelections, scrollMemoryRef,
    sessionDialog, sessionEventVersionRef, sessionRunGenerationsRef, sessionRunningOverridesRef,
    sessions, sessionsRef, sessionsTotal, setBusy,
    setBusySessionIds, setCloseComplete, setComposerPendingByScope, setComposerSelectionRevision,
    setCopyingSessionIds, setDiagnosticsBusy, setError, setFailedSessionIds,
    setGateModes, setLocalFailures, setManagementSection, setNotice,
    setPendingGateModes, setPendingSteersBySession, setRefreshing, setRestoredComposerDrafts,
    setSessionDialog, setSessionDirectories, setSessionNavigation, setSessions,
    setSessionsTotal, setSteerDequeueingBySession, setStoppingSessionIds, setUnseenReplySessionIds,
    setWarmingSessionIds, settledRunGenerationsRef, sidebarCommittedFullSequenceRef, sidebarFullRequestSequenceRef,
    sourceTurnTotalsRef, state, stats, steerDequeueExpectedDraftRevisionRef,
    stoppingCurrentSession, stoppingOperationTokensRef, streamDiagnosticsRef, streamGapRecoveriesRef,
    streamingWireProjectionsRef, subagentAddressesRef, syncMutatingSessionIds, terminalAssistantSessionIdsRef,
    terminalAssistantStreamGenerationsRef, toolStatus, turnTotal, unreadSteeringDropMessagesRef,
    useEffect, useMemo, useRef, viewCacheWriter,
    viewSession, viewSwitching, viewedSession, viewedSessionId,
    viewedSessionIdRef, viewingSubagentSession, warmingSessionIdsRef,
  });

  sessionManagementActionsRef.current = {
    finalizeDeletedSession: finalizeDeletedSessionAction,
    selectDeletionFallback: selectDeletionFallbackAction,
  };

  if (closeComplete) {
    const applicationClosed = closeComplete === "application";
    return (
      <main className="shutdown-screen">
        <span className="shutdown-mark"><PiMarkIcon /></span>
        <h1>{applicationClosed ? "Pi Chat 已关闭" : "当前窗口已退出"}</h1>
        <p>{applicationClosed
          ? "本地服务和会话进程已经结束。现在可以关闭此窗口。"
          : "其他 Pi Chat 窗口仍在运行。现在可以关闭此窗口。"}</p>
        <button type="button" onClick={() => window.close()}>关闭窗口</button>
      </main>
    );
  }

  return <AppView {...{
    AppShell, AskQuestionnaireDialog, ChevronRightIcon, ConversationPane,
    DRAFT_FAILURE_SCOPE, api, EditDiffSidebar, ExtensionDialog,
    ManagementPanel, SessionDialog, SessionInventory, appearance,
    askQuestionnaires, buildIdentityLabel, buildIdentityMismatch, busy,
    cancelQueuedPrompt, changeModel, clearConversationNavigationTarget, composerCommands,
    composerControls, composerDraftKey, composerDraftKeyId, composerDraftRevisionsRef,
    composerHasContent, composerNotices, composerQueueMode, composerState,
    composerSubmissionPaused, composerSubmissionScope, composerTargetSessionId, confirmCloneSession,
    confirmForkSession, conversationWorkspace, copyingSessionIds, createSession,
    currentSessionBusyBeforeStreaming, deleteSession, dequeuePendingSteers, diagnosticsBusy,
    diffSidebarOpen, diffSidebarWidth, dispatchAskQuestionnaire, dispatchPane,
    displayedConversationName, displayedQueue, draftWorkspaceCwd, draftWorkspaceOptions,
    exportStateDiagnostics, extensionRequest, failedSessionIds, forgottenComposerKeys,
    forkMessagePreview, forkableUserMessageText, globalMutationBlocked, initialPaneUnresolved,
    inspectorSessionId, lastRunDurationMs, lifecycleBlocked, liveMessage,
    loadAllSessions, loadDirectorySessions, loadEarlierTurns, loading,
    loadingAllSessions, loadingDirectoryKeys, loadingEarlier, localDraft,
    localDraftRef, localFailures, managementSection, messageTotal,
    messages, messagesTruncated, modelCatalogueRevisionGate, modelRuntimeSyncPending,
    models, mutatingSessionIds, mutationBlocked, navigateConversation,
    navigateSubagentAncestor, newConversationPresentation, normalizeCwdKey, observing,
    onScroll, openSubagentSession, pane, paneLoading,
    pendingSteersBySession, pendingUserMessage, piVersion, pickDefaultWorkspace,
    pickDraftWorkspace, pinnedInventoryAttemptRef, primaryCapabilityPending, primaryRuntime,
    queuePaused, recoveryActionBlocked, refreshManually, refreshing,
    renameSession, respondToExtension, restartPi, restoredComposerDrafts,
    resumeQueuedPrompt, runStartedAt, saveModelCatalog, scrollRef,
    selectDraftWorkspace, send, serverBuildIdentity, sessionActionBusy,
    sessionDialog, sessionDialogCopyBlocked, sessionDirectories, sessionNavigation,
    sessions, sessionsTotal, setAppearance, setComposerContentByScope,
    setDiffSidebarOpen, setDiffSidebarWidth, setError, setManagementSection,
    setModelRuntimeSyncPending, setModels, setSessionDialog, setSessionNavigation,
    setSidebarOpen, setSidebarWidth, shutdownPiChat, sidebarInventoryReady,
    sidebarOpen, sidebarViewBlocked, sidebarWidth, state,
    steerDequeueingBySession, stopGeneration, stoppingCurrentSession, subagentBreadcrumb,
    togglePinnedDirectory, togglePinnedSession, toolStatus, topBarSessionId,
    turnTotal, unseenReplySessionIds, updateComposerPending, viewSession,
    viewSwitching, viewedSession, viewedSessionId, viewedSessionIdRef,
    viewingSubagentSession, visibleTurnCount, waitingForPiMessage, webBuildIdentity,
    withoutPersistedFailure, workspaceActivityRevision, workspaceCwd, workspaceEpochRef,
    workspacePicking, workspaceRevisionRef,
  }} />;

}
