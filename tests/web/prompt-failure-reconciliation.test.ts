import assert from "node:assert/strict";
import test from "node:test";
import {
  planPromptFailureLocalTurn,
  reconcilePromptFailureRecord,
} from "../../src/web/application/prompt-failure-reconciliation";

test("prompt failure reconciliation keeps uncertain ordinary turns dispatched", () => {
  const plan = planPromptFailureLocalTurn({
    localEntry: { sessionId: "s", message: { role: "user", content: "m" }, expectedTurnTotal: 1 },
    pendingTurns: [],
    outcomeUnknown: true,
    steering: false,
  });
  assert.deepEqual(plan, { retainAsDispatched: true, removeFromPending: false });
});

test("prompt failure reconciliation removes definite rendered turns", () => {
  const message = { role: "user", content: "m" } as const;
  const plan = planPromptFailureLocalTurn({
    localEntry: { sessionId: "s", message, expectedTurnTotal: 1, renderedInTranscript: true },
    pendingTurns: [],
    outcomeUnknown: false,
    steering: false,
  });
  assert.equal(plan.removeFromPending, true);
  assert.equal(plan.renderedMessage, message);
});

test("prompt failure reconciliation records only definite transcript-worthy failures", () => {
  const calls: string[] = [];
  const host = {
    isTranscriptWorthyFailure: () => true,
    recordLocalFailure: (scope: string, message: string, incidentId?: string) => calls.push(`${scope}:${message}:${incidentId || ""}`),
  };
  assert.equal(reconcilePromptFailureRecord({
    scope: "session",
    message: "failed",
    incidentId: "PC-123",
    failureIsDefinite: true,
    steering: false,
  }, host), true);
  assert.equal(reconcilePromptFailureRecord({
    scope: "session",
    message: "uncertain",
    failureIsDefinite: false,
    steering: false,
  }, host), false);
  assert.deepEqual(calls, ["session:failed:PC-123"]);
});
