import type {
  SessionActivityState,
  SessionDirectorySummary,
  SessionSummary,
} from "../../shared/types";
import { groupSessionsForNavigation } from "../lib/session-navigation";

export type SidebarSessionStatus = "idle" | "unread" | "pending" | "running" | "error";

export interface SidebarWorkspaceAuthority {
  cwd: string;
  epoch: string;
  revision: number;
}

function legacyActivity(session: SessionSummary, failed: boolean): SessionActivityState {
  return {
    execution: failed ? "failed" : session.running ? "running" : session.queued ? "queued" : "idle",
    awaitingConfirmation: session.pendingConfirmation === true,
  };
}

/** Sidebar shows one coarse outcome; Composer and queue retain phase detail. */
export function sidebarSessionStatus(
  session: SessionSummary,
  failed: boolean,
  hasUnseenReply: boolean,
): { kind: SidebarSessionStatus; label: string } {
  const activity = session.activity || legacyActivity(session, failed);
  if (activity.execution === "paused") return { kind: "error", label: "队列已暂停，需要恢复或撤销" };
  if (activity.execution === "failed") {
    const detail = typeof activity.error === "string" ? activity.error.trim() : "";
    return {
      kind: "error",
      label: detail ? `会话运行异常：${detail}` : "会话运行异常",
    };
  }
  if (activity.awaitingConfirmation) return { kind: "pending", label: "等待权限确认" };
  if (activity.execution === "queued") return { kind: "running", label: "消息等待自动执行" };
  if (activity.execution === "dispatching") return { kind: "running", label: "正在派发队列消息" };
  if (activity.execution === "running") return { kind: "running", label: "正在生成" };
  if (hasUnseenReply) return { kind: "unread", label: "有新回复" };
  return { kind: "idle", label: "对话空闲" };
}

/**
 * JSONL-derived startup cwd and a replacement-process epoch are not a user
 * workspace change. Reset local sidebar-only UI only for a newer revision in
 * the same established process epoch.
 */
export function sidebarWorkspaceResetRequired(
  previous: SidebarWorkspaceAuthority,
  current: SidebarWorkspaceAuthority,
): boolean {
  return Boolean(
    previous.epoch
      && previous.epoch === current.epoch
      && current.revision > previous.revision
      && previous.cwd !== current.cwd,
  );
}

export interface SidebarViewModelInput {
  sessions: SessionSummary[];
  sessionDirectories: SessionDirectorySummary[];
  workspaceCwd: string;
  searchQuery: string;
  pinnedSessionIds: string[];
  pinnedDirectoryKeys: string[];
  collapsedDirectoryKeys: string[];
  expandedDirectoryKeys: string[];
}

/**
 * Pure inventory projection. It intentionally does not own HTTP, cache,
 * optimistic mutation, navigation, or local React UI state.
 */
export function buildSidebarViewModel(input: SidebarViewModelInput) {
  const groups = groupSessionsForNavigation(
    input.sessions,
    input.pinnedSessionIds,
    input.pinnedDirectoryKeys,
    input.collapsedDirectoryKeys,
    input.searchQuery,
    input.sessionDirectories,
    input.workspaceCwd,
    input.expandedDirectoryKeys,
  );
  return {
    searching: Boolean(input.searchQuery.trim()),
    groups,
    visibleSessionCount: groups.reduce((total, group) => total + group.sessions.length, 0),
    visibleSessionIds: new Set(
      groups
        .filter((group) => !group.collapsed)
        .flatMap((group) => group.sessions.map((session) => session.id)),
    ),
    pinnedSessionIds: new Set(input.pinnedSessionIds),
  };
}
