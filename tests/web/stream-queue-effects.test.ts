import assert from "node:assert/strict";
import test from "node:test";
import { applyKnownQueueDispatchEffect, applyQueueErrorEffect, applyQueueSnapshotEffect, applyQueueUpdateEffect, applySyntheticQueueDispatchEffect } from "../../src/web/application/stream-queue-effects";

test("synthetic queue dispatch creates one recoverable local turn", () => {
  const stored: unknown[][] = [];
  const turn = applySyntheticQueueDispatchEffect({
    sessionId: "s", queue: [], dispatchedId: "q", dispatchedMessage: "", imageCount: 1,
    sourceMessages: [], sourceTurnTotal: 0, baselineTurnTotal: 0, viewing: true,
  }, {
    localTurns: () => [],
    storeLocalTurns: (_id, turns) => stored.push(turns),
    dispatchPane: () => {},
  });
  assert.equal(turn.queueState, "dispatched");
  assert.equal(turn.message.content, "请查看附加的 1 张图片");
  assert.equal(stored.length, 1);
});

test("queue error effect returns affected rendered turns to the queue", () => {
  const calls: string[] = [];
  const turn = { sessionId: "s", message: { role: "user", content: "failed" }, queueId: "q", queueState: "dispatched", renderedInTranscript: true, expectedTurnTotal: 1 } as never;
  applyQueueErrorEffect({
    sessionId: "s", queue: [], paused: false, failedId: "q", viewing: true, errorMessage: "failed",
  }, {
    acceptQueue: (_id, queue, paused) => ({ queue, paused }),
    localTurns: () => [turn],
    bindQueuedAdmission: () => undefined,
    promoteAbsentTurns: () => [],
    dispatchPane: () => calls.push("pane"),
    requestPromptReconcile: () => {},
    updateSidebar: () => calls.push("sidebar"),
    patchSessionCache: () => calls.push("cache"),
    showError: () => calls.push("error"),
  });
  assert.equal(turn.queueState, "waiting");
  assert.equal(turn.queueRetryPending, true);
  assert.equal(turn.renderedInTranscript, false);
  assert.deepEqual(calls, ["sidebar", "cache", "pane", "error"]);
});

test("queue update effect clears an admitted pending editor without losing Queue projection", () => {
  const calls: string[] = [];
  const message = { role: "user", content: "queued" } as const;
  const turn = { sessionId: "s", message, queueState: "waiting", renderedInTranscript: true, expectedTurnTotal: 1 } as never;
  applyQueueUpdateEffect({
    sessionId: "s",
    queue: [{ id: "q", message: "queued", imageCount: 0, createdAt: 1 }],
    paused: false,
    admittedId: "q",
    viewing: true,
  }, {
    acceptQueue: (_id, queue, paused) => ({ queue, paused }),
    localTurns: () => [turn],
    bindQueuedAdmission: () => turn,
    promoteAbsentTurns: () => [],
    dispatchPane: () => calls.push("pane"),
    requestPromptReconcile: () => calls.push("reconcile"),
    updateSidebar: () => calls.push("sidebar"),
    patchSessionCache: () => calls.push("cache"),
  });
  assert.equal(turn.renderedInTranscript, false);
  assert.deepEqual(calls, ["sidebar", "cache", "pane"]);
});

test("queue snapshot effect promotes absent local turns only for the viewed Pane", () => {
  const calls: string[] = [];
  const turn = { sessionId: "s", message: { role: "user", content: "dispatch" }, expectedTurnTotal: 1 } as never;
  const projection = applyQueueSnapshotEffect({
    sessionId: "s",
    queue: [],
    paused: false,
    viewing: true,
  }, {
    acceptQueue: (_id, queue, paused) => ({ queue, paused }),
    localTurns: () => [turn],
    bindQueuedAdmission: () => {},
    promoteAbsentTurns: () => [turn],
    dispatchPane: () => calls.push("pane"),
    requestPromptReconcile: () => calls.push("reconcile"),
    updateSidebar: () => calls.push("sidebar"),
    patchSessionCache: () => calls.push("cache"),
  });
  assert.deepEqual(projection, { queue: [], paused: false });
  assert.equal(turn.renderedInTranscript, true);
  assert.deepEqual(calls, ["pane", "reconcile", "sidebar", "cache"]);
});
