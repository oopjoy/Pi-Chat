import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ApplicationLifecycle, BootstrapData, ExtensionUiRequest, ModelInfo, PiMessage, PiState, PromptImage, QueuedPrompt, SessionStats, SessionSummary, SessionViewData, SlashCommand, ThinkingLevel } from "../shared/types";
import { api } from "./api";
import { ChatInput } from "./components/ChatInput";
import { ChatMessage } from "./components/ChatMessage";
import { ConversationProcess } from "./components/ConversationProcess";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { ChevronRightIcon, PiMarkIcon } from "./components/Icons";
import { ManagementPanel, type ManagementSection } from "./components/ManagementPanel";
import { PromptQueue } from "./components/PromptQueue";
import { SessionControlBanner } from "./components/SessionControlBanner";
import { SessionDialog, type SessionDialogState } from "./components/SessionDialog";
import { SessionSidebar } from "./components/SessionSidebar";
import { TopBar } from "./components/TopBar";
import { useLiveMessageScheduler } from "./hooks/use-live-message";
import { shouldReconnectEventSource, usePiEventSource } from "./hooks/use-pi-event-source";
import { activeSessionIdsFromEvent, applyActiveSessionIds } from "./lib/active-sessions";
import { adjacentUserMessageOffset } from "./lib/conversation-navigation";
import { groupConversation } from "./lib/conversation-process";
import { extensionExecutionNotice } from "./lib/extension-notice";
import { gateModeFromCommand, gateModeFromNotice, type GateMode } from "./lib/gate-mode";
import { assistantMessage, lifecycleFromEvent, parseEventData, userMessage } from "./lib/pi-events";
import { applyAppearance, loadAppearance, loadSidebarOpen, loadSidebarWidth, saveAppearance, saveSidebarOpen, saveSidebarWidth, type AppearancePreferences } from "./lib/preferences";
import { rememberedSessionId, rememberSessionId } from "./lib/session-location";
import { SessionScrollMemory } from "./lib/session-scroll-memory";
import { SessionViewCache } from "./lib/session-view-cache";

const EMPTY_STATE: PiState = { model: null, isStreaming: false };

export function App() {
  const [state, setState] = useState<PiState>(EMPTY_STATE);
  const [messages, setMessages] = useState<PiMessage[]>([]);
  const [pendingUserMessage, setPendingUserMessage] = useState<PiMessage | null>(null);
  const [messageTotal, setMessageTotal] = useState(0);
  const [turnTotal, setTurnTotal] = useState(0);
  const [visibleTurnCount, setVisibleTurnCount] = useState(20);
  const [messagesTruncated, setMessagesTruncated] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [stats, setStats] = useState<SessionStats | undefined>();
  const [liveMessage, setLiveMessage] = useState<PiMessage | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [activeSessionIds, setActiveSessionIds] = useState<string[]>([]);
  const [viewedSessionId, setViewedSessionId] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [workspaceCwd, setWorkspaceCwd] = useState("");
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [gateAvailableOverride, setGateAvailableOverride] = useState<boolean | null>(null);
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [promptStarting, setPromptStarting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  /** Model / thinking only — must not freeze composer, sidebar, or the whole shell. */
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [workspacePicking, setWorkspacePicking] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [managementSection, setManagementSection] = useState<ManagementSection | null>(null);
  const [closeComplete, setCloseComplete] = useState<"window" | "application" | null>(null);
  const [sessionDialog, setSessionDialog] = useState<SessionDialogState>(null);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [appearance, setAppearance] = useState<AppearancePreferences>(loadAppearance);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [toolStatus, setToolStatus] = useState("");
  const [extensionRequest, setExtensionRequest] = useState<ExtensionUiRequest | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<"active" | "restoring" | "view-only" | "draft">("active");
  const [localDraft, setLocalDraft] = useState(false);
  const [viewControl, setViewControl] = useState<{ controlOwner?: string; controlledByThisWindow?: boolean }>({});
  const [eventSourceGeneration, setEventSourceGeneration] = useState(0);
  const [applicationLifecycle, setApplicationLifecycle] = useState<ApplicationLifecycle>("idle");
  const [gateModes, setGateModes] = useState<Record<string, GateMode>>({});
  const [failedSessionIds, setFailedSessionIds] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const scrollMemoryRef = useRef(new SessionScrollMemory());
  const pendingScrollRestoreRef = useRef("");
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
  const viewCacheRef = useRef(new SessionViewCache());
  const desiredSessionIdRef = useRef("");
  const navigationEpochRef = useRef(0);
  const refreshEpochRef = useRef(0);
  const recoveringConnectionRef = useRef<Promise<void> | null>(null);
  const commitLiveMessage = useCallback((message: PiMessage) => setLiveMessage(message), []);
  const { clearPendingLiveMessage, scheduleLiveMessage } = useLiveMessageScheduler(commitLiveMessage);

  const setViewedId = useCallback((id: string) => {
    clearPendingLiveMessage();
    viewedSessionIdRef.current = id;
    desiredSessionIdRef.current = id;
    setViewedSessionId(id);
    rememberSessionId(id);
  }, [clearPendingLiveMessage]);

  // Bootstrap owns application-wide metadata. Keep it separate from the selected
  // view so a refresh can restore a remembered cold Session without briefly
  // committing the Primary Runtime's blank draft to the timeline.
  const applyBootstrapMetadata = useCallback((data: BootstrapData) => {
    setSessions(data.sessions);
    const activeId = data.activeSessionId || data.sessions.find((session) => session.active)?.id || "";
    setActiveSessionId(activeId);
    setActiveSessionIds(data.activeSessionIds || (activeId ? [activeId] : []));
    setModels(data.models);
    setWorkspaceCwd(data.workspaceCwd);
    applicationLifecycleRef.current = data.applicationLifecycle || "idle";
    setApplicationLifecycle(data.applicationLifecycle || "idle");
  }, []);

  const applyBootstrap = useCallback((data: BootstrapData) => {
    localDraftRef.current = false;
    setLocalDraft(false);
    setPromptStarting(false);
    applyBootstrapMetadata(data);
    setGateAvailableOverride(null);
    setViewControl({ controlOwner: data.controlOwner, controlledByThisWindow: data.controlledByThisWindow });
    setState(data.state);
    setMessages(data.messages);
    setPendingUserMessage(null);
    setMessageTotal(data.messageTotal ?? data.messages.length);
    setTurnTotal(data.turnTotal ?? data.messages.filter((message) => message.role === "user").length);
    setVisibleTurnCount(data.visibleTurnCount ?? data.messages.filter((message) => message.role === "user").length);
    setMessagesTruncated(data.messagesTruncated === true);
    setStats(data.stats);
    setViewedId(data.activeSessionId || data.sessions.find((session) => session.active)?.id || "");
    setCommands(data.commands);
    setQueue(data.queue);
    setQueuePaused(data.queuePaused);
    setLiveMessage(null);
    setLiveMessage(data.liveMessage || null);
    setToolStatus(data.toolStatus || "");
    setExtensionRequest(data.pendingExtensionRequest || null);
    setRuntimeStatus("active");
    const activeViewId = data.activeSessionId || data.sessions.find((item) => item.active)?.id || "";
    const activeViewSession = data.sessions.find((session) => session.id === activeViewId);
    if (activeViewSession) viewCacheRef.current.remember({
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
    });
  }, [applyBootstrapMetadata, setViewedId]);

  const applySessionView = useCallback((view: SessionViewData) => {
    localDraftRef.current = false;
    setLocalDraft(false);
    setPromptStarting(false);
    setGateAvailableOverride(typeof view.gateAvailable === "boolean" ? view.gateAvailable : null);
    setViewControl({ controlOwner: view.controlOwner ?? view.session.controlOwner, controlledByThisWindow: view.controlledByThisWindow ?? view.session.controlledByThisWindow });
    setState(view.state);
    setMessages(view.messages);
    setPendingUserMessage(null);
    setMessageTotal(view.messageTotal);
    setTurnTotal(view.turnTotal ?? view.messages.filter((message) => message.role === "user").length);
    setVisibleTurnCount(view.visibleTurnCount ?? view.messages.filter((message) => message.role === "user").length);
    setMessagesTruncated(view.messagesTruncated);
    setStats(view.stats);
    setQueue(view.queue || []);
    setQueuePaused(view.queuePaused === true);
    if (view.commands) setCommands(view.commands);
    setLiveMessage(view.liveMessage || null);
    setToolStatus(view.toolStatus || "");
    setExtensionRequest(view.pendingExtensionRequest || null);
    setRuntimeStatus(view.runtimeStatus || (view.isActive ? "active" : "view-only"));
    // A blank New draft has no persisted user message and intentionally stays
    // out of sidebar history until its first successful prompt.
    if (view.session.messageCount > 0) setSessions((current) => current.some((session) => session.id === view.session.id) ? current.map((session) => session.id === view.session.id ? { ...session, ...view.session } : session) : [...current, view.session]);
    if (view.isActive) setActiveSessionIds((current) => [...new Set([...current, view.session.id])]);
    setViewedId(view.session.id);
  }, [setViewedId]);

  const refresh = useCallback(async () => {
    const refreshEpoch = ++refreshEpochRef.current;
    const navigationEpoch = navigationEpochRef.current;
    const wantedId = desiredSessionIdRef.current || viewedSessionIdRef.current || rememberedSessionId();
    const data = await api.bootstrap();
    if (refreshEpochRef.current !== refreshEpoch || navigationEpochRef.current !== navigationEpoch) return;
    // A local New draft intentionally has no Pi Session yet. Reconnect/bootstrap
    // may refresh global metadata, but must not replace its unsent composer.
    if (localDraftRef.current) {
      applyBootstrapMetadata(data);
      return;
    }
    const activeId = data.activeSessionId || data.sessions.find((session) => session.active)?.id || "";
    if (wantedId && wantedId !== activeId) {
      desiredSessionIdRef.current = wantedId;
      try {
        const view = await api.viewSession(wantedId);
        if (refreshEpochRef.current !== refreshEpoch || navigationEpochRef.current !== navigationEpoch || desiredSessionIdRef.current !== wantedId) return;
        viewCacheRef.current.remember(view);
        // Commit metadata and the wanted view together. Do not render the Primary
        // draft in between: EventSource readiness also calls refresh after F5.
        applyBootstrapMetadata(data);
        applySessionView(view);
        return;
      } catch (cause) {
        // Another window may have deleted this Session while this page was refreshing.
        // Bootstrap has already selected the current writable Session, so treat that 404 as recovery.
        if (!(cause instanceof Error) || !cause.message.includes("会话不存在")) {
          applyBootstrap(data);
          throw cause;
        }
        desiredSessionIdRef.current = activeId;
      }
    }
    applyBootstrap(data);
  }, [applyBootstrap, applyBootstrapMetadata, applySessionView]);

  const refreshSidebarSessions = useCallback(async () => {
    if (sessionRefreshInFlightRef.current) {
      sessionRefreshRequestedRef.current = true;
      return;
    }
    sessionRefreshInFlightRef.current = true;
    try {
      const result = await api.sessions();
      setSessions(result.sessions);
    } finally {
      sessionRefreshInFlightRef.current = false;
      if (sessionRefreshRequestedRef.current) {
        sessionRefreshRequestedRef.current = false;
        void refreshSidebarSessions();
      }
    }
  }, []);

  const scheduleSidebarRefresh = useCallback(() => {
    if (sessionRefreshTimerRef.current !== null) window.clearTimeout(sessionRefreshTimerRef.current);
    sessionRefreshTimerRef.current = window.setTimeout(() => {
      sessionRefreshTimerRef.current = null;
      void refreshSidebarSessions().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    }, 180);
  }, [refreshSidebarSessions]);

  useEffect(() => {
    refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setLoading(false));
    return () => { if (sessionRefreshTimerRef.current !== null) window.clearTimeout(sessionRefreshTimerRef.current); };
  }, [refresh]);

  useEffect(() => {
    applyAppearance(appearance);
    saveAppearance(appearance);
  }, [appearance]);

  useEffect(() => saveSidebarOpen(sidebarOpen), [sidebarOpen]);
  useEffect(() => saveSidebarWidth(sidebarWidth), [sidebarWidth]);

  // EventSource reconnects after a server restart, but it cannot replay events
  // missed while disconnected. Keep transport ownership in usePiEventSource;
  // this component remains responsible only for translating events into UI state.
  const handleEventSourceReady = useCallback((rawEvent: Event, source: EventSource) => {
      lastEventFrameAtRef.current = Date.now();
      const ready = parseEventData(rawEvent);
      if (lifecycleFromEvent(ready) === "restarting") {
        applicationLifecycleRef.current = "restarting";
        setApplicationLifecycle("restarting");
        setNotice("Pi Chat 正在构建并重启，暂时停止接收新操作…");
        source.close();
        handoffWaitRef.current ||= api.waitForApplicationHandoff().then(() => window.location.reload()).catch((cause) => {
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
          setNotice(readyLifecycle === "workspace-changing" ? "正在切换工作目录…" : "正在更新配置并重载 Runtime…");
        }
        return;
      }
      void refresh().then(() => {
        const id = viewedSessionIdRef.current;
        if (id) void api.markSessionViewed(id).catch(() => undefined);
      }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [refresh]);

  const handlePiEvent = useCallback((rawEvent: Event, source: EventSource) => {
      lastEventFrameAtRef.current = Date.now();
      const event = parseEventData(rawEvent);
      const type = String(event.type || "");
      sseFloodCountRef.current = 0;
      if (type === "pi_chat_heartbeat") return;
      if (type === "pi_chat_sse_resync" || type === "pi_chat_oversized_event") {
        void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        return;
      }
      const eventSessionId = typeof event.piChatSessionId === "string" ? event.piChatSessionId : "";
      if (eventSessionId && ["agent_start", "agent_settled", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end", "pi_chat_process_error"].includes(type)) {
        sessionEventVersionRef.current.set(eventSessionId, (sessionEventVersionRef.current.get(eventSessionId) || 0) + 1);
        lastSessionEventTypeRef.current.set(eventSessionId, type);
      }
      const viewingEventSession = !eventSessionId || eventSessionId === viewedSessionIdRef.current;
      if (eventSessionId && ["agent_start", "agent_settled", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end"].includes(type)) viewCacheRef.current.forget(eventSessionId);
      if (type === "pi_chat_application_closing") {
        source.close();
        setManagementSection(null);
        setCloseComplete("application");
        window.setTimeout(() => window.close(), 40);
      } else if (type === "agent_start") {
        if (eventSessionId) setSessions((current) => current.map((session) => ({ ...session, running: session.id === eventSessionId ? true : session.running })));
        if (viewingEventSession) {
          setPromptStarting(false);
          setRuntimeStatus("active");
          setState((current) => ({ ...current, isStreaming: true }));
          setToolStatus("Pi 正在思考…");
        }
      } else if (type === "compaction_start") {
        if (viewingEventSession) {
          const reason = String(event.reason || "");
          setState((current) => ({ ...current, isCompacting: true }));
          setToolStatus(reason === "overflow" ? "上下文溢出，正在自动压缩…" : "正在压缩上下文…");
        }
      } else if (type === "compaction_end") {
        if (viewingEventSession) {
          setState((current) => ({ ...current, isCompacting: false }));
          setToolStatus("");
          const errorMessage = typeof event.errorMessage === "string" ? event.errorMessage : "";
          if (errorMessage) setError(errorMessage);
          else if (event.aborted === false) {
            setNotice("上下文压缩完成");
            // The server now reports the compacted context as ready-but-unknown.
            void api.viewSession(eventSessionId).then((view) => {
              if (viewedSessionIdRef.current === eventSessionId) applySessionView(view);
            }).catch(() => undefined);
          }
        }
      } else if ((type === "message_start" || type === "message_update") && viewingEventSession) {
        const assistant = assistantMessage(event);
        if (assistant) scheduleLiveMessage(assistant);
      } else if (type === "message_end" && viewingEventSession) {
        clearPendingLiveMessage();
        const assistant = assistantMessage(event);
        if (assistant) setMessages((current) => [...current, assistant]);
        setLiveMessage(null);
      } else if (type === "tool_execution_start" && viewingEventSession) {
        setToolStatus(`正在运行工具：${String(event.toolName || "unknown")}`);
      } else if (type === "tool_execution_end" && viewingEventSession) {
        setToolStatus(`${String(event.toolName || "工具")} ${event.isError ? "执行失败" : "已完成"}`);
      } else if (type === "agent_settled") {
        if (eventSessionId) setSessions((current) => current.map((session) => session.id === eventSessionId ? { ...session, running: false } : session));
        if (viewingEventSession) {
          if (promptReconcileTimerRef.current !== null) window.clearTimeout(promptReconcileTimerRef.current);
          promptReconcileTimerRef.current = null;
          setPromptStarting(false);
          setState((current) => ({ ...current, isStreaming: false }));
          setToolStatus("");
          // A post-compaction turn has now persisted its new usage snapshot.
          void api.viewSession(eventSessionId).then((view) => {
            if (viewedSessionIdRef.current === eventSessionId) applySessionView(view);
          }).catch(() => undefined);
        }
        scheduleSidebarRefresh();
      } else if (type === "pi_chat_active_session_changed") {
        const ids = activeSessionIdsFromEvent(event.activeSessionIds);
        setActiveSessionIds(ids);
        setSessions((current) => applyActiveSessionIds(current, ids));
        const id = typeof event.sessionId === "string" ? event.sessionId : "";
        if (id === viewedSessionIdRef.current && !ids.includes(id)) setRuntimeStatus("view-only");
        scheduleSidebarRefresh();
      } else if (type === "pi_chat_application_lifecycle") {
        const lifecycle = String(event.lifecycle || "idle") as ApplicationLifecycle;
        applicationLifecycleRef.current = lifecycle;
        setApplicationLifecycle(lifecycle);
        if (lifecycle === "restarting") setNotice("Pi Chat 正在构建并重启，暂时停止接收新操作…");
        else if (lifecycle === "workspace-changing") setNotice("正在切换工作目录…");
        else if (lifecycle === "resources-reloading") setNotice("正在更新配置并重载 Runtime…");
        else if (lifecycle === "idle") {
          setNotice("");
          void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        }
      } else if (type === "pi_chat_sessions_changed") {
        if (typeof event.sessionId === "string") viewCacheRef.current.forget(event.sessionId);
        if (event.action === "deleted" && event.sessionId === viewedSessionIdRef.current) {
          viewedSessionIdRef.current = "";
          void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        } else {
          scheduleSidebarRefresh();
        }
      } else if (type === "pi_chat_queue_update" && viewingEventSession) {
        setQueue(Array.isArray(event.queue) ? event.queue as unknown as QueuedPrompt[] : []);
        setQueuePaused(event.paused === true);
      } else if (type === "pi_chat_queue_dispatch") {
        if (viewingEventSession) {
          const queuedText = typeof event.message === "string" && event.message ? event.message : Number(event.imageCount) > 0 ? `请查看附加的 ${Number(event.imageCount)} 张图片` : "队列消息";
          setMessages((current) => [...current, userMessage(queuedText, [])]);
        }
        if (viewingEventSession) setState((current) => ({ ...current, isStreaming: true }));
      } else if (type === "pi_chat_queue_error" && viewingEventSession) {
        setError(String(event.error || "队列消息发送失败"));
      } else if (type === "extension_ui_request") {
        const request = event as unknown as ExtensionUiRequest;
        if (["select", "confirm", "input", "editor"].includes(request.method)) {
          if (eventSessionId) setSessions((current) => current.map((session) => session.id === eventSessionId ? { ...session, pendingConfirmation: true } : session));
          if (viewingEventSession) setExtensionRequest(request);
        }
        else if (request.method === "notify") {
          const mode = gateModeFromNotice(request.message);
          if (mode && eventSessionId) setGateModes((current) => ({ ...current, [eventSessionId]: mode }));
          setNotice(request.message || "Pi 通知");
        }
      } else if (type === "pi_chat_session_control_changed") {
        const id = typeof event.sessionId === "string" ? event.sessionId : "";
        const owner = typeof event.controlOwner === "string" ? event.controlOwner : undefined;
        const controlledByThisWindow = event.controlledByThisWindow === true;
        if (id === viewedSessionIdRef.current) setViewControl({ controlOwner: owner, controlledByThisWindow });
        if (id) setSessions((current) => current.map((session) => session.id === id ? { ...session, controlOwner: owner, controlledByThisWindow } : session));
      } else if (type === "pi_chat_extension_request_resolved") {
        if (viewingEventSession) setExtensionRequest((current) => current?.id === event.id ? null : current);
        if (eventSessionId) setSessions((current) => current.map((session) => session.id === eventSessionId ? { ...session, pendingConfirmation: false } : session));
      } else if (type === "extension_error") {
        setError(String(event.error || "扩展执行失败"));
      } else if (type === "pi_chat_process_recovered") {
        if (eventSessionId) setFailedSessionIds((current) => current.filter((id) => id !== eventSessionId));
      } else if (type === "pi_chat_process_error") {
        if (eventSessionId) {
          setFailedSessionIds((current) => [...new Set([...current, eventSessionId])]);
          setSessions((current) => current.map((session) => session.id === eventSessionId ? { ...session, running: false } : session));
        }
        if (viewingEventSession) {
          if (promptReconcileTimerRef.current !== null) window.clearTimeout(promptReconcileTimerRef.current);
          promptReconcileTimerRef.current = null;
          setPromptStarting(false);
          setError(String(event.error || "Pi RPC 已退出"));
          setState((current) => ({ ...current, isStreaming: false }));
          stoppingRef.current = false;
          setStopping(false);
        }
      }
  }, [applySessionView, clearPendingLiveMessage, refresh, scheduleLiveMessage, scheduleSidebarRefresh]);

  const handleEventSourceError = useCallback((source: EventSource) => {
      source.close();
      if (applicationLifecycleRef.current === "restarting") {
        handoffWaitRef.current ||= api.waitForApplicationHandoff().then(() => window.location.reload()).catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
          handoffWaitRef.current = null;
        });
        return;
      }
      setError("与 Pi Chat 服务的事件连接已断开，正在重新连接…");
      recoveringConnectionRef.current ||= api.recoverConnection().then(() => {
        recoveringConnectionRef.current = null;
        setEventSourceGeneration((generation) => generation + 1);
        return refresh();
      }).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        recoveringConnectionRef.current = null;
      });
  }, [refresh]);

  const handleOversizedEventSourceFrame = useCallback((source: EventSource) => {
    source.close();
    lastEventFrameAtRef.current = Date.now();
    sseFloodCountRef.current += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(sseFloodCountRef.current - 1, 5));
    if (sseReconnectTimerRef.current !== null) window.clearTimeout(sseReconnectTimerRef.current);
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    sseReconnectTimerRef.current = window.setTimeout(() => {
      sseReconnectTimerRef.current = null;
      setEventSourceGeneration((generation) => generation + 1);
    }, delay);
  }, [refresh]);

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
    const resume = (event?: Event) => {
      if (document.visibilityState === "hidden") return;
      // Chromium may preserve a half-open EventSource while a standalone PWA is
      // frozen. A real visibility/pageshow resume always gets a fresh socket;
      // focus/online/watchdog only reconnect after a missed heartbeat window.
      if (!shouldReconnectEventSource(event?.type, document.visibilityState, lastEventFrameAtRef.current, Date.now())) return;
      lastEventFrameAtRef.current = Date.now();
      setEventSourceGeneration((generation) => generation + 1);
      void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    };
    const watchdog = window.setInterval(() => resume(), 10_000);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    return () => {
      window.clearInterval(watchdog);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
    };
  }, [loading, refresh]);

  useEffect(() => () => {
    if (promptReconcileTimerRef.current !== null) window.clearTimeout(promptReconcileTimerRef.current);
    if (sseReconnectTimerRef.current !== null) window.clearTimeout(sseReconnectTimerRef.current);
  }, []);

  useEffect(() => {
    if (loading || !viewedSessionId) return;
    void api.markSessionViewed(viewedSessionId).catch(() => undefined);
  }, [loading, viewedSessionId]);

  useLayoutEffect(() => {
    const sessionId = pendingScrollRestoreRef.current;
    if (!sessionId || sessionId !== viewedSessionId) return;
    const timeline = scrollRef.current;
    if (!timeline) return;
    const target = scrollMemoryRef.current.target(sessionId, timeline.scrollHeight, timeline.clientHeight);
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
      const view = await api.viewSession(id, visibleTurnCount + 10);
      if (viewedSessionIdRef.current !== id) return;
      applySessionView(view);
      requestAnimationFrame(() => {
        const element = scrollRef.current;
        if (element) element.scrollTop = Math.max(0, element.scrollHeight - previousHeight);
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
    scrollMemoryRef.current.remember(sessionId, element.scrollTop, element.scrollHeight, element.clientHeight, visibleTurnCount);
  };

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    if (pendingScrollRestoreRef.current === viewedSessionIdRef.current) return;
    stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    rememberCurrentScroll();
  };

  const navigateConversation = (direction: "top" | "previous" | "next" | "bottom") => {
    const timeline = scrollRef.current;
    if (!timeline) return;
    if (direction === "top") {
      stickToBottomRef.current = false;
      timeline.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (direction === "bottom") {
      stickToBottomRef.current = true;
      timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
      return;
    }
    const messagesInView = [...timeline.querySelectorAll<HTMLElement>(".message-user")];
    const target = adjacentUserMessageOffset(messagesInView.map((message) => message.offsetTop), timeline.scrollTop, direction);
    if (target !== null) {
      stickToBottomRef.current = false;
      timeline.scrollTo({ top: target - 14, behavior: "smooth" });
    }
  };

  const schedulePromptReconcile = (sessionId: string, eventVersion = sessionEventVersionRef.current.get(sessionId) || 0, failedAttempts = 0): void => {
    if (promptReconcileTimerRef.current !== null) window.clearTimeout(promptReconcileTimerRef.current);
    promptReconcileTimerRef.current = window.setTimeout(() => {
      promptReconcileTimerRef.current = null;
      if (viewedSessionIdRef.current !== sessionId) return;
      const latestVersion = sessionEventVersionRef.current.get(sessionId) || 0;
      if (latestVersion !== eventVersion) {
        schedulePromptReconcile(sessionId, latestVersion);
        return;
      }
      void api.viewSession(sessionId).then((view) => {
        if (viewedSessionIdRef.current !== sessionId) return;
        applySessionView(view);
        setPromptStarting(false);
        if (view.isStreaming) schedulePromptReconcile(sessionId, sessionEventVersionRef.current.get(sessionId) || 0);
      }).catch((cause) => {
        if (viewedSessionIdRef.current !== sessionId) return;
        if (failedAttempts < 4) schedulePromptReconcile(sessionId, latestVersion, failedAttempts + 1);
        else setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, 4_000);
  };

  const send = async (message: string, images: PromptImage[]) => {
    setError("");
    stickToBottomRef.current = true;
    setBusy(true);
    const alreadyStreaming = state.isStreaming;
    const previousToolStatus = toolStatus;
    const optimisticMessage = alreadyStreaming || message.startsWith("/") ? null : userMessage(message, images);
    setPendingUserMessage(optimisticMessage);
    try {
      const command = /^\/(new|compact|abort)(?:\s+([\s\S]*))?$/.exec(message);
      if (command?.[1] === "new") {
        createSession();
        return;
      }
      if (command?.[1] === "compact") {
        if (localDraftRef.current) throw new Error("新对话尚未发送消息，无需压缩上下文");
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

      let targetSessionId = viewedSessionIdRef.current;
      if (localDraftRef.current) {
        const draftModel = state.model;
        const draftThinking = state.thinkingLevel as ThinkingLevel | undefined;
        setPromptStarting(true);
        setToolStatus("正在启动 Pi 内核…");
        await clearViewedPromiseRef.current;
        clearViewedPromiseRef.current = null;
        const view = await api.newSession();
        targetSessionId = view.session.id;
        applySessionView(view);
        setPendingUserMessage(optimisticMessage);
        setPromptStarting(true);
        setToolStatus("Pi 内核已就绪，正在准备消息…");
        if (draftModel && (view.state.model?.provider !== draftModel.provider || view.state.model?.id !== draftModel.id)) {
          const selected = await api.setModel(draftModel.provider, draftModel.id, targetSessionId);
          setState((current) => ({ ...current, model: selected.model }));
        }
        if (draftThinking && view.state.thinkingLevel !== draftThinking) {
          const selected = await api.setThinking(draftThinking, targetSessionId);
          setState((current) => ({ ...current, thinkingLevel: selected.level }));
        }
      } else if (runtimeStatus !== "active") {
        setPromptStarting(true);
        setToolStatus("正在启动 Pi 内核…");
        setRuntimeStatus("restoring");
        const view = await api.activateSession(targetSessionId);
        viewCacheRef.current.forget(view.session.id);
        applySessionView(view);
        setPendingUserMessage(optimisticMessage);
        setPromptStarting(true);
        setToolStatus("Pi 内核已就绪，正在准备消息…");
      } else if (!alreadyStreaming) {
        setPromptStarting(true);
        setToolStatus("正在向 Pi 提交消息…");
      }

      const eventVersionBeforePrompt = sessionEventVersionRef.current.get(targetSessionId) || 0;
      const result = await api.prompt(message, images, targetSessionId);
      setPromptStarting(false);
      if (result.extension) {
        setPendingUserMessage(null);
        setToolStatus(alreadyStreaming ? previousToolStatus : "");
        if (typeof result.isStreaming === "boolean") setState((current) => ({ ...current, isStreaming: result.isStreaming as boolean }));
        const gateMode = result.command === "gate" ? gateModeFromCommand(message) : null;
        if (gateMode && targetSessionId) setGateModes((current) => ({ ...current, [targetSessionId]: gateMode }));
        setNotice(extensionExecutionNotice(message, result.command || "extension", result.description ? [...commands, { name: result.command || "extension", description: result.description, source: "extension" }] : commands));
      } else if (result.queued) {
        setPendingUserMessage(null);
        setToolStatus(alreadyStreaming ? previousToolStatus : "");
        if (result.queue) setQueue(result.queue);
        setNotice("消息已加入队列");
      } else {
        const eventVersionAfterPrompt = sessionEventVersionRef.current.get(targetSessionId) || 0;
        const terminalEvent = lastSessionEventTypeRef.current.get(targetSessionId);
        const settledBeforeAcknowledgement = eventVersionAfterPrompt > eventVersionBeforePrompt && (terminalEvent === "agent_settled" || terminalEvent === "pi_chat_process_error");
        if (settledBeforeAcknowledgement) {
          setPendingUserMessage(null);
          const view = await api.viewSession(targetSessionId);
          if (viewedSessionIdRef.current === targetSessionId) applySessionView(view);
        } else {
          setMessages((current) => [...current, optimisticMessage || userMessage(message, images)]);
          setPendingUserMessage(null);
          setState((current) => ({ ...current, isStreaming: true }));
          setToolStatus("Pi 正在思考…");
          schedulePromptReconcile(targetSessionId);
        }
      }
    } catch (cause) {
      setPendingUserMessage(null);
      setPromptStarting(false);
      if (!state.isStreaming) setToolStatus("");
      const messageText = cause instanceof Error ? cause.message : String(cause);
      setError(messageText);
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  const stopGeneration = async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    setError("");
    try {
      const result = await api.abort(viewedSessionId);
      setState((current) => ({ ...current, isStreaming: result.isStreaming }));
      setQueuePaused(result.queuePaused);
      if (!result.isStreaming) {
        setToolStatus("");
        setLiveMessage(null);
        await refresh();
      }
      setNotice(result.queuePaused ? "已停止；队列保持暂停，可撤销或继续" : "已停止生成");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  };

  const viewSession = async (id: string) => {
    if (id === viewedSessionIdRef.current) return;
    rememberCurrentScroll();
    const rememberedTurns = scrollMemoryRef.current.turns(id);
    const epoch = ++navigationEpochRef.current;
    desiredSessionIdRef.current = id;
    setError("");
    // Keep the current conversation visible until the destination view has
    // arrived. This avoids a blank timeline while an active Session is waiting
    // for a Gate confirmation or its runtime is answering state requests.
    const cached = viewCacheRef.current.get(id);
    const cachedTurns = cached?.visibleTurnCount ?? cached?.turnTotal ?? 0;
    if (cached && (!rememberedTurns || cachedTurns >= rememberedTurns)) {
      if (navigationEpochRef.current !== epoch || desiredSessionIdRef.current !== id) return;
      pendingScrollRestoreRef.current = id;
      applySessionView(cached);
      // This cached navigation supersedes any older in-flight cold request.
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const view = await api.viewSession(id, rememberedTurns);
      if (navigationEpochRef.current !== epoch || desiredSessionIdRef.current !== id) return;
      if (!view.isActive) viewCacheRef.current.remember(view);
      else viewCacheRef.current.forget(view.session.id);
      pendingScrollRestoreRef.current = id;
      applySessionView(view);
    } catch (cause) {
      if (navigationEpochRef.current === epoch) {
        desiredSessionIdRef.current = viewedSessionIdRef.current;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (navigationEpochRef.current === epoch) setBusy(false);
    }
  };

  const createSession = () => {
    rememberCurrentScroll();
    pendingScrollRestoreRef.current = "";
    // New is a local blank composer only. Starting a Secondary Pi process here
    // made a no-op UI action block on cold RPC startup and stale draft probes.
    navigationEpochRef.current += 1;
    refreshEpochRef.current += 1;
    if (promptReconcileTimerRef.current !== null) window.clearTimeout(promptReconcileTimerRef.current);
    promptReconcileTimerRef.current = null;
    const previousViewedSessionId = viewedSessionIdRef.current;
    localDraftRef.current = true;
    setLocalDraft(true);
    setViewedId("");
    setViewControl({});
    setState({ ...EMPTY_STATE, model: state.model, thinkingLevel: state.thinkingLevel });
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
    clearViewedPromiseRef.current = previousViewedSessionId ? api.clearSessionViewed(previousViewedSessionId).catch(() => undefined) : null;
  };

  const ensureRuntimeActive = async () => {
    if (!viewedSessionId || runtimeStatus === "active") return;
    setRuntimeStatus("restoring");
    const view = await api.activateSession(viewedSessionId);
    viewCacheRef.current.forget(view.session.id);
    applySessionView(view);
  };

  const changeModel = async (provider: string, modelId: string) => {
    if (!provider || !modelId || settingsBusy) return;
    if (localDraftRef.current) {
      const model = models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
      if (model) setState((current) => ({ ...current, model }));
      setNotice(`已为新对话选择 ${model?.name || modelId}`);
      return;
    }
    setSettingsBusy(true);
    setError("");
    try {
      await ensureRuntimeActive();
      const result = await api.setModel(provider, modelId, viewedSessionId);
      setState((current) => ({ ...current, model: result.model }));
      setNotice(result.pending ? `已选择 ${result.model?.name || modelId}，下一轮对话生效` : `已切换到 ${result.model?.name || modelId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsBusy(false);
    }
  };

  const changeThinking = async (level: ThinkingLevel) => {
    if (settingsBusy) return;
    if (localDraftRef.current) {
      setState((current) => ({ ...current, thinkingLevel: level }));
      setNotice(`已为新对话选择 ${level} 思考强度`);
      return;
    }
    setSettingsBusy(true);
    setError("");
    try {
      await ensureRuntimeActive();
      const result = await api.setThinking(level, viewedSessionId);
      setState((current) => ({ ...current, thinkingLevel: result.level }));
      setNotice(result.pending ? `已选择 ${result.level}，下一轮对话生效` : `思考强度已切换为 ${result.level}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsBusy(false);
    }
  };

  const pickWorkspace = async () => {
    if (anySessionRunning || sessions.some((session) => session.queued || session.pendingConfirmation)) {
      setError("请先停止所有并行生成、处理权限确认并清空当前队列，再切换工作目录。");
      return;
    }
    setBusy(true);
    setWorkspacePicking(true);
    setError("");
    setNotice("请在弹出的 Windows 窗口中浏览并选择工作目录");
    try {
      const result = await api.pickWorkspace();
      if (result.cancelled || !result.data) return;
      applyBootstrap(result.data);
      setNotice(`已切换工作目录：${result.workspaceName || result.data.workspaceCwd}`);
      stickToBottomRef.current = true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorkspacePicking(false);
      setBusy(false);
    }
  };

  const refreshManually = async () => {
    setRefreshing(true);
    setError("");
    try {
      await refresh();
      setNotice("会话已刷新");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  };

  const restartPi = async () => {
    if (!window.confirm("完整重启 Pi Chat 并应用本地更新？\n\n将结束 Pi Chat 服务及其所有 Pi RPC 会话进程，重新构建当前工作目录，然后启动全新的 Pi Chat。已保存的前端、服务端、内置组件与本地配置更新都会生效；聊天记录不会删除。\n\n会重新加载当前电脑上已经保存的 Pi Chat、扩展和配置改动。正在生成、排队或等待确认时无法执行。")) return;
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
    if (!window.confirm("关闭全部 Pi Chat？\n\n将先检查所有窗口中的对话。只要任一对话仍在执行、排队或等待确认，就不会关闭。\n\n确认空闲后，将关闭所有浏览器/PWA 窗口、本地服务和全部 Pi RPC。聊天记录和设置会保留。")) return;
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

  const renameSession = async (name: string) => {
    if (!sessionDialog) return;
    setSessionActionBusy(true);
    setError("");
    try {
      await api.renameSession(sessionDialog.session.id, name);
      setSessionDialog(null);
      await refresh();
      setNotice("对话已重命名");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSessionActionBusy(false);
    }
  };

  const deleteSession = async () => {
    if (!sessionDialog) return;
    const deletingId = sessionDialog.session.id;
    setSessionActionBusy(true);
    setError("");
    try {
      const data = await api.deleteSession(deletingId);
      scrollMemoryRef.current.forget(deletingId);
      setSessionDialog(null);
      if (viewedSessionIdRef.current === deletingId) applyBootstrap(data);
      else await refresh();
      setNotice("对话已删除");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSessionActionBusy(false);
    }
  };

  const changeGate = async (mode: GateMode) => {
    const sessionId = viewedSessionIdRef.current;
    if (!sessionId) return;
    const previous = gateModes[sessionId] || "strict";
    setGateModes((current) => ({ ...current, [sessionId]: mode }));
    try {
      await send(`/gate ${mode}`, []);
    } catch {
      setGateModes((current) => ({ ...current, [sessionId]: previous }));
    }
  };

  const respondToExtension = async (body: Record<string, unknown>) => {
    const submittedRequest = extensionRequest;
    if (!submittedRequest) return;
    const sessionId = submittedRequest.piChatSessionId || viewedSessionIdRef.current;
    setExtensionRequest(null);
    try {
      await api.respondToExtension({ ...body, ...(sessionId ? { sessionId } : {}) });
    } catch (cause) {
      // Re-read the authoritative pending request. This distinguishes a real
      // delivery failure from a lost HTTP response after Pi already accepted it.
      try {
        if (sessionId) {
          const view = await api.viewSession(sessionId);
          if (viewedSessionIdRef.current === sessionId) setExtensionRequest(view.pendingExtensionRequest || null);
        } else setExtensionRequest(submittedRequest);
      } catch {
        if (viewedSessionIdRef.current === sessionId) setExtensionRequest(submittedRequest);
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const viewingActiveSession = Boolean(viewedSessionId) && activeSessionIds.includes(viewedSessionId);
  // Group persisted and in-flight messages as one contiguous transcript. Splitting
  // them made a completed tool segment and the next streaming thought render as
  // two adjacent “过程” cards during one agent turn.
  const conversationItems = useMemo(
    () => groupConversation([
      ...messages,
      ...(pendingUserMessage ? [pendingUserMessage] : []),
      ...(liveMessage ? [liveMessage] : []),
    ]),
    [messages, pendingUserMessage, liveMessage],
  );
  const anySessionRunning = sessions.some((session) => session.running);
  const anySessionPendingConfirmation = sessions.some((session) => session.pendingConfirmation);
  const anySessionQueued = sessions.some((session) => session.queued);
  const lifecycleBlocked = applicationLifecycle !== "idle";
  const globalMutationBlocked = lifecycleBlocked || anySessionRunning || anySessionQueued || anySessionPendingConfirmation;
  const primaryQueueBusy = viewedSessionId === activeSessionId && queue.length > 0;
  const viewedSession = sessions.find((session) => session.id === viewedSessionId);
  const conversationName = localDraft ? "新对话" : viewedSession?.name || (state.messageCount ? state.sessionName || "已保存对话" : "新对话");
  const conversationWorkspace = viewedSession?.cwd || workspaceCwd;
  // Cold view-only sessions carry no RPC command list; the server reports Gate availability explicitly.
  const gateAvailable = gateAvailableOverride ?? commands.some((command) => command.name === "gate" && command.source === "extension");
  const gateMode = gateModes[viewedSessionId] || "strict";
  const effectiveControl = { ...viewedSession, ...viewControl };
  const observing = Boolean(effectiveControl.controlOwner && !effectiveControl.controlledByThisWindow);
  const takeControl = async () => {
    if (!viewedSessionId) return;
    try {
      if (runtimeStatus !== "active") await ensureRuntimeActive();
      const result = await api.takeSessionControl(viewedSessionId);
      setViewControl(result);
      setSessions((current) => current.map((session) => session.id === viewedSessionId ? { ...session, ...result } : session));
      setNotice("已接管此对话控制权");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (closeComplete) {
    const applicationClosed = closeComplete === "application";
    return <main className="shutdown-screen">
      <span className="shutdown-mark"><PiMarkIcon /></span>
      <h1>{applicationClosed ? "Pi Chat 已关闭" : "当前窗口已退出"}</h1>
      <p>{applicationClosed ? "本地服务和会话进程已经结束。现在可以关闭此窗口。" : "其他 Pi Chat 窗口仍在运行。现在可以关闭此窗口。"}</p>
      <button type="button" onClick={() => window.close()}>关闭窗口</button>
    </main>;
  }

  return (
    <div className="app-shell">
      <SessionSidebar
        sessions={sessions}
        viewedSessionId={viewedSessionId}
        workspaceCwd={workspaceCwd}
        open={sidebarOpen}
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
        newDisabled={loading || busy || lifecycleBlocked}
        refreshDisabled={loading || refreshing}
        restartDisabled={loading || busy || refreshing || globalMutationBlocked}
        workspaceDisabled={loading || busy || workspacePicking || globalMutationBlocked}
        viewBusy={loading || busy}
        refreshing={refreshing}
        warmingSessionIds={[]}
        failedSessionIds={failedSessionIds}
        workspacePicking={workspacePicking}
        onClose={() => setSidebarOpen(false)}
        onCollapse={() => setSidebarOpen(false)}
        onNew={() => void createSession()}
        onRefresh={() => void refreshManually()}
        onRestart={() => void restartPi()}
        onView={(id) => void viewSession(id)}
        onRename={(session) => setSessionDialog({ mode: "rename", session })}
        onDelete={(session) => setSessionDialog({ mode: "delete", session })}
        onPickWorkspace={() => void pickWorkspace()}
        onManage={setManagementSection}
      />
      {!sidebarOpen && <button type="button" className="sidebar-restore" onClick={() => setSidebarOpen(true)} title="展开会话栏" aria-label="展开会话栏"><ChevronRightIcon /></button>}
      <main className="chat-shell">
        <TopBar
          state={state}
          models={models}
          stats={stats}
          conversationName={conversationName}
          workspacePath={conversationWorkspace}
          disabled={busy || observing || lifecycleBlocked}
          settingsBusy={settingsBusy}
          streaming={state.isStreaming}
          gateAvailable={gateAvailable}
          gateMode={gateMode}
          onGate={(mode) => void changeGate(mode)}
          onModel={(provider, id) => void changeModel(provider, id)}
          onThinking={(level) => void changeThinking(level)}
        />
        <div className="timeline" ref={scrollRef} onScroll={onScroll}>
          <div className="timeline-inner">
            {loading ? (
              <div className="center-state"><span className="loader" />正在连接 Pi…</div>
            ) : !messages.length && !pendingUserMessage && !liveMessage ? (
              <section className="welcome">
                <span className="welcome-mark"><PiMarkIcon /></span>
                <h1>开始与 Pi 对话</h1>
                <p>支持流式输出、Markdown、KaTeX，以及复制原始 LaTeX 源码。</p>
              </section>
            ) : (
              <>
                {messagesTruncated && <div className="message-window-notice" role="status"><span>当前显示最近 {visibleTurnCount} 轮（共 {turnTotal} 轮、{messageTotal} 条消息）</span><button type="button" onClick={() => void loadEarlierTurns()} disabled={loadingEarlier}>{loadingEarlier ? "正在加载…" : "加载更早 10 轮"}</button></div>}
                {conversationItems.map((item, index) => item.kind === "process"
                  ? <ConversationProcess key={item.key} entries={item.entries} streaming={state.isStreaming && index === conversationItems.length - 1} />
                  : <ChatMessage key={item.key} message={item.message} streaming={state.isStreaming && index === conversationItems.length - 1 && Boolean(liveMessage)} />)}
              </>
            )}
            {state.isCompacting && <div className="agent-status is-compacting" role="status"><span className="loader small" />{toolStatus || "正在压缩上下文，当前消息会在完成后继续发送…"}</div>}
            {promptStarting && !state.isStreaming && toolStatus && <div className="agent-status"><span className="loader small" />{toolStatus}</div>}
            {state.isStreaming && !state.isCompacting && toolStatus && <div className="agent-status"><span className="loader small" />{toolStatus}</div>}
          </div>
        </div>
        <nav className="conversation-nav" aria-label="对话导航">
          <button type="button" onClick={() => navigateConversation("top")} title="回到首条对话" aria-label="回到首条对话">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4h12M10 16V7M7.2 9.8 10 7l2.8 2.8" /></svg>
          </button>
          <button type="button" onClick={() => navigateConversation("previous")} title="上一条对话" aria-label="上一条对话">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4M5.8 8.2 10 4l4.2 4.2" /></svg>
          </button>
          <button type="button" onClick={() => navigateConversation("next")} title="下一条对话" aria-label="下一条对话">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M5.8 11.8 10 16l4.2-4.2" /></svg>
          </button>
          <button type="button" onClick={() => navigateConversation("bottom")} title="回到最新对话" aria-label="回到最新对话">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16h12M10 4v9M7.2 10.2 10 13l2.8-2.8" /></svg>
          </button>
        </nav>
        <SessionControlBanner observing={observing} disabled={lifecycleBlocked} onTakeOver={() => void takeControl()} />
        <PromptQueue
          queue={queue}
          paused={queuePaused}
          busy={busy || observing || lifecycleBlocked}
          onCancel={(id) => void api.cancelQueued(id, viewedSessionId).then((result) => { setQueue(result.queue); setQueuePaused(result.paused); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}
          onResume={() => void api.resumeQueue(viewedSessionId).then((result) => { setQueue(result.queue); setQueuePaused(result.paused); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}
        />
        <ChatInput
          streaming={state.isStreaming}
          stopping={stopping}
          disabled={loading || busy || observing || lifecycleBlocked || Boolean(state.isCompacting)}
          disabledPlaceholder={lifecycleBlocked ? "Pi Chat 正在执行全局维护，暂时不能提交新操作" : observing ? "此对话正在另一窗口中控制；点击“接管控制”后可操作" : state.isCompacting ? "正在压缩上下文，完成后可继续发送…" : runtimeStatus === "restoring" || (busy && runtimeStatus !== "active") ? "正在恢复 Pi Runtime，就绪后即可发送…" : runtimeStatus === "view-only" ? "当前为只读查看；发送时会自动恢复 Pi Runtime" : undefined}
          acceptsImages={state.model?.input?.includes("image") === true}
          commands={commands}
          onSend={send}
          onPickLocalFiles={async () => (await api.pickLocalFiles()).paths}
          onReadClipboardFiles={async () => (await api.clipboardLocalFiles()).paths}
          onError={setError}
          onAbort={stopGeneration}
        />
        {(error || notice) && <div className={`app-toast ${error ? "error" : ""}`} role="status">{error || notice}</div>}
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
        onReloaded={(data) => data ? applyBootstrap(data) : void refresh()}
        onShutdown={() => void shutdownPiChat()}
      />
      <SessionDialog
        state={sessionDialog}
        busy={sessionActionBusy}
        onClose={() => setSessionDialog(null)}
        onRename={(name) => void renameSession(name)}
        onDelete={() => void deleteSession()}
      />
      <ExtensionDialog request={extensionRequest} onRespond={(body) => void respondToExtension(body)} />
    </div>
  );
}
