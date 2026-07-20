import type { SessionSummary } from "../../shared/types";
import type { ManagementSection } from "./ManagementPanel";

function relativeTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(timestamp);
}

const managementItems: Array<{ section: ManagementSection; icon: string; label: string }> = [
  { section: "settings", icon: "⚙", label: "设置" },
  { section: "models", icon: "◈", label: "Models" },
];

export function SessionSidebar({ sessions, viewedSessionId, workspaceCwd, open, busy, viewBusy, refreshing, workspacePicking, onClose, onCollapse, onNew, onRefresh, onRestart, onView, onRename, onDelete, onPickWorkspace, onManage }: {
  sessions: SessionSummary[];
  viewedSessionId: string;
  workspaceCwd: string;
  open: boolean;
  busy: boolean;
  viewBusy: boolean;
  refreshing: boolean;
  workspacePicking: boolean;
  onClose: () => void;
  onCollapse: () => void;
  onNew: () => void;
  onRefresh: () => void;
  onRestart: () => void;
  onView: (id: string) => void;
  onRename: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
  onPickWorkspace: () => void;
  onManage: (section: ManagementSection) => void;
}) {
  return (
    <>
      {open && <button type="button" className="sidebar-scrim" aria-label="关闭会话栏" onClick={onClose} />}
      <aside className={`sidebar ${open ? "is-open" : ""}`}>
        <div className="sidebar-topline">
          <div className="brand-row"><span className="brand-mark">π</span><strong>Pi Chat</strong></div>
          <button type="button" className="sidebar-collapse" onClick={onCollapse} title="收起侧栏" aria-label="收起侧栏">
            <svg className="sidebar-panel-icon" viewBox="0 0 20 16" width="18" height="14" aria-hidden="true">
              <rect x="1.25" y="1.25" width="17.5" height="13.5" rx="2.2" ry="2.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M7.2 1.25v13.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </button>
        </div>
        <div className="sidebar-actions">
          <button type="button" className="new-chat" disabled={busy} onClick={onNew}><span>＋</span> New</button>
          <button type="button" className={`refresh-chat ${refreshing ? "is-spinning" : ""}`} disabled={busy || refreshing} onClick={onRefresh} title="刷新会话列表" aria-label="刷新会话列表">↻</button>
          <button type="button" className="restart-pi" disabled={busy || refreshing} onClick={onRestart} title="重启 Pi RPC（不删除聊天记录）" aria-label="重启 Pi RPC">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.6v7.1M5.15 5.55a6.45 6.45 0 1 0 9.7 0" /></svg>
          </button>
        </div>
        <div className="session-heading"><span>对话</span><span>{sessions.length}</span></div>
        <nav className="session-list" aria-label="会话列表">
          {sessions.map((session) => {
            const unavailable = viewBusy || session.id === viewedSessionId;
            return <div className={`session-row ${session.id === viewedSessionId ? "is-active" : ""}`} key={session.id}>
              <button
                type="button"
                className={`session-item ${session.id === viewedSessionId ? "is-active" : ""} ${session.running ? "is-running" : ""} ${unavailable ? "is-disabled" : ""}`}
                disabled={unavailable}
                aria-current={session.id === viewedSessionId ? "page" : undefined}
                onClick={() => onView(session.id)}
                title={`${session.cwd}\n${session.preview}`}
              >
                <span className="session-name">{session.name}{session.running && <i className="session-running-dot" title="正在后台生成" />}</span>
                <span className="session-meta">{session.running ? "正在生成 · " : session.writable ? "并行就绪 · " : "按需启动 · "}{relativeTime(session.updatedAt)} · {session.messageCount} 条</span>
              </button>
              <span className="session-item-actions">
                <button type="button" onClick={() => onRename(session)} title="重命名对话" aria-label={`重命名 ${session.name}`}>
                  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 13.8-.7 3 3-.7L15 7.4 12.6 5 4 13.8Z" /><path d="m11.7 5.9 2.4 2.4" /></svg>
                </button>
                <button type="button" onClick={() => onDelete(session)} title="删除对话" aria-label={`删除 ${session.name}`}>
                  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6h11M8 3.8h4M6 6l.7 10h6.6L14 6M8.2 8.5v5M11.8 8.5v5" /></svg>
                </button>
              </span>
            </div>;
          })}
          {!sessions.length && <p className="empty-list">还没有历史会话</p>}
        </nav>
        <button type="button" className="workspace-picker" disabled={busy} onClick={onPickWorkspace} title="打开 Windows 文件夹选择窗口" aria-label="浏览并选择当前工作目录"><span>📁</span><span><strong>{workspacePicking ? "正在打开目录窗口…" : "浏览工作目录"}</strong><small>{workspaceCwd || "点击选择本地文件夹"}</small></span></button>
        <nav className="management-nav" aria-label="管理">
          {managementItems.map((item) => <button type="button" key={item.section} onClick={() => onManage(item.section)}><span>{item.icon}</span>{item.label}</button>)}
        </nav>
      </aside>
    </>
  );
}
