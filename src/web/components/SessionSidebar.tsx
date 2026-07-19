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

export function SessionSidebar({ sessions, viewedSessionId, workspaceCwd, open, busy, viewBusy, refreshing, workspacePicking, onClose, onCollapse, onNew, onRefresh, onView, onPickWorkspace, onManage }: {
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
  onView: (id: string) => void;
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
          <button type="button" className={`refresh-chat ${refreshing ? "is-spinning" : ""}`} disabled={busy || refreshing} onClick={onRefresh} title="刷新会话" aria-label="刷新会话">↻</button>
        </div>
        <div className="session-heading"><span>对话</span><span>{sessions.length}</span></div>
        <nav className="session-list" aria-label="会话列表">
          {sessions.map((session) => {
            const unavailable = viewBusy || session.id === viewedSessionId;
            return <a
              key={session.id}
              href={`?session=${session.id}`}
              className={`session-item ${session.id === viewedSessionId ? "is-active" : ""} ${session.running ? "is-running" : ""} ${unavailable ? "is-disabled" : ""}`}
              aria-disabled={unavailable}
              onClick={(event) => {
                if (unavailable) event.preventDefault();
                else if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) {
                  event.preventDefault();
                  onView(session.id);
                }
              }}
              title={`${session.cwd}\n${session.preview}\nCtrl + 点击可在新标签页查看`}
            >
              <span className="session-name">{session.name}{session.running && <i className="session-running-dot" title="正在后台生成" />}</span>
              <span className="session-meta">{session.running ? "正在后台生成 · " : ""}{relativeTime(session.updatedAt)} · {session.messageCount} 条</span>
            </a>;
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
