import { PanelRightIcon, SettingsIcon } from "./Icons";
import { SubagentStatusControl } from "./SubagentStatusControl";

export function TopBar({ sessionId, conversationName, workspacePath, buildIdentity, settingsOpen, onOpenSettings, diffSidebarOpen, onToggleDiffSidebar, onOpenSubagentSession }: {
  sessionId: string;
  conversationName: string;
  workspacePath: string;
  /** Compact, non-secret build diagnostic used to identify stale Web bundles. */
  buildIdentity: string;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  diffSidebarOpen: boolean;
  onToggleDiffSidebar: () => void;
  onOpenSubagentSession: (parentSessionId: string, childSessionId: string, label: string) => void;
}) {
  return (
    <header className="topbar">
      <div className="topbar-context">
        <strong className="topbar-title" title={`当前对话：${conversationName}\n工作路径：${workspacePath}\n${buildIdentity}`}>{conversationName}</strong>
        <SubagentStatusControl key={sessionId || "draft"} sessionId={sessionId} onOpenSession={onOpenSubagentSession} />
      </div>
      <div className="topbar-controls">
        <button type="button" className={`diff-sidebar-toggle${diffSidebarOpen ? " is-open" : ""}`} onClick={onToggleDiffSidebar} aria-label={diffSidebarOpen ? "收起 Diff 侧栏" : "展开 Diff 侧栏"} aria-pressed={diffSidebarOpen} title={diffSidebarOpen ? "收起修改对比侧栏" : "展开修改对比侧栏"}>
          <PanelRightIcon aria-hidden="true" />
        </button>
        <button type="button" className={`topbar-settings${settingsOpen ? " is-open" : ""}`} onClick={onOpenSettings} aria-label={settingsOpen ? "关闭设置" : "打开设置"} aria-expanded={settingsOpen} aria-controls="pi-chat-settings-dialog" title={settingsOpen ? "关闭设置" : "设置"}>
          <SettingsIcon aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
