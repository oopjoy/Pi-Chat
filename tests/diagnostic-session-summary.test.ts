import assert from "node:assert/strict";
import test from "node:test";
import { summarizeDiagnosticSessions } from "../src/web/application/app-presentation-state";
import { createBootstrapFixture } from "./fixtures/app-bootstrap";
import type { SessionSummary } from "../src/shared/types";

test("one-pass diagnostic counts preserve the prior six-filter semantics", () => {
  const base = createBootstrapFixture().sessions[0];
  const sessions: SessionSummary[] = [
    { ...base, id: "running", running: true, controlOwner: "other" },
    { ...base, id: "queued", queued: true, pendingConfirmation: true },
    { ...base, id: "failed", activity: { execution: "failed", awaitingConfirmation: false } },
    { ...base, id: "paused", activity: { execution: "paused", awaitingConfirmation: false }, controlOwner: "self", controlledByThisWindow: true },
    { ...base, id: "idle" },
  ];
  const before = JSON.stringify(sessions);
  assert.deepEqual(summarizeDiagnosticSessions(sessions), {
    sidebarRunningCount: 1, sidebarQueuedCount: 1, sidebarFailedCount: 1, sidebarPausedCount: 1, sidebarConfirmationCount: 1, sidebarForeignOwnerCount: 1,
  });
  assert.equal(JSON.stringify(sessions), before);
  assert.ok(Object.values(summarizeDiagnosticSessions([])).every(value => value === 0));
});
