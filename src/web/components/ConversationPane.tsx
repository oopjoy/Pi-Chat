import { Fragment, type ComponentProps, type RefObject } from "react";
import type { PiMessage, PiState } from "../../shared/types";
import { appendPendingUserMessage } from "../lib/local-user-turn";
import { groupConversation } from "../lib/conversation-process";
import { ChatInput } from "./ChatInput";
import { AssistantMessageHeader, ChatMessage } from "./ChatMessage";
import { CompactSelect } from "./CompactSelect";
import { CoordinationMessage } from "./CoordinationMessage";
import { ConversationProcess } from "./ConversationProcess";
import { FolderIcon, PiMarkIcon } from "./Icons";
import { PromptQueue } from "./PromptQueue";
import { SessionControlBanner } from "./SessionControlBanner";
import { TopBar } from "./TopBar";

type NavigationDirection = "top" | "previous" | "next" | "bottom";
type PaneLoading = { sessionId: string; name: string } | null;

export interface ConversationPaneProps {
  topBar: ComponentProps<typeof TopBar>;
  timelineRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onClearNavigation: () => void;
  loading: boolean;
  viewedSessionId: string;
  paneLoading: PaneLoading;
  messages: PiMessage[];
  pendingUserMessage: PiMessage | null;
  liveMessage: PiMessage | null;
  localDraft: boolean;
  newConversationPresentation: boolean;
  waitingForPi: boolean;
  draftWorkspaceCwd: string;
  workspaceCwd: string;
  workspacePicking: boolean;
  draftWorkspaceOptions: string[];
  onSelectDraftWorkspace: (cwd: string) => void;
  onPickDraftWorkspace: () => void;
  messagesTruncated: boolean;
  visibleTurnCount: number;
  turnTotal: number;
  messageTotal: number;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  state: PiState;
  toolStatus: string;
  onNavigate: (direction: NavigationDirection) => void;
  sessionControl: ComponentProps<typeof SessionControlBanner>;
  promptQueue: ComponentProps<typeof PromptQueue>;
  chatInput: ComponentProps<typeof ChatInput>;
}

/**
 * Stable selected-conversation DOM boundary. It is deliberately unkeyed: the
 * child ChatInput owns unsent text/images and must survive Session navigation.
 * API, SSE, cache, timers, and authority checks stay in the App coordinator.
 */
export function ConversationPane({
  topBar,
  timelineRef,
  onScroll,
  onClearNavigation,
  loading,
  viewedSessionId,
  paneLoading,
  messages,
  pendingUserMessage,
  liveMessage,
  localDraft,
  newConversationPresentation,
  waitingForPi,
  draftWorkspaceCwd,
  workspaceCwd,
  workspacePicking,
  draftWorkspaceOptions,
  onSelectDraftWorkspace,
  onPickDraftWorkspace,
  messagesTruncated,
  visibleTurnCount,
  turnTotal,
  messageTotal,
  loadingEarlier,
  onLoadEarlier,
  state,
  toolStatus,
  onNavigate,
  sessionControl,
  promptQueue,
  chatInput,
}: ConversationPaneProps) {
  const conversationItems = groupConversation(
    appendPendingUserMessage(messages, pendingUserMessage),
    {
      liveMessage: liveMessage || undefined,
      preserveTrailingAssistantPlaceholder: Boolean(liveMessage),
    },
  );
  const paneKey = viewedSessionId || "draft";
  const activeTurnStart = conversationItems.reduce(
    (latest, item, index) =>
      item.kind === "coordination"
      || (item.kind === "message" && item.message.role === "user")
        ? index
        : latest,
    -1,
  );
  const activeAssistantMetadata = {
    provider: state.model?.provider,
    model: state.model?.id,
    thinkingLevel: state.thinkingLevel,
  };
  const activeTurnItemStart = state.isStreaming ? activeTurnStart + 1 : -1;
  let activeHeaderMessage: PiMessage | null = state.isStreaming ? liveMessage : null;
  if (state.isStreaming && !activeHeaderMessage) {
    for (let index = activeTurnItemStart; index < conversationItems.length; index += 1) {
      const item = conversationItems[index];
      const candidate = item?.kind === "process"
        ? item.assistantHeader
        : item?.message.role === "assistant"
          ? item.message
          : undefined;
      if (candidate) {
        activeHeaderMessage = candidate;
        break;
      }
    }
    activeHeaderMessage ||= { role: "assistant" };
  }

  return <main className="chat-shell">
    <TopBar {...topBar} />
    <div
      className="timeline"
      ref={timelineRef}
      onScroll={onScroll}
      onWheel={onClearNavigation}
      onPointerDown={onClearNavigation}
    >
      <div className="timeline-inner">
        {loading && !viewedSessionId ? (
          <div className="center-state">
            <span className="loader" />
            正在读取已保存的对话…
          </div>
        ) : paneLoading ? (
          <section className="pane-loading" aria-live="polite" aria-busy="true">
            <span className="loader" />
            <div>
              <strong>正在打开 {paneLoading.name}</strong>
              <p>正在恢复会话内容…</p>
            </div>
          </section>
        ) : !messages.length && !pendingUserMessage && !liveMessage ? (
          <section className="welcome">
            <span className="welcome-mark"><PiMarkIcon /></span>
            <h1>开始与 Pi 对话</h1>
            <p>支持流式输出、Markdown、KaTeX，以及复制原始 LaTeX 源码。</p>
            {newConversationPresentation && <div className="draft-workspace">
              <span>新对话工作路径</span>
              <CompactSelect
                value={draftWorkspaceCwd || workspaceCwd || ""}
                options={draftWorkspaceOptions.map((cwd) => ({ value: cwd, label: cwd, title: cwd }))}
                disabled={!localDraft || workspacePicking || draftWorkspaceOptions.length === 0}
                ariaLabel="选择常用新对话工作路径"
                title={!localDraft ? "当前新对话的工作路径已经由 Pi Runtime 确定" : draftWorkspaceOptions.length ? "点击选择历史 Session 使用过的工作路径" : "暂无历史 Session 工作路径，请使用右侧浏览按钮"}
                align="left"
                checkPosition="start"
                className="draft-workspace-select"
                fallbackLabel={draftWorkspaceCwd || workspaceCwd || "未设置工作路径"}
                onChange={onSelectDraftWorkspace}
              />
              <button className="draft-workspace-picker" type="button" disabled={!localDraft || workspacePicking} onClick={onPickDraftWorkspace} title={localDraft ? "浏览新对话工作路径" : "当前新对话的工作路径已经确定"} aria-label="浏览新对话工作路径"><FolderIcon /></button>
              <small>{localDraft ? "点击路径可快速选择历史 Session 使用过的目录；浏览按钮可选择新目录。首次发送时才创建 Session。" : "当前新对话已准备就绪；发送第一条消息后会出现在历史对话中。"}</small>
            </div>}
          </section>
        ) : <>
          {messagesTruncated && <div className="message-window-notice" role="status">
            <span>当前显示最近 {visibleTurnCount} 轮（共 {turnTotal} 轮、{messageTotal} 条消息）</span>
            <button type="button" onClick={onLoadEarlier} disabled={loadingEarlier}>{loadingEarlier ? "正在加载…" : "加载更早 10 轮"}</button>
          </div>}
          {conversationItems.map((item, index) => {
            const inActiveRunningTurn = state.isStreaming && index >= activeTurnItemStart;
            const activeHeader = index === activeTurnItemStart && activeHeaderMessage
              ? <AssistantMessageHeader
                  message={activeHeaderMessage}
                  fallback={activeAssistantMetadata}
                />
              : null;
            if (item.kind === "coordination") {
              return <CoordinationMessage
                key={`${paneKey}:${item.key}`}
                message={item.message}
              />;
            }
            if (item.kind === "process") {
              return <Fragment key={`${paneKey}:${item.key}`}>
                {activeHeader}
                {!inActiveRunningTurn && item.assistantHeader && <AssistantMessageHeader message={item.assistantHeader} />}
                <ConversationProcess
                  disclosureKey={`${paneKey}:${item.key}`}
                  entries={item.entries}
                  streaming={state.isStreaming && index === conversationItems.length - 1}
                />
              </Fragment>;
            }
            const messageStreaming = state.isStreaming
              && index === conversationItems.length - 1
              && Boolean(liveMessage);
            return <Fragment key={`${paneKey}:${item.key}`}>
              {activeHeader}
              <ChatMessage
                message={item.message}
                streaming={messageStreaming}
                showAssistantMetadata={!inActiveRunningTurn && !item.hideAssistantMetadata}
                showGeneratedAt={!inActiveRunningTurn}
              />
            </Fragment>;
          })}
          {state.isStreaming && activeTurnItemStart >= conversationItems.length && activeHeaderMessage && <AssistantMessageHeader
            message={activeHeaderMessage}
            fallback={activeAssistantMetadata}
          />}
        </>}
        {waitingForPi && <div className="agent-status is-waiting" role="status" aria-live="polite">
          <span className="loader small" />
          正在等待 Pi 处理…
        </div>}
        {state.isCompacting && <div className="agent-status is-compacting" role="status">
          <span className="loader small" />
          {toolStatus || "正在压缩上下文，当前消息会在完成后继续发送…"}
        </div>}
        {state.isStreaming && !state.isCompacting && toolStatus && <div className="agent-status">
          <span className="loader small" />
          {toolStatus}
        </div>}
      </div>
    </div>
    <nav className="conversation-nav" aria-label="对话导航">
      <button type="button" onClick={() => onNavigate("top")} title="回到首条对话" aria-label="回到首条对话">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4h12M10 16V7M7.2 9.8 10 7l2.8 2.8" /></svg>
      </button>
      <button type="button" onClick={() => onNavigate("previous")} title="上一条对话" aria-label="上一条对话">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4M5.8 8.2 10 4l4.2 4.2" /></svg>
      </button>
      <button type="button" onClick={() => onNavigate("next")} title="下一条对话" aria-label="下一条对话">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M5.8 11.8 10 16l4.2-4.2" /></svg>
      </button>
      <button type="button" onClick={() => onNavigate("bottom")} title="回到最新对话" aria-label="回到最新对话">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16h12M10 4v9M7.2 10.2 10 13l2.8-2.8" /></svg>
      </button>
    </nav>
    <SessionControlBanner {...sessionControl} />
    <PromptQueue {...promptQueue} />
    <ChatInput {...chatInput} />
  </main>;
}
