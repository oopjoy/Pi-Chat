import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { SessionSummary } from "../src/shared/types";
import { SessionSidebar, sessionStatus } from "../src/web/components/SessionSidebar";

const session = (patch: Partial<SessionSummary>): SessionSummary => ({
  id: "session", sessionId: "session", name: "Session", preview: "", cwd: "C:/work", updatedAt: 0, messageCount: 1,
  ...patch,
});

test("sidebar separates normal work from confirmation, paused work, failure, and unseen completion", () => {
  const activity = (execution: "idle" | "queued" | "dispatching" | "running" | "paused" | "failed", awaitingConfirmation = false) => ({ activity: { execution, awaitingConfirmation } });
  assert.deepEqual(sessionStatus(session({ writable: false }), false, false), { kind: "idle", label: "对话空闲" });
  assert.deepEqual(sessionStatus(session(activity("queued")), false, true), { kind: "running", label: "消息等待自动执行" });
  assert.deepEqual(sessionStatus(session({ ...activity("dispatching"), queued: true }), false, true), { kind: "running", label: "正在派发队列消息" });
  assert.deepEqual(sessionStatus(session(activity("running")), false, true), { kind: "running", label: "正在生成" });
  assert.deepEqual(sessionStatus(session(activity("idle", true)), false, true), { kind: "pending", label: "等待权限确认" });
  assert.deepEqual(sessionStatus(session(activity("paused", true)), false, true), { kind: "error", label: "队列已暂停，需要恢复或撤销" });
  assert.deepEqual(sessionStatus(session(activity("failed")), false, true), { kind: "error", label: "会话运行异常" });
  assert.deepEqual(sessionStatus(session(activity("idle")), false, true), { kind: "unread", label: "有新回复" });
});

test("sidebar renders directory hierarchy, status description, and session actions accessibly", () => {
  const active = session({
    activity: { execution: "running", awaitingConfirmation: false },
    name: "Running Session",
    cwd: "C:/work",
  });
  const html = renderToStaticMarkup(createElement(SessionSidebar, {
    sessions: [active],
    sessionsTotal: 1,
    sessionDirectories: [{ cwd: "C:/work", count: 1, lastUserPromptAt: active.updatedAt }],
    inventoryReady: true,
    loadingAllSessions: false,
    loadingDirectoryKeys: [],
    viewedSessionId: "",
    workspaceCwd: "C:/work",
    open: true,
    width: 320,
    newDisabled: false,
    refreshDisabled: false,
    restartDisabled: false,
    viewBusy: false,
    refreshing: false,
    pinnedSessionIds: [],
    pinnedDirectoryKeys: [],
    collapsedDirectoryKeys: [],
    expandedDirectoryKeys: [],
    failedSessionIds: [],
    unseenReplySessionIds: [],
    mutatingSessionIds: [],
    onClose() {}, onCollapse() {}, onNew() {}, onRefresh() {}, onLoadAllSessions() {}, onLoadDirectory() {}, onRestart() {}, onView() {}, onTogglePin() {}, onToggleDirectoryPin() {}, onSetDirectoryCollapsed() {}, onRename() {}, onDelete() {}, onWidthChange() {},
  }));

  assert.match(html, /<section class="session-directory"[^>]*aria-label="c:\/work，1 个对话"/);
  assert.match(html, /aria-label="折叠目录 c:\/work，1 个对话"/);
  assert.match(html, /aria-label="正在生成"/);
  assert.match(html, /aria-label="Running Session 的操作菜单"/);
  assert.match(html, /aria-haspopup="menu"/);
});
