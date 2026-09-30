import assert from "node:assert/strict";
import test from "node:test";
import { PromptCoordinator } from "../../src/web/application/prompt-coordinator";
import { createPromptSubmitController } from "../../src/web/application/prompt-submit-controller";
import {
  classifyPromptFailure,
  createPromptSubmitFlow,
  draftIntentAfterSubmit,
  initialDraftSessionView,
  pendingSteerFromAcknowledgement,
  promptAcknowledgementKind,
  planAcknowledgedQueueProjection,
  planAcknowledgedTurn,
  prepareRestoringPrompt,
  promptPreparationRoute,
  promptSettledBeforeAcknowledgement,
  submitNewDraftPrompt,
} from "../../src/web/application/prompt-submit-flow";

test("prompt submit flow owns admission phase classification without owning Prompt state", async () => {
  const controller = createPromptSubmitController({ promptCoordinator: new PromptCoordinator() });
  const flow = createPromptSubmitFlow({
    controller,
    isResultPending: () => false,
    isExplicitClientRejection: () => false,
  });
  const result = await flow.admit({
    admission: {
      promptId: "prompt-1",
      sessionId: "session-1",
      navigationEpoch: 1,
      delivery: "queue",
    },
    execute: async () => ({ queued: true, id: "queue-1" }),
    facts: {
      promptSubmitted: true,
      promptAcceptedByEvent: false,
      promptTerminalByEvent: false,
    },
  });
  assert.deepEqual(result, { queued: true, id: "queue-1" });
});

test("prompt flow identifies a terminal event that beat HTTP acknowledgement", () => {
  assert.equal(promptSettledBeforeAcknowledgement({
    promptTerminalByEvent: false,
    eventVersionAfter: 4,
    eventVersionBefore: 3,
    lastEventType: "agent_settled",
  }), true);
  assert.equal(promptSettledBeforeAcknowledgement({
    promptTerminalByEvent: false,
    eventVersionAfter: 4,
    eventVersionBefore: 3,
    lastEventType: "message_end",
  }), false);
});

test("prompt flow classifies failure uncertainty separately from transcript worthiness", () => {
  assert.deepEqual(classifyPromptFailure({
    resultPending: true,
    promptSubmitted: true,
    promptAcceptedByEvent: false,
    promptTerminalByEvent: false,
    explicitClientRejection: false,
    upstreamOutcomeUnknown: false,
  }), { outcomeUnknown: true, failureIsDefinite: false });
  assert.deepEqual(classifyPromptFailure({
    resultPending: false,
    promptSubmitted: true,
    promptAcceptedByEvent: false,
    promptTerminalByEvent: false,
    explicitClientRejection: true,
    upstreamOutcomeUnknown: false,
  }), { outcomeUnknown: false, failureIsDefinite: true });
});

test("prompt flow plans local turn promotion from the authoritative Queue projection", () => {
  assert.deepEqual(planAcknowledgedTurn({
    kind: "queued",
    acceptedTurnPresent: true,
    resultId: "q1",
    currentQueue: [],
  }), { promoteFromQueue: true, markDispatched: false });
  assert.deepEqual(planAcknowledgedTurn({
    kind: "queued",
    acceptedTurnPresent: true,
    resultId: "q1",
    currentQueue: [{ id: "q1", message: "queued", imageCount: 0, createdAt: 1 }],
  }), { promoteFromQueue: false, markDispatched: false });
  assert.deepEqual(planAcknowledgedTurn({
    kind: "ordinary",
    acceptedTurnPresent: true,
    resultId: undefined,
    currentQueue: undefined,
  }), { promoteFromQueue: false, markDispatched: true });
});

test("prompt flow classifies acknowledgement kinds in authority order", () => {
  assert.equal(promptAcknowledgementKind({ extension: true, queued: true }), "extension");
  assert.equal(promptAcknowledgementKind({ steered: true, queued: true }), "steer");
  assert.equal(promptAcknowledgementKind({ queued: true }), "queued");
  assert.equal(promptAcknowledgementKind({}), "ordinary");
});

test("prompt flow builds a pending Steer projection without owning Steer state", () => {
  const steer = pendingSteerFromAcknowledgement({
    steered: true,
    queueState: "waiting",
    queueId: "steer-1",
    message: "steer this",
    imageCount: 1,
    createdAt: 10,
  });
  assert.deepEqual(steer, {
    id: "steer-1",
    message: "steer this",
    imageCount: 1,
    createdAt: 10,
  });
  assert.equal(pendingSteerFromAcknowledgement({
    steered: true,
    queueState: "dispatched",
    queueId: "steer-1",
    message: "steer this",
    imageCount: 0,
    createdAt: 10,
  }), null);
});

test("prompt flow plans an acknowledgement queue snapshot without owning Queue authority", () => {
  const plan = planAcknowledgedQueueProjection({
    incoming: [{ id: "q1", message: "new", imageCount: 0, createdAt: 2 }],
    incomingPaused: false,
    currentRevision: 3,
    requestRevision: 2,
    current: { queue: [], paused: false },
    source: "view",
    resultQueued: true,
    resultId: "q1",
  });
  assert.deepEqual(plan, {
    accepted: true,
    queue: [{ id: "q1", message: "new", imageCount: 0, createdAt: 2 }],
    paused: false,
  });
  assert.equal(planAcknowledgedQueueProjection({
    incoming: [{ id: "q1", message: "new", imageCount: 0, createdAt: 2 }],
    incomingPaused: false,
    currentRevision: 3,
    requestRevision: 2,
    current: { queue: [{ id: "q1", message: "stronger", imageCount: 0, createdAt: 1 }], paused: false },
    source: "event",
    resultQueued: true,
    resultId: "q1",
  })?.accepted, false);
});

test("prompt flow sequences existing Session restore through explicit host ports", async () => {
  const events: string[] = [];
  const result = await prepareRestoringPrompt({
    sessionId: "session",
    authority: "authority",
    dispatchPreparing: () => events.push("prepare"),
    protectLocalTurn: () => events.push("protect"),
    warmRuntime: async () => {
      events.push("warm");
      return { ready: true };
    },
    isCurrent: () => true,
    applyWarmReadiness: () => {
      events.push("ready");
      return true;
    },
    commitPreparing: () => events.push("commit"),
  });
  assert.deepEqual(events, ["prepare", "protect", "warm", "ready", "commit"]);
  assert.equal(result.cancelled, false);
});

test("prompt flow stops restore continuation after a generation change", async () => {
  let current = false;
  const result = await prepareRestoringPrompt({
    sessionId: "session",
    authority: "authority",
    dispatchPreparing: () => {},
    protectLocalTurn: () => {},
    warmRuntime: async () => ({ ready: true }),
    isCurrent: () => current,
    applyWarmReadiness: () => { throw new Error("must not apply stale readiness"); },
    commitPreparing: () => { throw new Error("must not commit stale readiness"); },
  });
  assert.equal(result.cancelled, true);
});

test("prompt flow selects one preparation route without owning Runtime state", () => {
  assert.equal(promptPreparationRoute({ isDraft: true, runtimeStatus: "active", alreadyStreaming: false }), "draft");
  assert.equal(promptPreparationRoute({ isDraft: false, runtimeStatus: "restoring", alreadyStreaming: false }), "restore");
  assert.equal(promptPreparationRoute({ isDraft: false, runtimeStatus: "active", alreadyStreaming: true }), "active");
});

test("prompt flow builds the initial draft Session view without React state", () => {
  const view = initialDraftSessionView({
    sessionId: "session",
    session: { id: "session" },
    state: { isStreaming: false },
    gateMode: "strict",
    accepted: true,
    queued: false,
  } as never);
  assert.equal(view.session.id, "session");
  assert.equal(view.isStreaming, true);
  assert.equal(view.runtimeStatus, "active");
  assert.deepEqual(view.messages, []);
});

test("prompt flow migrates only newer draft intent after atomic creation", () => {
  const migration = draftIntentAfterSubmit({
    capturedSelection: { revision: 1, thinkingLevel: "high" },
    newestDraftSelection: { revision: 2, thinkingLevel: "low" },
    capturedGateMode: "strict",
    newestDraftGateMode: "open",
  });
  assert.equal(migration.selectionForTarget?.revision, 2);
  assert.equal(migration.gateModeForTarget, "open");
  assert.equal(migration.clearDraftSelection, true);
  assert.equal(migration.clearDraftGateMode, true);
});

test("prompt submit flow uses the combined New transaction when available", async () => {
  let fallbackCalled = false;
  const initial = {
    sessionId: "combined",
    session: { id: "combined" },
    state: {},
    gateMode: "strict" as const,
    accepted: true as const,
    queued: false as const,
  } as never;
  const result = await submitNewDraftPrompt(
    {
      submitNewSession: async () => initial,
      newSession: async () => { fallbackCalled = true; throw new Error("fallback"); },
      prompt: async () => { fallbackCalled = true; throw new Error("fallback"); },
      isCurrent: () => true,
    },
    { message: "hello", images: [] },
  );
  assert.equal(result, initial);
  assert.equal(fallbackCalled, false);
});

test("prompt submit flow preserves legacy New fallback identity and prompt settings", async () => {
  const result = await submitNewDraftPrompt(
    {
      newSession: async () => ({
        session: { id: "legacy" },
        state: { isStreaming: false },
        gateMode: "strict",
      } as never),
      prompt: async (_message, _images, sessionId, gateMode, settings, operationId) => {
        assert.equal(sessionId, "legacy");
        assert.equal(gateMode, "open");
        assert.deepEqual(settings, { thinkingLevel: "high" });
        assert.equal(operationId, "op-legacy");
        return { promptId: "server-prompt", deliveryUncertain: true };
      },
      isCurrent: () => true,
    },
    {
      message: "hello",
      images: [],
      gateMode: "open",
      thinkingLevel: "high",
      promptSettings: { thinkingLevel: "high" },
      clientPromptOperationId: "op-legacy",
    },
  );
  assert.equal(result.sessionId, "legacy");
  assert.equal(result.deliveryUncertain, true);
  assert.equal(result.promptId, "server-prompt");
});

test("prompt submit flow keeps uncertain delivery on a pending result", async () => {
  const controller = createPromptSubmitController({ promptCoordinator: new PromptCoordinator() });
  const flow = createPromptSubmitFlow({
    controller,
    isResultPending: () => true,
    isExplicitClientRejection: () => false,
  });
  await assert.rejects(
    () => flow.admit({
      admission: {
        promptId: "prompt-2",
        sessionId: "session-2",
        navigationEpoch: 1,
        delivery: "queue",
      },
      execute: async () => { throw new Error("pending"); },
      facts: {
        promptSubmitted: true,
        promptAcceptedByEvent: false,
        promptTerminalByEvent: false,
      },
    }),
    /pending/,
  );
});
