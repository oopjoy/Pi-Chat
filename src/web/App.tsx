import { useCallback, useEffect, useRef, useState } from "react";
import type { BootstrapData, ModelInfo, PiMessage, PiState, PromptImage, QueuedPrompt, SessionStats, SessionSummary, SessionViewData, SlashCommand, ThinkingLevel } from "../shared/types";
import { api } from "./api";
import { ChatInput } from "./components/ChatInput";
import { ChatMessage } from "./components/ChatMessage";
import { ExtensionDialog, type ExtensionUiRequest } from "./components/ExtensionDialog";
import { ManagementPanel, type ManagementSection } from "./components/ManagementPanel";
import { PromptQueue } from "./components/PromptQueue";
import { SessionSidebar } from "./components/SessionSidebar";
import { TopBar } from "./components/TopBar";
import { adjacentUserMessageOffset } from "./lib/conversation-navigation";
import { extensionExecutionNotice } from "./lib/extension-notice";
import { applyAppearance, loadAppearance, loadSidebarOpen, saveAppearance, saveSidebarOpen, type AppearancePreferences } from "./lib/preferences";

const EMPTY_STATE: PiState = { model: null, isStreaming: false };

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
  const [messagesTruncated, setMessagesTruncated] = useState(false);
  const [stats, setStats] = useState<SessionStats | undefined>();
  const [liveMessage, setLiveMessage] = useState<PiMessage | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [viewedSessionId, setViewedSessionId] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [workspaceCwd, setWorkspaceCwd] = useState("");
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [workspacePicking, setWorkspacePicking] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  const [managementSection, setManagementSection] = useState<ManagementSection | null>(null);
  const [appearance, setAppearance] = useState<AppearancePreferences>(loadAppearance);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [toolStatus, setToolStatus] = useState("");
  const [extensionRequest, setExtensionRequest] = useState<ExtensionUiRequest | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const stoppingRef = useRef(false);
  const viewedSessionIdRef = useRef("");

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
    setMessagesTruncated(data.messagesTruncated === true);
    setStats(data.stats);
    setSessions(data.sessions);
    const activeId = data.activeSessionId || data.sessions.find((session) => session.active)?.id || "";
    setActiveSessionId(activeId);
    setViewedId(activeId);
    setModels(data.models);
    setWorkspaceCwd(data.workspaceCwd);
    setCommands(data.commands);
    setQueue(data.queue);
    setQueuePaused(data.queuePaused);
    setLiveMessage(null);
    setLiveMessage(data.liveMessage || null);
    setToolStatus(data.toolStatus || "");
  }, [setViewedId]);

  const applySessionView = useCallback((view: SessionViewData) => {
    setMessages(view.messages);
    setMessageTotal(view.messageTotal);
    setMessagesTruncated(view.messagesTruncated);
    setStats(view.stats);
    setLiveMessage(view.liveMessage || null);
    setToolStatus(view.toolStatus || "");
    setViewedId(view.session.id);
  }, [setViewedId]);

  const refresh = useCallback(async () => {
    const wantedId = viewedSessionIdRef.current || new URL(window.location.href).searchParams.get("session") || "";
    const data = await api.bootstrap();
    applyBootstrap(data);
    const activeId = data.activeSessionId || data.sessions.find((session) => session.active)?.id || "";
    if (wantedId && wantedId !== activeId) applySessionView(await api.viewSession(wantedId));
  }, [applyBootstrap, applySessionView]);

  useEffect(() => {
    refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    applyAppearance(appearance);
    saveAppearance(appearance);
  }, [appearance]);

  useEffect(() => saveSidebarOpen(sidebarOpen), [sidebarOpen]);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("pi", (rawEvent) => {
      const event = JSON.parse((rawEvent as MessageEvent<string>).data) as Record<string, unknown>;
      const type = String(event.type || "");
      const eventSessionId = typeof event.piChatSessionId === "string" ? event.piChatSessionId : "";
      const viewingEventSession = !eventSessionId || eventSessionId === viewedSessionIdRef.current;
      if (type === "agent_start") {
        setState((current) => ({ ...current, isStreaming: true }));
        if (eventSessionId) setSessions((current) => current.map((session) => ({ ...session, running: session.id === eventSessionId })));
        if (viewingEventSession) setToolStatus("Pi 正在思考…");
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
        setState((current) => ({ ...current, isStreaming: false }));
        if (eventSessionId) setSessions((current) => current.map((session) => session.id === eventSessionId ? { ...session, running: false } : session));
        if (viewingEventSession) setToolStatus("");
        void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
      } else if (type === "pi_chat_active_session_changed") {
        const id = typeof event.sessionId === "string" ? event.sessionId : "";
        setActiveSessionId(id);
        void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
      } else if (type === "pi_chat_queue_update") {
        setQueue(Array.isArray(event.queue) ? event.queue as unknown as QueuedPrompt[] : []);
        setQueuePaused(event.paused === true);
      } else if (type === "pi_chat_queue_dispatch") {
        if (viewingEventSession) {
          const queuedText = typeof event.message === "string" && event.message ? event.message : Number(event.imageCount) > 0 ? `请查看附加的 ${Number(event.imageCount)} 张图片` : "队列消息";
          setMessages((current) => [...current, userMessage(queuedText, [])]);
        }
        setState((current) => ({ ...current, isStreaming: true }));
      } else if (type === "pi_chat_queue_error") {
        setError(String(event.error || "队列消息发送失败"));
      } else if (type === "extension_ui_request") {
        const request = event as unknown as ExtensionUiRequest;
        if (["select", "confirm", "input", "editor"].includes(request.method)) setExtensionRequest(request);
        else if (request.method === "notify") setNotice(request.message || "Pi 通知");
      } else if (type === "extension_error") {
        setError(String(event.error || "扩展执行失败"));
      } else if (type === "pi_chat_process_error") {
        setError(String(event.error || "Pi RPC 已退出"));
        setState((current) => ({ ...current, isStreaming: false }));
        stoppingRef.current = false;
        setStopping(false);
      }
    });
    source.onerror = () => setError("与 Pi Chat 服务的事件连接已断开，浏览器将自动重连。");
    return () => source.close();
  }, [refresh]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: liveMessage ? "auto" : "smooth" });
  }, [messages, liveMessage, toolStatus]);

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
    try {
      const command = /^\/(new|compact|abort)(?:\s+([\s\S]*))?$/.exec(message);
      if (command?.[1] === "new") {
        if (state.isStreaming || queue.length) throw new Error("请先停止当前生成并清空队列");
        applyBootstrap(await api.newSession());
        setNotice("已新建会话");
        return;
      }
      if (command?.[1] === "compact") {
        await api.compact(command[2] || "");
        await refresh();
        setNotice("上下文压缩完成");
        return;
      }
      if (command?.[1] === "abort") {
        await stopGeneration();
        return;
      }
      const result = await api.prompt(message, images, viewedSessionId);
      if (result.extension) {
        if (typeof result.isStreaming === "boolean") setState((current) => ({ ...current, isStreaming: result.isStreaming as boolean }));
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
    }
  };

  const stopGeneration = async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    setError("");
    try {
      const result = await api.abort();
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
    setBusy(true);
    setError("");
    try {
      applySessionView(await api.viewSession(id));
      stickToBottomRef.current = true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const runTransition = async (operation: () => Promise<BootstrapData>) => {
    if (state.isStreaming || queue.length) {
      setError("请先停止当前生成并清空队列，再切换或新建会话。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      applyBootstrap(await operation());
      stickToBottomRef.current = true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const changeModel = async (provider: string, modelId: string) => {
    if (!provider || !modelId) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.setModel(provider, modelId);
      setState((current) => ({ ...current, model: result.model }));
      setNotice(`已切换到 ${result.model?.name || modelId}`);
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
      const result = await api.setThinking(level);
      setState((current) => ({ ...current, thinkingLevel: result.level }));
      setNotice(`思考强度已切换为 ${result.level}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const pickWorkspace = async () => {
    if (state.isStreaming || queue.length) {
      setError("请先停止当前生成并清空队列，再切换工作目录。");
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

  const respondToExtension = async (body: Record<string, unknown>) => {
    setExtensionRequest(null);
    try {
      await api.respondToExtension(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const viewingActiveSession = Boolean(viewedSessionId) && viewedSessionId === activeSessionId;
  const viewedSession = sessions.find((session) => session.id === viewedSessionId);

  return (
    <div className="app-shell">
      <SessionSidebar
        sessions={sessions}
        viewedSessionId={viewedSessionId}
        workspaceCwd={workspaceCwd}
        open={sidebarOpen}
        busy={loading || busy || state.isStreaming || queue.length > 0}
        viewBusy={loading || busy}
        refreshing={refreshing}
        workspacePicking={workspacePicking}
        onClose={() => setSidebarOpen(false)}
        onCollapse={() => setSidebarOpen(false)}
        onNew={() => void runTransition(api.newSession)}
        onRefresh={() => void refreshManually()}
        onView={(id) => void viewSession(id)}
        onPickWorkspace={() => void pickWorkspace()}
        onManage={setManagementSection}
      />
      {!sidebarOpen && <button type="button" className="sidebar-restore" onClick={() => setSidebarOpen(true)} title="展开会话栏" aria-label="展开会话栏">›</button>}
      <main className="chat-shell">
        <TopBar
          state={state}
          models={models}
          stats={stats}
          disabled={busy || state.isStreaming || queue.length > 0}
          onModel={(provider, id) => void changeModel(provider, id)}
          onThinking={(level) => void changeThinking(level)}
        />
        {!viewingActiveSession && viewedSession && <div className="session-view-banner" role="status"><span>只读查看：{viewedSession.name}{state.isStreaming ? " · 后台对话仍在生成" : ""}</span><button type="button" disabled={state.isStreaming || queue.length > 0 || busy} onClick={() => void runTransition(() => api.switchSession(viewedSession.id))}>{state.isStreaming ? "后台生成完成后可继续" : "在此继续对话"}</button></div>}
        <div className="timeline" ref={scrollRef} onScroll={onScroll}>
          <div className="timeline-inner">
            {loading ? (
              <div className="center-state"><span className="loader" />正在连接 Pi…</div>
            ) : !messages.length && !liveMessage ? (
              <section className="welcome">
                <span className="welcome-mark">π</span>
                <h1>开始与 Pi 对话</h1>
                <p>支持流式输出、Markdown、KaTeX，以及复制原始 LaTeX 源码。</p>
              </section>
            ) : (
              <>
                {messagesTruncated && <div className="message-window-notice" role="status">为保持轻量，当前仅显示最近 400 条对话（共 {messageTotal} 条）。历史内容仍保留在 Pi 会话中。</div>}
                {messages.map((message, index) => <ChatMessage key={`${message.timestamp || 0}-${index}`} message={message} />)}
              </>
            )}
            {liveMessage && <ChatMessage message={liveMessage} streaming />}
            {state.isStreaming && toolStatus && <div className="agent-status"><span className="loader small" />{toolStatus}</div>}
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
        {viewingActiveSession && <PromptQueue
          queue={queue}
          paused={queuePaused}
          busy={busy}
          onCancel={(id) => void api.cancelQueued(id).then((result) => { setQueue(result.queue); setQueuePaused(result.paused); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}
          onResume={() => void api.resumeQueue().then((result) => { setQueue(result.queue); setQueuePaused(result.paused); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}
        />}
        <ChatInput
          streaming={viewingActiveSession && state.isStreaming}
          stopping={stopping}
          disabled={loading || busy || !viewingActiveSession}
          disabledPlaceholder={!viewingActiveSession ? "当前为只读查看；点击上方“在此继续对话”后可输入" : undefined}
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
        busy={busy || state.isStreaming || queue.length > 0}
        onClose={() => setManagementSection(null)}
        onAppearance={setAppearance}
        onModel={(provider, id) => void changeModel(provider, id)}
        onReloaded={(data) => data ? applyBootstrap(data) : void refresh()}
      />
      <ExtensionDialog request={extensionRequest} onRespond={(body) => void respondToExtension(body)} />
    </div>
  );
}
