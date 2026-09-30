import assert from "node:assert/strict";
import test from "node:test";
import { reconcileIdleSessionView, sessionViewConfirmsIdle } from "../../src/web/application/session-reconciliation";
import type { SessionViewData } from "../../src/shared/types";

function view(overrides: Partial<SessionViewData> = {}): SessionViewData {
  return {
    session: {
      id: "session",
      sessionId: "session",
      name: "Session",
      preview: "",
      cwd: "C:\\work",
      updatedAt: 1,
      messageCount: 1,
      turnCount: 1,
      active: false,
      running: false,
      activity: {
        execution: "running",
        awaitingConfirmation: true,
        runStartedAt: 10,
      },
    },
    state: { isStreaming: false },
    messages: [],
    messageTotal: 1,
    turnTotal: 1,
    visibleTurnCount: 1,
    messagesTruncated: false,
    isActive: false,
    isStreaming: false,
    liveMessage: undefined,
    toolStatus: "",
    queue: [],
    queuePaused: true,
    ...overrides,
  };
}

test("session reconciliation derives a terminal view without owning cache or sidebar state", () => {
  const result = reconcileIdleSessionView(view());
  assert.equal(sessionViewConfirmsIdle(view()), true);
  assert.equal(result.session.running, false);
  assert.deepEqual(result.session.activity, {
    execution: "idle",
    awaitingConfirmation: false,
  });
  assert.equal(result.state.isStreaming, false);
  assert.equal(result.isStreaming, false);
  assert.equal(result.queuePaused, false);
  assert.equal(result.toolStatus, "");
});

test("session reconciliation leaves live views untouched", () => {
  const live = view({
    state: { isStreaming: true },
    isStreaming: true,
    toolStatus: "正在运行工具",
  });
  assert.equal(sessionViewConfirmsIdle(live), false);
  assert.equal(reconcileIdleSessionView(live), live);
});
