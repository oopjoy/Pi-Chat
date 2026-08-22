import { Fragment } from "react";
import { PanelRightIcon, SettingsIcon } from "./Icons";
import { SubagentStatusControl } from "./SubagentStatusControl";

/** A server-verified Session address projected into the read-only child trail. */
export type SubagentBreadcrumb = {
  sessionId: string;
  label: string;
};

export function TopBar({ sessionId, conversationName, workspacePath, buildIdentity, settingsOpen, onOpenSettings, diffSidebarOpen, onToggleDiffSidebar, onOpenSubagentSession, subagentBreadcrumb, onNavigateSubagentAncestor }: {
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
  /** Root-to-leaf path exists only for an addressed, read-only Subagent transcript. */
  subagentBreadcrumb?: readonly SubagentBreadcrumb[];
  /** Navigates to a prior server-verified ancestor; it never grants child authority. */
  onNavigateSubagentAncestor?: (sessionId: string, label: string) => void;
}) {
  const childTrail = subagentBreadcrumb && subagentBreadcrumb.length > 1
    ? subagentBreadcrumb
    : null;
  const title = `当前对话：${conversationName}\n工作路径：${workspacePath}\n${buildIdentity}`;
  return (
    <header className="topbar">
      <div className="topbar-context">
        {childTrail ? (
          <nav className="topbar-breadcrumb" aria-label="子代理对话路径" title={title}>
            {childTrail.map((item, index) => {
              const current = index === childTrail.length - 1;
              return <Fragment key={item.sessionId}>
                {index > 0 && <span className="topbar-breadcrumb-separator" aria-hidden="true">/</span>}
                {current ? (
                  <strong className="topbar-breadcrumb-current" aria-current="page">{item.label}</strong>
                ) : (
                  <button
                    type="button"
                    className="topbar-breadcrumb-link"
                    onClick={() => onNavigateSubagentAncestor?.(item.sessionId, item.label)}
                    aria-label={`返回父对话：${item.label}`}
                    title={`返回 ${item.label}`}
                  >
                    {item.label}
                  </button>
                )}
              </Fragment>;
            })}
          </nav>
        ) : (
          <strong className="topbar-title" title={title}>{conversationName}</strong>
        )}
        <SubagentStatusControl key={sessionId || "draft"} sessionId={sessionId} onOpenSession={onOpenSubagentSession} />
      </div>
      <div className="topbar-controls">
        <button type="button" className={`diff-sidebar-toggle${diffSidebarOpen ? " is-open" : ""}`} onClick={onToggleDiffSidebar} aria-label={diffSidebarOpen ? "收起文件与变更侧栏" : "展开文件与变更侧栏"} aria-pressed={diffSidebarOpen} title={diffSidebarOpen ? "收起 Files / Changes" : "展开 Files / Changes"}>
          <PanelRightIcon aria-hidden="true" />
        </button>
        <button type="button" className={`topbar-settings${settingsOpen ? " is-open" : ""}`} onClick={onOpenSettings} aria-label={settingsOpen ? "关闭设置" : "打开设置"} aria-expanded={settingsOpen} aria-controls="pi-chat-settings-dialog" title={settingsOpen ? "关闭设置" : "设置"}>
          <SettingsIcon aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
