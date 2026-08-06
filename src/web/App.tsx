import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { appendTerminalMessage } from "../shared/streaming-assistant";
import type {
  ApplicationLifecycle,
  BootstrapData,
  ExtensionUiRequest,
  ModelInfo,
  PiMessage,
  PiState,
  PrimaryRuntimeReadiness,
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
import {
  shouldReconnectEventSource,
  usePiEventSource,
} from "./hooks/use-pi-event-source";
import {
  activeSessionIdsFromEvent,
  applyActiveSessionIds,
} from "./lib/active-sessions";
import { adjacentUserMessageOffset } from "./lib/conversation-navigation";
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
  appendLocalTurnOnce,
  bindQueuedAdmission,
  bindQueuedDispatch,
  localTurnBelongsInTranscript,
  markLocalTurnQueued,
  nextLocalTurnTotal,
  protectTranscriptWithLocalTurns,
  removeLocalTurnAndRebase,
  type LocalUserTurn,
} from "./lib/local-user-turn";
import {
  refreshFailureKeepsCommittedView,
  sidebarNavigationBlocked,
} from "./lib/refresh-navigation-guards";
import { SessionScrollMemory } from "./lib/session-scroll-memory";
import { SessionViewCache } from "./lib/session-view-cache";
import { normalizeCwdKey, togglePinnedDirectory, togglePinnedSession } from "./lib/session-navigation";
import { buildIdentityLabel, buildIdentityMatches, webBuildIdentity } from "./lib/build-identity";
import { uniqueSessionSummaries } from "./lib/session-summary";
import {
  conversationPaneReducer,
  emptyConversationPane,
  type ConversationPaneAction,
  type ConversationPaneIdentity,
  type ConversationRuntimeStatus,
} from "./state/conversation-pane";

const LOCAL_DRAFT_BUSY_ID = "__local_draft_busy__";

type PaneAuthority = {
  sessionId: string;
  desiredSessionId: string;
  navigationEpoch: number;
  committedRevision: number;
  draftGeneration: number;
};

type PaneAuthoritySnapshot = PaneAuthority & {
  committedIdentity: ConversationPaneIdentity;
};
type DraftPaneAuthority = Omit<PaneAuthority, "sessionId" | "desiredSessionId">;
type ScheduledLiveMessage = {
  message: PiMessage;
  authority: PaneAuthoritySnapshot;
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

/** Optimistic terminal state for the narrow abort/settlement-to-SSE gap. */
function settleSidebarActivity(session: SessionSummary): SessionSummary {
  const activity = session.activity;
  if (!activity || (activity.execution !== "running" && activity.execution !== "dispatching"))
    return { ...session, running: false };
  const queued = session.queued === true;
  return {
    ...session,
    running: false,
    activity: { ...activity, execution: queued ? "queued" : "idle" },
  };
}

function recoverableRefreshError(message: string): boolean {
  return /请求超时|RPC 请求超时|RPC 查询仍在处理中/.test(message);
}

function hasAssistantPayload(message: PiMessage | null): message is PiMessage {
  if (!message) return false;
  return typeof message.content === "string"
    ? message.content.length > 0
    : Array.isArray(message.content) && message.content.length > 0;
}

export function App() {
  const [pane, dispatchPane] = useReducer(
    conversationPaneReducer,
    undefined,
    emptyConversationPane,
  );
  const paneAuthorityDispatchRef = useRef<(
    authority: PaneAuthoritySnapshot,
    action: Exclude<ConversationPaneAction, {
      type: "COMMIT_BOOTSTRAP" | "COMMIT_VIEW" | "RESET_DRAFT" | "CLEAR_PANE" | "DRAFT_WORKSPACE_SELECTED";
    }>,
  ) => boolean>(() => false);
  /** The synchronous authority mirror changes only with an atomic pane commit. */
  const committedPaneIdentityRef = useRef<ConversationPaneIdentity>(pane.identity);
  /** Commands are part of the committed projection, not a render-closure fallback. */
  const committedPaneCommandsRef = useRef<SlashCommand[]>(pane.commands);
  const paneCommitRevisionRef = useRef(0);
  const draftGenerationRef = useRef(0);
  const viewedSessionIdRef = useRef("");
  /** Draft intent is a coordinator guard only; pane.identity is the sole UI fact. */
  const localDraftRef = useRef(false);
  const { piState: state, messages, pendingUserMessage } = pane;
  const { messageTotal, turnTotal, visibleTurnCount, messagesTruncated } = pane;
  /** Pagination request authority stays in the coordinator map, not the pane reducer. */
  const [, setLoadingEarlierRevision] = useState(0);
  const { stats } = pane;
  const { liveMessage } = pane;
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const sessionsRef = useRef<SessionSummary[]>([]);
  /** A remembered pane may load before bootstrap; it must not become a fake one-row sidebar. */
  const sidebarInventoryReadyRef = useRef(false);
  const [sidebarInventoryReady, setSidebarInventoryReady] = useState(false);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [sessionDirectories, setSessionDirectories] = useState<SessionDirectorySummary[]>([]);
  const [loadingAllSessions, setLoadingAllSessions] = useState(false);
  const [loadingDirectoryKeys, setLoadingDirectoryKeys] = useState<string[]>([]);
  const [sessionNavigation, setSessionNavigation] = useState(
    () => loadSessionNavigationPreferences(),
  );
  const showAllSessionsRef = useRef(false);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [activeSessionIds, setActiveSessionIds] = useState<string[]>([]);
  const viewedSessionId = pane.identity.kind === "session" ? pane.identity.sessionId : "";
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [workspaceCwd, setWorkspaceCwd] = useState("");
  const { draftWorkspaceCwd } = pane;
  const { commands, gateAvailableOverride, queue, queuePaused } = pane;
  const [stopping, setStopping] = useState(false);
  const { promptStarting } = pane;
  const [loading, setLoading] = useState(true);
  /** Application-wide maintenance mutation; never used for an ordinary prompt. */
  const [busy, setBusy] = useState(false);
  /** Prompt/Runtime preparation is owned by a Session, so another pane stays usable. */
  const [busySessionIds, setBusySessionIds] = useState<string[]>([]);
  const [viewSwitching, setViewSwitching] = useState(false);
  const [paneLoading, setPaneLoading] = useState<{
    sessionId: string;
    name: string;
  } | null>(null);
  const [diffSidebarOpen, setDiffSidebarOpen] = useState(false);
  const [diffSidebarWidth, setDiffSidebarWidth] = useState(460);
  /** Model / thinking only — must not freeze composer, sidebar, or the whole shell. */
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [workspacePicking, setWorkspacePicking] = useState(false);
  /** Invalidates a native picker when its New draft is superseded. */
  const draftWorkspacePickerTokenRef = useRef<symbol | null>(null);
  /** One global default picker at a time; it never owns the visible conversation pane. */
  const workspaceDefaultPickerTokenRef = useRef<symbol | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [managementSection, setManagementSection] =
    useState<ManagementSection | null>(null);
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
  const localDraft = pane.identity.kind === "draft";
  const [eventSourceGeneration, setEventSourceGeneration] = useState(0);
  const [applicationLifecycle, setApplicationLifecycle] =
    useState<ApplicationLifecycle>("idle");
  /** A stale Web bundle may read, but must not mutate a different Server build. */
  const [buildIdentityMismatch, setBuildIdentityMismatch] = useState(false);
  const [serverBuildIdentity, setServerBuildIdentity] = useState(webBuildIdentity);
  /** Global Primary capability; separate from the Session/JSONL first-paint state. */
  const [primaryRuntime, setPrimaryRuntime] = useState<PrimaryRuntimeReadiness>(
    { status: "starting", generation: 0 },
  );
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
  const rememberSessionView = (view: SessionViewData) =>
    confirmedDeletedSessionIdsRef.current.has(view.session.id)
      ? undefined
      : viewCacheRef.current.remember(view);
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
  const applySessionActivity = useCallback((sessionId: string, activity: SessionActivityState) => {
    sessionRunningOverridesRef.current.set(
      sessionId,
      activity.execution === "running" || activity.execution === "dispatching",
    );
    setFailedSessionIds((current) =>
      activity.execution === "failed"
        ? [...new Set([...current, sessionId])]
        : current.filter((id) => id !== sessionId),
    );
    setSessions((current) => current.map((session) =>
      session.id === sessionId
        ? { ...session, activity, running: activity.execution === "running" || activity.execution === "dispatching", queued: activity.execution === "queued" || activity.execution === "paused", pendingConfirmation: activity.awaitingConfirmation }
        : session,
    ));
    patchSessionCache(sessionId, { sessionActivity: activity });
  }, []);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const scrollMemoryRef = useRef(new SessionScrollMemory());
  const pendingScrollRestoreRef = useRef("");
  const conversationNavigationTargetRef = useRef<number | null>(null);
  const stoppingRef = useRef(false);
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
  const sessionRefreshRequestedRef = useRef(false);
  const desiredSessionIdRef = useRef("");
  const navigationEpochRef = useRef(0);
  const navigationAbortRef = useRef<AbortController | null>(null);
  const navigationStartedAtRef = useRef(new Map<number, number>());
  /** Accepted local user turns remain visible until a JSONL-derived view includes them. */
  const localUserTurnsRef = useRef(new Map<string, LocalUserTurn[]>());
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
  const [pendingGateModes, setPendingGateModes] = useState<Record<string, GateMode>>({});
  const stageGateMode = useCallback((sessionId: string, mode: GateMode | undefined) => {
    if (mode) pendingGateModesRef.current.set(sessionId, mode);
    else pendingGateModesRef.current.delete(sessionId);
    setPendingGateModes(Object.fromEntries(pendingGateModesRef.current));
  }, []);
  const DRAFT_PREFS_KEY = "__local_draft__";
  const warmingSessionIdsRef = useRef(new Set<string>());
  const warmingRuntimeStartsRef = useRef(new Map<string, Promise<SessionRuntimeReadyData>>());
  /** message_end may precede agent_settled; only their pair creates an unread completion notice. */
  const terminalAssistantSessionIdsRef = useRef(new Set<string>());
  /** SSE lifecycle is newer than a delayed sidebar/bootstrap summary. */
  const sessionRunningOverridesRef = useRef(new Map<string, boolean>());
  const normalizeSessionRunning = (session: SessionSummary): SessionSummary => {
    const running = sessionRunningOverridesRef.current.get(session.id);
    return running === undefined ? session : { ...session, running };
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
  const sessionRunGenerationsRef = useRef(new Map<string, number>());
  /** Terminal generations are final: late tool/status frames from them are stale. */
  const settledRunGenerationsRef = useRef(new Map<string, number>());
  const refreshEpochRef = useRef(0);
  const bootstrapInFlightRef = useRef<Promise<BootstrapData> | null>(null);
  const handshakeInFlightRef = useRef<Promise<void> | null>(null);
  /** First remembered pane may paint while the slower global bootstrap continues. */
  const initialHistoryRef = useRef<{ id: string; request: Promise<SessionViewData> } | null>(null);
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
      typeof session.turnCount === "number" && Number.isFinite(session.turnCount)
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
  const reconcileOptimisticSessions = (incoming: SessionSummary[]) =>
    uniqueSessionSummaries(incoming)
      .map(normalizeSessionRunning)
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
  const commitLiveMessage = useCallback(
    ({ message, authority }: ScheduledLiveMessage) => {
      paneAuthorityDispatchRef.current(authority, {
        type: "LIVE_MESSAGE_UPDATED",
        sessionId: authority.sessionId,
        message,
      });
    },
    [],
  );
  const {
    clearPendingLiveMessage,
    drainPendingLiveMessage,
    scheduleLiveMessage,
  } = useLiveMessageScheduler(commitLiveMessage);
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
    const counts = busySessionCountsRef.current;
    counts.set(id, (counts.get(id) || 0) + 1);
    setBusySessionIds([...counts.keys()]);
    let released = false;
    return () => {
      if (released) return;
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
    (action: Extract<ConversationPaneAction, {
      type: "COMMIT_BOOTSTRAP" | "COMMIT_VIEW" | "RESET_DRAFT" | "CLEAR_PANE";
    }>) => {
      const identity = action.type === "COMMIT_BOOTSTRAP" || action.type === "COMMIT_VIEW"
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
      committedPaneCommandsRef.current =
        action.type === "COMMIT_BOOTSTRAP" || action.type === "COMMIT_VIEW"
          ? action.pane.commands
          : [];
      paneCommitRevisionRef.current += 1;
      if (action.type === "RESET_DRAFT" || action.type === "CLEAR_PANE")
        draftGenerationRef.current += 1;
      viewedSessionIdRef.current = id;
      desiredSessionIdRef.current = id;
      localDraftRef.current = identity.kind === "draft";
      rememberSessionId(id);
      dispatchPane(action);
    },
    [clearPendingLiveMessage],
  );

  /**
   * Capture the coordinator facts that authorize an async continuation to alter
   * the visible pane. A matching Session ID alone is insufficient: after
   * A → B → A, an old A request must not replace the newer A pane.
   */
  const capturePaneAuthority = useCallback((sessionId = viewedSessionIdRef.current): PaneAuthoritySnapshot => ({
    sessionId,
    desiredSessionId: desiredSessionIdRef.current,
    navigationEpoch: navigationEpochRef.current,
    committedRevision: paneCommitRevisionRef.current,
    committedIdentity: committedPaneIdentityRef.current,
    draftGeneration: draftGenerationRef.current,
  }), []);
  const paneAuthorityCanCommit = useCallback((authority: PaneAuthoritySnapshot) =>
    Boolean(authority.sessionId) &&
    authority.desiredSessionId === authority.sessionId &&
    desiredSessionIdRef.current === authority.sessionId &&
    navigationEpochRef.current === authority.navigationEpoch &&
    paneCommitRevisionRef.current === authority.committedRevision &&
    committedPaneIdentityRef.current.kind === authority.committedIdentity.kind &&
    committedPaneIdentityRef.current.sessionId === authority.committedIdentity.sessionId &&
    draftGenerationRef.current === authority.draftGeneration, []);
  const captureDraftPaneAuthority = useCallback((): DraftPaneAuthority => ({
    navigationEpoch: navigationEpochRef.current,
    committedRevision: paneCommitRevisionRef.current,
    draftGeneration: draftGenerationRef.current,
  }), []);
  const draftAuthorityCanCommit = useCallback((authority: DraftPaneAuthority) =>
    navigationEpochRef.current === authority.navigationEpoch &&
    draftGenerationRef.current === authority.draftGeneration &&
    committedPaneIdentityRef.current.kind === "draft" &&
    paneCommitRevisionRef.current === authority.committedRevision, []);

  // Every session-scoped async action captures the selected view before await.
  // A later response may update that Session cache, but must never paint over a
  // different Session the user navigated to in the meantime.
  const captureViewOperation = () => capturePaneAuthority();
  const viewOperationIsCurrent = (operation: ReturnType<typeof capturePaneAuthority>) =>
    paneAuthorityCanCommit(operation) &&
    viewedSessionIdRef.current === operation.sessionId;

  /** The only coordinator gateway for an async continuation to paint a pane. */
  const commitPaneIfCurrent = (
    authority: PaneAuthoritySnapshot,
    action: Exclude<ConversationPaneAction, {
      type: "COMMIT_BOOTSTRAP" | "COMMIT_VIEW" | "RESET_DRAFT" | "CLEAR_PANE" | "DRAFT_WORKSPACE_SELECTED";
    }>,
  ): boolean => {
    if (!paneAuthorityCanCommit(authority)) return false;
    dispatchPane(action);
    return true;
  };
  const commitDraftIfCurrent = (
    authority: DraftPaneAuthority,
    action: Extract<ConversationPaneAction, {
      type: "DRAFT_WORKSPACE_SELECTED" | "DRAFT_PROMPT_REJECTED";
    }>,
  ): boolean => {
    if (!draftAuthorityCanCommit(authority)) return false;
    dispatchPane(action);
    return true;
  };
  paneAuthorityDispatchRef.current = commitPaneIfCurrent;

  // Bootstrap owns application-wide metadata. Keep it separate from the selected
  // view so a refresh can restore a remembered cold Session without briefly
  // committing the Primary Runtime's blank draft to the timeline.
  const applyBootstrapMetadata = useCallback((data: BootstrapData) => {
    // A remembered JSONL view can win the startup race. Only a bootstrap
    // inventory is allowed to establish sidebar rows in that initial gap.
    sidebarInventoryReadyRef.current = true;
    setSidebarInventoryReady(true);
    for (const session of data.sessions) {
      if (
        typeof session.turnCount === "number" &&
        Number.isFinite(session.turnCount)
      )
        recordSourceTurnTotal(session.id, session.turnCount);
    }
    const incoming = reconcileOptimisticSessions(data.sessions);
    setSessions((current) => {
      if (!showAllSessionsRef.current) return incoming;
      const updates = new Map(incoming.map((session) => [session.id, session]));
      return uniqueSessionSummaries(
        current
          .filter(
            (session) =>
              !optimisticDeletesRef.current.has(session.id) &&
              !confirmedDeletedSessionIdsRef.current.has(session.id),
          )
          .map((session) => updates.get(session.id) || session),
      );
    });
    setSessionsTotal(
      optimisticSessionsTotal(
        data.sessions,
        data.sessionsTotal ?? data.sessions.length,
      ),
    );
    setSessionDirectories(data.sessionDirectories || []);
    const activeId =
      data.activeSessionId ||
      data.sessions.find((session) => session.active)?.id ||
      "";
    setActiveSessionId(activeId);
    const hotIds = data.activeSessionIds || (activeId ? [activeId] : []);
    setActiveSessionIds(hotIds);
    viewCacheRef.current.setPinned(hotIds);
    // A recovering Runtime can briefly return an empty model inventory while
    // its selected Session model is already known. Retain the last usable
    // choices through that transient snapshot; ComposerControls also renders a
    // readable current-model fallback until the inventory catches up.
    if (data.models.length || !data.state.model) setModels(data.models);
    setWorkspaceCwd(data.workspaceCwd);
    const identity = data.buildIdentity || webBuildIdentity;
    setServerBuildIdentity(identity);
    setBuildIdentityMismatch(!buildIdentityMatches(identity));
    setPrimaryRuntime(
      data.primaryRuntime || { status: "starting", generation: 0 },
    );
    applicationLifecycleRef.current = data.applicationLifecycle || "idle";
    setApplicationLifecycle(data.applicationLifecycle || "idle");
  }, []);

  const applyBootstrap = useCallback(
    (data: BootstrapData, authority?: PaneAuthoritySnapshot) => {
      if (authority && !paneAuthorityCanCommit(authority)) return;
      const activeViewId =
        data.activeSessionId ||
        data.sessions.find((item) => item.active)?.id ||
        "";
      const activeViewSession = data.sessions.find(
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
            queue: data.queue,
            queuePaused: data.queuePaused,
            commands: data.commands,
            pendingExtensionRequest: data.pendingExtensionRequest,
          })
        : null;
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
      applyBootstrapMetadata(data);
      if (activeViewId) updateGateMode(activeViewId, data.gateMode);
      const staged = activeViewId
        ? pendingSessionPrefsRef.current.get(activeViewId)
        : undefined;
      commitPane({
        type: "COMMIT_BOOTSTRAP",
        pane: {
          ...emptyConversationPane(),
          identity: activeViewId
            ? { kind: "session", sessionId: activeViewId }
            : { kind: "none", sessionId: "" },
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
          commands: data.commands,
          queue: data.queue,
          queuePaused: data.queuePaused,
          toolStatus: data.toolStatus || "",
          extensionRequest: data.pendingExtensionRequest || null,
          runtimeStatus: "active",
          control: {
            controlOwner: data.controlOwner,
            controlledByThisWindow: data.controlledByThisWindow,
          },
        },
      });
    },
    [applyBootstrapMetadata, commitPane, paneAuthorityCanCommit, updateGateMode],
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

  const applySessionView = useCallback(
    (
      view: SessionViewData,
      authority?: ReturnType<typeof capturePaneAuthority> | DraftPaneAuthority,
    ) => {
      // A structural deletion is terminal. An already-resolved view continuation
      // must not recreate its cache, sidebar row, or selected pane.
      if (confirmedDeletedSessionIdsRef.current.has(view.session.id)) return;
      // The coordinator, not the reducer, proves that this result still belongs
      // to the visible pane. Session ID alone cannot protect A → B → A.
      if (authority && ("sessionId" in authority
        ? !paneAuthorityCanCommit(authority)
        : !draftAuthorityCanCommit(authority))) return;
      // Cache the source view before adding local UI overlays. A cached overlay has
      // a synthetic turnTotal and must never confirm that its own user message was
      // persisted when the user switches away and returns.
      const sourceView = viewCacheRef.current.remember(view);
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
      const paneAuthority = authority && "sessionId" in authority
        ? authority
        : capturePaneAuthority(view.session.id);
      const extensionRequest = pending && !tryAutoAllowGate(
        pending,
        view.session.id,
        paneAuthority,
      )
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
          // command discovery. Normalize that merge here; the reducer receives
          // only a complete pane projection and never inherits cross-Session data.
          commands: resolvedView.commands ?? (
            committedPaneIdentityRef.current.kind === "session" &&
            committedPaneIdentityRef.current.sessionId === resolvedView.session.id
              ? committedPaneCommandsRef.current
              : []
          ),
          queue: resolvedView.queue || [],
          queuePaused: resolvedView.queuePaused === true,
          toolStatus: resolvedView.toolStatus || "",
          extensionRequest,
          runtimeStatus: nextRuntimeStatus,
          control: {
            controlOwner: sourceView.controlOwner ?? sourceView.session.controlOwner,
            controlledByThisWindow:
              sourceView.controlledByThisWindow ?? sourceView.session.controlledByThisWindow,
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
      // A blank New draft has no persisted user message and intentionally stays
      // out of sidebar history until its first successful prompt. A remembered
      // Session may restore before bootstrap; update an existing row, but do not
      // turn that one restored pane into a fake one-item sidebar.
      if (view.session.messageCount > 0) {
        const summary = applyLocalTurnCount(normalizeSessionRunning(view.session));
        setSessions((current) => {
          const known = current.some((session) => session.id === summary.id);
          if (!known && !sidebarInventoryReadyRef.current) return current;
          return uniqueSessionSummaries(
            known
              ? current.map((session) =>
                  session.id === summary.id ? { ...session, ...summary } : session,
                )
              : [...current, summary],
          );
        });
      }
      if (view.isActive)
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
    ],
  );

  const ensureHandshake = useCallback(() => {
    if (handshakeInFlightRef.current) return handshakeInFlightRef.current;
    const request = api.handshake()
      .then((handshake) => {
        setServerBuildIdentity(handshake.buildIdentity);
        setBuildIdentityMismatch(!buildIdentityMatches(handshake.buildIdentity));
      })
      .finally(() => {
        if (handshakeInFlightRef.current === request) handshakeInFlightRef.current = null;
      });
    handshakeInFlightRef.current = request;
    return request;
  }, []);

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
    const refreshEpoch = ++refreshEpochRef.current;
    const navigationEpoch = navigationEpochRef.current;
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
    const bootstrapAuthority = wantedId
      ? capturePaneAuthority(wantedId)
      : undefined;
    let earlyViewRequest: Promise<SessionViewData> | null = null;
    let earlyViewAuthority: ReturnType<typeof capturePaneAuthority> | null = null;
    if (wantedId && !viewedSessionIdRef.current && !localDraftRef.current) {
      desiredSessionIdRef.current = wantedId;
      earlyViewAuthority = capturePaneAuthority(wantedId);
      if (initialHistoryRef.current?.id !== wantedId) {
        const request = ensureHandshake()
          .then(() => api.viewSession(wantedId))
          .finally(() => {
            if (initialHistoryRef.current?.request === request) initialHistoryRef.current = null;
          });
        initialHistoryRef.current = { id: wantedId, request };
      }
      earlyViewRequest = initialHistoryRef.current.request;
      void earlyViewRequest.then((view) => {
        if (
          navigationEpochRef.current !== navigationEpoch ||
          desiredSessionIdRef.current !== wantedId ||
          localDraftRef.current ||
          confirmedDeletedSessionIdsRef.current.has(wantedId) ||
          !earlyViewAuthority ||
          !paneAuthorityCanCommit(earlyViewAuthority)
        ) return;
        applySessionView(view, earlyViewAuthority);
      }).catch(() => undefined);
    }
    const data = await loadBootstrap();
    if (
      refreshEpochRef.current !== refreshEpoch ||
      navigationEpochRef.current !== navigationEpoch
    )
      return;
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
      applyBootstrapMetadata(data);
      setError((current) => (recoverableRefreshError(current) ? "" : current));
      return;
    }
    const activeId =
      data.activeSessionId ||
      data.sessions.find((session) => session.active)?.id ||
      "";
    if (wantedId && wantedId !== activeId) {
      desiredSessionIdRef.current = wantedId;
      try {
        const viewVersion = sessionEventVersionRef.current.get(wantedId) || 0;
        const viewAuthority = earlyViewAuthority || capturePaneAuthority(wantedId);
        const view = await (earlyViewRequest || api.viewSession(wantedId));
        if (
          refreshEpochRef.current !== refreshEpoch ||
          navigationEpochRef.current !== navigationEpoch ||
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
        applySessionView(view, viewAuthority);
        setError((current) =>
          recoverableRefreshError(current) ? "" : current,
        );
        return;
      } catch (cause) {
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
          applyBootstrap(data, bootstrapAuthority);
          throw cause;
        }
        desiredSessionIdRef.current = activeId;
      }
    }
    applyBootstrap(data, bootstrapAuthority);
    setError((current) => (recoverableRefreshError(current) ? "" : current));
  }, [applyBootstrap, applyBootstrapMetadata, applySessionView, capturePaneAuthority, ensureHandshake, loadBootstrap, paneAuthorityCanCommit]);

  const refreshSidebarSessions = useCallback(async () => {
    if (sessionRefreshInFlightRef.current) {
      sessionRefreshRequestedRef.current = true;
      return;
    }
    sessionRefreshInFlightRef.current = true;
    try {
      const result = await api.sessions(showAllSessionsRef.current);
      for (const session of result.sessions) {
        if (
          typeof session.turnCount === "number" &&
          Number.isFinite(session.turnCount)
        )
          recordSourceTurnTotal(session.id, session.turnCount);
      }
      setSessions(reconcileOptimisticSessions(result.sessions));
      setSessionsTotal(
        optimisticSessionsTotal(
          result.sessions,
          result.total ?? result.sessions.length,
        ),
      );
      setSessionDirectories(result.directories || []);
    } finally {
      sessionRefreshInFlightRef.current = false;
      if (sessionRefreshRequestedRef.current) {
        sessionRefreshRequestedRef.current = false;
        void refreshSidebarSessions().catch((cause) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
      }
    }
  }, []);

  const loadAllSessions = useCallback(async () => {
    if (showAllSessionsRef.current || loadingAllSessions) return;
    setLoadingAllSessions(true);
    setError("");
    try {
      const result = await api.sessions(true);
      for (const session of result.sessions) {
        if (
          typeof session.turnCount === "number" &&
          Number.isFinite(session.turnCount)
        )
          recordSourceTurnTotal(session.id, session.turnCount);
      }
      showAllSessionsRef.current = true;
      setSessions(reconcileOptimisticSessions(result.sessions));
      setSessionsTotal(
        optimisticSessionsTotal(
          result.sessions,
          result.total ?? result.sessions.length,
        ),
      );
      setSessionDirectories(result.directories || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingAllSessions(false);
    }
  }, [loadingAllSessions]);

  const scheduleSidebarRefresh = useCallback(() => {
    if (sessionRefreshTimerRef.current !== null)
      window.clearTimeout(sessionRefreshTimerRef.current);
    sessionRefreshTimerRef.current = window.setTimeout(() => {
      sessionRefreshTimerRef.current = null;
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
      for (const request of loadingEarlierRequestsRef.current.values()) request.controller.abort();
      cancelPendingNavigation();
    };
  }, [cancelPendingNavigation, refresh]);

  useEffect(() => {
    applyAppearance(appearance);
    saveAppearance(appearance);
  }, [appearance]);

  useEffect(() => saveSidebarOpen(sidebarOpen), [sidebarOpen]);
  useEffect(() => saveSidebarWidth(sidebarWidth), [sidebarWidth]);
  useEffect(() => saveSessionNavigationPreferences(sessionNavigation), [sessionNavigation]);

  // EventSource reconnects after a server restart, but it cannot replay events
  // missed while disconnected. Keep transport ownership in usePiEventSource;
  // this component remains responsible only for translating events into UI state.
  const handleEventSourceReady = useCallback(
    (rawEvent: Event, source: EventSource) => {
      lastEventFrameAtRef.current = Date.now();
      // EventSource readiness is a foreground signal when it arrives while the
      // document is visible. The lifecycle effect below keeps renewing it.
      if (document.visibilityState !== "hidden")
        void api.renewPresence().catch(() => undefined);
      const ready = parseEventData(rawEvent);
      const readyRunEpoch =
        typeof ready.piChatRunEpoch === "string" ? ready.piChatRunEpoch : "";
      if (readyRunEpoch && readyRunEpoch !== runEpochRef.current) {
        for (const lease of promptBusyReleasesRef.current.values()) {
          lease.markTerminal();
          lease.release();
        }
        promptBusyReleasesRef.current.clear();
        sessionRunGenerationsRef.current.clear();
        settledRunGenerationsRef.current.clear();
        runEpochRef.current = readyRunEpoch;
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
      void refresh()
        .then(() => {
          const id = viewedSessionIdRef.current;
          if (id) void api.markSessionViewed(id).catch(() => undefined);
        })
        .catch(reportBackgroundRefreshError);
    },
    [refresh, reportBackgroundRefreshError],
  );

  const handlePiEvent = useCallback(
    (rawEvent: Event, source: EventSource) => {
      lastEventFrameAtRef.current = Date.now();
      const event = parseEventData(rawEvent);
      const type = String(event.type || "");
      sseFloodCountRef.current = 0;
      if (type === "pi_chat_heartbeat") return;
      if (type === "pi_chat_sse_resync" || type === "pi_chat_oversized_event") {
        void refresh().catch(reportBackgroundRefreshError);
        return;
      }
      const eventSessionId =
        typeof event.piChatSessionId === "string"
          ? event.piChatSessionId
          : type === "pi_chat_session_control_changed" && typeof event.sessionId === "string"
            ? event.sessionId
            : "";
      const eventRunEpoch =
        typeof event.piChatRunEpoch === "string" ? event.piChatRunEpoch : "";
      if (
        eventRunEpoch &&
        runEpochRef.current &&
        eventRunEpoch !== runEpochRef.current
      )
        return;
      const eventRunGeneration =
        typeof event.piChatRunGeneration === "number" &&
        Number.isFinite(event.piChatRunGeneration)
          ? event.piChatRunGeneration
          : undefined;
      if (eventSessionId && typeof eventRunGeneration === "number") {
        const latest = sessionRunGenerationsRef.current.get(eventSessionId) || 0;
        const settled = settledRunGenerationsRef.current.get(eventSessionId) || 0;
        // A Pi turn is a monotonic lifecycle. Once a generation settles, every
        // non-terminal frame from it is stale, even if SSE/backpressure makes
        // it arrive after settlement. This prevents a late tool completion or
        // activity snapshot from reviving an already-cleared spinner.
        if (
          eventRunGeneration < latest ||
          (eventRunGeneration <= settled && type !== "agent_settled")
        )
          return;
        sessionRunGenerationsRef.current.set(eventSessionId, Math.max(latest, eventRunGeneration));
        if (type === "agent_settled")
          settledRunGenerationsRef.current.set(eventSessionId, Math.max(settled, eventRunGeneration));
      }
      // Only explicitly global frames may omit a Session ID. A malformed
      // session-scoped frame must never be interpreted as belonging to whatever
      // pane happens to be visible at that instant.
      if (isSessionScopedEvent(type) && !eventSessionId) return;
      // A destination is no longer allowed to paint updates from the source
      // pane while navigation is in flight. Its events still update that pane's
      // cache, ready for an immediate return.
      const viewingEventSession =
        Boolean(eventSessionId) &&
        eventSessionId === viewedSessionIdRef.current &&
        viewedSessionIdRef.current === desiredSessionIdRef.current;
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
          releasePromptBusy(
            eventSessionId,
            eventRunGeneration,
            eventRunEpoch,
          );
          sessionRunningOverridesRef.current.set(eventSessionId, true);
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? { ...session, running: true }
                : session,
            ),
          );
          patchSessionCache(eventSessionId, {
            isStreaming: true,
            toolStatus: "Pi 正在思考…",
            state: { isStreaming: true },
          });
        }
        if (viewingEventSession) {
          setRuntimeWarming(eventSessionId, false);
          dispatchPane({
            type: "AGENT_STARTED",
            sessionId: eventSessionId,
            toolStatus: "Pi 正在思考…",
          });
        }
      } else if (type === "compaction_start") {
        if (eventSessionId)
          patchSessionCache(eventSessionId, {
            state: { isCompacting: true },
          });
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
        if (eventSessionId)
          patchSessionCache(eventSessionId, {
            toolStatus: "",
            state: { isCompacting: false },
          });
        if (viewingEventSession) {
          dispatchPane({ type: "COMPACTION_FINISHED", sessionId: eventSessionId });
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
            const authority = capturePaneAuthority(eventSessionId);
            void api
              .viewSession(eventSessionId)
              .then((view) => {
                if (
                  paneAuthorityCanCommit(authority) &&
                  (sessionEventVersionRef.current.get(eventSessionId) || 0) ===
                    requestVersion
                )
                  applySessionView(view, authority);
              })
              .catch(() => undefined);
          }
        }
      } else if (type === "message_start" || type === "message_update") {
        const assistant = assistantMessage(event);
        if (assistant && eventSessionId) {
          releasePromptBusy(
            eventSessionId,
            eventRunGeneration,
            eventRunEpoch,
          );
          updateLiveSessionCache(eventSessionId, assistant);
        }
        // Only the selected destination is allowed to turn an SSE draft into a
        // React update. Off-screen panes retain their latest draft in cache.
        if (assistant && viewingEventSession)
          scheduleLiveMessage({
            message: assistant,
            authority: capturePaneAuthority(eventSessionId),
          });
      } else if (type === "message_end") {
        const terminal =
          event.message && typeof event.message === "object"
            ? (event.message as PiMessage)
            : null;
        if (terminal?.role === "assistant") {
          if (eventSessionId)
            releasePromptBusy(
              eventSessionId,
              eventRunGeneration,
              eventRunEpoch,
            );
          const pendingAssistant = viewingEventSession
            ? drainPendingLiveMessage()?.message || null
            : null;
          const terminalAssistant = assistantMessage(event);
          const assistant = hasAssistantPayload(terminalAssistant)
            ? terminalAssistant
            : pendingAssistant || terminalAssistant;
          if (assistant && eventSessionId) {
            terminalAssistantSessionIdsRef.current.add(eventSessionId);
            appendTerminalSessionCache(eventSessionId, assistant);
          }
          if (viewingEventSession && assistant)
            dispatchPane({
              type: "TERMINAL_MESSAGE_COMMITTED",
              sessionId: eventSessionId,
              message: assistant,
            });
          else if (viewingEventSession)
            dispatchPane({
              type: "LIVE_MESSAGE_UPDATED",
              sessionId: eventSessionId,
              message: null,
            });
        } else {
          // User message_end is a transport echo of the prompt. The sender's
          // LocalUserTurn and the later JSONL view already own that row; caching
          // this echo can duplicate it when Pi assigns a nearby timestamp.
          if (terminal && terminal.role !== "user" && eventSessionId)
            appendTerminalSessionCache(eventSessionId, terminal);
          if (viewingEventSession && terminal?.role === "toolResult")
            dispatchPane({
              type: "TOOL_RESULT_COMMITTED",
              sessionId: eventSessionId,
              message: terminal,
            });
        }
      } else if (type === "tool_execution_start") {
        const status = `正在运行工具：${String(event.toolName || "unknown")}`;
        if (eventSessionId)
          patchSessionCache(eventSessionId, { toolStatus: status });
        if (viewingEventSession)
          dispatchPane({
            type: "TOOL_STATUS_UPDATED",
            sessionId: eventSessionId,
            status,
          });
      } else if (type === "tool_execution_end") {
        const status = `${String(event.toolName || "工具")} ${event.isError ? "执行失败" : "已完成，Pi 正在继续…"}`;
        if (eventSessionId)
          patchSessionCache(eventSessionId, { toolStatus: status });
        if (viewingEventSession)
          dispatchPane({
            type: "TOOL_STATUS_UPDATED",
            sessionId: eventSessionId,
            status,
          });
      } else if (type === "agent_settled") {
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
        if (viewingEventSession) {
          if (promptReconcileTimerRef.current !== null)
            window.clearTimeout(promptReconcileTimerRef.current);
          promptReconcileTimerRef.current = null;
          dispatchPane({ type: "AGENT_SETTLED", sessionId: eventSessionId });
          // A post-compaction turn has now persisted its new usage snapshot.
          const requestVersion =
            sessionEventVersionRef.current.get(eventSessionId) || 0;
          const authority = capturePaneAuthority(eventSessionId);
          void api
            .viewSession(eventSessionId)
            .then((view) => {
              if (
                paneAuthorityCanCommit(authority) &&
                (sessionEventVersionRef.current.get(eventSessionId) || 0) ===
                  requestVersion
              )
                applySessionView(view, authority);
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
          const next = readiness as PrimaryRuntimeReadiness;
          setPrimaryRuntime((current) =>
            next.generation >= current.generation ? next : current,
          );
          // Capability metadata becomes available after the Session-first shell
          // is already usable. Refresh it in the background without replacing a
          // selected cold pane (refresh keeps desired/viewed guards).
          if (next.status === "ready")
            void refresh().catch(reportBackgroundRefreshError);
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
          setNotice("");
          void refresh().catch(reportBackgroundRefreshError);
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
        const currentQueue = Array.isArray(event.queue)
          ? (event.queue as unknown as QueuedPrompt[])
          : [];
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
                ? { ...session, queued: currentQueue.length > 0 }
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
            messages: removeAdmittedTurn && turn
              ? ((current) => current.filter((candidate) => candidate !== turn.message))
              : undefined,
            pendingUserMessage: turn
              ? ((current) => current === turn.message ? null : current)
              : undefined,
          });
      } else if (type === "pi_chat_queue_dispatch") {
        const dispatchedId = typeof event.id === "string" ? event.id : "";
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
              pendingUserMessage: (current) =>
                current === knownLocally.message ? null : current,
              messages: shouldAppend
                ? ((current) => current.includes(knownLocally.message)
                  ? current
                  : [...current, knownLocally.message])
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
              messages: (current) => [...current, message],
            });
        }
        if (eventSessionId)
          patchSessionCache(eventSessionId, {
            state: { isStreaming: true },
            isStreaming: true,
          });
      } else if (type === "pi_chat_queue_error") {
        const currentQueue = Array.isArray(event.queue)
          ? (event.queue as unknown as QueuedPrompt[])
          : [];
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
        if (eventSessionId)
          patchSessionCache(eventSessionId, {
            ...(currentQueue.length ? { queue: currentQueue } : null),
            ...(event.paused === true ? { queuePaused: true } : null),
            state: { isStreaming: false },
            isStreaming: false,
            liveMessage: undefined,
            toolStatus: "",
          });
        if (viewingEventSession) {
          dispatchPane({
            type: "QUEUE_FAILED",
            sessionId: eventSessionId,
            ...(currentQueue.length ? { queue: currentQueue } : null),
            ...(event.paused === true ? { paused: true } : null),
            messages: (current) => current.filter((candidate) =>
              !failedRenderedTurns.has(candidate),
            ),
            pendingUserMessage: null,
          });
          setError(String(event.error || "队列消息发送失败"));
        }
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
            if (!authority || !tryAutoAllowGate(request, sessionId, authority, true))
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
        const activity = event.activity as Partial<SessionActivityState> | undefined;
        if (
          eventSessionId && activity &&
          ["idle", "queued", "dispatching", "running", "paused", "failed"].includes(String(activity.execution)) &&
          typeof activity.awaitingConfirmation === "boolean"
        ) {
          const next = activity as SessionActivityState;
          applySessionActivity(eventSessionId, next);
          const streaming = next.execution === "running" || next.execution === "dispatching";
          patchSessionCache(eventSessionId, { isStreaming: streaming, state: { isStreaming: streaming } });
        } else if (eventSessionId && typeof event.running === "boolean") {
          // Older servers still publish this partial event during a rolling update.
          const running = event.running === true;
          sessionRunningOverridesRef.current.set(eventSessionId, running);
          setSessions((current) => current.map((session) => session.id === eventSessionId ? { ...session, running } : session));
          patchSessionCache(eventSessionId, { isStreaming: running, state: { isStreaming: running } });
        }
      } else if (type === "pi_chat_process_recovered") {
        if (eventSessionId)
          setFailedSessionIds((current) =>
            current.filter((id) => id !== eventSessionId),
          );
      } else if (type === "pi_chat_process_error") {
        if (eventSessionId) {
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
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? { ...session, running: false }
                : session,
            ),
          );
          patchSessionCache(eventSessionId, {
            isStreaming: false,
            liveMessage: undefined,
            toolStatus: "",
            runtimeStatus: "view-only",
            state: { isStreaming: false, isCompacting: false },
          });
        }
        if (viewingEventSession) {
          if (promptReconcileTimerRef.current !== null)
            window.clearTimeout(promptReconcileTimerRef.current);
          promptReconcileTimerRef.current = null;
          dispatchPane({ type: "PROCESS_FAILED", sessionId: eventSessionId });
          setError(String(event.error || "Pi RPC 已退出"));
          stoppingRef.current = false;
          setStopping(false);
        }
      }
    },
    [
      applySessionView,
      cancelPendingNavigation,
      drainPendingLiveMessage,
      refresh,
      reportBackgroundRefreshError,
      scheduleLiveMessage,
      scheduleSidebarRefresh,
      setRuntimeWarming,
      releasePromptBusy,
      tryAutoAllowGate,
      updateGateMode,
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
          setError("");
          setEventSourceGeneration((generation) => generation + 1);
          return refresh();
        })
        .catch((cause) => {
          reportBackgroundRefreshError(cause);
          recoveringConnectionRef.current = null;
        });
    },
    [refresh, reportBackgroundRefreshError],
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
        relinquishPresence();
        return;
      }
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
    const signalWindowClose = () => {
      relinquishPresence();
      // `pagehide` is not a reliable close signal for installed/frozen PWAs:
      // some hosts emit it while merely backgrounding a renderer. Treating it
      // as a final close can turn a hidden long-running task into a service
      // shutdown. `unload` is deliberately narrower. If a platform cannot
      // deliver it, the conservative outcome is an idle local service rather
      // than stopping a Pi worker that may still be doing work.
      api.signalWindowClose();
    };
    window.addEventListener("blur", pausePresenceRenewal);
    window.addEventListener("unload", signalWindowClose);
    return () => {
      window.clearInterval(watchdog);
      window.clearInterval(presenceRenewal);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("blur", pausePresenceRenewal);
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
    void api.markSessionViewed(viewedSessionId).catch(() => undefined);
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
    new Map<string, { token: symbol; navigationEpoch: number; controller: AbortController }>(),
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
      const requestStartRevision = viewCacheRef.current.revisionFor(id);
      let view: SessionViewData;
      try {
        // A normal hot-runtime view also probes state, stats, and commands. Those
        // RPC reads can queue behind a long tool turn, leaving this button looking
        // permanently busy although the parsed in-memory history is already ready.
        // Prefer the RPC-free hot-memory snapshot, then use the JSONL-only view for
        // cold/reclaimed Sessions or an incomplete hot history.
        view = await api.viewSession(id, requestedTurns, { fast: true, signal: controller.signal });
        const visible = view.visibleTurnCount ?? 0;
        if (
          view.historyPending ||
          (view.turnTotal ?? 0) < turnTotal ||
          (view.messagesTruncated && visible <= visibleTurnCount)
        )
          throw new ApiRequestError("热会话历史尚未就绪", 409, "HOT_VIEW_UNAVAILABLE");
      } catch (cause) {
        if (
          !(cause instanceof ApiRequestError) ||
          cause.code !== "HOT_VIEW_UNAVAILABLE"
        )
          throw cause;
        view = await api.viewSession(id, requestedTurns, { signal: controller.signal });
      }
      if (!paneAuthorityCanCommit(authority)) return;
      // Events received while a historical page is loading are already held in
      // the pane cache. Do not discard a successful page merely because a live
      // status/tool frame arrived; merge it through the cache below instead.
      const eventVersion = sessionEventVersionRef.current.get(id) || 0;
      const loadedView =
        eventVersion === requestVersion
          ? view
          : viewCacheRef.current.mergeNavigation(view, requestStartRevision);
      applySessionView(loadedView, authority);
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
      if (
        loadingEarlierRequestsRef.current.get(id)?.token === requestToken
      ) {
        loadingEarlierRequestsRef.current.delete(id);
        setLoadingEarlierRevision((current) => current + 1);
      }
    }
  }, [applySessionView, capturePaneAuthority, messagesTruncated, paneAuthorityCanCommit, turnTotal, visibleTurnCount]);

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
      void api
        .viewSession(sessionId)
        .then((view) => {
          if (!paneAuthorityCanCommit(authority)) return;
          const completedVersion =
            sessionEventVersionRef.current.get(sessionId) || 0;
          if (completedVersion !== latestVersion) {
            schedulePromptReconcile(sessionId, completedVersion);
            return;
          }
          applySessionView(view, authority);
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

  const send = async (message: string, images: PromptImage[]) => {
    if (buildIdentityMismatch) return;
    setError("");
    stickToBottomRef.current = true;
    const initialSessionId =
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
      alreadyStreaming || queuePaused || queue.length > 0;
    const previousToolStatus = toolStatus;
    const optimisticMessage =
      willQueueLocally || message.startsWith("/")
        ? null
        : userMessage(message, images);
    const localTurn = optimisticMessage || userMessage(message, images);
    let targetSessionId = viewedSessionIdRef.current;
    let promptAuthority: ReturnType<typeof capturePaneAuthority> | null =
      targetSessionId ? capturePaneAuthority(targetSessionId) : null;
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
      if (!turn || !targetSessionId || protectedLocalTurn)
        return protectedLocalTurn;
      const pending = localUserTurnsRef.current.get(targetSessionId) || [];
      protectedLocalTurn = {
        sessionId: targetSessionId,
        message: turn,
        expectedTurnTotal: nextLocalTurnTotal(messages, turnTotal, pending),
        queueState:
          willQueueLocally && !message.startsWith("/") ? "waiting" : undefined,
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
        if (runtimeStatus !== "active") {
          const authority = captureViewOperation();
          dispatchPane({
            type: "RUNTIME_STATUS_CHANGED",
            sessionId: authority.sessionId,
            status: "restoring",
          });
          const view = await api.activateSession(viewedSessionId);
          viewCacheRef.current.forget(view.session.id);
          if (viewOperationIsCurrent(authority)) applySessionView(view, authority);
          else rememberSessionView(view);
        }
        await api.compact(command[2] || "", viewedSessionId);
        await refresh();
        setNotice("上下文压缩完成");
        return;
      }
      if (command?.[1] === "abort") {
        await stopGeneration();
        return;
      }

      // Preferences chosen while cold/draft are local until the first send starts a Runtime.
      const prefsKey = localDraftRef.current
        ? DRAFT_PREFS_KEY
        : targetSessionId;
      const staged = pendingSessionPrefsRef.current.get(prefsKey);
      let preferredModel =
        staged?.model !== undefined ? staged.model : state.model;
      let preferredThinking =
        staged?.thinkingLevel !== undefined
          ? staged.thinkingLevel
          : (state.thinkingLevel as ThinkingLevel | undefined);
      let initialPromptResult: Awaited<ReturnType<typeof api.prompt>> | null = null;
      if (localDraftRef.current) {
        const draftAuthority = captureDraftPaneAuthority();
        dispatchPane({
          type: "PROMPT_PREPARING",
          target: { kind: "draft" },
          status: "正在准备 Pi，消息会自动发送…",
        });
        // Once the combined mutation is written its outcome may be unknown;
        // retain the protected local bubble until SSE/JSONL proves otherwise.
        promptSubmitted = true;
        await clearViewedPromiseRef.current;
        clearViewedPromiseRef.current = null;
        // One host transaction owns the empty draft through model/thinking/Gate
        // setup and prompt acceptance. Do not expose three extra browser round
        // trips after the dedicated Runtime has just cold-started.
        const submitNewSession = api.submitNewSession || (async (input: { cwd?: string; message: string; images: PromptImage[]; model?: ModelInfo | null; thinkingLevel?: ThinkingLevel; gateMode?: GateMode }) => {
          const view = await api.newSession(input.cwd);
          await api.prompt(input.message, input.images, view.session.id, input.gateMode);
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
        targetSessionId = initial.sessionId;
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
            status: "Pi 正在思考…",
            clearPending: true,
          });
        } else rememberSessionView(initialView);
        pendingSessionPrefsRef.current.delete(DRAFT_PREFS_KEY);
        // Preserve the ordinary acknowledgement/optimistic-turn path below;
        // only the transport setup was collapsed into this first request.
        initialPromptResult = initial;
      } else if (runtimeStatus !== "active") {
        const activationAuthority = capturePaneAuthority(targetSessionId);
        dispatchPane({
          type: "PROMPT_PREPARING",
          target: { kind: "session", sessionId: targetSessionId },
          status: "正在准备 Pi，消息会自动发送…",
          runtimeStatus: "restoring",
        });
        protectLocalPrompt();
        promptAuthority = activationAuthority;
        // A selected cold Session is normally already warming in the
        // background. Await only its minimal capability promise; do not turn
        // the first prompt into a full history/stats/commands activation.
        const ready = await warmSessionRuntime(targetSessionId);
        // The pane state is optimistic while cold. Compare staged settings to
        // the Runtime state proven by /warm, not to that optimistic snapshot;
        // otherwise a selection made during warm can be skipped accidentally.
        const latestStaged = pendingSessionPrefsRef.current.get(targetSessionId);
        preferredModel = latestStaged?.model !== undefined ? latestStaged.model : preferredModel;
        preferredThinking = latestStaged?.thinkingLevel !== undefined
          ? latestStaged.thinkingLevel
          : preferredThinking;
        const activationIsCurrent = applyWarmReadiness(
          targetSessionId,
          ready,
          activationAuthority,
        );
        if (activationIsCurrent)
          commitPaneIfCurrent(activationAuthority, {
            type: "PROMPT_PREPARING",
            target: { kind: "session", sessionId: targetSessionId },
            status: "Pi 已就绪，正在发送消息…",
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
          commitPaneIfCurrent(activationAuthority, {
            type: "SETTINGS_CONFIRMED",
            sessionId: targetSessionId,
            state: { model: selected.model },
          });
        }
        if (preferredThinking && ready.state.thinkingLevel !== preferredThinking) {
          const selected = await api.setThinking(
            preferredThinking,
            targetSessionId,
          );
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
            status: "正在向 Pi 提交消息…",
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
      const result = initialPromptResult || await api.prompt(
        message,
        images,
        targetSessionId,
        requestedGateMode,
      );
      // HTTP acceptance can mean the prompt was queued, before Gate reaches its
      // dispatch boundary. Retain the staged display/send intent until the
      // matching Runtime-confirmed Gate SSE arrives.
      // A late acknowledgement is useful for backend reconciliation, but it
      // cannot write into a later A pane after A → B → A.
      if (!promptPaneIsCurrent()) {
        scheduleSidebarRefresh();
        return;
      }
      // Extension commands do not create an ordinary user turn. Queued prompts
      // do: retain their local bubble immediately, then match its dispatch by ID.
      if (result.extension && protectedLocalTurn) {
        const pending = localUserTurnsRef.current.get(targetSessionId) || [];
        const remaining = removeLocalTurnAndRebase(pending, protectedLocalTurn);
        if (remaining.length)
          localUserTurnsRef.current.set(targetSessionId, remaining);
        else localUserTurnsRef.current.delete(targetSessionId);
        protectedLocalTurn = null;
      }
      const acceptedLocalTurn = localTurnEntry();
      if (result.queued && acceptedLocalTurn && typeof result.id === "string") {
        // Dispatch SSE may beat this acknowledgement. Never demote a turn that
        // the scheduler has already started into the waiting-only queue UI.
        markLocalTurnQueued(acceptedLocalTurn, result.id);
      } else if (!result.extension && acceptedLocalTurn) {
        acceptedLocalTurn.queueState = "dispatched";
      }
      if (!result.extension && acceptedLocalTurn) {
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
                  ...commands,
                  {
                    name: result.command || "extension",
                    description: result.description,
                    source: "extension",
                  },
                ]
              : commands,
          ),
        );
      } else if (result.queued) {
        // A waiting prompt belongs only in PromptQueue. The dispatch event is
        // the single transition that makes its local user bubble visible.
        const queuedTurn = localTurnEntry();
        const removeQueuedTurn =
          queuedTurn?.queueState === "waiting" && queuedTurn.renderedInTranscript;
        if (removeQueuedTurn) queuedTurn.renderedInTranscript = false;
        // A dispatch event can beat this HTTP acknowledgement. In that race the
        // response contains the old enqueue snapshot, so SSE remains authoritative.
        commitPaneIfCurrent(promptAuthority!, {
          type: "PROMPT_ACKNOWLEDGED",
          sessionId: targetSessionId,
          ...(removeQueuedTurn
            ? { messages: (current) => current.filter((candidate) => candidate !== queuedTurn!.message) }
            : null),
          ...(result.queue && queuedTurn?.queueState !== "dispatched"
            ? { queue: result.queue }
            : null),
          toolStatus: alreadyStreaming ? previousToolStatus : "",
        });
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
            messages: (current) => appendLocalTurnOnce(current, localTurnEntry()),
          });
          try {
            const requestVersion =
              sessionEventVersionRef.current.get(targetSessionId) || 0;
            const view = await api.viewSession(targetSessionId);
            if (
              promptAuthority &&
              paneAuthorityCanCommit(promptAuthority) &&
              (sessionEventVersionRef.current.get(targetSessionId) || 0) ===
                requestVersion
            )
              applySessionView(view, promptAuthority);
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
            messages: (current) => appendLocalTurnOnce(current, localTurnEntry()),
            isStreaming: true,
            toolStatus: "Pi 正在思考…",
          });
          schedulePromptReconcile(targetSessionId);
        }
      }
    } catch (cause) {
      // Failure recovery changes pending rows, transcript, spinner, and error
      // presentation. Bind it to the exact pre-request pane as well.
      if (!promptPaneIsCurrent()) {
        scheduleSidebarRefresh();
        return;
      }
      const localEntry = localTurnEntry();
      const explicitClientRejection =
        cause instanceof ApiRequestError &&
        cause.status >= 400 &&
        cause.status < 500;
      const outcomeUnknown =
        promptSubmitted &&
        (promptAcceptedByEvent ||
          promptTerminalByEvent ||
          !explicitClientRejection);
      let rejectionMessages:
        | PiMessage[]
        | ((current: PiMessage[]) => PiMessage[])
        | undefined;
      if (localEntry && outcomeUnknown) {
        // The request body reached the prompt endpoint, but its acknowledgement
        // may have been lost after Pi accepted it. SSE or JSONL will confirm the
        // protected row; deleting it here makes an actively running prompt vanish.
        localEntry.queueState = "dispatched";
        rejectionMessages = (current) => appendLocalTurnOnce(current, localEntry);
        schedulePromptReconcile(targetSessionId);
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
      const visibleFailure = promptAuthority
        ? commitPaneIfCurrent(promptAuthority, {
            type: "PROMPT_REJECTED",
            sessionId: targetSessionId,
            ...(rejectionMessages ? { messages: rejectionMessages } : null),
            toolStatus:
              !state.isStreaming && !promptAcceptedByEvent ? "" : undefined,
          })
        : Boolean(
            promptDraftAuthority &&
            commitDraftIfCurrent(promptDraftAuthority, {
              type: "DRAFT_PROMPT_REJECTED",
            }),
          );
      if (visibleFailure) {
        const messageText =
          cause instanceof Error ? cause.message : String(cause);
        setError(messageText);
      }
      if (visibleFailure && !outcomeUnknown) throw cause;
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
    if (buildIdentityMismatch || stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    setError("");
    const operation = captureViewOperation();
    try {
      const result = await api.abort(operation.sessionId);
      patchSessionCache(operation.sessionId, {
        state: { isStreaming: result.isStreaming },
        isStreaming: result.isStreaming,
        queuePaused: result.queuePaused,
        ...(result.isStreaming
          ? null
          : { liveMessage: undefined, toolStatus: "" }),
      });
      if (!result.isStreaming) {
        sessionRunningOverridesRef.current.set(operation.sessionId, false);
        setSessions((current) => current.map((session) =>
          session.id === operation.sessionId ? settleSidebarActivity(session) : session,
        ));
      }
      if (!commitPaneIfCurrent(operation, {
        type: "STOP_COMPLETED",
        sessionId: operation.sessionId,
        isStreaming: result.isStreaming,
        queuePaused: result.queuePaused,
      })) return;
      if (!result.isStreaming) {
        // Never await full bootstrap/refresh here: while the worker is still
        // draining after abort, get_messages/bootstrap can hang for the full
        // API timeout and leave the UI stuck on "停止中…".
        scheduleSidebarRefresh();
        const requestVersion =
          sessionEventVersionRef.current.get(operation.sessionId) || 0;
        void api
          .viewSession(operation.sessionId)
          .then((view) => {
            if (
              viewOperationIsCurrent(operation) &&
              (sessionEventVersionRef.current.get(operation.sessionId) || 0) ===
                requestVersion
            )
              applySessionView(view, operation);
            else rememberSessionView(view);
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
      stoppingRef.current = false;
      setStopping(false);
    }
  };

  const viewSession = async (id: string) => {
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
    for (const request of loadingEarlierRequestsRef.current.values()) request.controller.abort();
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
      applySessionView({ ...cached, viewSource: "browser-cache" }, navigationAuthority);
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
        Date.now() - cached.cachedAt >= 15_000
      );
      if (!needsReconcile) return;
      const requestVersion = sessionEventVersionRef.current.get(id) || 0;
      void api
        .viewSession(id, rememberedTurns, { signal: controller.signal })
        .then((view) => {
          if (
            confirmedDeletedSessionIdsRef.current.has(id) ||
            !paneAuthorityCanCommit(reconcileAuthority)
          )
            return;
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
            const patched = refreshSessionCache(id, view);
            if (patched) applySessionView(patched, reconcileAuthority);
          } else applySessionView(view, reconcileAuthority);
        })
        .catch(() => undefined);
      return;
    }
    // Preserve the reading grid and composer layout while the first target view
    // arrives. The loading pane replaces only Timeline content, so the prior
    // conversation cannot masquerade as the target and no empty-state reflow occurs.
    setPaneLoading({
      sessionId: id,
      name: sessions.find((session) => session.id === id)?.name || "对话",
    });
    // The source pane remains committed while this target view loads. Its
    // Runtime projection must not be overwritten with the target's status.
    try {
      const requestStartRevision = viewCacheRef.current.revisionFor(id);
      const hot = activeSessionIds.includes(id);
      let view: SessionViewData;
      try {
        view = await api.viewSession(id, rememberedTurns, {
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
        view = await api.viewSession(id, rememberedTurns, {
          signal: controller.signal,
        });
      }
      if (
        confirmedDeletedSessionIdsRef.current.has(id) ||
        !paneAuthorityCanCommit(navigationAuthority)
      )
        return;
      pendingScrollRestoreRef.current = id;
      const committed = viewCacheRef.current.mergeNavigation(view, requestStartRevision);
      applySessionView(committed, navigationAuthority);
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
    // A New draft supersedes both kinds of native picker. A late response must
    // not alter either this draft or the default it inherited.
    draftWorkspacePickerTokenRef.current = null;
    workspaceDefaultPickerTokenRef.current = null;
    setWorkspacePicking(false);
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
          ...(pendingSessionPrefsRef.current.get(sessionId)?.thinkingLevel !== undefined
            ? { thinkingLevel: pendingSessionPrefsRef.current.get(sessionId)!.thinkingLevel }
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

  function joinWarmPane(
    sessionId: string,
    authority: PaneAuthoritySnapshot,
  ) {
    const warm = warmingRuntimeStartsRef.current.get(sessionId);
    if (!warm) return;
    void warm
      .then((ready) => {
        applyWarmReadiness(sessionId, ready, authority, true);
      })
      .catch((cause) => {
        if (!commitPaneIfCurrent(authority, {
          type: "RUNTIME_FAILED",
          sessionId,
        })) return;
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
      setRuntimeWarming(sessionId, true);
      const start = api
        .warmSession(sessionId)
        .then((ready) => {
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
          if (warmingRuntimeStartsRef.current.get(sessionId) === start)
            warmingRuntimeStartsRef.current.delete(sessionId);
          setRuntimeWarming(sessionId, false);
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

  const stageSessionPref = (patch: {
    model?: ModelInfo | null;
    thinkingLevel?: ThinkingLevel;
  }) => {
    const key = localDraftRef.current ? DRAFT_PREFS_KEY : viewedSessionId;
    if (!key) return;
    const current = pendingSessionPrefsRef.current.get(key) || {};
    pendingSessionPrefsRef.current.set(key, { ...current, ...patch });
  };

  const changeModel = async (provider: string, modelId: string) => {
    if (buildIdentityMismatch || !provider || !modelId || settingsBusy) return;
    const model = models.find(
      (candidate) =>
        candidate.provider === provider && candidate.id === modelId,
    );
    // Cold history and local New drafts only stage preferences until the first send.
    if (localDraftRef.current || runtimeStatus !== "active") {
      if (model) {
        stageSessionPref({ model });
        dispatchPane({
          type: "PREFERENCES_STAGED",
          target: localDraftRef.current
            ? { kind: "draft" }
            : { kind: "session", sessionId: viewedSessionIdRef.current },
          model,
        });
      }
      setNotice(`已选择 ${model?.name || modelId}，发送时生效`);
      return;
    }
    const operation = captureViewOperation();
    setSettingsBusy(true);
    setError("");
    try {
      const result = await api.setModel(provider, modelId, operation.sessionId);
      patchSessionCache(operation.sessionId, {
        state: { model: result.model },
      });
      if (!commitPaneIfCurrent(operation, {
        type: "SETTINGS_CONFIRMED",
        sessionId: operation.sessionId,
        state: { model: result.model },
      })) return;
      setNotice(
        result.pending
          ? `已选择 ${result.model?.name || modelId}，下一轮对话生效`
          : `已切换到 ${result.model?.name || modelId}`,
      );
    } catch (cause) {
      if (viewOperationIsCurrent(operation))
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsBusy(false);
    }
  };

  const changeThinking = async (level: ThinkingLevel) => {
    if (buildIdentityMismatch || settingsBusy) return;
    if (localDraftRef.current || runtimeStatus !== "active") {
      stageSessionPref({ thinkingLevel: level });
      dispatchPane({
        type: "PREFERENCES_STAGED",
        target: localDraftRef.current
          ? { kind: "draft" }
          : { kind: "session", sessionId: viewedSessionIdRef.current },
        thinkingLevel: level,
      });
      setNotice(`已选择 ${level} 思考强度，发送时生效`);
      return;
    }
    const operation = captureViewOperation();
    setSettingsBusy(true);
    setError("");
    try {
      const result = await api.setThinking(level, operation.sessionId);
      patchSessionCache(operation.sessionId, {
        state: { thinkingLevel: result.level },
      });
      if (!commitPaneIfCurrent(operation, {
        type: "SETTINGS_CONFIRMED",
        sessionId: operation.sessionId,
        state: { thinkingLevel: result.level },
      })) return;
      setNotice(
        result.pending
          ? `已选择 ${result.level}，下一轮对话生效`
          : `思考强度已切换为 ${result.level}`,
      );
    } catch (cause) {
      if (viewOperationIsCurrent(operation))
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsBusy(false);
    }
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
      ) return;
      commitDraftIfCurrent(authority, {
        type: "DRAFT_WORKSPACE_SELECTED",
        cwd: result.cwd,
      });
      setNotice(`新对话将使用工作目录：${result.cwd}`);
    } catch (cause) {
      if (
        draftWorkspacePickerTokenRef.current === token &&
        draftAuthorityCanCommit(authority)
      ) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (draftWorkspacePickerTokenRef.current === token) {
        draftWorkspacePickerTokenRef.current = null;
        setWorkspacePicking(false);
      }
    }
  };

  const pickDefaultWorkspace = async () => {
    if (workspacePicking || mutationBlocked) return;
    const token = Symbol("default-workspace-picker");
    workspaceDefaultPickerTokenRef.current = token;
    setWorkspacePicking(true);
    setError("");
    setNotice("请在弹出的 Windows 窗口中选择默认工作路径");
    try {
      const result = await api.pickWorkspace();
      if (workspaceDefaultPickerTokenRef.current !== token || result.cancelled || !result.data) return;
      // This is global metadata only. A pending draft can have its own selected
      // cwd, and an existing Runtime always keeps its immutable Session cwd.
      applyBootstrapMetadata(result.data);
      setNotice(`以后新建的对话将使用工作目录：${result.data.workspaceCwd}`);
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
    const result = await api.sessions(true);
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
    return { outcome, result } as const;
  };

  const applySessionListSnapshot = (result: {
    sessions: SessionSummary[];
    total: number;
  }) => {
    setSessions(reconcileOptimisticSessions(result.sessions));
    setSessionsTotal(optimisticSessionsTotal(result.sessions, result.total));
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
    setSessionNavigation((current) => ({
      ...current,
      pinnedSessionIds: current.pinnedSessionIds.filter((id) => id !== sessionId),
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
      (viewedSessionIdRef.current && viewedSessionIdRef.current !== deletedId) ||
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
    const result = await api.sessions(true);
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
    applySessionListSnapshot(result);
    for (const absent of absentRenames)
      selectDeletionFallback(absent.id, result.sessions, absent.wasViewed);
  };

  const refreshManually = async () => {
    setRefreshing(true);
    setError("");
    try {
      await refresh();
      await reconcilePendingSessionMutations();
      setNotice("会话已刷新");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  };

  const restartPi = async () => {
    // A mismatched bundle has stale browser state by definition. Let the server
    // make the final quiescence decision rather than trapping recovery behind a
    // possibly stale sidebar activity projection.
    if (busy || lifecycleBlocked || (!buildIdentityMismatch && (anySessionRunning || anySessionQueued || anySessionPendingConfirmation))) return;
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
    if (busy || lifecycleBlocked || (!buildIdentityMismatch && (anySessionRunning || anySessionQueued || anySessionPendingConfirmation))) return;
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
        optimisticRenamesRef.current.delete(sessionId);
        syncMutatingSessionIds();
        applyBootstrapMetadata(data);
        setNotice("对话已重命名");
      })
      .catch(async (cause) => {
        const pending = optimisticRenamesRef.current.get(sessionId);
        if (!pending || pending.token !== token) return;
        try {
          const { outcome, result } = await reconcileSessionMutation(
            sessionId,
            "rename",
            name,
          );
          if (optimisticRenamesRef.current.get(sessionId)?.token !== token)
            return;
          if (outcome === "committed") {
            optimisticRenamesRef.current.delete(sessionId);
            syncMutatingSessionIds();
            applySessionListSnapshot(result);
            setNotice("对话已重命名");
            return;
          }
          if (outcome === "absent") {
            const wasViewed = finalizeDeletedSession(sessionId);
            applySessionListSnapshot(result);
            selectDeletionFallback(sessionId, result.sessions, wasViewed);
            setError("重命名未完成：对话已不存在或已被删除");
            return;
          }
          if (outcome === "not-committed") {
            optimisticRenamesRef.current.delete(sessionId);
            syncMutatingSessionIds();
            applySessionListSnapshot(result);
            const message =
              cause instanceof Error ? cause.message : String(cause);
            setError(`重命名失败，已恢复原名称：${message}`);
            return;
          }
        } catch {
          // Transport is still indeterminate; retain the local intent and guard.
        }
        if (optimisticRenamesRef.current.get(sessionId)?.token !== token)
          return;
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
    const token = ++optimisticSessionMutationTokenRef.current;
    optimisticDeletesRef.current.set(deletingId, {
      token,
      session: deleting,
      index,
      sessionsTotal,
      wasViewed,
    });
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
        const finalizedViewed = finalizeDeletedSession(deletingId);
        // Do not replace a newer user selection or local draft while the request settled.
        applyBootstrapMetadata(data);
        selectDeletionFallback(deletingId, data.sessions, finalizedViewed);
        setNotice("对话已删除");
      })
      .catch(async (cause) => {
        const pending = optimisticDeletesRef.current.get(deletingId);
        if (!pending || pending.token !== token) return;
        try {
          const { outcome, result } = await reconcileSessionMutation(
            deletingId,
            "delete",
          );
          if (optimisticDeletesRef.current.get(deletingId)?.token !== token)
            return;
          if (outcome === "committed") {
            const finalizedViewed = finalizeDeletedSession(deletingId);
            applySessionListSnapshot(result);
            selectDeletionFallback(deletingId, result.sessions, finalizedViewed);
            setNotice("对话已删除");
            return;
          }
          if (outcome === "not-committed") {
            optimisticDeletesRef.current.delete(deletingId);
            syncMutatingSessionIds();
            applySessionListSnapshot(result);
            const message =
              cause instanceof Error ? cause.message : String(cause);
            setError(`删除失败，已恢复对话显示：${message}`);
            return;
          }
        } catch {
          // Transport is still indeterminate; retain the local intent and guard.
        }
        if (optimisticDeletesRef.current.get(deletingId)?.token !== token)
          return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(`删除结果尚未确认，请刷新页面后核对：${message}`);
      });
  };

  const changeGate = async (mode: GateMode) => {
    const sessionId = viewedSessionIdRef.current;
    if (buildIdentityMismatch || !sessionId) return;
    // A cold history pane has no Runtime to mutate. Keep its intended Gate mode
    // locally and let the next real prompt synchronize it immediately before Pi
    // executes; selecting the control must not activate a conversation by itself.
    if (runtimeStatus !== "active") {
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
  }) => {
    if (buildIdentityMismatch) return;
    const submittedRequest = extensionRequest;
    if (!submittedRequest) return;
    const sessionId = submittedRequest.piChatSessionId || viewedSessionIdRef.current;
    if (!sessionId) {
      setError("确认请求缺少会话标识，已拒绝发送");
      return;
    }
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
    } catch (cause) {
      // Re-read the authoritative pending request. This distinguishes a real
      // delivery failure from a lost HTTP response after Pi already accepted it.
      try {
        const view = await api.viewSession(sessionId);
        commitPaneIfCurrent(extensionAuthority, {
          type: "EXTENSION_REQUEST_CHANGED",
          sessionId,
          request: view.pendingExtensionRequest || null,
        });
      } catch {
        commitPaneIfCurrent(extensionAuthority, {
          type: "EXTENSION_REQUEST_CHANGED",
          sessionId,
          request: submittedRequest,
        });
      }
      if (paneAuthorityCanCommit(extensionAuthority))
        setError(cause instanceof Error ? cause.message : String(cause));
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
  const globalMutationBlocked = mutationBlocked ||
    anySessionRunning ||
    anySessionQueued ||
    anySessionPendingConfirmation;
  const composerQueueMode =
    state.isStreaming || queuePaused || queue.length > 0;
  const viewedSession = sessions.find(
    (session) => session.id === viewedSessionId,
  );
  const currentSessionBusy = busySessionIds.includes(
    viewedSessionId || (localDraft ? LOCAL_DRAFT_BUSY_ID : ""),
  );
  // Once Pi has authoritatively started generating, the composer may accept a
  // follow-up into the queue even if the first HTTP acknowledgement is late.
  const currentSessionPreparing = currentSessionBusy && !state.isStreaming;
  const sidebarViewBlocked = sidebarNavigationBlocked(loading, lifecycleBlocked);
  const conversationName = localDraft
    ? "新对话"
    : viewedSession?.name ||
      state.sessionName ||
      "已保存对话";
  const loadingSession = paneLoading
    ? sessions.find((session) => session.id === paneLoading.sessionId)
    : undefined;
  const conversationWorkspace =
    loadingSession?.cwd || viewedSession?.cwd || workspaceCwd;
  const displayedConversationName = paneLoading?.name || conversationName;
  // Gate is a verified Pi Chat system component, not an optional entry in
  // Pi's transient command inventory. A cold/starting Runtime may legitimately
  // return commands: [], which must disable controls when necessary—not make
  // the permission-mode selector disappear.
  const primaryRuntimeMessage =
    primaryRuntime.status === "starting"
      ? "Pi 正在准备；已保存的对话仍可阅读和切换。发送会等待 Runtime 就绪。"
      : primaryRuntime.status === "failed"
        ? `Pi 当前不可用；仍可阅读历史。发送和 Primary 设置将在恢复前不可用。${primaryRuntime.error ? ` ${primaryRuntime.error}` : ""}`
        : "";
  // Primary settings must wait for capability readiness. Existing dedicated
  // Secondary Runtimes remain independently configurable if Primary later
  // fails, so scope this only to the active Primary Session.
  const primarySettingsUnavailable =
    viewedSessionId === activeSessionId && primaryRuntime.status !== "ready";
  const primarySessionFailed =
    primaryRuntime.status === "failed" && viewedSessionId === activeSessionId;
  const gateAvailable = gateAvailableOverride ?? true;
  // A staged value can describe the next prompt in a cold history pane, but
  // never alters gateModesRef, which is the only authority for auto-allow.
  const gateMode = pendingGateModes[viewedSessionId] ?? gateModes[viewedSessionId];
  const effectiveControl = { ...viewedSession, ...viewControl };
  const observing = Boolean(
    effectiveControl.controlOwner && !effectiveControl.controlledByThisWindow,
  );
  const takeControl = async () => {
    if (mutationBlocked) return;
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
      if (!takeoverIsCurrent() || !commitPaneIfCurrent(authority, {
        type: "CONTROL_UPDATED",
        sessionId,
        control: result,
      })) return;
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

  const cancelQueuedPrompt = (id: string) => {
    const operation = captureViewOperation();
    void api
      .cancelQueued(id, operation.sessionId)
      .then((result) => {
        const pending = localUserTurnsRef.current.get(operation.sessionId) || [];
        const cancelled = pending.find((turn) => turn.queueId === id);
        const remaining = cancelled
          ? removeLocalTurnAndRebase(pending, cancelled)
          : pending;
        if (remaining.length)
          localUserTurnsRef.current.set(operation.sessionId, remaining);
        else localUserTurnsRef.current.delete(operation.sessionId);
        if (cancelled) {
          const restoredTurnTotal = Math.max(
            sourceTurnTotalsRef.current.get(operation.sessionId) || 0,
            cancelled.expectedTurnTotal - 1,
            ...remaining.map((turn) => turn.expectedTurnTotal),
          );
          setSessions((current) => current.map((session) =>
            session.id === operation.sessionId
              ? { ...session, turnCount: restoredTurnTotal }
              : session,
          ));
        }
        patchSessionCache(operation.sessionId, {
          queue: result.queue,
          queuePaused: result.paused,
        });
        commitPaneIfCurrent(operation, {
          type: "QUEUE_UPDATED",
          sessionId: operation.sessionId,
          queue: result.queue,
          paused: result.paused,
          messages: cancelled?.renderedInTranscript
            ? (current) => current.filter((message) => message !== cancelled.message)
            : undefined,
        });
      })
      .catch((cause) => {
        if (viewOperationIsCurrent(operation))
          setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  const resumeQueuedPrompt = () => {
    const operation = captureViewOperation();
    void api
      .resumeQueue(operation.sessionId)
      .then((result) => {
        patchSessionCache(operation.sessionId, {
          queue: result.queue,
          queuePaused: result.paused,
        });
        commitPaneIfCurrent(operation, {
          type: "QUEUE_UPDATED",
          sessionId: operation.sessionId,
          queue: result.queue,
          paused: result.paused,
        });
      })
      .catch((cause) => {
        if (viewOperationIsCurrent(operation))
          setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  const composerControls = (
    <ComposerControls
      state={state}
      models={models}
      stats={stats}
      disabled={
        currentSessionPreparing ||
        viewSwitching ||
        observing ||
        mutationBlocked ||
        Boolean(state.isCompacting)
      }
      settingsBusy={settingsBusy}
      streaming={state.isStreaming}
      gateAvailable={gateAvailable}
      gateMode={gateMode}
      primaryUnavailable={primarySettingsUnavailable}
      onGate={(mode) => void changeGate(mode)}
      onModel={(provider, id) => void changeModel(provider, id)}
      onThinking={(level) => void changeThinking(level)}
    />
  );

  const composerNotices = <>
    {buildIdentityMismatch && (
      <div className="primary-runtime-status is-failed" role="status">
        网页与服务版本不一致，普通操作已暂停。请刷新页面；若仍存在，可在左侧使用“完整重启”，或在设置中关闭 Pi Chat 后重新打开。
      </div>
    )}
    {primaryRuntimeMessage && (
      <div className={`primary-runtime-status is-${primaryRuntime.status}`} role="status">
        {primaryRuntimeMessage}
      </div>
    )}
    {promptStarting && currentSessionPreparing && !state.isStreaming && toolStatus && (
      <div className="composer-preparing-status" role="status">
        <span className="loader small" />
        {toolStatus}
      </div>
    )}
    {(error || notice) && (
      <div className={`app-toast ${error ? "error" : ""}`} role="status">
        {error || notice}
      </div>
    )}
  </>;

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
          loading || busy || refreshing ||
          (buildIdentityMismatch ? recoveryActionBlocked : globalMutationBlocked)
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
        onLoadDirectory={(cwd, offset) => {
          if (loadingDirectoryKeys.includes(cwd)) return;
          setLoadingDirectoryKeys((current) => [...current, cwd]);
          void api.directorySessions(cwd, offset).then((result) => {
            setSessions((current) => uniqueSessionSummaries([...current, ...result.sessions]));
            setSessionDirectories(result.directories || []);
          }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() =>
            setLoadingDirectoryKeys((current) => current.filter((key) => key !== cwd)),
          );
        }}
        onRestart={() => void restartPi()}
        onView={(id) => {
          if (window.matchMedia?.("(max-width: 760px)").matches)
            setSidebarOpen(false);
          void viewSession(id);
        }}
        onTogglePin={(sessionId) =>
          setSessionNavigation((current) => ({
            ...current,
            pinnedSessionIds: togglePinnedSession(current.pinnedSessionIds, sessionId),
          }))
        }
        onToggleDirectoryPin={(cwd) =>
          setSessionNavigation((current) => ({
            ...current,
            pinnedDirectoryKeys: togglePinnedDirectory(current.pinnedDirectoryKeys, cwd),
          }))
        }
        onSetDirectoryCollapsed={(cwd, collapsed) =>
          setSessionNavigation((current) => {
            const key = normalizeCwdKey(cwd);
            if (!key) return current;
            return collapsed
              ? { ...current, collapsedDirectoryKeys: [...new Set([...current.collapsedDirectoryKeys, key])], expandedDirectoryKeys: current.expandedDirectoryKeys.filter((value) => value !== key) }
              : { ...current, collapsedDirectoryKeys: current.collapsedDirectoryKeys.filter((value) => value !== key), expandedDirectoryKeys: [...new Set([...current.expandedDirectoryKeys, key])] };
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
        draftWorkspaceCwd={draftWorkspaceCwd}
        workspaceCwd={workspaceCwd}
        workspacePicking={workspacePicking}
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
          observing,
          disabled: mutationBlocked,
          onTakeOver: () => void takeControl(),
        }}
        promptQueue={{
          queue,
          paused: queuePaused,
          busy: currentSessionPreparing || viewSwitching || observing || mutationBlocked,
          onCancel: cancelQueuedPrompt,
          onResume: resumeQueuedPrompt,
        }}
        chatInput={{
          streaming: composerQueueMode,
          activelyStreaming: state.isStreaming,
          stopping,
          disabled:
            loading ||
            currentSessionPreparing ||
            viewSwitching ||
            observing ||
            mutationBlocked ||
            Boolean(state.isCompacting) ||
            primarySessionFailed,
          disabledPlaceholder:
            buildIdentityMismatch
              ? "网页与服务构建不一致；请刷新页面后再提交操作"
              : lifecycleBlocked
                ? "Pi Chat 正在执行全局维护，暂时不能提交新操作"
                : observing
                  ? "此对话正在另一窗口中控制；点击“接管控制”后可操作"
                  : primarySessionFailed
                    ? "Pi Runtime 当前不可用；历史仍可阅读"
                    : state.isCompacting
                      ? "正在压缩上下文，完成后可继续发送…"
                      : currentSessionPreparing
                        ? runtimeStatus === "restoring" || runtimeStatus === "draft"
                          ? "正在准备 Pi；可随时切换到其他对话"
                          : "正在提交消息…"
                        : runtimeStatus === "view-only"
                          ? "当前为历史查看；发送时会自动准备 Pi"
                          : undefined,
          acceptsImages: state.model?.input?.includes("image") === true,
          commands,
          controls: composerControls,
          notices: composerNotices,
          onSend: send,
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
          busy || (buildIdentityMismatch ? recoveryActionBlocked : globalMutationBlocked)
        }
        onClose={() => setManagementSection(null)}
        onAppearance={setAppearance}
        onPickWorkspace={() => void pickDefaultWorkspace()}
        onModel={(provider, id) => void changeModel(provider, id)}
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
      <ExtensionDialog
        request={extensionRequest}
        disabled={buildIdentityMismatch}
        onRespond={(body) => void respondToExtension(body)}
      />
      <EditDiffSidebar
        open={diffSidebarOpen}
        width={diffSidebarWidth}
        onOpenChange={setDiffSidebarOpen}
        onWidthChange={setDiffSidebarWidth}
      />
    </AppShell>
  );
}
