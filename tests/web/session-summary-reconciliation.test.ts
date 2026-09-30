import assert from "node:assert/strict";
import test from "node:test";
import {
  applySidebarQueueProjection,
  applySidebarRunningOverride,
  settleSidebarActivity,
} from "../../src/web/application/session-summary-reconciliation";
import type { SessionSummary } from "../../src/shared/types";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session",
    sessionId: "session",
    name: "Session",
    preview: "",
    cwd: "C:\\work",
    updatedAt: 1,
    messageCount: 1,
    turnCount: 1,
    active: false,
    running: true,
    queued: false,
    activity: { execution: "running", awaitingConfirmation: false },
    ...overrides,
  };
}

test("sidebar running projection preserves the one-row Session summary boundary", () => {
  const stopped = applySidebarRunningOverride(summary(), false);
  assert.equal(stopped.running, false);
  assert.equal(stopped.activity?.execution, "idle");
  assert.equal(applySidebarRunningOverride(stopped, true).activity?.execution, "running");
});

test("sidebar queue projection changes only coarse queue/activity facts", () => {
  const projected = applySidebarQueueProjection(
    summary({ activity: { execution: "queued", awaitingConfirmation: false } }),
    [{ id: "q1", message: "queued", imageCount: 0, createdAt: 1 }],
    false,
  );
  assert.equal(projected.queued, true);
  assert.equal(projected.activity?.execution, "running");
  assert.equal(projected.preview, "");
  assert.equal(applySidebarQueueProjection(projected, [], false).queued, false);
});

test("settling a sidebar row does not mutate the input summary", () => {
  const original = summary();
  const settled = settleSidebarActivity(original);
  assert.equal(original.activity?.execution, "running");
  assert.equal(settled.activity?.execution, "idle");
});
