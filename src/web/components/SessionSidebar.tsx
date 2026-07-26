import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { SessionSummary } from "../../shared/types";
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "../lib/preferences";
import { ChipIcon, FolderIcon, PanelLeftIcon, PiMarkIcon, PlusIcon, RefreshIcon, SettingsIcon } from "./Icons";
import type { ManagementSection } from "./ManagementPanel";

function relativeTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(timestamp);
}

const managementItems: Array<{ section: ManagementSection; label: string }> = [
  { section: "settings", label: "设置" },
  { section: "models", label: "Models" },
];

type SessionStatus = "dormant" | "ready" | "pending" | "running" | "error";

export function sessionStatus(session: SessionSummary, warming: boolean, failed: boolean): { kind: SessionStatus; label: string } {
  // A confirmation pauses an in-flight turn but needs user attention first.
  if (session.pendingConfirmation) return { kind: "pending", label: "等待权限确认" };
  // A queued follow-up must not hide the reply currently being generated.
  if (session.running) return { kind: "running", label: "正在生成" };
  if (warming) return { kind: "running", label: "正在启动会话" };
  if (session.queued) return { kind: "pending", label: "消息等待发送" };
  if (failed) return { kind: "error", label: "会话运行异常" };
  if (session.writable) return { kind: "ready", label: "已就绪" };
  return { kind: "dormant", label: "按需启动" };
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

export function SessionSidebar({ sessions, sessionsTotal, loadingAllSessions, viewedSessionId, workspaceCwd, open, width, newDisabled, refreshDisabled, restartDisabled, workspaceDisabled, viewBusy, refreshing, warmingSessionIds, failedSessionIds, workspacePicking, onClose, onCollapse, onNew, onRefresh, onLoadAllSessions, onRestart, onView, onRename, onDelete, onPickWorkspace, onManage, onWidthChange }: {
  sessions: SessionSummary[];
  sessionsTotal: number;
  loadingAllSessions: boolean;
  viewedSessionId: string;
  workspaceCwd: string;
  open: boolean;
  width: number;
  newDisabled: boolean;
  refreshDisabled: boolean;
  restartDisabled: boolean;
  workspaceDisabled: boolean;
  viewBusy: boolean;
  refreshing: boolean;
  warmingSessionIds: string[];
  failedSessionIds: string[];
  workspacePicking: boolean;
  onClose: () => void;
  onCollapse: () => void;
  onNew: () => void;
  onRefresh: () => void;
  onLoadAllSessions: () => void;
  onRestart: () => void;
  onView: (id: string) => void;
  onRename: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
  onPickWorkspace: () => void;
  onManage: (section: ManagementSection) => void;
  onWidthChange: (width: number) => void;
}) {
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
  const menuSession = sessions.find((session) => session.id === sessionMenuId);

  return (
    <>
      {open && <button type="button" className="sidebar-scrim" aria-label="关闭会话栏" onClick={onClose} />}
      <aside className={`sidebar ${open ? "is-open" : ""}`} style={{ "--sidebar-width": `${width}px` } as CSSProperties}>
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
        <div className="session-heading"><span>对话</span><span>{sessions.length < sessionsTotal ? `${sessions.length}/${sessionsTotal}` : sessionsTotal}</span></div>
        <nav className="session-list" aria-label="会话列表">
          {sessions.map((session) => {
            const unavailable = viewBusy || session.id === viewedSessionId;
            const status = sessionStatus(session, warmingSessionIds.includes(session.id), failedSessionIds.includes(session.id));
            return <div className={`session-row ${session.id === viewedSessionId ? "is-active" : ""}`} key={session.id}>
              <button
                type="button"
                className={`session-item ${session.id === viewedSessionId ? "is-active" : ""} ${session.running ? "is-running" : ""} ${unavailable ? "is-disabled" : ""}`}
                disabled={unavailable}
                aria-current={session.id === viewedSessionId ? "page" : undefined}
                onClick={() => onView(session.id)}
                title={`${session.cwd}\n${session.preview}`}
              >
                <span className="session-name">{session.name}</span>
                <span className="session-meta"><i className={`session-status is-${status.kind}`} role="img" aria-label={status.label} title={status.label} />{relativeTime(session.updatedAt)} · {session.turnCount ?? session.messageCount} 轮</span>
              </button>
              <div className={`session-item-actions${sessionMenuId === session.id ? " is-open" : ""}`}>
                <button type="button" className="session-menu-trigger" onClick={(event) => {
                  if (sessionMenuId === session.id) return setSessionMenuId("");
                  const rect = event.currentTarget.getBoundingClientRect();
                  const menuHeight = 72;
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
          {sessions.length < sessionsTotal && <button type="button" className="load-all-sessions" disabled={loadingAllSessions} onClick={onLoadAllSessions}>{loadingAllSessions ? "正在加载…" : `加载全部对话（共 ${sessionsTotal} 个）`}</button>}
          {!sessions.length && <p className="empty-list">还没有历史会话</p>}
        </nav>
        <button type="button" className="workspace-picker" disabled={workspaceDisabled} onClick={onPickWorkspace} title="设置工作路径" aria-label="设置工作路径"><FolderIcon className="workspace-picker-icon" /><span title={workspaceCwd || "未设置工作路径"}>{workspacePicking ? "正在打开目录窗口…" : workspaceCwd || "未设置工作路径"}</span></button>
        <nav className="management-nav" aria-label="管理">
          {managementItems.map((item) => <button type="button" key={item.section} onClick={() => onManage(item.section)}>{item.section === "models" ? <ChipIcon className="sidebar-line-icon" /> : <SettingsIcon className="sidebar-line-icon" />}{item.label}</button>)}
        </nav>
        <ResizeHandle width={width} onWidthChange={onWidthChange} />
      </aside>
      {menuSession && createPortal(<div className="session-item-menu" ref={sessionMenuRef} role="menu" style={sessionMenuPosition}>
        <button type="button" role="menuitem" onClick={() => { setSessionMenuId(""); onRename(menuSession); }}>重命名</button>
        <button type="button" role="menuitem" className="is-danger" disabled={menuSession.running || menuSession.queued || menuSession.pendingConfirmation} onClick={() => { setSessionMenuId(""); onDelete(menuSession); }} title={menuSession.running ? "该对话正在生成，停止后才能删除" : menuSession.queued ? "该对话有待发送消息，清空队列后才能删除" : menuSession.pendingConfirmation ? "该对话正在等待确认，处理后才能删除" : undefined}>删除</button>
      </div>, document.body)}
    </>
  );
}
