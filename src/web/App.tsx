import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { appendTerminalMessage } from "../shared/streaming-assistant";
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
import { ComposerControls } from "./components/ComposerControls";
import { EditDiffSidebar } from "./components/EditToolDiff";
import {
  describeGateRequest,
  ExtensionDialog,
} from "./components/ExtensionDialog";
import { ChevronRightIcon, PiMarkIcon } from "./components/Icons";
import {
  ManagementPanel,
  type ManagementSection,
} from "./components/ManagementPanel";
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
  type AskQuestionnairePlan,
} from "./lib/ask-questionnaire";
import { recentSessionWorkspaces } from "./lib/session-workspaces";
import { adjacentUserMessageOffset } from "./lib/conversation-navigation";
import { extensionExecutionNotice } from "./lib/extension-notice";
import {
  gateModeFromCommand,
  gateModeFromNotice,
  type GateMode,
} from "./lib/gate-mode";
import {
  assistantMessage,
  canonicalMessageEndFromEvent,
  lifecycleFromEvent,
  parseEventData,
  userMessage,
} from "./lib/pi-events";
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
  BrowserStreamDiagnosticsAggregator,
  type LiveMessageSchedulerOutcome,
} from "./lib/stream-observability";
import {
  appendLocalTurnOnce,
  bindQueuedAdmission,
  bindQueuedDispatch,
  consumeLocalSteeringTurn,
  localTurnBelongsInTranscript,
  markLocalTurnQueued,
  nextLocalTurnTotal,
  protectTranscriptWithLocalTurns,
  removeLocalTurnAndRebase,
  removePendingSteeringTurns,
  type LocalUserTurn,
} from "./lib/local-user-turn";
import {
  refreshFailureKeepsCommittedView,
  sidebarNavigationBlocked,
} from "./lib/refresh-navigation-guards";
import { SessionScrollMemory } from "./lib/session-scroll-memory";
import { SessionViewCache } from "./lib/session-view-cache";
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

/** SSE events whose state can make an in-flight SessionViewData snapshot stale. */
const GLOBAL_SSE_EVENT_TYPES = new Set([
  "pi_chat_heartbeat",
  "pi_chat_sse_resync",
  "pi_chat_oversized_event",
  "pi_chat_application_closing",
  "pi_chat_application_lifecycle",
  "pi_chat_active_session_changed",
  "pi_chat_sessions_changed",
  "pi_chat_primary_runtime_status",
  "pi_chat_workspace_changed",
]);

const SESSION_VIEW_INVALIDATING_EVENT_TYPES = new Set([
  "agent_start",
  "agent_settled",
  "compaction_start",
  "compaction_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "pi_chat_process_error",
  "pi_chat_queue_update",
  "pi_chat_queue_dispatch",
  "pi_chat_queue_error",
  "extension_ui_request",
  "pi_chat_extension_request_resolved",
  "pi_chat_fast_mode_changed",
  "pi_chat_gate_mode_changed",
  "pi_chat_session_control_changed",
  "pi_chat_session_status",
]);

function invalidatesSessionViewVersion(type: string): boolean {
  return SESSION_VIEW_INVALIDATING_EVENT_TYPES.has(type);
}

function isSessionScopedEvent(type: string): boolean {
  return !GLOBAL_SSE_EVENT_TYPES.has(type);
}

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

function recoverableRefreshError(message: string): boolean {
  return /请求超时|RPC 请求超时|RPC 查询仍在处理中/.test(message);
}

/** Ignore older generations and same-generation startup snapshots that arrive after a terminal SSE state. */
function newerPrimaryReadiness(
  current: PrimaryRuntimeReadiness,
  incoming: PrimaryRuntimeReadiness,
): PrimaryRuntimeReadiness {
  if (incoming.generation > current.generation) return incoming;
  if (incoming.generation < current.generation) return current;
  if (incoming.status === "starting" && current.status !== "starting")
    return current;
  // SSE/legacy snapshots may omit adopted model/session fields. Equal-generation
  // frames refine one readiness record; they must never erase capability proof
  // that came from the controller's atomic adoption.
  return { ...current, ...incoming };
}

/** A capability snapshot is usable only for this exact selected-model shape. */
function modelCapabilityKey(model: ModelInfo | null | undefined): string {
  if (!model) return "";
  return [model.provider, model.id, ...(model.input || [])].join("\u0000");
}

export function App() {
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
  /** Commands are part of the committed projection, not a render-closure fallback. */
  const committedPaneCommandsRef = useRef<SlashCommand[]>(pane.commands);
  const paneCommitRevisionRef = useRef(0);
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
  const { messageTotal, turnTotal, visibleTurnCount, messagesTruncated } = pane;
  /** Pagination request authority stays in the coordinator map, not the pane reducer. */
  const [, setLoadingEarlierRevision] = useState(0);
  const { stats } = pane;
  const { liveMessage } = pane;
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
  const [models, setModels] = useState<ModelInfo[]>([]);
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
  /** A prompt raced a foreign controller after its last SSE projection. */
  const [deferredComposerScopes, setDeferredComposerScopes] = useState<Record<string, {
    targetSessionId: string;
    controlVersion: number;
  }>>({});
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
  /** Model / thinking only — must not freeze composer, sidebar, or the whole shell. */
  const [settingsBusy, setSettingsBusy] = useState(false);
  const settingsOperationTokenRef = useRef<symbol | null>(null);
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
  const {
    toolStatus,
    extensionRequest,
    runtimeStatus,
    control: viewControl,
  } = pane;
  const [askQuestionnaires, setAskQuestionnaires] = useState<
    Record<string, AskQuestionnairePlan>
  >({});
  const localDraft = pane.identity.kind === "draft";
  const [eventSourceGeneration, setEventSourceGeneration] = useState(0);
  const [applicationLifecycle, setApplicationLifecycle] =
    useState<ApplicationLifecycle>("idle");
  /** A stale Web bundle may read, but must not mutate a different Server build. */
  const [buildIdentityMismatch, setBuildIdentityMismatch] = useState(false);
  const [serverBuildIdentity, setServerBuildIdentity] =
    useState(webBuildIdentity);
  /** Global Primary capability; separate from the Session/JSONL first-paint state. */
  const [primaryRuntime, setPrimaryRuntime] = useState<PrimaryRuntimeReadiness>(
    { status: "starting", generation: 0 },
  );
  /** The latest Bootstrap snapshot that has confirmed a particular model's input capability. */
  const [primaryCapabilitySnapshot, setPrimaryCapabilitySnapshot] = useState<{
    generation: number;
    modelKeys: string[];
  } | null>(null);
  // EventSource callbacks retain their transport identity across UI commits.
  // Read current capability facts from refs instead of re-subscribing on each render.
  const primaryRuntimeRef = useRef(primaryRuntime);
  primaryRuntimeRef.current = primaryRuntime;
  const primaryCapabilitySnapshotRef = useRef(primaryCapabilitySnapshot);
  primaryCapabilitySnapshotRef.current = primaryCapabilitySnapshot;
  /** Session IDs whose Pi Runtime is being prepared outside the reading path. */
  const [warmingSessionIds, setWarmingSessionIds] = useState<string[]>([]);
  /** Browser-local notice: a background Session completed an assistant reply not yet opened here. */
  const [unseenReplySessionIds, setUnseenReplySessionIds] = useState<string[]>(
    [],
  );
  const [mutatingSessionIds, setMutatingSessionIds] = useState<string[]>([]);
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
    const filteredQueue = filterCancelledQueue(
      view.session.id,
      view.queue || [],
    );
    if (!latestQueueProjectionRef.current.has(view.session.id)) {
      latestQueueProjectionRef.current.set(view.session.id, {
        queue: filteredQueue,
        paused: view.queuePaused === true,
      });
      advanceQueueProjectionRevision(view.session.id);
    }
    return viewCacheRef.current.remember({ ...view, queue: filteredQueue });
  };
  const refreshSessionCache = (id: string, patch: Partial<SessionViewData>) =>
    confirmedDeletedSessionIdsRef.current.has(id)
      ? undefined
      : viewCacheRef.current.refresh(id, patch);
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
  const conversationNavigationTargetRef = useRef<number | null>(null);
  /** Abort leases are per Runtime Session; A stopping must not block B. */
  const stoppingOperationTokensRef = useRef(new Map<string, symbol>());
  const lastEventFrameAtRef = useRef(Date.now());
  const sessionEventVersionRef = useRef(new Map<string, number>());
  const lastSessionEventTypeRef = useRef(new Map<string, string>());
  const promptReconcileTimerRef = useRef<number | null>(null);
  const sseReconnectTimerRef = useRef<number | null>(null);
  const sseFloodCountRef = useRef(0);
  const clearViewedPromiseRef = useRef<Promise<unknown> | null>(null);
  const applicationLifecycleRef = useRef<ApplicationLifecycle>("idle");
  const handoffWaitRef = useRef<Promise<void> | null>(null);
  const sessionRefreshTimerRef = useRef<number | null>(null);
  const sessionRefreshInFlightRef = useRef(false);
  const sessionRefreshGenerationRef = useRef<number | null>(null);
  const sessionRefreshRequestedRef = useRef(false);
  const loadAllSessionsGenerationRef = useRef<number | null>(null);
  const directoryLoadGenerationsRef = useRef(new Map<string, number>());
  const desiredSessionIdRef = useRef("");
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
  const navigationEpochRef = useRef(0);
  const navigationAbortRef = useRef<AbortController | null>(null);
  const navigationStartedAtRef = useRef(new Map<number, number>());
  /** Accepted local user turns remain visible until a JSONL-derived view includes them. */
  const localUserTurnsRef = useRef(new Map<string, LocalUserTurn[]>());
  const queueCancellationSequenceRef = useRef(0);
  const appliedCancelledDraftSequenceRef = useRef(0);
  const queueMutationSequenceRef = useRef(new Map<string, number>());
  const appliedQueueMutationSequenceRef = useRef(new Map<string, number>());
  const cancelledQueueIdsRef = useRef(new Map<string, Set<string>>());
  const queueProjectionRevisionRef = useRef(new Map<string, number>());
  /** Latest queue projection per Session, independent of pane/cache residency. */
  const latestQueueProjectionRef = useRef(
    new Map<string, { queue: QueuedPrompt[]; paused: boolean }>(),
  );
  const composerDraftRevisionRef = useRef(0);
  const [cancelledDraft, setCancelledDraft] = useState<{
    revision: number;
    expectedDraftRevision: number;
    message: string;
    images: PromptImage[];
  } | null>(null);
  /** A terminal compaction frame outranks a later stale hot-memory view until a new compaction begins. */
  const completedCompactionSessionIdsRef = useRef(new Set<string>());
  /** Background accepted Steers that were dropped remain explainable when their Session is opened. */
  const unreadSteeringDropMessagesRef = useRef(new Map<string, string>());
  /** Last authoritative turn count from sidebar/view data, safe inside long-lived SSE callbacks. */
  const sourceTurnTotalsRef = useRef(new Map<string, number>());
  /** Model/thinking chosen on a cold session or local draft before Runtime starts. */
  const pendingSessionPrefsRef = useRef(
    new Map<
      string,
      { model?: ModelInfo | null; thinkingLevel?: ThinkingLevel }
    >(),
  );
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
  /** SSE lifecycle is newer than a delayed sidebar/bootstrap summary. */
  const sessionRunningOverridesRef = useRef(new Map<string, boolean>());
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
  ): { queue: QueuedPrompt[]; paused: boolean } => {
    const projection = {
      queue: filterCancelledQueue(sessionId, incoming),
      paused,
    };
    latestQueueProjectionRef.current.set(sessionId, projection);
    advanceQueueProjectionRevision(sessionId);
    return projection;
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
  const syncMutatingSessionIds = () =>
    setMutatingSessionIds([
      ...new Set([
        ...optimisticRenamesRef.current.keys(),
        ...optimisticDeletesRef.current.keys(),
      ]),
    ]);
  const recordSourceTurnTotal = (sessionId: string, total: number): void => {
    if (!Number.isFinite(total)) return;
    sourceTurnTotalsRef.current.set(
      sessionId,
      Math.max(sourceTurnTotalsRef.current.get(sessionId) || 0, total),
    );
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
    // Automatic reconciliation is best-effort. History is already readable from
    // JSONL, so a busy/still-pending RPC query must not become a fatal red banner.
    if (recoverableRefreshError(message)) return;
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
    navigationAbortRef.current?.abort();
    navigationAbortRef.current = null;
    navigationStartedAtRef.current.clear();
    if (invalidate) {
      // Abort is advisory: a response that already resolved may still run its
      // continuation. Move the generation and intent first so it cannot paint.
      navigationEpochRef.current += 1;
      desiredSessionIdRef.current = viewedSessionIdRef.current;
    }
    setPaneLoading(null);
    setViewSwitching(false);
  }, []);

  const recordPaneCommit = useCallback((view: SessionViewData) => {
    const startedAt = navigationStartedAtRef.current.get(
      navigationEpochRef.current,
    );
    if (startedAt === undefined) return;
    navigationStartedAtRef.current.delete(navigationEpochRef.current);
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
      commitSidebarSessions(data.sessions, { kind: "base" });
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
      primaryCapabilitySnapshotRef.current = snapshot;
      setPrimaryCapabilitySnapshot(snapshot);
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
      // choices through that transient snapshot; ComposerControls also renders a
      // readable current-model fallback until the inventory catches up.
      if (data.models.length || !data.state.model) setModels(data.models);
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
      setBuildIdentityMismatch(!buildIdentityMatches(identity));
      const readiness = data.primaryRuntime || {
        status: "starting" as const,
        generation: 0,
      };
      const acceptedReadiness = newerPrimaryReadiness(
        primaryRuntimeRef.current,
        readiness,
      );
      primaryRuntimeRef.current = acceptedReadiness;
      setPrimaryRuntime(acceptedReadiness);
      applicationLifecycleRef.current = data.applicationLifecycle || "idle";
      setApplicationLifecycle(data.applicationLifecycle || "idle");
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
          })
        : null;
      reconcileQueuedAdmissions(activeViewId, sourceView?.queue || bootstrapQueue);
      const protectedTranscript = protectTranscriptWithLocalTurns(
        localUserTurnsRef.current.get(activeViewId),
        sourceView?.messages || data.messages,
        sourceView?.messageTotal ?? data.messageTotal,
        sourceView?.turnTotal ?? data.turnTotal,
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
        // explicit before the first prompt. This remains browser-local until send.
        pendingSessionPrefsRef.current.set(DRAFT_PREFS_KEY, {
          model: data.state.model,
          thinkingLevel: data.state.thinkingLevel as ThinkingLevel | undefined,
        });
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
          piState: {
            ...data.state,
            ...(staged?.model !== undefined ? { model: staged.model } : null),
            ...(staged?.thinkingLevel !== undefined
              ? { thinkingLevel: staged.thinkingLevel }
              : null),
          },
          messages: protectedTranscript.messages,
          messageTotal: protectedTranscript.messageTotal,
          turnTotal: protectedTranscript.turnTotal,
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
      // A compaction_end frame is terminal for this Session. Hot-memory views
      // deliberately avoid a busy RPC probe and may therefore still contain the
      // pre-end `isCompacting: true` snapshot; never let that stale view relock
      // a composer after Pi has resumed the actual turn.
      const normalizedView =
        completedCompactionSessionIdsRef.current.has(view.session.id) &&
        view.state.isCompacting
          ? {
              ...view,
              state: { ...view.state, isCompacting: false },
            }
          : view;
      // Cache the source view before adding local UI overlays. A cached overlay has
      // a synthetic turnTotal and must never confirm that its own user message was
      // persisted when the user switches away and returns.
      const filteredProjection =
        queueRequestRevision === undefined
          ? acceptQueueProjection(
              normalizedView.session.id,
              normalizedView.queue || [],
              normalizedView.queuePaused === true,
            )
          : acceptQueueProjectionIfCurrent(
              normalizedView.session.id,
              queueRequestRevision,
              normalizedView.queue || [],
              normalizedView.queuePaused === true,
            );
      const filteredQueue = filteredProjection.queue;
      const queueFilteredView = {
        ...normalizedView,
        session: applySidebarQueueProjection(
          normalizedView.session,
          filteredQueue,
        ),
        queue: filteredQueue,
      };
      const sourceView = viewCacheRef.current.remember(queueFilteredView);
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
      const protectedTranscript = protectTranscriptWithLocalTurns(
        localUserTurnsRef.current.get(sourceView.session.id),
        sourceView.messages,
        sourceView.messageTotal,
        sourceView.turnTotal,
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
      // A cold preference remains authoritative through Runtime activation. Do not
      // discard it merely because the activation view reports the history's last
      // persisted settings; send() clears it only after both desired settings are
      // successfully applied to this Runtime.
      const staged = pendingSessionPrefsRef.current.get(
        resolvedView.session.id,
      );
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
            ...(staged?.model !== undefined ? { model: staged.model } : null),
            ...(staged?.thinkingLevel !== undefined
              ? { thinkingLevel: staged.thinkingLevel }
              : null),
          },
          messages: resolvedView.messages,
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
          queuePaused: filteredProjection.paused,
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
          queuePaused: filteredProjection.paused,
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
    loadBootstrap,
    paneAuthorityCanCommit,
    refreshAuthorityIsCurrent,
  ]);

  const startIdleRecovery = useCallback(
    (serverEpochChanged = false, refreshOnOrdinaryIdle = false) => {
      // Idle is authoritative lifecycle state even when the following bootstrap
      // is slow or rejected. Do not leave navigation and mutations locked on
      // stale maintenance state while JSONL fallback remains available.
      applicationLifecycleRef.current = "idle";
      setApplicationLifecycle("idle");
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
        void refreshSidebarSessions().catch((cause) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
      }
    }
  }, []);

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
      void refreshSidebarSessions().catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
    }, 180);
  }, [refreshSidebarSessions]);

  useEffect(() => {
    refresh()
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setLoading(false));
    return () => {
      if (sessionRefreshTimerRef.current !== null)
        window.clearTimeout(sessionRefreshTimerRef.current);
      for (const request of loadingEarlierRequestsRef.current.values())
        request.controller.abort();
      cancelPendingNavigation();
    };
  }, [cancelPendingNavigation, refresh]);

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
    void refreshSidebarSessions().catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [
    refreshSidebarSessions,
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
        settingsOperationTokenRef.current = null;
        setSettingsBusy(false);
        refreshOperationTokenRef.current = null;
        setRefreshing(false);
        clearStoppingForSession();
        completedCompactionSessionIdsRef.current.clear();
        sessionRunningOverridesRef.current.clear();
        setFailedSessionIds([]);
        setConfirmedCommands([]);
        setAskQuestionnaires({});
        cancelledQueueIdsRef.current.clear();
        queueProjectionRevisionRef.current.clear();
        latestQueueProjectionRef.current.clear();
        queueMutationSequenceRef.current.clear();
        appliedQueueMutationSequenceRef.current.clear();
        viewCacheRef.current.clear();
        optimisticRenamesRef.current.clear();
        optimisticDeletesRef.current.clear();
        syncMutatingSessionIds();
        busySessionCountsRef.current.clear();
        setBusySessionIds([]);
        sidebarInventoryReadyRef.current = false;
        setSidebarInventoryReady(false);
        setSessions([]);
        setSessionsTotal(0);
        setSessionDirectories([]);
        // Primary readiness generations are local to one server process. Clear
        // A's high generation before B reports its own lower-generation state.
        const replacementReadiness = { status: "starting" as const, generation: 0 };
        primaryRuntimeRef.current = replacementReadiness;
        primaryCapabilitySnapshotRef.current = null;
        setPrimaryRuntime(replacementReadiness);
        setPrimaryCapabilitySnapshot(null);
        workspaceEpochRef.current =
          typeof ready.workspaceEpoch === "string"
            ? ready.workspaceEpoch
            : readyRunEpoch;
        workspaceRevisionRef.current = 0;
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
        const next = newerPrimaryReadiness(primaryRuntimeRef.current, incoming);
        primaryRuntimeRef.current = next;
        setPrimaryRuntime(next);
        const acceptedReady =
          next.status === "ready" &&
          next.generation === incoming.generation &&
          incoming.status === "ready";
        if (acceptedReady && next.model) {
          const target = localDraftRef.current
            ? { kind: "draft" as const }
            : next.sessionId
              ? { kind: "session" as const, sessionId: next.sessionId }
              : { kind: "draft" as const };
          const preferenceKey = localDraftRef.current
            ? DRAFT_PREFS_KEY
            : next.sessionId || "";
          const staged = preferenceKey
            ? pendingSessionPrefsRef.current.get(preferenceKey)
            : undefined;
          const selectedModel =
            staged?.model !== undefined ? staged.model : next.model;
          const snapshot = {
            generation: next.generation,
            modelKeys: [modelCapabilityKey(next.model)].filter(Boolean),
          };
          primaryCapabilitySnapshotRef.current = snapshot;
          setPrimaryCapabilitySnapshot(snapshot);
          dispatchPane({
            type: "PREFERENCES_STAGED",
            target,
            model: selectedModel,
            thinkingLevel:
              staged?.thinkingLevel !== undefined
                ? staged.thinkingLevel
                : next.thinkingLevel,
          });
        }
      }
      if (lifecycleFromEvent(ready) === "restarting") {
        applicationLifecycleRef.current = "restarting";
        setApplicationLifecycle("restarting");
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
        applicationLifecycleRef.current = readyLifecycle;
        setApplicationLifecycle(readyLifecycle);
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
      startIdleRecovery,
    ],
  );

  const handlePiEvent = useCallback(
    (rawEvent: Event, source: EventSource) => {
      lastEventFrameAtRef.current = Date.now();
      const event = parseEventData(rawEvent);
      if (!event) {
        recordSseRejectionDiagnostic({
          eventType: "unknown",
          decisionReason: "malformed-json",
        });
        return;
      }
      const type = String(event.type || "");
      sseFloodCountRef.current = 0;
      if (type === "pi_chat_heartbeat") return;
      if (type === "pi_chat_sse_resync" || type === "pi_chat_oversized_event") {
        void refresh().catch(reportBackgroundRefreshError);
        return;
      }
      const rawEventSessionId =
        typeof event.piChatSessionId === "string"
          ? event.piChatSessionId
          : type === "pi_chat_session_control_changed" &&
              typeof event.sessionId === "string"
            ? event.sessionId
            : "";
      const rawEventRunGeneration =
        typeof event.piChatRunGeneration === "number" &&
        Number.isSafeInteger(event.piChatRunGeneration) &&
        event.piChatRunGeneration >= 0
          ? event.piChatRunGeneration
          : undefined;
      const terminalEvent = type === "message_end"
        ? canonicalMessageEndFromEvent(event)
        : null;
      if (type === "message_end" && !terminalEvent) {
        recordSseRejectionDiagnostic({
          sessionId: rawEventSessionId,
          runGeneration: rawEventRunGeneration,
          eventType: type,
          decisionReason: "malformed-critical-event",
        });
        return;
      }
      const eventSessionId = terminalEvent?.piChatSessionId || rawEventSessionId;
      const eventRunEpoch = terminalEvent?.piChatRunEpoch ||
        (typeof event.piChatRunEpoch === "string" ? event.piChatRunEpoch : "");
      if (
        eventRunEpoch &&
        runEpochRef.current &&
        eventRunEpoch !== runEpochRef.current
      ) {
        recordSseRejectionDiagnostic({
          sessionId: eventSessionId,
          eventType: type || "unknown",
          decisionReason: "stale-run-epoch",
        });
        return;
      }
      const eventRunGeneration = terminalEvent?.piChatRunGeneration ??
        (typeof event.piChatRunGeneration === "number" &&
        Number.isFinite(event.piChatRunGeneration)
          ? event.piChatRunGeneration
          : undefined);
      if (eventSessionId && typeof eventRunGeneration === "number") {
        const latest =
          sessionRunGenerationsRef.current.get(eventSessionId) || 0;
        const settled =
          settledRunGenerationsRef.current.get(eventSessionId) || 0;
        // A Pi turn is a monotonic lifecycle. Once a generation settles, every
        // non-terminal frame from it is stale, even if SSE/backpressure makes
        // it arrive after settlement. This prevents a late tool completion or
        // activity snapshot from reviving an already-cleared spinner.
        if (eventRunGeneration < latest) {
          recordSseRejectionDiagnostic({
            sessionId: eventSessionId,
            runGeneration: eventRunGeneration,
            eventType: type || "unknown",
            decisionReason: "stale-run-generation",
          });
          return;
        }
        if (eventRunGeneration <= settled && type !== "agent_settled") {
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
          Math.max(latest, eventRunGeneration),
        );
        if (type === "agent_settled")
          settledRunGenerationsRef.current.set(
            eventSessionId,
            Math.max(settled, eventRunGeneration),
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
      recordBrowserStateDiagnostic("sse", "admitted", {
        sessionId: eventSessionId,
        runGeneration: eventRunGeneration,
        details: {
          eventType: type || "unknown",
          viewing: viewingEventSession,
          navigationEpoch: navigationEpochRef.current,
        },
      });
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
        }
        if (viewingEventSession) {
          setRuntimeWarming(eventSessionId, false);
          dispatchPane({
            type: "AGENT_STARTED",
            sessionId: eventSessionId,
            toolStatus: WAITING_FOR_PI_STATUS,
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
      } else if (type === "message_start" || type === "message_update") {
        const rawMessage =
          event.message && typeof event.message === "object"
            ? (event.message as PiMessage)
            : null;
        if (type === "message_start" && rawMessage?.role === "user" && eventSessionId) {
          const localTurns = localUserTurnsRef.current.get(eventSessionId) || [];
          // Only a server-verified native steer consumption may reveal a hidden
          // local Steer turn. Pi dequeues the steering message before forwarding
          // this message_start, so an ordinary prompt sharing the same text can
          // never be mistaken for a consumed Steer.
          const consumed =
            (event as { nativeSteeringConsumed?: boolean })
              .nativeSteeringConsumed === true
              ? consumeLocalSteeringTurn(localTurns, rawMessage)
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
        const assistant = assistantMessage(event);
        if (assistant && eventSessionId) {
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
        if (assistant && viewingEventSession)
          scheduleLiveMessage({
            message: assistant,
            authority: capturePaneAuthority(eventSessionId),
            runGeneration: eventRunGeneration ?? -1,
          });
      } else if (type === "message_end" && terminalEvent) {
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
        if (eventSessionId && toolName === "ask_user_question") {
          const questionnaire = parseAskQuestionnaire(event.toolCallId, event.args);
          if (questionnaire)
            setAskQuestionnaires((current) => ({
              ...current,
              [eventSessionId]: questionnaire,
            }));
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
          });
      } else if (type === "tool_execution_end") {
        if (eventSessionId && String(event.toolName || "") === "ask_user_question")
          setAskQuestionnaires((current) => {
            const active = current[eventSessionId];
            if (!active || active.toolCallId !== String(event.toolCallId || "")) return current;
            const next = { ...current };
            delete next[eventSessionId];
            return next;
          });
        const status = `${String(event.toolName || "工具")} ${event.isError ? "执行失败" : "已完成，Pi 正在继续…"}`;
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
          completedCompactionSessionIdsRef.current.add(eventSessionId);
          patchSessionCache(eventSessionId, {
            isStreaming: true,
            toolStatus: status,
            state: { isStreaming: true, isCompacting: false },
          });
        }
        if (viewingEventSession)
          dispatchPane(
            sessionStillRunning
              ? {
                  type: "AGENT_STARTED",
                  sessionId: eventSessionId,
                  toolStatus: status,
                }
              : {
                  type: "COMPACTION_FINISHED",
                  sessionId: eventSessionId,
                },
          );
      } else if (type === "pi_chat_native_steering_cleared") {
        if (eventSessionId) {
          const pending = localUserTurnsRef.current.get(eventSessionId) || [];
          const remaining = removePendingSteeringTurns(pending);
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
        if (eventSessionId)
          setAskQuestionnaires((current) => {
            if (!current[eventSessionId]) return current;
            const next = { ...current };
            delete next[eventSessionId];
            return next;
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
        if (completedAssistantReply && !viewingEventSession) {
          setUnseenReplySessionIds((current) =>
            current.includes(eventSessionId)
              ? current
              : [...current, eventSessionId],
          );
        }
        if (eventSessionId) {
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
            state: { isStreaming: false, isCompacting: false },
          });
        }
        if (eventSessionId && typeof eventRunGeneration === "number")
          streamDiagnosticsRef.current?.terminal({
            sessionId: eventSessionId,
            runGeneration: eventRunGeneration,
          });
        if (viewingEventSession) {
          if (promptReconcileTimerRef.current !== null)
            window.clearTimeout(promptReconcileTimerRef.current);
          promptReconcileTimerRef.current = null;
          dispatchPane({ type: "AGENT_SETTLED", sessionId: eventSessionId });
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
          const next = newerPrimaryReadiness(current, incoming);
          const acceptedTransition =
            next.generation !== current.generation ||
            next.status !== current.status ||
            next.error !== current.error;
          if (acceptedTransition) {
            primaryRuntimeRef.current = next;
            // A new startup or failure invalidates the preceding generation's
            // ModelInfo.input assertion before a later ready can paint.
            if (next.status !== "ready") {
              primaryCapabilitySnapshotRef.current = null;
              setPrimaryCapabilitySnapshot(null);
            }
            setPrimaryRuntime(next);
            // Ready is now an adopted state/capability snapshot, not a request
            // to issue another bootstrap/get_state. Update only the exact
            // visible Primary pane or local draft; cold/Secondary panes keep
            // their independent Session state.
            if (next.status === "ready" && next.model) {
              const target = localDraftRef.current
                ? { kind: "draft" as const }
                : next.sessionId
                  ? { kind: "session" as const, sessionId: next.sessionId }
                  : { kind: "draft" as const };
              const preferenceKey = localDraftRef.current
                ? DRAFT_PREFS_KEY
                : next.sessionId || "";
              const staged = preferenceKey
                ? pendingSessionPrefsRef.current.get(preferenceKey)
                : undefined;
              dispatchPane({
                type: "PREFERENCES_STAGED",
                target,
                model: staged?.model !== undefined ? staged.model : next.model,
                thinkingLevel:
                  staged?.thinkingLevel !== undefined
                    ? staged.thinkingLevel
                    : next.thinkingLevel,
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
      } else if (type === "pi_chat_application_lifecycle") {
        const lifecycle = String(
          event.lifecycle || "idle",
        ) as ApplicationLifecycle;
        if (lifecycle !== "idle") cancelPendingNavigation();
        applicationLifecycleRef.current = lifecycle;
        setApplicationLifecycle(lifecycle);
        if (lifecycle === "restarting")
          setNotice("Pi Chat 正在构建并重启，暂时停止接收新操作…");
        else if (lifecycle === "workspace-changing")
          setNotice("正在切换工作目录…");
        else if (lifecycle === "resources-reloading")
          setNotice("正在更新配置并重载 Runtime…");
        else if (lifecycle === "idle") {
          startIdleRecovery(false, true);
        }
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
        const currentProjection = acceptQueueProjection(
          eventSessionId,
          Array.isArray(event.queue)
            ? (event.queue as unknown as QueuedPrompt[])
            : [],
          event.paused === true,
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
            queuePaused: event.paused === true,
          });
        if (viewingEventSession)
          dispatchPane({
            type: "QUEUE_UPDATED",
            sessionId: eventSessionId,
            queue: currentQueue,
            paused: event.paused === true,
            messages:
              removeAdmittedTurn && turn
                ? (current) =>
                    current.filter((candidate) => candidate !== turn.message)
                : undefined,
            pendingUserMessage: turn
              ? (current) => (current === turn.message ? null : current)
              : undefined,
          });
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
                ? applySidebarQueueProjection(session, dispatchProjection.queue)
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
        // Dispatch can beat the enqueue HTTP response. Bind its queue ID to the
        // already-protected local turn before considering an observer fallback.
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
          const streaming =
            next.execution === "running" || next.execution === "dispatching";
          const terminalActivity =
            next.execution === "idle" ||
            next.execution === "queued" ||
            next.execution === "failed";
          if (terminalActivity && typeof eventRunGeneration === "number")
            settledRunGenerationsRef.current.set(
              eventSessionId,
              Math.max(
                settledRunGenerationsRef.current.get(eventSessionId) || 0,
                eventRunGeneration,
              ),
            );
          // `paused` means the follow-up queue is paused; the current Pi turn
          // may still be running while abort settles. It is not terminal proof.
          if (terminalActivity) clearStoppingForSession(eventSessionId);
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
          if (!running) clearStoppingForSession(eventSessionId);
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
          if (viewingEventSession && !running) {
            clearPendingLiveMessage();
            dispatchPane({
              type: "AGENT_SETTLED",
              sessionId: eventSessionId,
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
        if (eventSessionId)
          setAskQuestionnaires((current) => {
            if (!current[eventSessionId]) return current;
            const next = { ...current };
            delete next[eventSessionId];
            return next;
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
          const error = errorText
            ? incidentId
              ? `${errorText}（事件 ID：${incidentId}）`
              : errorText
            : undefined;
          const activity: SessionActivityState = {
            execution: "failed",
            awaitingConfirmation: false,
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
          if (promptReconcileTimerRef.current !== null)
            window.clearTimeout(promptReconcileTimerRef.current);
          promptReconcileTimerRef.current = null;
          dispatchPane({ type: "PROCESS_FAILED", sessionId: eventSessionId });
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
        }
      }
    },
    [
      applySessionView,
      cancelPendingNavigation,
      drainPendingLiveMessage,
      refresh,
      reportBackgroundRefreshError,
      recordSseRejectionDiagnostic,
      scheduleLiveMessage,
      scheduleSidebarRefresh,
      setRuntimeWarming,
      startIdleRecovery,
      releasePromptBusy,
      tryAutoAllowGate,
      updateGateMode,
      clearStoppingForSession,
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
      setError("与 Pi Chat 服务的事件连接已断开，正在重新连接…");
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
          setSessions([]);
          setSessionsTotal(0);
          setSessionDirectories([]);
          optimisticRenamesRef.current.clear();
          optimisticDeletesRef.current.clear();
          syncMutatingSessionIds();
          // Drop every process-derived authority before bootstrapping that token.
          sessionRunningOverridesRef.current.clear();
          setFailedSessionIds([]);
          setConfirmedCommands([]);
          completedCompactionSessionIdsRef.current.clear();
          cancelledQueueIdsRef.current.clear();
          queueProjectionRevisionRef.current.clear();
          latestQueueProjectionRef.current.clear();
          queueMutationSequenceRef.current.clear();
          appliedQueueMutationSequenceRef.current.clear();
          viewCacheRef.current.clear();
          sessionRunGenerationsRef.current.clear();
          settledRunGenerationsRef.current.clear();
          const recoveredReadiness = {
            status: "starting" as const,
            generation: 0,
          };
          primaryRuntimeRef.current = recoveredReadiness;
          primaryCapabilitySnapshotRef.current = null;
          setPrimaryRuntime(recoveredReadiness);
          setPrimaryCapabilitySnapshot(null);
          bootstrapInFlightRef.current = null;
          handshakeInFlightRef.current = null;
          initialHistoryRef.current = null;
          settingsOperationTokenRef.current = null;
          setSettingsBusy(false);
          refreshOperationTokenRef.current = null;
          setRefreshing(false);
          clearStoppingForSession();
          draftWorkspacePickerTokenRef.current = null;
          workspaceDefaultPickerTokenRef.current = null;
          setWorkspacePicking(false);
          busySessionCountsRef.current.clear();
          setBusySessionIds([]);
          promptBusyReleasesRef.current.clear();
          warmingRuntimeStartsRef.current.clear();
          warmingSessionIdsRef.current.clear();
          setWarmingSessionIds([]);
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
    const renewPresence = () => {
      if (!isForeground()) return;
      void api.renewPresence().catch(() => undefined);
    };
    const relinquishPresence = () => {
      if (isForeground()) return;
      void api.relinquishPresence().catch(() => undefined);
    };
    // Native dialogs and ordinary task switching trigger blur. Keep the lease
    // until hidden/pagehide or its TTL instead of immediately dropping control.
    const pausePresenceRenewal = () => undefined;
    const resume = (event?: Event) => {
      if (!isForeground()) {
        // A genuine close/reload commonly becomes hidden between beforeunload
        // and unload. Preserve its last fresh foreground lease until the close
        // beacon is sent; ordinary backgrounding has no latch and relinquishes.
        if (!foregroundCloseIntent) relinquishPresence();
        return;
      }
      foregroundCloseIntent = false;
      renewPresence();
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
    const watchdog = window.setInterval(() => resume(), 10_000);
    const presenceRenewal = window.setInterval(renewPresence, 7_000);
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
      window.clearInterval(presenceRenewal);
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
      if (promptReconcileTimerRef.current !== null)
        window.clearTimeout(promptReconcileTimerRef.current);
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
    const sessionId = pendingScrollRestoreRef.current;
    if (!sessionId || sessionId !== viewedSessionId) return;
    const timeline = scrollRef.current;
    if (!timeline) return;
    const target = scrollMemoryRef.current.target(
      sessionId,
      timeline.scrollHeight,
      timeline.clientHeight,
    );
    timeline.scrollTop = target.top;
    stickToBottomRef.current = target.stickToBottom;
    pendingScrollRestoreRef.current = "";
  }, [viewedSessionId, messages]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    // Tool status updates are deliberately excluded: they are frequent during streaming
    // and must never start a new scroll animation. Recheck inside rAF in case the user
    // scrolled into history between React commit and layout.
    requestAnimationFrame(() => {
      const timeline = scrollRef.current;
      if (!timeline || !stickToBottomRef.current) return;
      timeline.scrollTo({ top: timeline.scrollHeight, behavior: "auto" });
    });
  }, [messages, liveMessage]);

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
    // Scroll DOM and visibleTurnCount belong to the last committed React view.
    // The routing ref can already point at the destination while the old view
    // is still painted, which would save the cold Session position under the
    // hot Session ID during a fast switch.
    const sessionId = viewedSessionId;
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
    if (pendingScrollRestoreRef.current === viewedSessionIdRef.current) return;
    stickToBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    rememberCurrentScroll();
  };

  const clearConversationNavigationTarget = () => {
    conversationNavigationTargetRef.current = null;
  };

  const navigateConversation = (
    direction: "top" | "previous" | "next" | "bottom",
  ) => {
    const timeline = scrollRef.current;
    if (!timeline) return;
    if (direction === "top") {
      stickToBottomRef.current = false;
      conversationNavigationTargetRef.current = 0;
      timeline.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (direction === "bottom") {
      stickToBottomRef.current = true;
      conversationNavigationTargetRef.current = timeline.scrollHeight;
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
    if (promptReconcileTimerRef.current !== null)
      window.clearTimeout(promptReconcileTimerRef.current);
    promptReconcileTimerRef.current = window.setTimeout(() => {
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
          applySessionView(view, authority, queueRequestRevision);
          if (view.isStreaming)
            schedulePromptReconcile(sessionId, completedVersion);
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
  };

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
      !steering && (alreadyStreaming || queuePaused || queue.length > 0);
    const previousToolStatus = toolStatus;
    const optimisticMessage =
      willQueueLocally || message.startsWith("/")
        ? null
        : userMessage(message, images);
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
      protectedLocalTurn = {
        sessionId: targetSessionId,
        message: turn,
        expectedTurnTotal: nextLocalTurnTotal(messages, turnTotal, pending),
        queueState:
          (willQueueLocally || steering) && !message.startsWith("/")
            ? "waiting"
            : undefined,
        ...(steering ? { revealOnMessageStart: true } : null),
        confirmByPosition: images.length > 0,
      };
      localUserTurnsRef.current.set(targetSessionId, [
        ...pending,
        protectedLocalTurn,
      ]);
      return protectedLocalTurn;
    };
    const localTurnEntry = (): LocalUserTurn | undefined =>
      targetSessionId
        ? (localUserTurnsRef.current.get(targetSessionId) || []).find(
            (turn) => turn.message === localTurn,
          )
        : undefined;
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
            const projection = acceptQueueProjectionIfCurrent(
              view.session.id,
              queueRequestRevision,
              view.queue || [],
              view.queuePaused === true,
            );
            rememberSessionView({
              ...view,
              queue: projection.queue,
              queuePaused: projection.paused,
            });
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

      const assertImageCapability = (model: ModelInfo | null | undefined) => {
        if (!images.length || model?.input?.includes("image")) return;
        if (!model || !Array.isArray(model.input))
          throw new Error("模型图片能力尚未确认；请刷新后重试或先发送文字消息");
        throw new Error("当前模型不支持图片输入");
      };

      // Preferences chosen while cold/draft are local until the first send starts a Runtime.
      const prefsKey = localDraftRef.current
        ? DRAFT_PREFS_KEY
        : targetSessionId;
      const staged = pendingSessionPrefsRef.current.get(prefsKey);
      // A child JSONL's historical settings describe the child only. They must
      // never silently reconfigure its parent merely because this composer
      // routes an ordinary message to that verified parent.
      const sendingFromChildView =
        Boolean(targetSessionId) && targetSessionId !== viewedSessionIdRef.current;
      let preferredModel =
        staged?.model !== undefined
          ? staged.model
          : sendingFromChildView
            ? undefined
            : state.model;
      let preferredThinking =
        staged?.thinkingLevel !== undefined
          ? staged.thinkingLevel
          : sendingFromChildView
            ? undefined
            : (state.thinkingLevel as ThinkingLevel | undefined);
      let confirmedPromptModel = state.model;
      let initialPromptResult: Awaited<ReturnType<typeof api.prompt>> | null =
        null;
      if (localDraftRef.current) {
        assertImageCapability(preferredModel);
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
            await api.prompt(
              input.message,
              input.images,
              view.session.id,
              input.gateMode,
            );
            return {
              sessionId: view.session.id,
              session: view.session,
              state: view.state,
              gateMode: view.gateMode || "strict",
              accepted: true as const,
              queued: false as const,
            };
          });
        const initial = await submitNewSession({
          cwd: draftWorkspaceCwd || workspaceCwd,
          message,
          images,
          model: preferredModel,
          thinkingLevel: preferredThinking,
        });
        if (!promptOperationIsInCurrentRun()) return;
        targetSessionId = initial.sessionId;
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
        pendingSessionPrefsRef.current.delete(DRAFT_PREFS_KEY);
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
        // A selected cold Session is normally already warming in the
        // background. Await only its minimal capability promise; do not turn
        // the first prompt into a full history/stats/commands activation.
        const ready = await warmSessionRuntime(targetSessionId);
        if (!promptOperationIsInCurrentRun()) return;
        // The pane state is optimistic while cold. Compare staged settings to
        // the Runtime state proven by /warm, not to that optimistic snapshot;
        // otherwise a selection made during warm can be skipped accidentally.
        const latestStaged =
          pendingSessionPrefsRef.current.get(targetSessionId);
        preferredModel =
          latestStaged?.model !== undefined
            ? latestStaged.model
            : preferredModel;
        preferredThinking =
          latestStaged?.thinkingLevel !== undefined
            ? latestStaged.thinkingLevel
            : preferredThinking;
        confirmedPromptModel = ready.state.model;
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
            clearPending: true,
          });
        // Re-apply staged cold preferences only when they differ from the
        // readiness state; this avoids a full activation view merely to learn
        // settings that were already cached with the JSONL pane.
        if (
          preferredModel &&
          (ready.state.model?.provider !== preferredModel.provider ||
            ready.state.model?.id !== preferredModel.id)
        ) {
          const selected = await api.setModel(
            preferredModel.provider,
            preferredModel.id,
            targetSessionId,
          );
          if (!promptOperationIsInCurrentRun()) return;
          confirmedPromptModel = selected.model;
          commitPaneIfCurrent(activationAuthority, {
            type: "SETTINGS_CONFIRMED",
            sessionId: targetSessionId,
            state: { model: selected.model },
          });
        }
        if (
          preferredThinking &&
          ready.state.thinkingLevel !== preferredThinking
        ) {
          const selected = await api.setThinking(
            preferredThinking,
            targetSessionId,
          );
          if (!promptOperationIsInCurrentRun()) return;
          commitPaneIfCurrent(activationAuthority, {
            type: "SETTINGS_CONFIRMED",
            sessionId: targetSessionId,
            state: { thinkingLevel: selected.level },
          });
        }
        if (activationIsCurrent)
          pendingSessionPrefsRef.current.delete(targetSessionId);
      } else if (!alreadyStreaming) {
        if (promptAuthority)
          commitPaneIfCurrent(promptAuthority, {
            type: "PROMPT_PREPARING",
            target: { kind: "session", sessionId: targetSessionId },
            status: WAITING_FOR_PI_STATUS,
          });
        // A staged cold preference can survive a prior explicit activation
        // (for example, Take control). Apply it here too; otherwise this active
        // path would prompt with the historical last-turn settings.
        if (staged) {
          if (staged.model) {
            const selected = await api.setModel(
              staged.model.provider,
              staged.model.id,
              targetSessionId,
            );
            if (!promptOperationIsInCurrentRun()) return;
            confirmedPromptModel = selected.model;
            if (promptAuthority)
              commitPaneIfCurrent(promptAuthority, {
                type: "SETTINGS_CONFIRMED",
                sessionId: targetSessionId,
                state: { model: selected.model },
              });
          }
          if (staged.thinkingLevel) {
            const selected = await api.setThinking(
              staged.thinkingLevel,
              targetSessionId,
            );
            if (!promptOperationIsInCurrentRun()) return;
            if (promptAuthority)
              commitPaneIfCurrent(promptAuthority, {
                type: "SETTINGS_CONFIRMED",
                sessionId: targetSessionId,
                state: { thinkingLevel: selected.level },
              });
          }
          pendingSessionPrefsRef.current.delete(prefsKey);
        }
      }

      if (!initialPromptResult) assertImageCapability(confirmedPromptModel);

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
      protectLocalPrompt();
      promptSubmitted = true;
      const requestedGateMode =
        pendingGateModesRef.current.get(targetSessionId) ??
        gateModesRef.current[targetSessionId];
      if (!promptOperationIsInCurrentRun()) return;
      const result =
        initialPromptResult ||
        (steering
          ? await api.prompt(
              message,
              images,
              targetSessionId,
              requestedGateMode,
              "steer",
            )
          : await api.prompt(
              message,
              images,
              targetSessionId,
              requestedGateMode,
            ));
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
      const acknowledgedProjection = result.queue
        ? (() => {
            const currentRevision =
              queueProjectionRevisionRef.current.get(targetSessionId) || 0;
            if (currentRevision === promptQueueProjectionRevision)
              return {
                ...acceptQueueProjection(
                  targetSessionId,
                  result.queue,
                  queuePaused,
                ),
                accepted: true,
              };
            const current = latestQueueProjectionRef.current.get(
              targetSessionId,
            ) || { queue: [], paused: queuePaused };
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
            const alreadyProjected = current.queue.some(
              (item) => item.id === admitted.id,
            );
            if (alreadyProjected) return { ...current, accepted: false };
            return {
              ...acceptQueueProjection(
                targetSessionId,
                [...current.queue, admitted],
                current.paused,
              ),
              accepted: true,
            };
          })()
        : undefined;
      const acknowledgedQueue = acknowledgedProjection?.queue;
      if (result.queued && acceptedLocalTurn && typeof result.id === "string") {
        // Dispatch SSE may beat this acknowledgement. Never demote a turn that
        // the scheduler has already started into the waiting-only queue UI.
        markLocalTurnQueued(acceptedLocalTurn, result.id);
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
        commitPaneIfCurrent(promptAuthority!, {
          type: "PROMPT_ACKNOWLEDGED",
          sessionId: targetSessionId,
          ...(removeQueuedTurn
            ? {
                messages: (current) =>
                  current.filter(
                    (candidate) => candidate !== queuedTurn!.message,
                  ),
              }
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
      const explicitClientRejection =
        cause instanceof ApiRequestError &&
        cause.status >= 400 &&
        cause.status < 500;
      const stoppedSteerRejection = authoritativeStoppedSteerRejection(
        cause,
        steering,
      );
      const outcomeUnknown =
        promptSubmitted &&
        (promptAcceptedByEvent ||
          promptTerminalByEvent ||
          !explicitClientRejection);
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
        setError(messageText);
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
              const projection = acceptQueueProjectionIfCurrent(
                operation.sessionId,
                queueRequestRevision,
                view.queue || [],
                view.queuePaused === true,
              );
              rememberSessionView({
                ...view,
                queue: projection.queue,
                queuePaused: projection.paused,
              });
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
    const epoch = ++navigationEpochRef.current;
    const controller = new AbortController();
    navigationAbortRef.current = controller;
    desiredSessionIdRef.current = id;
    const navigationAuthority = capturePaneAuthority(id);
    navigationStartedAtRef.current.set(epoch, window.performance.now());
    setViewSwitching(true);
    setError("");
    // Keep the current conversation visible until the destination view has
    // arrived. This avoids a blank timeline while an active Session is waiting
    // for a Gate confirmation or its runtime is answering state requests.
    const cached = viewCacheRef.current.get(id);
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
          // An empty busy-runtime read may update transient state, but cached
          // terminal leases are not evidence that JSONL persisted those rows.
          // Patch the already-painted cache without promoting its transcript into
          // the authoritative branch; a later non-empty view performs confirmation.
          if (!view.messages.length && cached.messages.length) {
            const projection = acceptQueueProjectionIfCurrent(
              id,
              queueRequestRevision,
              view.queue || [],
              view.queuePaused === true,
            );
            const patched = refreshSessionCache(id, {
              ...view,
              queue: projection.queue,
              queuePaused: projection.paused,
            });
            if (patched)
              applySessionView(
                patched,
                reconcileAuthority,
                queueProjectionRevisionRef.current.get(id) || 0,
              );
          } else
            applySessionView(view, reconcileAuthority, queueRequestRevision);
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
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (navigationEpochRef.current === epoch) {
        navigationStartedAtRef.current.delete(epoch);
        setPaneLoading(null);
        desiredSessionIdRef.current = viewedSessionIdRef.current;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (navigationAbortRef.current === controller)
        navigationAbortRef.current = null;
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
    if (promptReconcileTimerRef.current !== null)
      window.clearTimeout(promptReconcileTimerRef.current);
    promptReconcileTimerRef.current = null;
    const previousViewedSessionId = viewedSessionIdRef.current;
    // Carry over the currently displayed model/thinking as the draft defaults.
    pendingSessionPrefsRef.current.set(DRAFT_PREFS_KEY, {
      model: state.model,
      thinkingLevel: state.thinkingLevel as ThinkingLevel | undefined,
    });
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
      : {
          ...ready.state,
          ...(pendingSessionPrefsRef.current.get(sessionId)?.model !== undefined
            ? { model: pendingSessionPrefsRef.current.get(sessionId)!.model }
            : null),
          ...(pendingSessionPrefsRef.current.get(sessionId)?.thinkingLevel !==
          undefined
            ? {
                thinkingLevel:
                  pendingSessionPrefsRef.current.get(sessionId)!.thinkingLevel,
              }
            : null),
        };
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
          const staged = pendingSessionPrefsRef.current.get(sessionId);
          const cacheState = {
            ...ready.state,
            ...(staged?.model !== undefined ? { model: staged.model } : null),
            ...(staged?.thinkingLevel !== undefined
              ? { thinkingLevel: staged.thinkingLevel }
              : null),
          };
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

  const ensureRuntimeActive = async () => {
    const sessionId = viewedSessionIdRef.current;
    if (!sessionId || runtimeStatus === "active") return false;
    const authority = capturePaneAuthority(sessionId);
    const ready = await warmSessionRuntime(sessionId);
    return applyWarmReadiness(sessionId, ready, authority);
  };

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

  const stageSessionPref = (patch: {
    model?: ModelInfo | null;
    thinkingLevel?: ThinkingLevel;
  }) => {
    const key = localDraftRef.current ? DRAFT_PREFS_KEY : composerTargetForViewedSession();
    if (!key) return;
    const current = pendingSessionPrefsRef.current.get(key) || {};
    pendingSessionPrefsRef.current.set(key, { ...current, ...patch });
  };

  const changeModel = async (provider: string, modelId: string) => {
    if (buildIdentityMismatch || !provider || !modelId) return;
    const model = models.find(
      (candidate) =>
        candidate.provider === provider && candidate.id === modelId,
    );
    const viewed = viewedSessionIdRef.current;
    const targetSessionId = composerTargetForViewedSession();
    const childOriginated = Boolean(viewed && targetSessionId && viewed !== targetSessionId);
    const targetControl = targetSessionId === viewed
      ? viewControl
      : sessions.find((session) => session.id === targetSessionId);
    const targetObserving = Boolean(
      targetControl?.controlOwner && targetControl.controlledByThisWindow !== true,
    );
    // Cold history, child views, foreign controllers, and a superseded setting
    // request only stage a per-target preference. The eventual prompt path owns
    // application to Pi, so a setting click never preempts another window.
    if (localDraftRef.current || runtimeStatus !== "active" || childOriginated || targetObserving || settingsBusy || state.isCompacting) {
      if (model) {
        stageSessionPref({ model });
        dispatchPane({
          type: "PREFERENCES_STAGED",
          target: localDraftRef.current
            ? { kind: "draft" }
            : { kind: "session", sessionId: viewed },
          model,
        });
      }
      setNotice(`已选择 ${model?.name || modelId}，发送时生效`);
      return;
    }
    const operation = captureViewOperation();
    const operationToken = Symbol("set-model");
    settingsOperationTokenRef.current = operationToken;
    setSettingsBusy(true);
    setError("");
    try {
      const result = await api.setModel(provider, modelId, operation.sessionId);
      if (!viewOperationIsInCurrentRun(operation)) return;
      const stagedModel = pendingSessionPrefsRef.current.get(operation.sessionId)?.model;
      const superseded = Boolean(
        stagedModel &&
        (stagedModel.provider !== result.model?.provider || stagedModel.id !== result.model?.id),
      );
      if (superseded) return;
      patchSessionCache(operation.sessionId, {
        state: { model: result.model },
      });
      if (
        !commitPaneIfCurrent(operation, {
          type: "SETTINGS_CONFIRMED",
          sessionId: operation.sessionId,
          state: { model: result.model },
        })
      )
        return;
      setNotice(
        result.pending
          ? `已选择 ${result.model?.name || modelId}，下一轮对话生效`
          : `已切换到 ${result.model?.name || modelId}`,
      );
    } catch (cause) {
      if (viewOperationIsCurrent(operation))
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (
        settingsOperationTokenRef.current === operationToken &&
        viewOperationIsInCurrentRun(operation)
      ) {
        settingsOperationTokenRef.current = null;
        setSettingsBusy(false);
      }
    }
  };

  const changeThinking = async (level: ThinkingLevel) => {
    if (buildIdentityMismatch) return;
    const viewed = viewedSessionIdRef.current;
    const targetSessionId = composerTargetForViewedSession();
    const childOriginated = Boolean(viewed && targetSessionId && viewed !== targetSessionId);
    const targetControl = targetSessionId === viewed
      ? viewControl
      : sessions.find((session) => session.id === targetSessionId);
    const targetObserving = Boolean(
      targetControl?.controlOwner && targetControl.controlledByThisWindow !== true,
    );
    if (localDraftRef.current || runtimeStatus !== "active" || childOriginated || targetObserving || settingsBusy || state.isCompacting) {
      stageSessionPref({ thinkingLevel: level });
      dispatchPane({
        type: "PREFERENCES_STAGED",
        target: localDraftRef.current
          ? { kind: "draft" }
          : { kind: "session", sessionId: viewed },
        thinkingLevel: level,
      });
      setNotice(`已选择 ${level} 思考强度，发送时生效`);
      return;
    }
    const operation = captureViewOperation();
    const operationToken = Symbol("set-thinking");
    settingsOperationTokenRef.current = operationToken;
    setSettingsBusy(true);
    setError("");
    try {
      const result = await api.setThinking(level, operation.sessionId);
      if (!viewOperationIsInCurrentRun(operation)) return;
      const stagedThinking = pendingSessionPrefsRef.current.get(operation.sessionId)?.thinkingLevel;
      if (stagedThinking && stagedThinking !== result.level) return;
      patchSessionCache(operation.sessionId, {
        state: { thinkingLevel: result.level },
      });
      if (
        !commitPaneIfCurrent(operation, {
          type: "SETTINGS_CONFIRMED",
          sessionId: operation.sessionId,
          state: { thinkingLevel: result.level },
        })
      )
        return;
      setNotice(
        result.pending
          ? `已选择 ${result.level}，下一轮对话生效`
          : `思考强度已切换为 ${result.level}`,
      );
    } catch (cause) {
      if (viewOperationIsCurrent(operation))
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (
        settingsOperationTokenRef.current === operationToken &&
        viewOperationIsInCurrentRun(operation)
      ) {
        settingsOperationTokenRef.current = null;
        setSettingsBusy(false);
      }
    }
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
   * its row or cached pane.
   */
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
    scrollMemoryRef.current.forget(sessionId);
    viewCacheRef.current.forget(sessionId);
    localUserTurnsRef.current.delete(sessionId);
    sourceTurnTotalsRef.current.delete(sessionId);
    cancelledQueueIdsRef.current.delete(sessionId);
    queueProjectionRevisionRef.current.delete(sessionId);
    latestQueueProjectionRef.current.delete(sessionId);
    queueMutationSequenceRef.current.delete(sessionId);
    appliedQueueMutationSequenceRef.current.delete(sessionId);
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
      .then((data) => {
        if (optimisticRenamesRef.current.get(sessionId)?.token !== token)
          return;
        if (runEpochGenerationRef.current !== runEpochGeneration) {
          void reconcilePendingSessionMutations().catch(() => undefined);
          return;
        }
        optimisticRenamesRef.current.delete(sessionId);
        syncMutatingSessionIds();
        applyBootstrapMetadata(data);
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
              cause.status < 500;
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
              cause.status < 500;
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
    if (buildIdentityMismatch || !sessionId) return;
    const childOriginated = Boolean(viewed && viewed !== sessionId);
    const targetControl = sessionId === viewed
      ? viewControl
      : sessions.find((session) => session.id === sessionId);
    const targetObserving = Boolean(
      targetControl?.controlOwner && targetControl.controlledByThisWindow !== true,
    );
    // A cold history pane, a child transcript, a foreign controller, and local
    // preparation stage Gate for the target prompt instead of issuing an
    // unauthorized command against a Runtime the pane does not own.
    if (runtimeStatus !== "active" || childOriginated || targetObserving || settingsBusy || state.isCompacting) {
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
  const composerQueueMode =
    state.isStreaming || queuePaused || queue.length > 0;
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
  const composerTargetControl = composerTargetSessionId === viewedSessionId
    ? viewControl
    : sessions.find((session) => session.id === composerTargetSessionId);
  const composerTargetObserving = Boolean(
    composerTargetControl?.controlOwner &&
    composerTargetControl.controlledByThisWindow !== true,
  );
  const currentSessionBusy = busySessionIds.includes(
    viewedSessionId || (localDraft ? LOCAL_DRAFT_BUSY_ID : ""),
  );
  // Once Pi has authoritatively started generating, the composer may accept a
  // follow-up into the queue even if the first HTTP acknowledgement is late.
  const currentSessionPreparing = currentSessionBusy && !state.isStreaming;
  const composerSubmissionScope = localDraft
    ? `draft:${draftGenerationRef.current}`
    : `session:${composerTargetSessionId || "none"}`;
  const composerSubmissionPending = composerPendingByScope[composerSubmissionScope] || 0;
  const composerSubmissionDeferred = deferredComposerScopes[composerSubmissionScope];
  const deferredTargetSessionId = composerSubmissionDeferred?.targetSessionId || "";
  const deferredTargetControl = deferredTargetSessionId === viewedSessionId
    ? viewControl
    : sessions.find((session) => session.id === deferredTargetSessionId);
  const deferredTargetObserving = Boolean(
    deferredTargetControl?.controlOwner &&
    deferredTargetControl.controlledByThisWindow !== true,
  );
  useEffect(() => {
    if (!composerSubmissionDeferred || !deferredTargetSessionId) return;
    // A conflict itself proves that a foreign owner existed, even if this page
    // missed the corresponding "foreign" SSE. Resume only after a later
    // authoritative control frame clears that owner (or confirms this page),
    // never from the stale pre-conflict projection or a later pane's version.
    const controlVersion =
      sessionEventVersionRef.current.get(deferredTargetSessionId) || 0;
    if (
      deferredTargetControl?.controlledByThisWindow === true ||
      (!deferredTargetObserving &&
        controlVersion > composerSubmissionDeferred.controlVersion)
    ) {
      setDeferredComposerScopes((current) => {
        if (!current[composerSubmissionScope]) return current;
        const next = { ...current };
        delete next[composerSubmissionScope];
        return next;
      });
    }
  }, [
    composerSubmissionDeferred,
    composerSubmissionScope,
    deferredTargetObserving,
    deferredTargetControl?.controlledByThisWindow,
    deferredTargetSessionId,
  ]);
  const composerSubmissionPaused =
    !mutationBlocked &&
    (viewSwitching ||
      currentSessionPreparing ||
      Boolean(state.isCompacting) ||
      composerTargetObserving ||
      Boolean(composerSubmissionDeferred) ||
      (viewingSubagentSession && !composerTargetSessionId));
  const composerSubmissionPausedMessage = viewingSubagentSession && !composerTargetSessionId
    ? "子代理父对话地址不可用；消息已保留，等待验证恢复"
    : composerSubmissionDeferred || composerTargetObserving
      ? viewingSubagentSession
        ? "父对话正在另一窗口中控制；消息已保留，控制权可用后将发送"
        : "另一窗口正在控制此对话；消息已保留，控制权可用后将发送"
    : state.isCompacting
      ? "消息已保存，等待压缩完成后发送"
      : currentSessionPreparing
        ? "消息已保存，正在准备 Runtime 后发送"
        : "消息已保存，等待会话切换完成后发送";
  const waitingForPi =
    !state.isStreaming &&
    (currentSessionPreparing || composerSubmissionPending > 0);
  // The server intentionally keeps an empty active Primary out of the indexed
  // sidebar until its first user turn. Preserve its real Session authority, but
  // present the same New-conversation shell instead of the legacy saved fallback.
  const emptyPrimaryDraftPresentation = Boolean(
    viewedSessionId &&
      viewedSessionId === activeSessionId &&
      sidebarInventoryReady &&
      !viewedSession &&
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
  // An existing Secondary can keep working while Primary starts or recovers,
  // but a Primary pane, cold history, or local New draft needs both a ready
  // Runtime and a committed same-model Bootstrap snapshot before image input is
  // authoritative. A ready SSE alone carries no ModelInfo.input capability.
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
  const primaryRuntimeDisabledPlaceholder =
    primaryRuntime.status === "failed"
      ? "Pi Runtime 当前不可用；恢复 ready 后才能输入"
      : "Pi 正在准备；Runtime ready 后才能输入";
  const imageInputPendingMessage =
    primaryRuntime.status === "failed"
      ? "Pi 当前不可用，模型图片能力尚未确认"
      : primaryRuntime.status === "ready"
        ? "模型图片能力尚未确认；文字消息仍可发送"
        : "Pi 正在准备，模型图片能力尚未确认";
  const primarySessionFailed = false;
  const gateAvailable = gateAvailableOverride ?? true;
  // A staged value can describe the next prompt in a cold history pane, but
  // never alters gateModesRef, which is the only authority for auto-allow.
  const gateMode =
    pendingGateModes[composerTargetSessionId] ?? gateModes[composerTargetSessionId];
  const effectiveControl = { ...viewedSession, ...viewControl };
  const observing = Boolean(
    effectiveControl.controlOwner && !effectiveControl.controlledByThisWindow,
  );
  const takeControl = async () => {
    if (mutationBlocked || viewingSubagentSession) return;
    const sessionId = viewedSessionIdRef.current;
    if (!sessionId) return;
    const authority = capturePaneAuthority(sessionId);
    // A newer control SSE for the same committed pane is authoritative over an
    // older HTTP takeover response. Pane identity/revision alone does not see
    // that race because no navigation need occur.
    const eventVersion = sessionEventVersionRef.current.get(sessionId) || 0;
    const takeoverIsCurrent = () =>
      paneAuthorityCanCommit(authority) &&
      (sessionEventVersionRef.current.get(sessionId) || 0) === eventVersion;
    const finishSessionBusy = beginSessionBusy(sessionId);
    try {
      const activatedHere =
        runtimeStatus === "active" || (await ensureRuntimeActive());
      if (!activatedHere || !takeoverIsCurrent()) return;
      const result = await api.takeSessionControl(sessionId);
      if (
        !takeoverIsCurrent() ||
        !commitPaneIfCurrent(authority, {
          type: "CONTROL_UPDATED",
          sessionId,
          control: result,
        })
      )
        return;
      setSessions((current) =>
        current.map((session) =>
          session.id === sessionId ? { ...session, ...result } : session,
        ),
      );
      setNotice("已接管此对话控制权");
    } catch (cause) {
      if (takeoverIsCurrent())
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      finishSessionBusy();
    }
  };

  const cancelQueuedPrompt = (item: QueuedPrompt) => {
    const operation = captureViewOperation();
    queueCancellationSequenceRef.current += 1;
    const cancellationSequence = queueCancellationSequenceRef.current;
    const expectedDraftRevision = composerDraftRevisionRef.current;
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
    void api
      .cancelQueued(item.id, operation.sessionId)
      .then((result) => {
        if (!viewOperationIsInCurrentRun(operation)) return;
        if (confirmedDeletedSessionIdsRef.current.has(operation.sessionId))
          return;
        const pending =
          localUserTurnsRef.current.get(operation.sessionId) || [];
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
        if (
          commitPaneIfCurrent(operation, {
            type: "QUEUE_UPDATED",
            sessionId: operation.sessionId,
            queue: authoritativeQueue,
            paused: authoritativeProjection.paused,
            messages: cancelled?.renderedInTranscript
              ? (current) =>
                  current.filter((message) => message !== cancelled.message)
              : undefined,
          })
        ) {
          // HTTP completions may arrive out of click order. The latest successful
          // cancellation wins the Composer, never whichever response finishes last.
          if (cancellationSequence > appliedCancelledDraftSequenceRef.current) {
            appliedCancelledDraftSequenceRef.current = cancellationSequence;
            setCancelledDraft({
              revision: cancellationSequence,
              expectedDraftRevision,
              ...restored,
            });
          }
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
            )
          : acceptQueueProjection(
              operation.sessionId,
              result.queue,
              result.paused,
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

  useEffect(() => {
    recordDiagnosticProjection(false);
  }, [
    composerQueueMode,
    currentSessionPreparing,
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
      state={state}
      models={models}
      stats={stats}
      disabled={mutationBlocked}
      settingsBusy={settingsBusy}
      streaming={state.isStreaming}
      gateAvailable={gateAvailable}
      gateMode={gateMode}
      primaryUnavailable={false}
      onGate={(mode) => void changeGate(mode)}
      onModel={(provider, id) => void changeModel(provider, id)}
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
        viewBusy={sidebarViewBlocked}
        refreshing={refreshing}
        pinnedSessionIds={sessionNavigation.pinnedSessionIds}
        pinnedDirectoryKeys={sessionNavigation.pinnedDirectoryKeys}
        collapsedDirectoryKeys={sessionNavigation.collapsedDirectoryKeys}
        expandedDirectoryKeys={sessionNavigation.expandedDirectoryKeys}
        failedSessionIds={failedSessionIds}
        unseenReplySessionIds={unseenReplySessionIds}
        mutatingSessionIds={mutatingSessionIds}
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
          sessionId: paneLoading?.sessionId || viewedSessionId,
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
        }}
        timelineRef={scrollRef}
        onScroll={onScroll}
        onClearNavigation={clearConversationNavigationTarget}
        loading={loading}
        viewedSessionId={viewedSessionId}
        paneLoading={paneLoading}
        messages={messages}
        pendingUserMessage={pendingUserMessage}
        liveMessage={liveMessage}
        localDraft={localDraft}
        newConversationPresentation={newConversationPresentation}
        waitingForPi={waitingForPi}
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
        loadingEarlier={loadingEarlier}
        onLoadEarlier={() => void loadEarlierTurns()}
        state={state}
        toolStatus={toolStatus}
        onNavigate={navigateConversation}
        sessionControl={{
          observing: viewingSubagentSession ? false : observing,
          disabled: mutationBlocked || viewingSubagentSession,
          onTakeOver: () => void takeControl(),
        }}
        promptQueue={{
          queue,
          paused: queuePaused,
          busy:
            currentSessionPreparing ||
            viewSwitching ||
            observing ||
            mutationBlocked ||
            viewingSubagentSession,
          onCancel: cancelQueuedPrompt,
          onResume: resumeQueuedPrompt,
        }}
        chatInput={{
          streaming: viewingSubagentSession ? false : composerQueueMode,
          activelyStreaming: viewingSubagentSession ? false : state.isStreaming,
          stopping: viewingSubagentSession ? false : stoppingCurrentSession,
          // Editing is independent from runtime preparation, compaction, and
          // foreign control. Those conditions pause only the accepted snapshot.
          disabled: mutationBlocked,
          disabledPlaceholder: buildIdentityMismatch
            ? "网页与服务构建不一致；请刷新页面后再提交操作"
            : lifecycleBlocked
              ? "Pi Chat 正在执行全局维护，暂时不能提交新操作"
              : undefined,
          acceptsImages: state.model?.input?.includes("image") === true,
          imageInputPending: primaryCapabilityPending,
          imageInputPendingMessage,
          resolveImageCapabilityOnSend:
            viewingSubagentSession ||
            (primaryRuntime.status === "ready" &&
              !localDraft &&
              runtimeStatus !== "active"),
          restoredDraft: cancelledDraft,
          onDraftRevisionChange: (revision) => {
            composerDraftRevisionRef.current = revision;
          },
          submissionScope: composerSubmissionScope,
          submissionTargetSessionId: composerTargetSessionId || undefined,
          submissionControlVersion:
            sessionEventVersionRef.current.get(composerTargetSessionId) || 0,
          allowFollowupSubmissions: true,
          submissionPaused: composerSubmissionPaused,
          submissionPausedMessage: composerSubmissionPausedMessage,
          onSubmissionPendingChange: updateComposerPending,
          onSubmissionDeferred: (error, submission) => {
            if (!(error instanceof ApiRequestError) || error.code !== "SESSION_CONTROL_CONFLICT")
              return false;
            setError("");
            const targetSessionId = submission.targetSessionId;
            const controlVersion = submission.controlVersion;
            if (!targetSessionId || typeof controlVersion !== "number")
              return false;
            setDeferredComposerScopes((current) => current[submission.scope]
              ? current
              : {
                  ...current,
                  [submission.scope]: { targetSessionId, controlVersion },
                });
            return true;
          },
          commands: composerCommands,
          controls: composerControls,
          notices: composerNotices,
          onSend: async (message, images, delivery) => {
            if (
              viewingSubagentSession &&
              (!composerTargetSessionId ||
                delivery !== "queue" ||
                message.startsWith("/"))
            )
              throw new Error("子代理视图仅支持向已验证父对话发送普通消息");
            return send(message, images, delivery, viewingSubagentSession ? composerTargetSessionId : "");
          },
          onPickLocalFiles: async () => (await api.pickLocalFiles()).paths,
          onReadClipboardFiles: async () =>
            (await api.clipboardLocalFiles()).paths,
          onError: setError,
          onAbort: stopGeneration,
        }}
      />
      <ManagementPanel
        section={managementSection}
        appearance={appearance}
        workspaceCwd={workspaceCwd}
        workspacePicking={workspacePicking}
        workspaceDisabled={mutationBlocked}
        models={models}
        state={state}
        busy={busy || globalMutationBlocked}
        shutdownBlocked={
          busy ||
          (buildIdentityMismatch
            ? recoveryActionBlocked
            : globalMutationBlocked)
        }
        diagnosticsBusy={diagnosticsBusy}
        onClose={() => setManagementSection(null)}
        onAppearance={setAppearance}
        onPickWorkspace={() => void pickDefaultWorkspace()}
        onModel={(provider, id) => void changeModel(provider, id)}
        onExportDiagnostics={exportStateDiagnostics}
        onShutdown={() => void shutdownPiChat()}
      />
      <SessionDialog
        state={sessionDialog}
        busy={sessionActionBusy}
        disabled={buildIdentityMismatch}
        onClose={() => setSessionDialog(null)}
        onRename={(name) => void renameSession(name)}
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
          onFallback={() => setAskQuestionnaires((current) => {
            if (current[askSessionId]?.toolCallId !== questionnaire.toolCallId) return current;
            const next = { ...current };
            delete next[askSessionId];
            return next;
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
      <EditDiffSidebar
        open={diffSidebarOpen}
        width={diffSidebarWidth}
        onOpenChange={setDiffSidebarOpen}
        onWidthChange={setDiffSidebarWidth}
      />
    </AppShell>
  );
}
