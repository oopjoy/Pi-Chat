import assert from "node:assert/strict";
import test from "node:test";
import { promptPhaseForError, promptPhaseForResult } from "../../src/web/application/prompt-submit-controller";

test("prompt submit controller maps successful admissions to stable phases", () => {
  assert.deepEqual(promptPhaseForResult({ deliveryUncertain: true, queued: true }), { type: "uncertain" });
  assert.deepEqual(promptPhaseForResult({ queued: true }), { type: "queue" });
  assert.deepEqual(promptPhaseForResult({}), { type: "run" });
});

test("prompt submit controller preserves uncertain delivery when acknowledgement facts are incomplete", () => {
  const phase = promptPhaseForError({
    error: new Error("timeout"),
    promptSubmitted: true,
    promptAcceptedByEvent: false,
    promptTerminalByEvent: false,
    isResultPending: () => false,
    isExplicitClientRejection: () => false,
  });
  assert.deepEqual(phase, { type: "uncertain" });
});

test("prompt submit controller allows definite client rejection to fail", () => {
  const phase = promptPhaseForError({
    error: new Error("bad request"),
    promptSubmitted: true,
    promptAcceptedByEvent: false,
    promptTerminalByEvent: false,
    isResultPending: () => false,
    isExplicitClientRejection: () => true,
  });
  assert.deepEqual(phase, { type: "fail" });
});
