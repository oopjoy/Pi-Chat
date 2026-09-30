import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProtectedLocalTurn,
  capturePromptSelection,
} from "../../src/web/application/prompt-submit-flow";

test("protected local turn is only built for the currently viewed ordinary Session", () => {
  const message = { role: "user", content: "hello" } as const;
  const input = {
    turn: message,
    targetSessionId: "session-a",
    viewedSessionId: "session-a",
    protectedLocalTurn: null,
    pendingTurns: [],
    promptOperationId: "op-a",
    messages: [],
    turnTotal: 0,
    willQueueLocally: false,
    steering: false,
    message: "hello",
    images: [],
    baselineTurnTotal: 0,
  };
  const result = buildProtectedLocalTurn(input);
  assert.equal(result?.sessionId, "session-a");
  assert.equal(result?.promptOperationId, "op-a");
  assert.equal(result?.queueState, undefined);
  assert.equal(buildProtectedLocalTurn({ ...input, viewedSessionId: "child" }), null);
  assert.equal(buildProtectedLocalTurn({ ...input, protectedLocalTurn: result! }), null);
});

test("prompt flow captures staged Model/Thinking/Gate intent without browser revisions", () => {
  const captured = capturePromptSelection({
    stagedSelection: {
      revision: 7,
      model: { id: "model", name: "Model", provider: "provider", reasoning: true },
      thinkingLevel: "high",
    },
    models: [{ id: "model", name: "Model", provider: "provider", reasoning: true }],
    isDraft: true,
    draftGateMode: "open",
  });
  assert.equal(captured.selection?.revision, 7);
  assert.deepEqual(captured.promptSettings, {
    model: { provider: "provider", modelId: "model" },
    thinkingLevel: "high",
  });
  assert.equal(captured.draftGateMode, "open");
  assert.equal((captured.promptSettings as unknown as { revision?: number }).revision, undefined);
});

test("protected local turn keeps Steer hidden until Pi consumes it", () => {
  const result = buildProtectedLocalTurn({
    turn: { role: "user", content: "steer" },
    targetSessionId: "session-a",
    viewedSessionId: "session-a",
    protectedLocalTurn: null,
    pendingTurns: [],
    promptOperationId: "op-a",
    messages: [],
    turnTotal: 0,
    willQueueLocally: true,
    steering: true,
    message: "steer",
    images: [],
    baselineTurnTotal: 0,
  });
  assert.equal(result?.queueState, "waiting");
  assert.equal(result?.revealOnMessageStart, true);
  assert.match(result?.queueId || "", /^[a-f0-9-]{36}$/);
});
