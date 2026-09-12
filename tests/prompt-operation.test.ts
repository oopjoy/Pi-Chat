import assert from "node:assert/strict";
import test from "node:test";
import {
  createPromptOperation,
  isPromptOperationTerminal,
  promptOperationIsCurrent,
  PROMPT_AUTHORITY_CONTRACT,
  transitionPromptOperation,
} from "../src/web/application/prompt-operation";

function operation(delivery: "normal" | "queue" | "steer" = "normal") {
  return createPromptOperation({
    promptId: "p1",
    sessionId: "aaaaaaaaaaaaaaaaaaaa",
    navigationEpoch: 4,
    runEpoch: "epoch-a",
    runtimeGeneration: 9,
    delivery,
    createdAt: 100,
  });
}

test("Prompt operation model keeps server facts separate from browser projection", () => {
  assert.equal(PROMPT_AUTHORITY_CONTRACT.accepted, "pi-runtime-or-server-response-and-event");
  assert.equal(PROMPT_AUTHORITY_CONTRACT.optimisticTurn, "browser-prompt-projection");
  assert.equal(PROMPT_AUTHORITY_CONTRACT.transcript, "pi-jsonl");
  assert.equal(operation("steer").phase, "created");
});

test("Prompt operation models normal, queued, and uncertain delivery paths", () => {
  let current = operation("queue");
  current = transitionPromptOperation(current, { type: "admit" })!;
  current = transitionPromptOperation(current, { type: "queue" })!;
  current = transitionPromptOperation(current, { type: "dispatch" })!;
  current = transitionPromptOperation(current, { type: "uncertain" })!;
  assert.equal(current.phase, "uncertain");
  assert.equal(isPromptOperationTerminal(current), false);

  current = transitionPromptOperation(current, { type: "run", runtimeGeneration: 10 })!;
  current = transitionPromptOperation(current, { type: "settle" })!;
  assert.equal(current.observedRuntimeGeneration, 10);
  assert.equal(current.phase, "settled");
  assert.equal(isPromptOperationTerminal(current), true);
});

test("Prompt operation rejects illegal phase regressions", () => {
  let current = transitionPromptOperation(operation(), { type: "admit" })!;
  current = transitionPromptOperation(current, { type: "run" })!;
  assert.equal(transitionPromptOperation(current, { type: "queue" }), undefined);
  assert.equal(transitionPromptOperation(current, { type: "admit" }), undefined);
  assert.equal(transitionPromptOperation(current, { type: "settle" })?.phase, "settled");
});

test("Prompt operation fencing requires Session and navigation identity", () => {
  const current = transitionPromptOperation(operation(), { type: "admit" })!;
  assert.equal(promptOperationIsCurrent(current, {
    sessionId: current.sessionId,
    navigationEpoch: current.navigationEpoch,
    runtimeGeneration: current.admissionRuntimeGeneration,
  }), true);
  assert.equal(promptOperationIsCurrent(current, {
    sessionId: "bbbbbbbbbbbbbbbbbbbb",
    navigationEpoch: current.navigationEpoch,
    runtimeGeneration: current.admissionRuntimeGeneration,
  }), false);
  assert.equal(promptOperationIsCurrent(current, {
    sessionId: current.sessionId,
    navigationEpoch: current.navigationEpoch + 1,
    runtimeGeneration: current.admissionRuntimeGeneration,
  }), false);
  assert.equal(promptOperationIsCurrent(current, {
    sessionId: current.sessionId,
    navigationEpoch: current.navigationEpoch,
    runtimeGeneration: (current.admissionRuntimeGeneration || 0) + 1,
  }), false);
  assert.equal(promptOperationIsCurrent(current, {
    sessionId: current.sessionId,
    navigationEpoch: current.navigationEpoch,
    runEpoch: "epoch-b",
    runtimeGeneration: current.admissionRuntimeGeneration,
  }), false);
  assert.equal(promptOperationIsCurrent(
    transitionPromptOperation(current, { type: "fail" })!,
    current,
  ), false);
});
