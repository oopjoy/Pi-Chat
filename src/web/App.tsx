import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
  SessionStats,
  SessionSummary,
  SessionViewData,
  SlashCommand,
  ThinkingLevel,
} from "../shared/types";
import { ApiRequestError, api } from "./api";
import { ChatInput } from "./components/ChatInput";
import { ChatMessage } from "./components/ChatMessage";
import { ComposerControls } from "./components/ComposerControls";
import { ConversationProcess } from "./components/ConversationProcess";
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
import { PromptQueue } from "./components/PromptQueue";
import { SessionControlBanner } from "./components/SessionControlBanner";
import {
  SessionDialog,
  type SessionDialogState,
} from "./components/SessionDialog";
import { SessionSidebar } from "./components/SessionSidebar";
import { TopBar } from "./components/TopBar";
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
import { groupConversation } from "./lib/conversation-process";
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
  loadSidebarOpen,
  loadSidebarWidth,
  saveAppearance,
  saveSidebarOpen,
  saveSidebarWidth,
  type AppearancePreferences,
} from "./lib/preferences";
import { rememberedSessionId, rememberSessionId } from "./lib/session-location";
import {
  appendLocalTurnOnce,
  appendPendingUserMessage,
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
import { uniqueSessionSummaries } from "./lib/session-summary";

const EMPTY_STATE: PiState = { model: null, isStreaming: false };
const LOCAL_DRAFT_BUSY_ID = "__local_draft_busy__";

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
  const [state, setState] = useState<PiState>(EMPTY_STATE);
  const [messages, setMessages] = useState<PiMessage[]>([]);
  const [pendingUserMessage, setPendingUserMessage] =
    useState<PiMessage | null>(null);
  const [messageTotal, setMessageTotal] = useState(0);
  const [turnTotal, setTurnTotal] = useState(0);
  const [visibleTurnCount, setVisibleTurnCount] = useState(20);
  const [messagesTruncated, setMessagesTruncated] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [stats, setStats] = useState<SessionStats | undefined>();
  const [liveMessage, setLiveMessage] = useState<PiMessage | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const sessionsRef = useRef<SessionSummary[]>([]);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [loadingAllSessions, setLoadingAllSessions] = useState(false);
  const showAllSessionsRef = useRef(false);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [activeSessionIds, setActiveSessionIds] = useState<string[]>([]);
  const [viewedSessionId, setViewedSessionId] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [workspaceCwd, setWorkspaceCwd] = useState("");
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [gateAvailableOverride, setGateAvailableOverride] = useState<
    boolean | null
  >(null);
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [promptStarting, setPromptStarting] = useState(false);
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
  const [toolStatus, setToolStatus] = useState("");
  const [extensionRequest, setExtensionRequest] =
    useState<ExtensionUiRequest | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<
    "active" | "restoring" | "view-only" | "draft"
  >("active");
  const [localDraft, setLocalDraft] = useState(false);
  const [viewControl, setViewControl] = useState<{
    controlOwner?: string;
    controlledByThisWindow?: boolean;
  }>({});
  const [eventSourceGeneration, setEventSourceGeneration] = useState(0);
  const [applicationLifecycle, setApplicationLifecycle] =
    useState<ApplicationLifecycle>("idle");
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
  const viewCacheRef = useRef(new SessionViewCache());
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
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const scrollMemoryRef = useRef(new SessionScrollMemory());
  const pendingScrollRestoreRef = useRef("");
  const conversationNavigationTargetRef = useRef<number | null>(null);
  const stoppingRef = useRef(false);
  const viewedSessionIdRef = useRef("");
  const localDraftRef = useRef(false);
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
  const DRAFT_PREFS_KEY = "__local_draft__";
  const warmingSessionIdsRef = useRef(new Set<string>());
  const warmingRuntimeStartsRef = useRef(new Map<string, Promise<void>>());
  /** message_end may precede agent_settled; only their pair creates an unread completion notice. */
  const terminalAssistantSessionIdsRef = useRef(new Set<string>());
  /** SSE lifecycle is newer than a delayed sidebar/bootstrap summary. */
  const sessionRunningOverridesRef = useRef(new Map<string, boolean>());
  const normalizeSessionRunning = (session: SessionSummary): SessionSummary => {
    const running = sessionRunningOverridesRef.current.get(session.id);
    return running === undefined ? session : { ...session, running };
  };
  const busySessionCountsRef = useRef(new Map<string, number>());
  const refreshEpochRef = useRef(0);
  const bootstrapInFlightRef = useRef<Promise<BootstrapData> | null>(null);
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
  const reconcileOptimisticSessions = (incoming: SessionSummary[]) =>
    uniqueSessionSummaries(incoming)
      .map(normalizeSessionRunning)
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
    (message: PiMessage) => setLiveMessage(message),
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

  const setViewedId = useCallback(
    (id: string) => {
      // Background refreshes repeatedly apply a view for the already selected
      // Session. Only an actual navigation may discard that Session's throttled
      // cumulative assistant snapshot.
      if (viewedSessionIdRef.current !== id) clearPendingLiveMessage();
      conversationNavigationTargetRef.current = null;
      viewedSessionIdRef.current = id;
      desiredSessionIdRef.current = id;
      setViewedSessionId(id);
      rememberSessionId(id);
    },
    [clearPendingLiveMessage],
  );

  // Every session-scoped async action captures the selected view before await.
  // A later response may update that Session cache, but must never paint over a
  // different Session the user navigated to in the meantime.
  const captureViewOperation = () => ({
    sessionId: viewedSessionIdRef.current,
    navigationEpoch: navigationEpochRef.current,
  });
  const viewOperationIsCurrent = (operation: {
    sessionId: string;
    navigationEpoch: number;
  }) =>
    Boolean(operation.sessionId) &&
    viewedSessionIdRef.current === operation.sessionId &&
    desiredSessionIdRef.current === operation.sessionId &&
    navigationEpochRef.current === operation.navigationEpoch;

  // Bootstrap owns application-wide metadata. Keep it separate from the selected
  // view so a refresh can restore a remembered cold Session without briefly
  // committing the Primary Runtime's blank draft to the timeline.
  const applyBootstrapMetadata = useCallback((data: BootstrapData) => {
    for (const session of data.sessions) {
      if (
        typeof session.turnCount === "number" &&
        Number.isFinite(session.turnCount)
      )
        sourceTurnTotalsRef.current.set(session.id, session.turnCount);
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
    const activeId =
      data.activeSessionId ||
      data.sessions.find((session) => session.active)?.id ||
      "";
    setActiveSessionId(activeId);
    const hotIds = data.activeSessionIds || (activeId ? [activeId] : []);
    setActiveSessionIds(hotIds);
    viewCacheRef.current.setPinned(hotIds);
    setModels(data.models);
    setWorkspaceCwd(data.workspaceCwd);
    setPrimaryRuntime(
      data.primaryRuntime || { status: "starting", generation: 0 },
    );
    applicationLifecycleRef.current = data.applicationLifecycle || "idle";
    setApplicationLifecycle(data.applicationLifecycle || "idle");
  }, []);

  const applyBootstrap = useCallback(
    (data: BootstrapData) => {
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
      localDraftRef.current = false;
      setLocalDraft(false);
      setPromptStarting(false);
      applyBootstrapMetadata(data);
      setGateAvailableOverride(null);
      if (activeViewId) updateGateMode(activeViewId, data.gateMode);
      setViewControl({
        controlOwner: data.controlOwner,
        controlledByThisWindow: data.controlledByThisWindow,
      });
      const staged = activeViewId
        ? pendingSessionPrefsRef.current.get(activeViewId)
        : undefined;
      setState({
        ...data.state,
        ...(staged?.model !== undefined ? { model: staged.model } : null),
        ...(staged?.thinkingLevel !== undefined
          ? { thinkingLevel: staged.thinkingLevel }
          : null),
      });
      setMessages(protectedTranscript.messages);
      setPendingUserMessage(null);
      setMessageTotal(protectedTranscript.messageTotal);
      setTurnTotal(protectedTranscript.turnTotal);
      setVisibleTurnCount(
        data.visibleTurnCount ??
          protectedTranscript.messages.filter(
            (message) => message.role === "user",
          ).length,
      );
      setMessagesTruncated(data.messagesTruncated === true);
      setStats(data.stats);
      setViewedId(
        data.activeSessionId ||
          data.sessions.find((session) => session.active)?.id ||
          "",
      );
      setCommands(data.commands);
      setQueue(data.queue);
      setQueuePaused(data.queuePaused);
      setLiveMessage(sourceView?.liveMessage || data.liveMessage || null);
      setToolStatus(data.toolStatus || "");
      setExtensionRequest(data.pendingExtensionRequest || null);
      setRuntimeStatus("active");
    },
    [applyBootstrapMetadata, setViewedId, updateGateMode],
  );

  const tryAutoAllowGate = useCallback(
    (request: ExtensionUiRequest, sessionId: string): boolean => {
      const details =
        gateModesRef.current[sessionId] === "open"
          ? describeGateRequest(request)
          : null;
      if (!details) return false;
      setExtensionRequest(null);
      void api
        .respondToExtension({
          id: request.id,
          value: details.allowValue,
          sessionId,
        })
        .then(() => setNotice("已按放行模式自动允许受保护操作"))
        .catch((cause) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
      return true;
    },
    [],
  );

  const applySessionView = useCallback(
    (view: SessionViewData) => {
      // A structural deletion is terminal. An already-resolved view continuation
      // must not recreate its cache, sidebar row, or selected pane.
      if (confirmedDeletedSessionIdsRef.current.has(view.session.id)) return;
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
      sourceTurnTotalsRef.current.set(
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
      localDraftRef.current = false;
      setLocalDraft(false);
      setPromptStarting(false);
      setGateAvailableOverride(
        typeof view.gateAvailable === "boolean" ? view.gateAvailable : null,
      );
      updateGateMode(sourceView.session.id, view.gateMode);
      setViewControl({
        controlOwner: view.controlOwner ?? view.session.controlOwner,
        controlledByThisWindow:
          view.controlledByThisWindow ?? view.session.controlledByThisWindow,
      });
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
      setState({
        ...resolvedView.state,
        ...(staged?.model !== undefined ? { model: staged.model } : null),
        ...(staged?.thinkingLevel !== undefined
          ? { thinkingLevel: staged.thinkingLevel }
          : null),
      });
      setMessages(resolvedView.messages);
      setPendingUserMessage(null);
      setMessageTotal(resolvedView.messageTotal);
      setTurnTotal(
        resolvedView.turnTotal ??
          resolvedView.messages.filter((message) => message.role === "user")
            .length,
      );
      setVisibleTurnCount(
        resolvedView.visibleTurnCount ??
          resolvedView.messages.filter((message) => message.role === "user")
            .length,
      );
      setMessagesTruncated(resolvedView.messagesTruncated);
      setStats(resolvedView.stats);
      setQueue(resolvedView.queue || []);
      setQueuePaused(resolvedView.queuePaused === true);
      if (resolvedView.commands) setCommands(resolvedView.commands);
      setLiveMessage(resolvedView.liveMessage || null);
      setToolStatus(resolvedView.toolStatus || "");
      // Same open-mode auto-allow path for pending requests restored via view/bootstrap.
      const pending = view.pendingExtensionRequest || null;
      if (pending) {
        if (!tryAutoAllowGate(pending, view.session.id))
          setExtensionRequest(pending);
      } else setExtensionRequest(null);
      setRuntimeStatus(nextRuntimeStatus);
      if (nextRuntimeStatus === "active")
        setRuntimeWarming(resolvedView.session.id, false);
      setPaneLoading((current) =>
        current?.sessionId === resolvedView.session.id ? null : current,
      );
      recordPaneCommit(resolvedView);
      // A blank New draft has no persisted user message and intentionally stays
      // out of sidebar history until its first successful prompt.
      if (view.session.messageCount > 0) {
        const summary = normalizeSessionRunning(view.session);
        setSessions((current) =>
          uniqueSessionSummaries(
            current.some((session) => session.id === summary.id)
              ? current.map((session) =>
                  session.id === summary.id ? { ...session, ...summary } : session,
                )
              : [...current, summary],
          ),
        );
      }
      if (view.isActive)
        setActiveSessionIds((current) => [
          ...new Set([...current, view.session.id]),
        ]);
      setViewedId(view.session.id);
    },
    [
      recordPaneCommit,
      setRuntimeWarming,
      setViewedId,
      tryAutoAllowGate,
      updateGateMode,
    ],
  );

  const loadBootstrap = useCallback(() => {
    if (bootstrapInFlightRef.current) return bootstrapInFlightRef.current;
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
    const requestVersion = wantedId
      ? sessionEventVersionRef.current.get(wantedId) || 0
      : 0;
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
        const view = await api.viewSession(wantedId);
        if (
          refreshEpochRef.current !== refreshEpoch ||
          navigationEpochRef.current !== navigationEpoch ||
          desiredSessionIdRef.current !== wantedId
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
        applySessionView(view);
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
          applyBootstrap(data);
          throw cause;
        }
        desiredSessionIdRef.current = activeId;
      }
    }
    applyBootstrap(data);
    setError((current) => (recoverableRefreshError(current) ? "" : current));
  }, [applyBootstrap, applyBootstrapMetadata, applySessionView, loadBootstrap]);

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
          sourceTurnTotalsRef.current.set(session.id, session.turnCount);
      }
      setSessions(reconcileOptimisticSessions(result.sessions));
      setSessionsTotal(
        optimisticSessionsTotal(
          result.sessions,
          result.total ?? result.sessions.length,
        ),
      );
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
          sourceTurnTotalsRef.current.set(session.id, session.turnCount);
      }
      showAllSessionsRef.current = true;
      setSessions(reconcileOptimisticSessions(result.sessions));
      setSessionsTotal(
        optimisticSessionsTotal(
          result.sessions,
          result.total ?? result.sessions.length,
        ),
      );
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
      cancelPendingNavigation();
    };
  }, [cancelPendingNavigation, refresh]);

  useEffect(() => {
    applyAppearance(appearance);
    saveAppearance(appearance);
  }, [appearance]);

  useEffect(() => saveSidebarOpen(sidebarOpen), [sidebarOpen]);
  useEffect(() => saveSidebarWidth(sidebarWidth), [sidebarWidth]);

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
        typeof event.piChatSessionId === "string" ? event.piChatSessionId : "";
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
          sessionRunningOverridesRef.current.set(eventSessionId, true);
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? { ...session, running: true, releasable: false }
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
          setPromptStarting(false);
          setRuntimeWarming(eventSessionId, false);
          setRuntimeStatus("active");
          setState((current) => ({ ...current, isStreaming: true }));
          setToolStatus("Pi 正在思考…");
        }
      } else if (type === "compaction_start") {
        if (eventSessionId)
          patchSessionCache(eventSessionId, {
            state: { isCompacting: true },
          });
        if (viewingEventSession) {
          const reason = String(event.reason || "");
          setState((current) => ({ ...current, isCompacting: true }));
          setToolStatus(
            reason === "overflow"
              ? "上下文溢出，正在自动压缩…"
              : "正在压缩上下文…",
          );
        }
      } else if (type === "compaction_end") {
        if (eventSessionId)
          patchSessionCache(eventSessionId, {
            toolStatus: "",
            state: { isCompacting: false },
          });
        if (viewingEventSession) {
          setState((current) => ({ ...current, isCompacting: false }));
          setToolStatus("");
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
            void api
              .viewSession(eventSessionId)
              .then((view) => {
                if (
                  viewedSessionIdRef.current === eventSessionId &&
                  (sessionEventVersionRef.current.get(eventSessionId) || 0) ===
                    requestVersion
                )
                  applySessionView(view);
              })
              .catch(() => undefined);
          }
        }
      } else if (type === "message_start" || type === "message_update") {
        const assistant = assistantMessage(event);
        if (assistant && eventSessionId)
          updateLiveSessionCache(eventSessionId, assistant);
        // Only the selected destination is allowed to turn an SSE draft into a
        // React update. Off-screen panes retain their latest draft in cache.
        if (assistant && viewingEventSession) scheduleLiveMessage(assistant);
      } else if (type === "message_end") {
        const terminal =
          event.message && typeof event.message === "object"
            ? (event.message as PiMessage)
            : null;
        if (terminal?.role === "assistant") {
          const pendingAssistant = viewingEventSession
            ? drainPendingLiveMessage()
            : null;
          const terminalAssistant = assistantMessage(event);
          const assistant = hasAssistantPayload(terminalAssistant)
            ? terminalAssistant
            : pendingAssistant || terminalAssistant;
          if (assistant && eventSessionId) {
            terminalAssistantSessionIdsRef.current.add(eventSessionId);
            appendTerminalSessionCache(eventSessionId, assistant);
          }
          if (viewingEventSession) {
            if (assistant)
              setMessages((current) =>
                appendTerminalMessage(current, assistant),
              );
            setLiveMessage(null);
          }
        } else {
          if (terminal && eventSessionId)
            appendTerminalSessionCache(eventSessionId, terminal);
          if (viewingEventSession && terminal?.role === "toolResult") {
            setMessages((current) => appendTerminalMessage(current, terminal));
          }
        }
      } else if (type === "tool_execution_start") {
        const status = `正在运行工具：${String(event.toolName || "unknown")}`;
        if (eventSessionId)
          patchSessionCache(eventSessionId, { toolStatus: status });
        if (viewingEventSession) setToolStatus(status);
      } else if (type === "tool_execution_end") {
        const status = `${String(event.toolName || "工具")} ${event.isError ? "执行失败" : "已完成"}`;
        if (eventSessionId)
          patchSessionCache(eventSessionId, { toolStatus: status });
        if (viewingEventSession) setToolStatus(status);
      } else if (type === "agent_settled") {
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
                ? { ...session, running: false }
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
          setPromptStarting(false);
          setState((current) => ({
            ...current,
            isStreaming: false,
            isCompacting: false,
          }));
          setToolStatus("");
          // A post-compaction turn has now persisted its new usage snapshot.
          const requestVersion =
            sessionEventVersionRef.current.get(eventSessionId) || 0;
          void api
            .viewSession(eventSessionId)
            .then((view) => {
              if (
                viewedSessionIdRef.current === eventSessionId &&
                (sessionEventVersionRef.current.get(eventSessionId) || 0) ===
                  requestVersion
              )
                applySessionView(view);
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
          setRuntimeStatus("view-only");
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
        if (turn && viewingEventSession)
          setPendingUserMessage((current) =>
            current === turn.message ? null : current,
          );
        if (turn?.renderedInTranscript) {
          if (viewingEventSession)
            setMessages((current) =>
              current.filter((candidate) => candidate !== turn.message),
            );
          turn.renderedInTranscript = false;
        }
        if (eventSessionId)
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? {
                    ...session,
                    queued: currentQueue.length > 0,
                    ...(currentQueue.length > 0 ? { releasable: false } : null),
                  }
                : session,
            ),
          );
        if (eventSessionId)
          patchSessionCache(eventSessionId, {
            queue: currentQueue,
            queuePaused: event.paused === true,
          });
        if (viewingEventSession) {
          setQueue(currentQueue);
          setQueuePaused(event.paused === true);
        }
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
          if (viewingEventSession)
            setPendingUserMessage((current) =>
              current === knownLocally.message ? null : current,
            );
          if (viewingEventSession && !knownLocally.renderedInTranscript) {
            setMessages((current) =>
              current.includes(knownLocally.message)
                ? current
                : [...current, knownLocally.message],
            );
            knownLocally.renderedInTranscript = true;
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
            setMessages((current) => [...current, message]);
        }
        if (eventSessionId)
          patchSessionCache(eventSessionId, {
            state: { isStreaming: true },
            isStreaming: true,
          });
        if (viewingEventSession)
          setState((current) => ({ ...current, isStreaming: true }));
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
        for (const turn of localTurns) {
          if (!turn.queueId || !queuedIds.has(turn.queueId)) continue;
          turn.queueState = "waiting";
          if (turn.renderedInTranscript) {
            if (viewingEventSession)
              setMessages((current) =>
                current.filter((candidate) => candidate !== turn.message),
              );
            turn.renderedInTranscript = false;
          }
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
          if (currentQueue.length) setQueue(currentQueue);
          if (event.paused === true) setQueuePaused(true);
          setState((current) => ({ ...current, isStreaming: false }));
          setLiveMessage(null);
          setToolStatus("");
          setError(String(event.error || "队列消息发送失败"));
        }
      } else if (type === "extension_ui_request") {
        const request = event as unknown as ExtensionUiRequest;
        if (["select", "confirm", "input", "editor"].includes(request.method)) {
          if (eventSessionId) {
            setSessions((current) =>
              current.map((session) =>
                session.id === eventSessionId
                  ? { ...session, pendingConfirmation: true, releasable: false }
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
            if (!sessionId || !tryAutoAllowGate(request, sessionId))
              setExtensionRequest(request);
          }
        } else if (request.method === "notify") {
          const mode = gateModeFromNotice(request.message);
          if (mode && eventSessionId) updateGateMode(eventSessionId, mode);
          if (viewingEventSession) setNotice(request.message || "Pi 通知");
        }
      } else if (type === "pi_chat_gate_mode_changed") {
        const mode = event.mode;
        if (eventSessionId && (mode === "strict" || mode === "open"))
          updateGateMode(eventSessionId, mode);
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
          setViewControl({ controlOwner: owner, controlledByThisWindow });
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
          setExtensionRequest((current) =>
            current?.id === event.id ? null : current,
          );
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
        if (eventSessionId && typeof event.running === "boolean") {
          const running = event.running === true;
          sessionRunningOverridesRef.current.set(eventSessionId, running);
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? { ...session, running }
                : session,
            ),
          );
          patchSessionCache(eventSessionId, {
            isStreaming: running,
            state: { isStreaming: running },
          });
        }
      } else if (type === "pi_chat_process_recovered") {
        if (eventSessionId)
          setFailedSessionIds((current) =>
            current.filter((id) => id !== eventSessionId),
          );
      } else if (type === "pi_chat_process_error") {
        if (eventSessionId) {
          terminalAssistantSessionIdsRef.current.delete(eventSessionId);
          sessionRunningOverridesRef.current.set(eventSessionId, false);
          setFailedSessionIds((current) => [
            ...new Set([...current, eventSessionId]),
          ]);
          setSessions((current) =>
            current.map((session) =>
              session.id === eventSessionId
                ? { ...session, running: false, releasable: false }
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
          setPromptStarting(false);
          setError(String(event.error || "Pi RPC 已退出"));
          setState((current) => ({ ...current, isStreaming: false }));
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
    // SSE proves that a socket exists, not that Chromium still schedules this
    // renderer. Renew a separate short foreground lease only while this page is
    // visible, so a frozen/hidden PWA cannot hold another visible window hostage.
    const renewPresence = () => {
      if (document.visibilityState === "hidden") return;
      void api.renewPresence().catch(() => undefined);
    };
    const resume = (event?: Event) => {
      if (document.visibilityState === "hidden") return;
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
    return () => {
      window.clearInterval(watchdog);
      window.clearInterval(presenceRenewal);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
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

  const loadingEarlierRef = useRef(false);
  const loadEarlierTurns = useCallback(async () => {
    const id = viewedSessionIdRef.current;
    if (!id || !messagesTruncated || loadingEarlierRef.current) return;
    const timeline = scrollRef.current;
    const previousHeight = timeline?.scrollHeight || 0;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    setError("");
    stickToBottomRef.current = false;
    try {
      const requestVersion = sessionEventVersionRef.current.get(id) || 0;
      const view = await api.viewSession(id, visibleTurnCount + 10);
      if (viewedSessionIdRef.current !== id) return;
      if ((sessionEventVersionRef.current.get(id) || 0) !== requestVersion)
        return;
      applySessionView(view);
      requestAnimationFrame(() => {
        const element = scrollRef.current;
        if (element)
          element.scrollTop = Math.max(
            0,
            element.scrollHeight - previousHeight,
          );
      });
    } catch (cause) {
      if (viewedSessionIdRef.current === id) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      loadingEarlierRef.current = false;
      setLoadingEarlier(false);
    }
  }, [applySessionView, messagesTruncated, visibleTurnCount]);

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
      void api
        .viewSession(sessionId)
        .then((view) => {
          if (viewedSessionIdRef.current !== sessionId) return;
          const completedVersion =
            sessionEventVersionRef.current.get(sessionId) || 0;
          if (completedVersion !== latestVersion) {
            schedulePromptReconcile(sessionId, completedVersion);
            return;
          }
          applySessionView(view);
          setPromptStarting(false);
          if (view.isStreaming)
            schedulePromptReconcile(sessionId, completedVersion);
        })
        .catch((cause) => {
          if (viewedSessionIdRef.current !== sessionId) return;
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
    setError("");
    stickToBottomRef.current = true;
    const sendNavigationEpoch = navigationEpochRef.current;
    const initialSessionId =
      viewedSessionIdRef.current ||
      (localDraftRef.current ? LOCAL_DRAFT_BUSY_ID : "");
    let busySessionId = initialSessionId;
    let releaseSessionBusy = beginSessionBusy(busySessionId);
    const moveSessionBusyTo = (sessionId: string) => {
      if (!sessionId || sessionId === busySessionId) return;
      releaseSessionBusy();
      busySessionId = sessionId;
      releaseSessionBusy = beginSessionBusy(busySessionId);
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
    let protectedLocalTurn: LocalUserTurn | null = null;
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
    setPendingUserMessage(optimisticMessage);
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
          setRuntimeStatus("restoring");
          const view = await api.activateSession(viewedSessionId);
          viewCacheRef.current.forget(view.session.id);
          applySessionView(view);
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
      const preferredModel =
        staged?.model !== undefined ? staged.model : state.model;
      const preferredThinking =
        staged?.thinkingLevel !== undefined
          ? staged.thinkingLevel
          : (state.thinkingLevel as ThinkingLevel | undefined);
      if (localDraftRef.current) {
        setPromptStarting(true);
        setToolStatus("正在准备 Pi，消息会自动发送…");
        await clearViewedPromiseRef.current;
        clearViewedPromiseRef.current = null;
        const view = await api.newSession();
        targetSessionId = view.session.id;
        moveSessionBusyTo(targetSessionId);
        protectLocalPrompt();
        const stillViewingDraft =
          navigationEpochRef.current === sendNavigationEpoch &&
          localDraftRef.current;
        if (stillViewingDraft) {
          applySessionView(view);
          setPendingUserMessage(null);
          setPromptStarting(true);
          setToolStatus("Pi 已就绪，正在发送消息…");
        } else rememberSessionView(view);
        if (
          preferredModel &&
          (view.state.model?.provider !== preferredModel.provider ||
            view.state.model?.id !== preferredModel.id)
        ) {
          const selected = await api.setModel(
            preferredModel.provider,
            preferredModel.id,
            targetSessionId,
          );
          if (viewedSessionIdRef.current === targetSessionId)
            setState((current) => ({ ...current, model: selected.model }));
        }
        if (
          preferredThinking &&
          view.state.thinkingLevel !== preferredThinking
        ) {
          const selected = await api.setThinking(
            preferredThinking,
            targetSessionId,
          );
          if (viewedSessionIdRef.current === targetSessionId)
            setState((current) => ({
              ...current,
              thinkingLevel: selected.level,
            }));
        }
        pendingSessionPrefsRef.current.delete(DRAFT_PREFS_KEY);
      } else if (runtimeStatus !== "active") {
        setPromptStarting(true);
        setToolStatus("正在准备 Pi，消息会自动发送…");
        setRuntimeStatus("restoring");
        protectLocalPrompt();
        const activationEpoch = navigationEpochRef.current;
        const view = await api.activateSession(targetSessionId);
        const activationIsCurrent =
          viewedSessionIdRef.current === targetSessionId &&
          desiredSessionIdRef.current === targetSessionId &&
          navigationEpochRef.current === activationEpoch;
        if (activationIsCurrent) {
          viewCacheRef.current.forget(view.session.id);
          applySessionView(view);
        } else rememberSessionView(view);
        setPendingUserMessage(null);
        setPromptStarting(true);
        setToolStatus("Pi 已就绪，正在发送消息…");
        // Re-apply any model/thinking chosen while the conversation was view-only.
        if (
          preferredModel &&
          (view.state.model?.provider !== preferredModel.provider ||
            view.state.model?.id !== preferredModel.id)
        ) {
          const selected = await api.setModel(
            preferredModel.provider,
            preferredModel.id,
            targetSessionId,
          );
          setState((current) => ({ ...current, model: selected.model }));
        }
        if (
          preferredThinking &&
          view.state.thinkingLevel !== preferredThinking
        ) {
          const selected = await api.setThinking(
            preferredThinking,
            targetSessionId,
          );
          setState((current) => ({
            ...current,
            thinkingLevel: selected.level,
          }));
        }
        pendingSessionPrefsRef.current.delete(targetSessionId);
      } else if (!alreadyStreaming) {
        setPromptStarting(true);
        setToolStatus("正在向 Pi 提交消息…");
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
            setState((current) => ({ ...current, model: selected.model }));
          }
          if (staged.thinkingLevel) {
            const selected = await api.setThinking(
              staged.thinkingLevel,
              targetSessionId,
            );
            setState((current) => ({
              ...current,
              thinkingLevel: selected.level,
            }));
          }
          pendingSessionPrefsRef.current.delete(prefsKey);
        }
      }

      const eventVersionBeforePrompt =
        sessionEventVersionRef.current.get(targetSessionId) || 0;
      // Protect the prompt across every asynchronous refresh until a JSONL view
      // confirms the additional user turn. This also covers active Sessions,
      // which have no Runtime-start view to pass through above.
      protectLocalPrompt();
      const result = await api.prompt(
        message,
        images,
        targetSessionId,
        gateModesRef.current[targetSessionId],
      );
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
      if (result.queued && localTurnEntry() && typeof result.id === "string") {
        const queuedTurn = localTurnEntry()!;
        // Dispatch SSE may beat this acknowledgement. Never demote a turn that
        // the scheduler has already started into the waiting-only queue UI.
        markLocalTurnQueued(queuedTurn, result.id);
      } else if (!result.extension && localTurnEntry()) {
        localTurnEntry()!.queueState = "dispatched";
      }
      // An orphaned blank view may let the user escape through the sidebar while
      // this request is still pending. Its late response belongs to the old
      // Session and must not overwrite the newly selected conversation.
      if (viewedSessionIdRef.current !== targetSessionId) {
        scheduleSidebarRefresh();
        return;
      }
      setPromptStarting(false);
      if (result.extension) {
        setPendingUserMessage(null);
        setToolStatus(alreadyStreaming ? previousToolStatus : "");
        if (typeof result.isStreaming === "boolean")
          setState((current) => ({
            ...current,
            isStreaming: result.isStreaming as boolean,
          }));
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
        if (
          queuedTurn?.queueState === "waiting" &&
          queuedTurn.renderedInTranscript
        ) {
          setMessages((current) =>
            current.filter((candidate) => candidate !== queuedTurn.message),
          );
          queuedTurn.renderedInTranscript = false;
        }
        setPendingUserMessage(null);
        setToolStatus(alreadyStreaming ? previousToolStatus : "");
        // A dispatch event can beat this HTTP acknowledgement. In that race the
        // response contains the old enqueue snapshot, so SSE remains authoritative.
        if (result.queue && queuedTurn?.queueState !== "dispatched")
          setQueue(result.queue);
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
          eventVersionAfterPrompt > eventVersionBeforePrompt &&
          (terminalEvent === "agent_settled" ||
            terminalEvent === "pi_chat_process_error");
        if (settledBeforeAcknowledgement) {
          // A very fast turn can settle before the prompt HTTP acknowledgement.
          // Commit the local bubble before waiting for its final JSONL view.
          protectLocalPrompt(localTurn);
          setMessages((current) =>
            appendLocalTurnOnce(current, localTurnEntry()),
          );
          setPendingUserMessage(null);
          try {
            const requestVersion =
              sessionEventVersionRef.current.get(targetSessionId) || 0;
            const view = await api.viewSession(targetSessionId);
            if (
              viewedSessionIdRef.current === targetSessionId &&
              (sessionEventVersionRef.current.get(targetSessionId) || 0) ===
                requestVersion
            )
              applySessionView(view);
          } catch {
            // History already includes the optimistic user turn; a busy view RPC
            // must not turn a completed prompt into a red timeout banner.
          }
        } else {
          // A reconnect/view refresh may already have moved the protected local
          // overlay into `messages` while this HTTP acknowledgement was pending.
          // Do not create a duplicate user bubble in that race.
          protectLocalPrompt(localTurn);
          setMessages((current) =>
            appendLocalTurnOnce(current, localTurnEntry()),
          );
          setPendingUserMessage(null);
          setState((current) => ({ ...current, isStreaming: true }));
          setToolStatus("Pi 正在思考…");
          schedulePromptReconcile(targetSessionId);
        }
      }
    } catch (cause) {
      const rejectedTurn = localTurnEntry();
      if (rejectedTurn) {
        const pending = localUserTurnsRef.current.get(targetSessionId) || [];
        const remaining = removeLocalTurnAndRebase(pending, rejectedTurn);
        if (remaining.length)
          localUserTurnsRef.current.set(targetSessionId, remaining);
        else localUserTurnsRef.current.delete(targetSessionId);
      }
      viewCacheRef.current.forget(targetSessionId);
      if (
        rejectedTurn?.renderedInTranscript &&
        viewedSessionIdRef.current === targetSessionId
      ) {
        setMessages((current) =>
          current.filter((candidate) => candidate !== rejectedTurn.message),
        );
      }
      if (viewedSessionIdRef.current === targetSessionId) {
        setPendingUserMessage(null);
        setPromptStarting(false);
        if (!state.isStreaming) setToolStatus("");
        const messageText =
          cause instanceof Error ? cause.message : String(cause);
        setError(messageText);
      }
      if (viewedSessionIdRef.current === targetSessionId) throw cause;
    } finally {
      releaseSessionBusy();
    }
  };

  const stopGeneration = async () => {
    if (stoppingRef.current) return;
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
      if (!viewOperationIsCurrent(operation)) return;
      setState((current) => ({ ...current, isStreaming: result.isStreaming }));
      setQueuePaused(result.queuePaused);
      if (!result.isStreaming) {
        setPromptStarting(false);
        setToolStatus("");
        setLiveMessage(null);
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
              applySessionView(view);
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
    // Snapshot exactly what the user is leaving, including a cumulative SSE
    // assistant draft. Returning to a running Session can then paint this first
    // frame immediately instead of waiting on its busy Pi Runtime.
    const leavingId = viewedSessionIdRef.current;
    // Drain the 50ms throttled A update before selecting B; otherwise the old
    // pane can commit one more expensive Markdown render after the click.
    const pendingLeavingLive = drainPendingLiveMessage();
    if (leavingId && pendingLeavingLive)
      updateLiveSessionCache(leavingId, pendingLeavingLive);
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
    const epoch = ++navigationEpochRef.current;
    const controller = new AbortController();
    navigationAbortRef.current = controller;
    desiredSessionIdRef.current = id;
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
      applySessionView({ ...cached, viewSource: "browser-cache" });
      // This cached navigation supersedes any older in-flight cold request.
      setViewSwitching(false);
      // Always reconcile behind the already-painted cache. This preserves the
      // final answer of a Session that settled while it was off-screen, without
      // making a busy Runtime's RPC latency visible to the user.
      const requestVersion = sessionEventVersionRef.current.get(id) || 0;
      void api
        .viewSession(id, rememberedTurns)
        .then((view) => {
          if (
            confirmedDeletedSessionIdsRef.current.has(id) ||
            navigationEpochRef.current !== epoch ||
            desiredSessionIdRef.current !== id ||
            viewedSessionIdRef.current !== id
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
            if (patched) applySessionView(patched);
          } else applySessionView(view);
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
    setRuntimeStatus(activeSessionIds.includes(id) ? "restoring" : "view-only");
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
        navigationEpochRef.current !== epoch ||
        desiredSessionIdRef.current !== id
      )
        return;
      pendingScrollRestoreRef.current = id;
      applySessionView(
        viewCacheRef.current.mergeNavigation(view, requestStartRevision),
      );
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
    cancelPendingNavigation();
    rememberCurrentScroll();
    pendingScrollRestoreRef.current = "";
    // New is a local blank composer only. Starting a Secondary Pi process here
    // made a no-op UI action block on cold RPC startup and stale draft probes.
    navigationEpochRef.current += 1;
    refreshEpochRef.current += 1;
    setViewSwitching(false);
    if (promptReconcileTimerRef.current !== null)
      window.clearTimeout(promptReconcileTimerRef.current);
    promptReconcileTimerRef.current = null;
    const previousViewedSessionId = viewedSessionIdRef.current;
    localDraftRef.current = true;
    setLocalDraft(true);
    setViewedId("");
    setViewControl({});
    // Carry over the currently displayed model/thinking as the draft defaults.
    pendingSessionPrefsRef.current.set(DRAFT_PREFS_KEY, {
      model: state.model,
      thinkingLevel: state.thinkingLevel as ThinkingLevel | undefined,
    });
    setState({
      ...EMPTY_STATE,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
    });
    setMessages([]);
    setPendingUserMessage(null);
    setMessageTotal(0);
    setTurnTotal(0);
    setVisibleTurnCount(0);
    setMessagesTruncated(false);
    setStats(undefined);
    setQueue([]);
    setQueuePaused(false);
    setLiveMessage(null);
    setToolStatus("");
    setExtensionRequest(null);
    setRuntimeStatus("draft");
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
   * Start a Runtime as a Session-scoped background capability upgrade. Reading
   * and switching stay live; if the user leaves meanwhile, the resulting view
   * is retained only in that Session's data pane.
   */
  const warmSessionRuntime = useCallback(
    (sessionId: string): Promise<void> => {
      if (!sessionId) return Promise.resolve();
      const existing = warmingRuntimeStartsRef.current.get(sessionId);
      if (existing) return existing;
      setRuntimeWarming(sessionId, true);
      const start = api
        .activateSession(sessionId)
        .then((view) => {
          viewCacheRef.current.forget(view.session.id);
          if (
            viewedSessionIdRef.current === sessionId &&
            desiredSessionIdRef.current === sessionId
          ) {
            applySessionView(view);
            setRuntimeStatus("active");
          } else rememberSessionView(view);
        })
        .catch((cause) => {
          if (
            viewedSessionIdRef.current === sessionId &&
            desiredSessionIdRef.current === sessionId
          ) {
            setRuntimeStatus("view-only");
            setError(cause instanceof Error ? cause.message : String(cause));
          }
          throw cause;
        })
        .finally(() => {
          if (warmingRuntimeStartsRef.current.get(sessionId) === start)
            warmingRuntimeStartsRef.current.delete(sessionId);
          setRuntimeWarming(sessionId, false);
        });
      warmingRuntimeStartsRef.current.set(sessionId, start);
      return start;
    },
    [applySessionView, setRuntimeWarming],
  );

  const ensureRuntimeActive = async () => {
    const sessionId = viewedSessionIdRef.current;
    if (!sessionId || runtimeStatus === "active") return false;
    await warmSessionRuntime(sessionId);
    return (
      viewedSessionIdRef.current === sessionId &&
      desiredSessionIdRef.current === sessionId
    );
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
    if (!provider || !modelId || settingsBusy) return;
    const model = models.find(
      (candidate) =>
        candidate.provider === provider && candidate.id === modelId,
    );
    // Cold history and local New drafts only stage preferences until the first send.
    if (localDraftRef.current || runtimeStatus !== "active") {
      if (model) {
        stageSessionPref({ model });
        setState((current) => ({ ...current, model }));
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
      if (!viewOperationIsCurrent(operation)) return;
      setState((current) => ({ ...current, model: result.model }));
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
    if (settingsBusy) return;
    if (localDraftRef.current || runtimeStatus !== "active") {
      stageSessionPref({ thinkingLevel: level });
      setState((current) => ({ ...current, thinkingLevel: level }));
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
      if (!viewOperationIsCurrent(operation)) return;
      setState((current) => ({ ...current, thinkingLevel: result.level }));
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

  const pickWorkspace = async () => {
    if (
      anySessionRunning ||
      sessions.some((session) => session.queued || session.pendingConfirmation)
    ) {
      setError(
        "请先停止所有并行生成、处理权限确认并清空当前队列，再切换工作目录。",
      );
      return;
    }
    cancelPendingNavigation();
    setBusy(true);
    setWorkspacePicking(true);
    setError("");
    setNotice("请在弹出的 Windows 窗口中浏览并选择工作目录");
    try {
      const result = await api.pickWorkspace();
      if (result.cancelled || !result.data) return;
      showAllSessionsRef.current = false;
      applyBootstrap(result.data);
      setNotice(
        `已切换工作目录：${result.workspaceName || result.data.workspaceCwd}`,
      );
      stickToBottomRef.current = true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorkspacePicking(false);
      setBusy(false);
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
      setViewedSessionId("");
      rememberSessionId("");
      setLocalDraft(false);
      setViewControl({});
      setState(EMPTY_STATE);
      setMessages([]);
      setPendingUserMessage(null);
      setMessageTotal(0);
      setTurnTotal(0);
      setVisibleTurnCount(0);
      setMessagesTruncated(false);
      setStats(undefined);
      setQueue([]);
      setQueuePaused(false);
      setLiveMessage(null);
      setToolStatus("");
      setExtensionRequest(null);
      setPromptStarting(false);
      setRuntimeStatus("view-only");
    }
    optimisticRenamesRef.current.delete(sessionId);
    optimisticDeletesRef.current.delete(sessionId);
    confirmedDeletedSessionIdsRef.current.add(sessionId);
    scrollMemoryRef.current.forget(sessionId);
    viewCacheRef.current.forget(sessionId);
    localUserTurnsRef.current.delete(sessionId);
    sourceTurnTotalsRef.current.delete(sessionId);
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

  const releaseSession = async (session: SessionSummary) => {
    setSessionActionBusy(true);
    setError("");
    try {
      const result = await api.releaseSession(session.id);
      const ids = result.activeSessionIds;
      setActiveSessionIds(ids);
      viewCacheRef.current.setPinned(ids);
      setSessions((current) => applyActiveSessionIds(current, ids));
      const cached = viewCacheRef.current.get(session.id);
      if (cached)
        refreshSessionCache(session.id, {
          runtimeStatus: "view-only",
          isActive: false,
          isStreaming: false,
          liveMessage: undefined,
          toolStatus: "",
          session: {
            ...cached.session,
            writable: false,
            releasable: false,
            running: false,
            queued: false,
          },
          state: { ...cached.state, isStreaming: false },
        });
      if (viewedSessionIdRef.current === session.id) {
        setRuntimeStatus("view-only");
        setState((current) => ({ ...current, isStreaming: false }));
        setToolStatus("");
      }
      setNotice("已释放对话运行资源");
      void refreshSidebarSessions().catch(reportBackgroundRefreshError);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSessionActionBusy(false);
    }
  };

  const deleteSession = () => {
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
        finalizeDeletedSession(deletingId);
        // Do not replace a newer user selection or local draft while the request settled.
        applyBootstrapMetadata(data);
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
            finalizeDeletedSession(deletingId);
            applySessionListSnapshot(result);
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
    if (!viewedSessionIdRef.current) return;
    // Gate changes are security-sensitive: never auto-allow from an optimistic
    // browser value before the Runtime confirms that the command succeeded.
    await send(`/gate ${mode}`, []);
  };

  const respondToExtension = async (body: Record<string, unknown>) => {
    const submittedRequest = extensionRequest;
    if (!submittedRequest) return;
    const sessionId =
      submittedRequest.piChatSessionId || viewedSessionIdRef.current;
    setExtensionRequest(null);
    try {
      await api.respondToExtension({
        ...body,
        ...(sessionId ? { sessionId } : {}),
      });
    } catch (cause) {
      // Re-read the authoritative pending request. This distinguishes a real
      // delivery failure from a lost HTTP response after Pi already accepted it.
      try {
        if (sessionId) {
          const view = await api.viewSession(sessionId);
          if (viewedSessionIdRef.current === sessionId)
            setExtensionRequest(view.pendingExtensionRequest || null);
        } else setExtensionRequest(submittedRequest);
      } catch {
        if (viewedSessionIdRef.current === sessionId)
          setExtensionRequest(submittedRequest);
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const viewingActiveSession =
    Boolean(viewedSessionId) && activeSessionIds.includes(viewedSessionId);
  // Group persisted and in-flight messages as one contiguous transcript. Splitting
  // them made a completed tool segment and the next streaming thought render as
  // two adjacent “过程” cards during one agent turn.
  const conversationItems = useMemo(
    () =>
      groupConversation(
        appendPendingUserMessage(messages, pendingUserMessage),
        {
          liveMessage: liveMessage || undefined,
          preserveTrailingAssistantPlaceholder: Boolean(liveMessage),
        },
      ),
    [messages, pendingUserMessage, liveMessage],
  );
  const anySessionRunning = sessions.some((session) => session.running);
  const anySessionPendingConfirmation = sessions.some(
    (session) => session.pendingConfirmation,
  );
  const anySessionQueued = sessions.some((session) => session.queued);
  const lifecycleBlocked = applicationLifecycle !== "idle";
  const globalMutationBlocked =
    lifecycleBlocked ||
    anySessionRunning ||
    anySessionQueued ||
    anySessionPendingConfirmation;
  const primaryQueueBusy =
    viewedSessionId === activeSessionId && queue.length > 0;
  const composerQueueMode =
    state.isStreaming || queuePaused || queue.length > 0;
  const viewedSession = sessions.find(
    (session) => session.id === viewedSessionId,
  );
  const currentSessionBusy = busySessionIds.includes(
    viewedSessionId || (localDraft ? LOCAL_DRAFT_BUSY_ID : ""),
  );
  const sidebarViewBlocked = sidebarNavigationBlocked(
    loading,
    lifecycleBlocked,
  );
  const conversationName = localDraft
    ? "新对话"
    : viewedSession?.name ||
      (state.messageCount ? state.sessionName || "已保存对话" : "新对话");
  const loadingSession = paneLoading
    ? sessions.find((session) => session.id === paneLoading.sessionId)
    : undefined;
  const conversationWorkspace =
    loadingSession?.cwd || viewedSession?.cwd || workspaceCwd;
  const displayedConversationName = paneLoading?.name || conversationName;
  // Cold view-only sessions carry no RPC command list; the server reports Gate availability explicitly.
  const primaryRuntimeMessage =
    primaryRuntime.status === "starting"
      ? "Pi 正在准备；已保存的对话仍可阅读和切换。发送会等待 Runtime 就绪。"
      : primaryRuntime.status === "failed"
        ? `Pi 当前不可用；仍可阅读历史。发送和 Primary 设置将在恢复前不可用。${primaryRuntime.error ? ` ${primaryRuntime.error}` : ""}`
        : "";
  const primarySessionFailed =
    primaryRuntime.status === "failed" && viewedSessionId === activeSessionId;
  const gateAvailable =
    gateAvailableOverride ??
    commands.some(
      (command) => command.name === "gate" && command.source === "extension",
    );
  const gateMode = gateModes[viewedSessionId];
  const effectiveControl = { ...viewedSession, ...viewControl };
  const observing = Boolean(
    effectiveControl.controlOwner && !effectiveControl.controlledByThisWindow,
  );
  const takeControl = async () => {
    const sessionId = viewedSessionIdRef.current;
    if (!sessionId) return;
    const releaseSessionBusy = beginSessionBusy(sessionId);
    try {
      const activatedHere =
        runtimeStatus === "active" || (await ensureRuntimeActive());
      if (!activatedHere || viewedSessionIdRef.current !== sessionId) return;
      const result = await api.takeSessionControl(sessionId);
      if (viewedSessionIdRef.current !== sessionId) return;
      setViewControl(result);
      setSessions((current) =>
        current.map((session) =>
          session.id === sessionId ? { ...session, ...result } : session,
        ),
      );
      setNotice("已接管此对话控制权");
    } catch (cause) {
      if (viewedSessionIdRef.current === sessionId)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      releaseSessionBusy();
    }
  };

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
    <div
      className="app-shell"
      style={
        {
          "--diff-sidebar-width": diffSidebarOpen
            ? `${diffSidebarWidth}px`
            : "0px",
        } as CSSProperties
      }
    >
      <SessionSidebar
        sessions={sessions}
        sessionsTotal={sessionsTotal}
        loadingAllSessions={loadingAllSessions}
        viewedSessionId={viewedSessionId}
        workspaceCwd={workspaceCwd}
        open={sidebarOpen}
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
        newDisabled={loading || lifecycleBlocked}
        refreshDisabled={loading || refreshing}
        restartDisabled={loading || busy || refreshing || globalMutationBlocked}
        workspaceDisabled={
          loading || busy || workspacePicking || globalMutationBlocked
        }
        viewBusy={sidebarViewBlocked}
        refreshing={refreshing}
        warmingSessionIds={warmingSessionIds}
        failedSessionIds={failedSessionIds}
        unseenReplySessionIds={unseenReplySessionIds}
        mutatingSessionIds={mutatingSessionIds}
        workspacePicking={workspacePicking}
        onClose={() => setSidebarOpen(false)}
        onCollapse={() => setSidebarOpen(false)}
        onNew={() => void createSession()}
        onRefresh={() => void refreshManually()}
        onLoadAllSessions={() => void loadAllSessions()}
        onRestart={() => void restartPi()}
        onView={(id) => {
          if (window.matchMedia?.("(max-width: 760px)").matches)
            setSidebarOpen(false);
          void viewSession(id);
        }}
        onRelease={(session) => void releaseSession(session)}
        onRename={(session) => setSessionDialog({ mode: "rename", session })}
        onDelete={(session) => setSessionDialog({ mode: "delete", session })}
        onPickWorkspace={() => void pickWorkspace()}
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
      <main className="chat-shell">
        <TopBar
          conversationName={displayedConversationName}
          workspacePath={conversationWorkspace}
          settingsOpen={managementSection !== null}
          onOpenSettings={() =>
            setManagementSection((current) => (current ? null : "settings"))
          }
          diffSidebarOpen={diffSidebarOpen}
          onToggleDiffSidebar={() => setDiffSidebarOpen((open) => !open)}
        />
        <div
          className="timeline"
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={clearConversationNavigationTarget}
          onPointerDown={clearConversationNavigationTarget}
        >
          <div className="timeline-inner">
            {loading ? (
              <div className="center-state">
                <span className="loader" />
                正在读取已保存的对话…
              </div>
            ) : paneLoading ? (
              <section
                className="pane-loading"
                aria-live="polite"
                aria-busy="true"
              >
                <span className="loader" />
                <div>
                  <strong>正在打开 {paneLoading.name}</strong>
                  <p>正在恢复会话内容…</p>
                </div>
              </section>
            ) : !messages.length && !pendingUserMessage && !liveMessage ? (
              <section className="welcome">
                <span className="welcome-mark">
                  <PiMarkIcon />
                </span>
                <h1>开始与 Pi 对话</h1>
                <p>支持流式输出、Markdown、KaTeX，以及复制原始 LaTeX 源码。</p>
              </section>
            ) : (
              <>
                {messagesTruncated && (
                  <div className="message-window-notice" role="status">
                    <span>
                      当前显示最近 {visibleTurnCount} 轮（共 {turnTotal} 轮、
                      {messageTotal} 条消息）
                    </span>
                    <button
                      type="button"
                      onClick={() => void loadEarlierTurns()}
                      disabled={loadingEarlier}
                    >
                      {loadingEarlier ? "正在加载…" : "加载更早 10 轮"}
                    </button>
                  </div>
                )}
                {conversationItems.map((item, index) =>
                  item.kind === "process" ? (
                    <ConversationProcess
                      key={`${viewedSessionId || "draft"}:${item.key}`}
                      disclosureKey={`${viewedSessionId || "draft"}:${item.key}`}
                      entries={item.entries}
                      streaming={
                        state.isStreaming &&
                        index === conversationItems.length - 1
                      }
                    />
                  ) : (
                    <ChatMessage
                      key={`${viewedSessionId || "draft"}:${item.key}`}
                      message={item.message}
                      streaming={
                        state.isStreaming &&
                        index === conversationItems.length - 1 &&
                        Boolean(liveMessage)
                      }
                    />
                  ),
                )}
              </>
            )}
            {state.isCompacting && (
              <div className="agent-status is-compacting" role="status">
                <span className="loader small" />
                {toolStatus || "正在压缩上下文，当前消息会在完成后继续发送…"}
              </div>
            )}
            {state.isStreaming && !state.isCompacting && toolStatus && (
              <div className="agent-status">
                <span className="loader small" />
                {toolStatus}
              </div>
            )}
          </div>
        </div>
        <nav className="conversation-nav" aria-label="对话导航">
          <button
            type="button"
            onClick={() => navigateConversation("top")}
            title="回到首条对话"
            aria-label="回到首条对话"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 4h12M10 16V7M7.2 9.8 10 7l2.8 2.8" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => navigateConversation("previous")}
            title="上一条对话"
            aria-label="上一条对话"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 16V4M5.8 8.2 10 4l4.2 4.2" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => navigateConversation("next")}
            title="下一条对话"
            aria-label="下一条对话"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 4v12M5.8 11.8 10 16l4.2-4.2" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => navigateConversation("bottom")}
            title="回到最新对话"
            aria-label="回到最新对话"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 16h12M10 4v9M7.2 10.2 10 13l2.8-2.8" />
            </svg>
          </button>
        </nav>
        <SessionControlBanner
          observing={observing}
          disabled={lifecycleBlocked}
          onTakeOver={() => void takeControl()}
        />
        <PromptQueue
          queue={queue}
          paused={queuePaused}
          busy={
            currentSessionBusy || viewSwitching || observing || lifecycleBlocked
          }
          onCancel={(id) => {
            const operation = captureViewOperation();
            void api
              .cancelQueued(id, operation.sessionId)
              .then((result) => {
                const pending =
                  localUserTurnsRef.current.get(operation.sessionId) || [];
                const cancelled = pending.find((turn) => turn.queueId === id);
                const remaining = cancelled
                  ? removeLocalTurnAndRebase(pending, cancelled)
                  : pending;
                if (remaining.length)
                  localUserTurnsRef.current.set(operation.sessionId, remaining);
                else localUserTurnsRef.current.delete(operation.sessionId);
                patchSessionCache(operation.sessionId, {
                  queue: result.queue,
                  queuePaused: result.paused,
                });
                if (!viewOperationIsCurrent(operation)) return;
                if (cancelled?.renderedInTranscript)
                  setMessages((current) =>
                    current.filter((message) => message !== cancelled.message),
                  );
                setQueue(result.queue);
                setQueuePaused(result.paused);
              })
              .catch((cause) => {
                if (viewOperationIsCurrent(operation))
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  );
              });
          }}
          onResume={() => {
            const operation = captureViewOperation();
            void api
              .resumeQueue(operation.sessionId)
              .then((result) => {
                patchSessionCache(operation.sessionId, {
                  queue: result.queue,
                  queuePaused: result.paused,
                });
                if (!viewOperationIsCurrent(operation)) return;
                setQueue(result.queue);
                setQueuePaused(result.paused);
              })
              .catch((cause) => {
                if (viewOperationIsCurrent(operation))
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  );
              });
          }}
        />
        <ChatInput
          streaming={composerQueueMode}
          activelyStreaming={state.isStreaming}
          stopping={stopping}
          disabled={
            loading ||
            currentSessionBusy ||
            viewSwitching ||
            observing ||
            lifecycleBlocked ||
            Boolean(state.isCompacting) ||
            primarySessionFailed
          }
          disabledPlaceholder={
            lifecycleBlocked
              ? "Pi Chat 正在执行全局维护，暂时不能提交新操作"
              : observing
                ? "此对话正在另一窗口中控制；点击“接管控制”后可操作"
                : primarySessionFailed
                  ? "Pi Runtime 当前不可用；历史仍可阅读"
                  : state.isCompacting
                    ? "正在压缩上下文，完成后可继续发送…"
                    : runtimeStatus === "restoring" ||
                        (currentSessionBusy && runtimeStatus !== "active")
                      ? "正在准备 Pi；可随时切换到其他对话"
                      : runtimeStatus === "view-only"
                        ? "当前为历史查看；发送时会自动准备 Pi"
                        : undefined
          }
          acceptsImages={state.model?.input?.includes("image") === true}
          commands={commands}
          controls={
            <ComposerControls
              state={state}
              models={models}
              stats={stats}
              disabled={
                currentSessionBusy ||
                viewSwitching ||
                observing ||
                lifecycleBlocked ||
                Boolean(state.isCompacting)
              }
              settingsBusy={settingsBusy}
              streaming={state.isStreaming}
              gateAvailable={gateAvailable}
              gateMode={gateMode}
              primaryUnavailable={primarySessionFailed}
              onGate={(mode) => void changeGate(mode)}
              onModel={(provider, id) => void changeModel(provider, id)}
              onThinking={(level) => void changeThinking(level)}
            />
          }
          notices={
            <>
              {primaryRuntimeMessage && (
                <div
                  className={`primary-runtime-status is-${primaryRuntime.status}`}
                  role="status"
                >
                  {primaryRuntimeMessage}
                </div>
              )}
              {promptStarting && !state.isStreaming && toolStatus && (
                <div className="composer-preparing-status" role="status">
                  <span className="loader small" />
                  {toolStatus}
                </div>
              )}
              {(error || notice) && (
                <div
                  className={`app-toast ${error ? "error" : ""}`}
                  role="status"
                >
                  {error || notice}
                </div>
              )}
            </>
          }
          onSend={send}
          onPickLocalFiles={async () => (await api.pickLocalFiles()).paths}
          onReadClipboardFiles={async () =>
            (await api.clipboardLocalFiles()).paths
          }
          onError={setError}
          onAbort={stopGeneration}
        />
      </main>
      <ManagementPanel
        section={managementSection}
        appearance={appearance}
        models={models}
        state={state}
        busy={busy || globalMutationBlocked}
        onClose={() => setManagementSection(null)}
        onAppearance={setAppearance}
        onModel={(provider, id) => void changeModel(provider, id)}
        onShutdown={() => void shutdownPiChat()}
      />
      <SessionDialog
        state={sessionDialog}
        busy={sessionActionBusy}
        onClose={() => setSessionDialog(null)}
        onRename={(name) => void renameSession(name)}
        onDelete={() => void deleteSession()}
      />
      <ExtensionDialog
        request={extensionRequest}
        onRespond={(body) => void respondToExtension(body)}
      />
      <EditDiffSidebar
        open={diffSidebarOpen}
        width={diffSidebarWidth}
        onOpenChange={setDiffSidebarOpen}
        onWidthChange={setDiffSidebarWidth}
      />
    </div>
  );
}
