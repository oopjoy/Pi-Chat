import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BootstrapData, ExtensionUiRequest, ModelInfo, PiMessage, PiState, PromptImage, QueuedPrompt, SessionStats, SessionSummary, SessionViewData, SlashCommand, ThinkingLevel } from "../shared/types";
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
import { adjacentUserMessageOffset } from "./lib/conversation-navigation";
import { groupConversation } from "./lib/conversation-process";
import { extensionExecutionNotice } from "./lib/extension-notice";
import { gateModeFromCommand, gateModeFromNotice, type GateMode } from "./lib/gate-mode";
import { applyAppearance, loadAppearance, loadSidebarOpen, loadSidebarWidth, saveAppearance, saveSidebarOpen, saveSidebarWidth, type AppearancePreferences } from "./lib/preferences";

const EMPTY_STATE: PiState = { model: null, isStreaming: false };
const VIEW_CACHE_LIMIT = 5;

type SessionViewSnapshot = SessionViewData & { cachedAt: number };

function rememberView(cache: Map<string, SessionViewSnapshot>, view: SessionViewData): void {
  cache.delete(view.session.id);
  cache.set(view.session.id, { ...view, cachedAt: Date.now() });
  while (cache.size > VIEW_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function forgetView(cache: Map<string, SessionViewSnapshot>, id: string): void {
  cache.delete(id);
}

function assistantMessage(event: Record<string, unknown>): PiMessage | null {
  const message = event.message;
  if (!message || typeof message !== "object" || (message as PiMessage).role !== "assistant") return null;
  return message as PiMessage;
}

function userMessage(text: string, images: PromptImage[]): PiMessage {
  if (!images.length) return { role: "user", content: text, timestamp: Date.now() };
  return {
    role: "user",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })),
    ],
    timestamp: Date.now(),
  };
}

export function App() {
  const [state, setState] = useState<PiState>(EMPTY_STATE);
  const [messages, setMessages] = useState<PiMessage[]>([]);
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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [workspacePicking, setWorkspacePicking] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [managementSection, setManagementSection] = useState<ManagementSection | null>(null);
  const [sessionDialog, setSessionDialog] = useState<SessionDialogState>(null);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [appearance, setAppearance] = useState<AppearancePreferences>(loadAppearance);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [toolStatus, setToolStatus] = useState("");
  const [extensionRequest, setExtensionRequest] = useState<ExtensionUiRequest | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<"active" | "restoring" | "view-only">("active");
  const [gateModes, setGateModes] = useState<Record<string, GateMode>>({});
  const [warmingSessionIds, setWarmingSessionIds] = useState<string[]>([]);
  const [failedSessionIds, setFailedSessionIds] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const stoppingRef = useRef(false);
  const viewedSessionIdRef = useRef("");
  const warmingSessionIdsRef = useRef(new Set<string>());
  const sessionRefreshTimerRef = useRef<number | null>(null);
  const sessionRefreshInFlightRef = useRef(false);
  const sessionRefreshRequestedRef = useRef(false);
  const viewCacheRef = useRef(new Map<string, SessionViewSnapshot>());

  const setViewedId = useCallback((id: string) => {
    viewedSessionIdRef.current = id;
    setViewedSessionId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("session", id);
    else url.searchParams.delete("session");
    window.history.replaceState(null, "", url);
  }, []);

  const applyBootstrap = useCallback((data: BootstrapData) => {
    setState(data.state);
    setMessages(data.messages);
    setMessageTotal(data.messageTotal ?? data.messages.length);
    setTurnTotal(data.turnTotal ?? data.messages.filter((message) => message.role === "user").length);
    setVisibleTurnCount(data.visibleTurnCount ?? data.messages.filter((message) => message.role === "user").length);
    setMessagesTruncated(data.messagesTruncated === true);
    setStats(data.stats);
    setSessions(data.sessions);
    const activeId = data.activeSessionId || data.sessions.find((session) => session.active)?.id || "";
    setActiveSessionId(activeId);
    setActiveSessionIds(data.activeSessionIds || (activeId ? [activeId] : []));
    setViewedId(activeId);
    setModels(data.models);
    setWorkspaceCwd(data.workspaceCwd);
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
    if (activeViewSession) rememberView(viewCacheRef.current, {
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
  }, [setViewedId]);

  const applySessionView = useCallback((view: SessionViewData) => {
    setGateAvailableOverride(typeof view.gateAvailable === "boolean" ? view.gateAvailable : null);
    setState(view.state);
    setMessages(view.messages);
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
    const wantedId = viewedSessionIdRef.current || new URL(window.location.href).searchParams.get("session") || "";
    const data = await api.bootstrap();
    applyBootstrap(data);
    const activeId = data.activeSessionId || data.sessions.find((session) => session.active)?.id || "";
    if (wantedId && wantedId !== activeId) {
      try {
        const view = await api.viewSession(wantedId);
        rememberView(viewCacheRef.current, view);
        applySessionView(view);
      } catch (cause) {
        // Another window may have deleted this Session while this page was refreshing.
        // Bootstrap has already selected the current writable Session, so treat that 404 as recovery.
        if (!(cause instanceof Error) || !cause.message.includes("会话不存在")) throw cause;
      }
    }
  }, [applyBootstrap, applySessionView]);

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

  useEffect(() => {
    // Bootstrap obtains the per-start token before SSE is allowed to connect.
    if (loading) return;
    const source = new EventSource(api.eventsUrl());
    // EventSource reconnects after a server restart, but it cannot replay the events missed
    // while disconnected. Reload the requested Session as soon as the new stream is ready.
    source.addEventListener("ready", () => {
      void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    });
    source.addEventListener("pi", (rawEvent) => {
      const event = JSON.parse((rawEvent as MessageEvent<string>).data) as Record<string, unknown>;
      const type = String(event.type || "");
      const eventSessionId = typeof event.piChatSessionId === "string" ? event.piChatSessionId : "";
      const viewingEventSession = !eventSessionId || eventSessionId === viewedSessionIdRef.current;
      if (eventSessionId && ["agent_start", "agent_settled", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end"].includes(type)) forgetView(viewCacheRef.current, eventSessionId);
      if (type === "agent_start") {
        if (eventSessionId) setSessions((current) => current.map((session) => ({ ...session, running: session.id === eventSessionId ? true : session.running })));
        if (viewingEventSession) {
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
        if (assistant) setLiveMessage(assistant);
      } else if (type === "message_end" && viewingEventSession) {
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
          setState((current) => ({ ...current, isStreaming: false }));
          setToolStatus("");
          // A post-compaction turn has now persisted its new usage snapshot.
          void api.viewSession(eventSessionId).then((view) => {
            if (viewedSessionIdRef.current === eventSessionId) applySessionView(view);
          }).catch(() => undefined);
        }
        scheduleSidebarRefresh();
      } else if (type === "pi_chat_active_session_changed") {
        const ids = Array.isArray(event.activeSessionIds) ? event.activeSessionIds.filter((id): id is string => typeof id === "string") : [];
        if (ids.length) {
          setActiveSessionIds(ids);
          setSessions((current) => current.map((session) => ({ ...session, writable: ids.includes(session.id) })));
        }
        const id = typeof event.sessionId === "string" ? event.sessionId : "";
        if (!ids.length && id) setActiveSessionId(id);
        scheduleSidebarRefresh();
      } else if (type === "pi_chat_sessions_changed") {
        if (typeof event.sessionId === "string") forgetView(viewCacheRef.current, event.sessionId);
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
        if (id) setSessions((current) => current.map((session) => session.id === id ? { ...session, controlOwner: owner, controlledByThisWindow: false } : session));
      } else if (type === "pi_chat_extension_request_resolved") {
        if (viewingEventSession) setExtensionRequest((current) => current?.id === event.id ? null : current);
        if (eventSessionId) setSessions((current) => current.map((session) => session.id === eventSessionId ? { ...session, pendingConfirmation: false } : session));
      } else if (type === "extension_error") {
        setError(String(event.error || "扩展执行失败"));
      } else if (type === "pi_chat_process_recovered") {
        if (eventSessionId) setFailedSessionIds((current) => current.filter((id) => id !== eventSessionId));
      } else if (type === "pi_chat_process_error") {
        if (eventSessionId) setFailedSessionIds((current) => [...new Set([...current, eventSessionId])]);
        setError(String(event.error || "Pi RPC 已退出"));
        setState((current) => ({ ...current, isStreaming: false }));
        stoppingRef.current = false;
        setStopping(false);
      }
    });
    source.onerror = () => setError("与 Pi Chat 服务的事件连接已断开，浏览器将自动重连。");
    return () => source.close();
  }, [loading, refresh, scheduleSidebarRefresh]);

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

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  };

  const loadEarlierTurns = async () => {
    const id = viewedSessionIdRef.current;
    if (!id || !messagesTruncated || loadingEarlier) return;
    const timeline = scrollRef.current;
    const previousHeight = timeline?.scrollHeight || 0;
    setLoadingEarlier(true);
    setError("");
    stickToBottomRef.current = false;
    try {
      applySessionView(await api.viewSession(id, visibleTurnCount + 10));
      requestAnimationFrame(() => {
        const element = scrollRef.current;
        if (element) element.scrollTop = element.scrollHeight - previousHeight;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingEarlier(false);
    }
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

  const send = async (message: string, images: PromptImage[]) => {
    setError("");
    stickToBottomRef.current = true;
    setBusy(true);
    try {
      const command = /^\/(new|compact|abort)(?:\s+([\s\S]*))?$/.exec(message);
      if (command?.[1] === "new") {
        applySessionView(await api.newSession());
        setNotice("已新建独立会话");
        return;
      }
      if (command?.[1] === "compact") {
        if (runtimeStatus !== "active") {
          setRuntimeStatus("restoring");
          const view = await api.activateSession(viewedSessionId);
          forgetView(viewCacheRef.current, view.session.id);
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
      if (runtimeStatus !== "active") {
        setRuntimeStatus("restoring");
        const view = await api.activateSession(viewedSessionId);
        forgetView(viewCacheRef.current, view.session.id);
        applySessionView(view);
      }
      const result = await api.prompt(message, images, viewedSessionId);
      if (result.extension) {
        if (typeof result.isStreaming === "boolean") setState((current) => ({ ...current, isStreaming: result.isStreaming as boolean }));
        const gateMode = result.command === "gate" ? gateModeFromCommand(message) : null;
        if (gateMode && viewedSessionId) setGateModes((current) => ({ ...current, [viewedSessionId]: gateMode }));
        setNotice(extensionExecutionNotice(message, result.command || "extension", result.description ? [...commands, { name: result.command || "extension", description: result.description, source: "extension" }] : commands));
      } else if (result.queued) {
        if (result.queue) setQueue(result.queue);
        setNotice("消息已加入队列");
      } else {
        setMessages((current) => [...current, userMessage(message, images)]);
        setState((current) => ({ ...current, isStreaming: true }));
      }
    } catch (cause) {
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

  const prewarmSession = (id: string) => {
    if (warmingSessionIdsRef.current.has(id) || activeSessionIds.includes(id)) return;
    warmingSessionIdsRef.current.add(id);
    setWarmingSessionIds((current) => [...new Set([...current, id])]);
    setFailedSessionIds((current) => current.filter((sessionId) => sessionId !== id));
    // Activation starts an independent Pi runtime only; it does not send a prompt
    // or alter the session JSONL. History remains available while this runs.
    void api.activateSession(id).then((view) => {
      forgetView(viewCacheRef.current, id);
      if (viewedSessionIdRef.current === id) {
        applySessionView(view);
        stickToBottomRef.current = true;
      } else {
        setSessions((current) => current.map((session) => session.id === id ? { ...session, ...view.session } : session));
        if (view.isActive) setActiveSessionIds((current) => [...new Set([...current, id])]);
      }
    }).catch((cause) => {
      setFailedSessionIds((current) => [...new Set([...current, id])]);
      if (viewedSessionIdRef.current === id) setError(`会话预热失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }).finally(() => {
      warmingSessionIdsRef.current.delete(id);
      setWarmingSessionIds((current) => current.filter((sessionId) => sessionId !== id));
    });
  };

  const viewSession = async (id: string) => {
    if (id === viewedSessionIdRef.current) return;
    setError("");
    // Keep the current conversation visible until the destination view has
    // arrived. This avoids a blank timeline while an active Session is waiting
    // for a Gate confirmation or its runtime is answering state requests.
    const cached = viewCacheRef.current.get(id);
    if (cached) {
      applySessionView(cached);
      stickToBottomRef.current = true;
      const cachedStatus = cached.runtimeStatus || (cached.isActive ? "active" : "view-only");
      if (cachedStatus !== "active") {
        prewarmSession(id);
        void api.viewSession(id).then((view) => {
          if (!view.isActive) rememberView(viewCacheRef.current, view);
          else forgetView(viewCacheRef.current, view.session.id);
          if (viewedSessionIdRef.current === id) applySessionView(view);
        }).catch(() => undefined);
      }
      return;
    }
    setBusy(true);
    try {
      const view = await api.viewSession(id);
      if (!view.isActive) rememberView(viewCacheRef.current, view);
      else forgetView(viewCacheRef.current, view.session.id);
      applySessionView(view);
      stickToBottomRef.current = true;
      if (!view.isActive) prewarmSession(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const createSession = async () => {
    setBusy(true);
    setError("");
    try {
      applySessionView(await api.newSession());
      stickToBottomRef.current = true;
      setNotice("已新建独立会话");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const ensureRuntimeActive = async () => {
    if (!viewedSessionId || runtimeStatus === "active") return;
    setRuntimeStatus("restoring");
    const view = await api.activateSession(viewedSessionId);
    forgetView(viewCacheRef.current, view.session.id);
    applySessionView(view);
  };

  const changeModel = async (provider: string, modelId: string) => {
    if (!provider || !modelId) return;
    setBusy(true);
    setError("");
    try {
      await ensureRuntimeActive();
      const result = await api.setModel(provider, modelId, viewedSessionId);
      setState((current) => ({ ...current, model: result.model }));
      setNotice(result.pending ? `已选择 ${result.model?.name || modelId}，下一轮对话生效` : `已切换到 ${result.model?.name || modelId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const changeThinking = async (level: ThinkingLevel) => {
    setBusy(true);
    setError("");
    try {
      await ensureRuntimeActive();
      const result = await api.setThinking(level, viewedSessionId);
      setState((current) => ({ ...current, thinkingLevel: result.level }));
      setNotice(result.pending ? `已选择 ${result.level}，下一轮对话生效` : `思考强度已切换为 ${result.level}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
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
      // The server briefly disappears while the handoff process replaces it.
      // A delayed full reload obtains the new per-start token and hashed bundle.
      window.setTimeout(() => window.location.reload(), 700);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const shutdownPiChat = async () => {
    if (!window.confirm("关闭 Pi Chat？\n\n将结束 Pi Chat 服务及其管理的全部 Pi RPC 会话进程。聊天记录和设置会保留。\n\n之后请通过桌面上的“Pi Chat（网页）”或“Pi Chat（Edge PWA）”重新启动。")) return;
    setBusy(true);
    setError("");
    setNotice("正在关闭 Pi Chat 服务和会话进程…");
    try {
      await api.shutdown();
      window.setTimeout(() => window.location.reload(), 700);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
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
    const sessionId = extensionRequest?.piChatSessionId;
    setExtensionRequest(null);
    try {
      await api.respondToExtension({ ...body, ...(sessionId ? { sessionId } : {}) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const viewingActiveSession = Boolean(viewedSessionId) && activeSessionIds.includes(viewedSessionId);
  const conversationItems = useMemo(() => groupConversation(messages), [messages]);
  const anySessionRunning = sessions.some((session) => session.running);
  const anySessionPendingConfirmation = sessions.some((session) => session.pendingConfirmation);
  const anySessionQueued = sessions.some((session) => session.queued);
  const globalMutationBlocked = anySessionRunning || anySessionQueued || anySessionPendingConfirmation;
  const primaryQueueBusy = viewedSessionId === activeSessionId && queue.length > 0;
  const viewedSession = sessions.find((session) => session.id === viewedSessionId);
  const conversationName = viewedSession?.name || (state.messageCount ? state.sessionName || "已保存对话" : "新对话");
  const conversationWorkspace = viewedSession?.cwd || workspaceCwd;
  // Cold view-only sessions carry no RPC command list; the server reports Gate availability explicitly.
  const gateAvailable = gateAvailableOverride ?? commands.some((command) => command.name === "gate" && command.source === "extension");
  const gateMode = gateModes[viewedSessionId] || "strict";
  const observing = Boolean(viewedSession?.controlOwner && !viewedSession?.controlledByThisWindow);
  const takeControl = async () => {
    if (!viewedSessionId) return;
    try {
      if (runtimeStatus !== "active") await ensureRuntimeActive();
      const result = await api.takeSessionControl(viewedSessionId);
      setSessions((current) => current.map((session) => session.id === viewedSessionId ? { ...session, ...result } : session));
      setNotice("已接管此对话控制权");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="app-shell">
      <SessionSidebar
        sessions={sessions}
        viewedSessionId={viewedSessionId}
        workspaceCwd={workspaceCwd}
        open={sidebarOpen}
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
        newDisabled={loading || busy}
        refreshDisabled={loading || refreshing}
        restartDisabled={loading || busy || refreshing || globalMutationBlocked}
        workspaceDisabled={loading || busy || workspacePicking || globalMutationBlocked}
        viewBusy={loading || busy}
        refreshing={refreshing}
        warmingSessionIds={warmingSessionIds}
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
          disabled={busy || observing}
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
            ) : !messages.length && !liveMessage ? (
              <section className="welcome">
                <span className="welcome-mark"><PiMarkIcon /></span>
                <h1>开始与 Pi 对话</h1>
                <p>支持流式输出、Markdown、KaTeX，以及复制原始 LaTeX 源码。</p>
              </section>
            ) : (
              <>
                {messagesTruncated && <div className="message-window-notice" role="status"><span>当前显示最近 {visibleTurnCount} 轮（共 {turnTotal} 轮、{messageTotal} 条消息）</span><button type="button" onClick={() => void loadEarlierTurns()} disabled={loadingEarlier}>{loadingEarlier ? "正在加载…" : "加载更早 10 轮"}</button></div>}
                {conversationItems.map((item, index) => item.kind === "process"
                  ? <ConversationProcess key={`process-${index}`} entries={item.entries} />
                  : <ChatMessage key={`message-${item.message.timestamp || 0}-${index}`} message={item.message} />)}
              </>
            )}
            {liveMessage && <ChatMessage message={liveMessage} streaming />}
            {state.isCompacting && <div className="agent-status is-compacting" role="status"><span className="loader small" />{toolStatus || "正在压缩上下文，当前消息会在完成后继续发送…"}</div>}
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
        <SessionControlBanner observing={observing} onTakeOver={() => void takeControl()} />
        <PromptQueue
          queue={queue}
          paused={queuePaused}
          busy={busy || observing}
          onCancel={(id) => void api.cancelQueued(id, viewedSessionId).then((result) => { setQueue(result.queue); setQueuePaused(result.paused); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}
          onResume={() => void api.resumeQueue(viewedSessionId).then((result) => { setQueue(result.queue); setQueuePaused(result.paused); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}
        />
        <ChatInput
          streaming={state.isStreaming}
          stopping={stopping}
          disabled={loading || busy || observing || Boolean(state.isCompacting)}
          disabledPlaceholder={observing ? "此对话正在另一窗口中控制；点击“接管控制”后可操作" : state.isCompacting ? "正在压缩上下文，完成后可继续发送…" : runtimeStatus === "restoring" || (busy && runtimeStatus !== "active") ? "正在恢复 Pi Runtime，就绪后即可发送…" : runtimeStatus === "view-only" ? "当前为只读查看；发送时会自动恢复 Pi Runtime" : undefined}
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
