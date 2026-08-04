import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { SessionActivityState, SessionDirectorySummary, SessionSummary } from "../../shared/types";
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "../lib/preferences";
import { ChevronRightIcon, FolderIcon, PanelLeftIcon, PinIcon, PiMarkIcon, PlusIcon, RefreshIcon, SearchIcon } from "./Icons";
import { groupSessionsForNavigation } from "../lib/session-navigation";

function relativeTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} h`;
  return new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric" }).format(timestamp);
}

type SessionStatus = "idle" | "unread" | "pending" | "running" | "error";

function legacyActivity(session: SessionSummary, failed: boolean): SessionActivityState {
  return {
    execution: failed ? "failed" : session.running ? "running" : session.queued ? "queued" : "idle",
    awaitingConfirmation: session.pendingConfirmation === true,
  };
}

/** Sidebar shows one coarse outcome; the Composer/queue supplies phase detail. */
export function sessionStatus(session: SessionSummary, failed: boolean, hasUnseenReply: boolean): { kind: SessionStatus; label: string } {
  const activity = session.activity || legacyActivity(session, failed);
  // Failure is actionable even while an old Gate request remains visible.
  if (activity.execution === "paused") return { kind: "error", label: "队列已暂停，需要恢复或撤销" };
  if (activity.execution === "failed") return { kind: "error", label: "会话运行异常" };
  if (activity.awaitingConfirmation) return { kind: "pending", label: "等待权限确认" };
  if (activity.execution === "queued") return { kind: "running", label: "消息等待自动执行" };
  if (activity.execution === "dispatching") return { kind: "running", label: "正在派发队列消息" };
  if (activity.execution === "running") return { kind: "running", label: "正在生成" };
  if (hasUnseenReply) return { kind: "unread", label: "有新回复" };
  return { kind: "idle", label: "对话空闲" };
}

function ResizeHandle({ width, onWidthChange }: { width: number; onWidthChange: (width: number) => void }) {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("sidebar-resizing");
    const onMove = (move: PointerEvent) => {
      const next = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(startWidth + move.clientX - startX)));
      onWidthChange(next);
    };
    const onEnd = () => {
      document.body.classList.remove("sidebar-resizing");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 16 : -16;
    onWidthChange(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width + delta)));
  };
  return <div className="sidebar-resize-handle" role="separator" aria-orientation="vertical" aria-label="拖动调整会话栏宽度" aria-valuemin={SIDEBAR_WIDTH_MIN} aria-valuemax={SIDEBAR_WIDTH_MAX} aria-valuenow={Math.round(width)} tabIndex={0} onPointerDown={onPointerDown} onKeyDown={onKeyDown} />;
}

export function SessionSidebar({ sessions, sessionsTotal, sessionDirectories, inventoryReady, loadingAllSessions, loadingDirectoryKeys, viewedSessionId, workspaceCwd, open, width, newDisabled, refreshDisabled, restartDisabled, viewBusy, refreshing, pinnedSessionIds, pinnedDirectoryKeys, collapsedDirectoryKeys, expandedDirectoryKeys, failedSessionIds, unseenReplySessionIds, mutatingSessionIds, onClose, onCollapse, onNew, onRefresh, onLoadAllSessions, onLoadDirectory, onRestart, onView, onTogglePin, onToggleDirectoryPin, onSetDirectoryCollapsed, onRename, onDelete, onWidthChange }: {
  sessions: SessionSummary[];
  sessionsTotal: number;
  sessionDirectories: SessionDirectorySummary[];
  /** A remembered conversation can render before the sidebar inventory is authoritative. */
  inventoryReady: boolean;
  loadingAllSessions: boolean;
  loadingDirectoryKeys: string[];
  viewedSessionId: string;
  workspaceCwd: string;
  open: boolean;
  width: number;
  newDisabled: boolean;
  refreshDisabled: boolean;
  restartDisabled: boolean;
  viewBusy: boolean;
  refreshing: boolean;
  pinnedSessionIds: string[];
  pinnedDirectoryKeys: string[];
  collapsedDirectoryKeys: string[];
  expandedDirectoryKeys: string[];
  failedSessionIds: string[];
  /** Browser-local completion notice; intentionally separate from Runtime state. */
  unseenReplySessionIds: string[];
  /** A rename/delete has been accepted locally and must settle before another one starts. */
  mutatingSessionIds: string[];
  onClose: () => void;
  onCollapse: () => void;
  onNew: () => void;
  onRefresh: () => void;
  onLoadAllSessions: () => void;
  onLoadDirectory: (cwd: string, offset: number) => void;
  onRestart: () => void;
  onView: (id: string) => void;
  onTogglePin: (sessionId: string) => void;
  onToggleDirectoryPin: (cwd: string) => void;
  onSetDirectoryCollapsed: (cwd: string, collapsed: boolean) => void;
  onRename: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
  onWidthChange: (width: number) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [sessionMenuId, setSessionMenuId] = useState("");
  const [sessionMenuPosition, setSessionMenuPosition] = useState({ top: 0, left: 0 });
  const sessionMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sessionMenuId) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!sessionMenuRef.current?.contains(target) && !target.closest(".session-menu-trigger")) setSessionMenuId("");
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSessionMenuId("");
    };
    const closeOnLayoutChange = () => setSessionMenuId("");
    document.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnLayoutChange);
    document.addEventListener("scroll", closeOnLayoutChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnLayoutChange);
      document.removeEventListener("scroll", closeOnLayoutChange, true);
    };
  }, [sessionMenuId]);
  useEffect(() => {
    if (!open) setSessionMenuId("");
  }, [open]);
  useEffect(() => {
    setSearchQuery("");
    setSessionMenuId("");
  }, [workspaceCwd]);
  const menuSession = sessions.find((session) => session.id === sessionMenuId);
  const searching = Boolean(searchQuery.trim());
  const groups = groupSessionsForNavigation(
    sessions,
    pinnedSessionIds,
    pinnedDirectoryKeys,
    collapsedDirectoryKeys,
    searchQuery,
    sessionDirectories,
    workspaceCwd,
    expandedDirectoryKeys,
  );
  const visibleSessionCount = groups.reduce((total, group) => total + group.sessions.length, 0);
  const visibleSessionIds = new Set(groups.filter((group) => !group.collapsed).flatMap((group) => group.sessions.map((session) => session.id)));
  const pinnedIds = new Set(pinnedSessionIds);
  useEffect(() => {
    if (sessionMenuId && !visibleSessionIds.has(sessionMenuId)) setSessionMenuId("");
  }, [sessionMenuId, visibleSessionIds]);

  return (
    <>
      {open && <button type="button" className="sidebar-scrim" aria-label="关闭会话栏" onClick={onClose} />}
      <aside className={`sidebar ${open ? "is-open" : ""}`} aria-hidden={!open} inert={!open} style={{ "--sidebar-width": `${width}px` } as CSSProperties}>
        <div className="sidebar-topline">
          <div className="brand-row"><span className="brand-mark"><PiMarkIcon /></span><strong>Pi Chat</strong></div>
          <button type="button" className="sidebar-collapse" onClick={onCollapse} title="收起侧栏" aria-label="收起侧栏">
            <PanelLeftIcon className="sidebar-panel-icon" />
          </button>
        </div>
        <div className="sidebar-actions">
          <button type="button" className="new-chat" disabled={newDisabled} onClick={onNew}><PlusIcon />New</button>
          <button type="button" className="refresh-chat" disabled={refreshDisabled} onClick={onRefresh} title="刷新会话列表" aria-label="刷新会话列表"><RefreshIcon className={refreshing ? "is-spinning" : ""} /></button>
          <button type="button" className="restart-pi" disabled={restartDisabled} onClick={onRestart} title="完整重启 Pi Chat 并应用本地更新" aria-label="完整重启 Pi Chat 并应用更新">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.6v7.1M5.15 5.55a6.45 6.45 0 1 0 9.7 0" /></svg>
          </button>
        </div>
        <div className="session-heading"><span>对话</span><span>{searching ? `${visibleSessionCount} 项` : sessions.length < sessionsTotal ? `${sessions.length}/${sessionsTotal}` : sessionsTotal}</span></div>
        <label className="session-search">
          <SearchIcon />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => {
              const next = event.target.value;
              if (!searchQuery.trim() && next.trim() && sessions.length < sessionsTotal) onLoadAllSessions();
              setSearchQuery(next);
            }}
            placeholder="搜索对话"
            aria-label="搜索对话"
          />
        </label>
        <nav className="session-list" aria-label="会话列表">
          {groups.map((group) => {
            const groupId = `session-directory-${encodeURIComponent(group.key)}`;
            const loadingDirectory = loadingDirectoryKeys.includes(group.key);
            const loadedCount = group.sessions.length;
            return <section className={`session-directory${group.fixed ? " is-fixed" : ""}`} key={group.key} aria-label={`${group.label}，${group.total} 个对话`}>
              <div className="session-directory-header">
                <button type="button" className="session-directory-toggle" aria-label={`${group.collapsed ? "展开" : "折叠"}目录 ${group.label}，${group.total} 个对话`} aria-expanded={!group.collapsed} aria-controls={groupId} onClick={() => {
                  setSessionMenuId("");
                  if (group.collapsed && !loadedCount && group.total) onLoadDirectory(group.key, 0);
                  onSetDirectoryCollapsed(group.key, !group.collapsed);
                }} title={group.label}>
                  <ChevronRightIcon className={group.collapsed ? "" : "is-expanded"} />
                  <FolderIcon />
                  <span>{group.label}</span>
                  <small>{group.total}</small>
                </button>
                {group.pinnable && <button type="button" className={`session-directory-pin${group.fixed ? " is-fixed" : ""}`} aria-label={`${group.fixed ? "取消固定" : "固定"}目录 ${group.label}`} aria-pressed={group.fixed} title={group.fixed ? "取消固定目录" : "固定目录"} onClick={() => onToggleDirectoryPin(group.key)}><PinIcon /></button>}
              </div>
              {!group.collapsed && <div className="session-directory-items" id={groupId}>
                {group.sessions.map((session) => {
                  const unavailable = viewBusy || session.id === viewedSessionId;
                  const failed = failedSessionIds.includes(session.id);
                  const mutating = mutatingSessionIds.includes(session.id);
                  const status = sessionStatus(session, failed, unseenReplySessionIds.includes(session.id));
                  const pinned = pinnedIds.has(session.id);
                  return <div className={`session-row ${session.id === viewedSessionId ? "is-active" : ""} ${status.kind !== "idle" ? "has-status" : ""} ${sessionMenuId === session.id ? "is-menu-open" : ""}`} key={session.id}>
                    <button
                      type="button"
                      className={`session-item ${session.id === viewedSessionId ? "is-active" : ""} ${session.running ? "is-running" : ""} ${unavailable ? "is-disabled" : ""}`}
                      disabled={unavailable}
                      aria-current={session.id === viewedSessionId ? "page" : undefined}
                      onClick={() => onView(session.id)}
                      title={`${session.name}\n${relativeTime(session.updatedAt)} · ${session.turnCount ?? session.messageCount} turns · ${session.messageCount} messages`}
                    >
                      <span className="session-name"><span className="session-name-text">{session.name}</span>{pinned && <span className="session-pin-indicator" title="已置顶"><PinIcon /></span>}</span>
                      <span className="session-meta">{relativeTime(session.updatedAt)}</span>
                    </button>
                    <div className={`session-item-actions${sessionMenuId === session.id ? " is-open" : ""}`}>
                      <span className={`session-status is-${status.kind}`} role="img" aria-label={status.label} title={status.label} />
                      <button type="button" className="session-menu-trigger" disabled={mutating} onClick={(event) => {
                        if (sessionMenuId === session.id) return setSessionMenuId("");
                        const rect = event.currentTarget.getBoundingClientRect();
                        const menuHeight = 108;
                        setSessionMenuPosition({
                          top: rect.bottom + menuHeight + 6 <= window.innerHeight ? rect.bottom + 4 : Math.max(4, rect.top - menuHeight - 4),
                          left: Math.max(4, rect.right - 108),
                        });
                        setSessionMenuId(session.id);
                      }} title="对话操作" aria-label={`${session.name} 的操作菜单`} aria-haspopup="menu" aria-expanded={sessionMenuId === session.id}>
                        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.5" cy="10" r="1" /><circle cx="10" cy="10" r="1" /><circle cx="15.5" cy="10" r="1" /></svg>
                      </button>
                    </div>
                  </div>;
                })}
                {!loadedCount && group.total > 0 && <p className="session-directory-empty">{loadingDirectory ? "正在加载…" : "展开后加载对话"}</p>}
                {loadedCount < group.total && <button type="button" className="load-directory-sessions" disabled={loadingDirectory} onClick={() => onLoadDirectory(group.key, loadedCount)}>{loadingDirectory ? "正在加载…" : `加载更多（${loadedCount}/${group.total}）`}</button>}
              </div>}
            </section>;
          })}
          {searching && loadingAllSessions && <p className="empty-list">正在加载全部对话…</p>}
          {searching && !loadingAllSessions && sessions.length < sessionsTotal && <button type="button" className="load-all-sessions" onClick={onLoadAllSessions}>重试加载全部对话</button>}
          {searching && !loadingAllSessions && sessions.length >= sessionsTotal && !visibleSessionCount && <p className="empty-list">没有匹配的对话</p>}
          {!searching && !sessions.length && <p className="empty-list">{inventoryReady ? "还没有历史会话" : "正在加载对话…"}</p>}
        </nav>
        <ResizeHandle width={width} onWidthChange={onWidthChange} />
      </aside>
      {menuSession && visibleSessionIds.has(menuSession.id) && createPortal(<div className="session-item-menu" ref={sessionMenuRef} role="menu" style={sessionMenuPosition}>
        <button type="button" role="menuitem" onClick={() => { setSessionMenuId(""); onTogglePin(menuSession.id); }}>{pinnedIds.has(menuSession.id) ? "取消置顶" : "置顶"}</button>
        <button type="button" role="menuitem" disabled={mutatingSessionIds.includes(menuSession.id)} onClick={() => { setSessionMenuId(""); onRename(menuSession); }}>重命名</button>
        <button type="button" role="menuitem" className="is-danger" disabled={mutatingSessionIds.includes(menuSession.id) || menuSession.running || menuSession.queued || menuSession.pendingConfirmation} onClick={() => { setSessionMenuId(""); onDelete(menuSession); }} title={mutatingSessionIds.includes(menuSession.id) ? "该对话的管理操作尚未确认" : menuSession.running ? "该对话正在生成，停止后才能删除" : menuSession.queued ? "该对话有待发送消息，清空队列后才能删除" : menuSession.pendingConfirmation ? "该对话正在等待确认，处理后才能删除" : undefined}>删除</button>
      </div>, document.body)}
    </>
  );
}
