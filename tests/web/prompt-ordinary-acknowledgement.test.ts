import assert from "node:assert/strict";
import test from "node:test";
import { reconcileOrdinaryPromptAcknowledgement } from "../../src/web/application/prompt-ordinary-acknowledgement";

test("direct acknowledgement promotes a browser-conservatively queued turn into transcript state", async () => {
  const turn = {
    sessionId: "s",
    message: { role: "user" as const, content: "m" },
    expectedTurnTotal: 1,
    queueState: "waiting" as const,
    queueRetryPending: true,
  };
  await reconcileOrdinaryPromptAcknowledgement({
    sessionId: "s",
    authority: {} as never,
    eventVersionBefore: 1,
    eventVersionAfter: 1,
    lastEventType: "agent_start",
    promptTerminalByEvent: false,
  }, {
    protectLocalTurn: () => {},
    localTurnEntry: () => turn,
    commitPane: () => true,
    fetchSessionView: async () => { throw new Error("not settled"); },
    currentEventVersion: () => 1,
    currentPaneAuthority: () => true,
    applySessionView: () => {},
    queueRevision: () => 0,
    schedulePromptReconcile: () => {},
  });
  assert.equal(turn.queueState, "dispatched");
  assert.equal(turn.queueRetryPending, false);
});

test("ordinary acknowledgement commits a running local turn and schedules reconciliation", async () => {
  const calls: string[] = [];
  const authority = { sessionId: "s" } as never;
  await reconcileOrdinaryPromptAcknowledgement({
    sessionId: "s",
    authority,
    eventVersionBefore: 1,
    eventVersionAfter: 1,
    lastEventType: "agent_start",
    promptTerminalByEvent: false,
  }, {
    protectLocalTurn: () => calls.push("protect"),
    localTurnEntry: () => ({ sessionId: "s", message: { role: "user", content: "m" }, expectedTurnTotal: 1 }),
    commitPane: (_authority, action) => { calls.push(action.type); return true; },
    fetchSessionView: async () => { throw new Error("not settled"); },
    currentEventVersion: () => 1,
    currentPaneAuthority: () => true,
    applySessionView: () => {},
    queueRevision: () => 0,
    schedulePromptReconcile: () => calls.push("reconcile"),
  });
  assert.deepEqual(calls, ["protect", "PROMPT_ACKNOWLEDGED", "reconcile"]);
});
