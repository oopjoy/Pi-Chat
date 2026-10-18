import { Fragment, useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../../shared/types";
import { PanelRightIcon, SettingsIcon, MoreIcon } from "./Icons";
import { SubagentStatusControl } from "./SubagentStatusControl";

/** A server-verified Session address projected into the read-only child trail. */
export type SubagentBreadcrumb = {
  sessionId: string;
  label: string;
};

export function TopBar({ sessionId, conversationName, workspacePath, buildIdentity, settingsOpen, onOpenSettings, diffSidebarOpen, onToggleDiffSidebar, onOpenSubagentSession, subagentBreadcrumb, onNavigateSubagentAncestor, sessionMenu }: {
  sessionId: string;
  /** 与左侧栏会话三点按钮相同的操作集合；为 null 时不显示。 */
  sessionMenu?: {
    session: SessionSummary | null;
    pinnedSessionIds: string[];
    mutationBusy: boolean;
    onTogglePin: (sessionId: string) => void;
    onClone: (session: SessionSummary) => void;
    onCopyDeepLink: (sessionId: string) => Promise<void>;
    onRename: (session: SessionSummary) => void;
    onDelete: (session: SessionSummary) => void;
  } | null;
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
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!actionsOpen) return;
    const close = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) setActionsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setActionsOpen(false);
      actionsTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [actionsOpen]);
  useEffect(() => {
    if (sessionId && sessionMenu && actionsOpen) setActionsOpen(false);
  }, [sessionId, sessionMenu, actionsOpen]);
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
        {sessionMenu && sessionMenu.session && !childTrail ? (
          <div className="topbar-session-actions" ref={actionsRef}>
            <button
              type="button"
              className={`topbar-session-actions-trigger${actionsOpen ? " is-open" : ""}`}
              ref={actionsTriggerRef}
              onClick={() => setActionsOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              aria-label="对话操作"
              title="对话操作"
            ><MoreIcon /></button>
            {actionsOpen && <div className="session-item-menu topbar-session-actions-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); sessionMenu.onTogglePin(sessionId); }}>{sessionMenu.pinnedSessionIds.includes(sessionId) ? "取消置顶" : "置顶"}</button>
              <button type="button" role="menuitem" disabled={sessionMenu.mutationBusy} onClick={() => { setActionsOpen(false); sessionMenu.onClone(sessionMenu.session!); }} title={sessionMenu.mutationBusy ? "该对话的管理操作尚未确认" : undefined}>复制为新对话</button>
              <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); void sessionMenu.onCopyDeepLink(sessionId); }}>复制深度链接</button>
              <button type="button" role="menuitem" disabled={sessionMenu.mutationBusy} onClick={() => { setActionsOpen(false); sessionMenu.onRename(sessionMenu.session!); }} title={sessionMenu.mutationBusy ? "该对话的管理操作尚未确认" : undefined}>重命名</button>
              <button type="button" role="menuitem" className="is-danger" disabled={sessionMenu.mutationBusy} onClick={() => { setActionsOpen(false); sessionMenu.onDelete(sessionMenu.session!); }} title={sessionMenu.mutationBusy ? "该对话的管理操作尚未确认" : undefined}>删除</button>
            </div>}
          </div>
        ) : null}
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
