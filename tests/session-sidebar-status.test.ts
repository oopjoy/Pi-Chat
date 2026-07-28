import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../src/shared/types";
import { sessionCanRelease, sessionStatus } from "../src/web/components/SessionSidebar";

const session = (patch: Partial<SessionSummary>): SessionSummary => ({
  id: "session", sessionId: "session", name: "Session", preview: "", cwd: "C:/work", updatedAt: 0, messageCount: 1,
  ...patch,
});

test("sidebar keeps the blue running ring when a follow-up is queued", () => {
  assert.deepEqual(sessionStatus(session({ running: true, queued: true }), false, false), { kind: "running", label: "正在生成" });
  assert.deepEqual(sessionStatus(session({ queued: true }), false, false), { kind: "pending", label: "消息等待发送" });
  assert.deepEqual(sessionStatus(session({ running: true, queued: true, pendingConfirmation: true }), false, false), { kind: "pending", label: "等待权限确认" });
});

test("manual release appears only for an idle healthy hot Secondary capability", () => {
  assert.equal(sessionCanRelease(session({ releasable: true }), false, false), true);
  for (const patch of [{ running: true }, { queued: true }, { pendingConfirmation: true }]) {
    assert.equal(sessionCanRelease(session({ releasable: true, ...patch }), false, false), false);
  }
  assert.equal(sessionCanRelease(session({ releasable: true }), true, false), false);
  assert.equal(sessionCanRelease(session({ releasable: true }), false, true), false);
  assert.equal(sessionCanRelease(session({ releasable: false }), false, false), false);
});
