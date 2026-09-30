import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveActiveSessionChangedEffect,
  deriveApplicationLifecycleEffect,
  deriveExtensionRequestResolvedEffect,
  deriveFastModeChangedEffect,
  deriveGateModeChangedEffect,
  derivePromptDeliveryUncertainEffect,
  deriveQueueDispatchEffect,
  deriveQueueErrorEffect,
  deriveQueueSnapshotEffect,
  deriveSessionControlChangedEffect,
  deriveSessionMutationEffect,
  deriveWorkspaceChangedEffect,
  planQueueErrorTurns,
} from "../../src/web/application/stream-event-effects";

test("active-session lifecycle effect keeps the complete active set and view-only transition", () => {
  assert.deepEqual(
    deriveActiveSessionChangedEffect(
      { activeSessionIds: ["a", "b"], sessionId: "a" },
      "a",
    ),
    {
      activeSessionIds: ["a", "b"],
      sessionId: "a",
      viewedSessionBecameViewOnly: false,
    },
  );
  assert.deepEqual(
    deriveActiveSessionChangedEffect(
      { activeSessionIds: [], sessionId: "a" },
      "a",
    ),
    {
      activeSessionIds: [],
      sessionId: "a",
      viewedSessionBecameViewOnly: true,
    },
  );
});

test("active-session lifecycle effect ignores malformed session IDs", () => {
  assert.deepEqual(
    deriveActiveSessionChangedEffect({ activeSessionIds: ["a"], sessionId: 42 }, "a"),
    {
      activeSessionIds: ["a"],
      sessionId: "",
      viewedSessionBecameViewOnly: false,
    },
  );
});

test("gate, extension and uncertain Prompt effects keep their input contract", () => {
  assert.deepEqual(deriveGateModeChangedEffect({ mode: "strict" }), { mode: "strict" });
  assert.equal(deriveGateModeChangedEffect({ mode: "invalid" }), null);
  assert.deepEqual(deriveExtensionRequestResolvedEffect({ id: "request" }), { requestId: "request" });
  assert.equal(deriveExtensionRequestResolvedEffect({ id: 4 }), null);
  assert.equal(derivePromptDeliveryUncertainEffect().notice.includes("请勿重复发送"), true);
});

test("workspace and structural Session effects keep metadata distinct from authority", () => {
  assert.deepEqual(deriveWorkspaceChangedEffect({ cwd: "C:/work" }, "epoch", 2), {
    cwd: "C:/work", workspaceEpoch: "epoch", workspaceRevision: 2,
  });
  assert.equal(deriveWorkspaceChangedEffect({}, "epoch", 2), null);
  assert.deepEqual(deriveSessionMutationEffect({ action: "deleted", sessionId: "s" }), {
    action: "deleted", sessionId: "s", structural: true,
  });
  assert.equal(deriveSessionMutationEffect({ action: "created", sessionId: "s" }).structural, false);
});

test("queue error turn plan identifies retrying and rendered turns without mutating them", () => {
  const message = { role: "user", content: "failed" } as const;
  const plan = planQueueErrorTurns([
    {
      sessionId: "s",
      message,
      queueId: "failed",
      queueState: "dispatched",
      expectedTurnTotal: 1,
      renderedInTranscript: true,
    },
    {
      sessionId: "s",
      message: { role: "user", content: "waiting" },
      queueId: "waiting",
      queueState: "waiting",
      expectedTurnTotal: 2,
    },
  ], new Set(["failed", "waiting"]), "failed");
  assert.deepEqual(plan.affectedQueueIds, ["failed", "waiting"]);
  assert.deepEqual(plan.failedRenderedMessages, [message]);
});

test("session control and fast mode effects normalize closed fields", () => {
  assert.deepEqual(deriveSessionControlChangedEffect({ sessionId: "s", controlledByThisWindow: true }), {
    sessionId: "s",
    controlledByThisWindow: true,
  });
  assert.deepEqual(deriveFastModeChangedEffect({ active: 1 }), { active: false });
});

test("queue dispatch effect normalizes identity and payload fields", () => {
  assert.deepEqual(deriveQueueDispatchEffect({
    id: "q1",
    message: "run",
    piChatClientPromptOperationId: "op1",
    imageCount: 2,
    settings: { model: "model" },
  }), {
    id: "q1",
    message: "run",
    clientPromptOperationId: "op1",
    imageCount: 2,
    settings: { model: "model" },
  });
  assert.equal(deriveQueueDispatchEffect({}).id, "");
});

test("queue error effect keeps a safe fallback snapshot", () => {
  assert.deepEqual(deriveQueueErrorEffect({ id: "q1", paused: true }, {
    queue: [{ id: "fallback" }],
    paused: false,
  }), {
    queue: [{ id: "fallback" }],
    paused: true,
    failedId: "q1",
  });
});

test("queue snapshot effect validates the complete Queue payload", () => {
  assert.deepEqual(deriveQueueSnapshotEffect({
    queue: [{ id: "q1" }],
    paused: true,
    admittedId: "q1",
  }), {
    queue: [{ id: "q1" }],
    paused: true,
    admittedId: "q1",
  });
  assert.equal(deriveQueueSnapshotEffect({ queue: "malformed" }), null);
});

test("application lifecycle effect derives notice and recovery policy", () => {
  assert.deepEqual(deriveApplicationLifecycleEffect("resources-reloading"), {
    lifecycle: "resources-reloading",
    notice: "正在更新配置并重载 Runtime…",
    cancelsNavigation: true,
    startsIdleRecovery: false,
  });
  assert.deepEqual(deriveApplicationLifecycleEffect("idle"), {
    lifecycle: "idle",
    cancelsNavigation: false,
    startsIdleRecovery: true,
  });
  assert.equal(deriveApplicationLifecycleEffect("unknown"), null);
});
