import assert from "node:assert/strict";
import test from "node:test";
import { drainPrimaryAfterSettlement } from "../../src/server/services/primary-settlement-drain";

test("primary settlement drain adopts the FIFO state before releasing dispatch", async () => {
  const calls: string[] = [];
  let running = true;
  let dispatching = true;
  await drainPrimaryAfterSettlement({
    readState: async () => ({ isStreaming: false }),
    closed: () => false,
    isCurrent: () => true,
    activePromptId: () => "prompt",
    traceSettled: () => calls.push("trace"),
    traceFailure: () => calls.push("trace-failure"),
    clearPrompt: () => calls.push("clear"),
    adoptState: (state) => { running = state.isStreaming; calls.push("adopt"); },
    isRunning: () => running,
    shouldResetSteering: () => false,
    resetSteering: async () => calls.push("reset"),
    releaseDispatch: () => { dispatching = false; calls.push("release"); },
    broadcastActivity: () => calls.push("activity"),
    dispatchNext: () => calls.push("dispatch"),
    markSettlementFailure: () => calls.push("failure"),
  }, "session", 7, "prompt");

  assert.equal(dispatching, false);
  assert.deepEqual(calls, ["trace", "clear", "adopt", "release", "activity", "dispatch"]);
});

test("primary settlement drain resets unconsumed steering before next dispatch", async () => {
  const calls: string[] = [];
  let running = false;
  await drainPrimaryAfterSettlement({
    readState: async () => ({ isStreaming: false }),
    closed: () => false,
    isCurrent: () => true,
    activePromptId: () => undefined,
    traceSettled: () => {},
    traceFailure: () => {},
    clearPrompt: () => {},
    adoptState: (state) => { running = state.isStreaming; },
    isRunning: () => running,
    shouldResetSteering: () => true,
    resetSteering: async () => calls.push("reset"),
    releaseDispatch: () => calls.push("release"),
    broadcastActivity: () => calls.push("activity"),
    dispatchNext: () => calls.push("dispatch"),
    markSettlementFailure: () => calls.push("failure"),
  }, "session", 7);
  assert.deepEqual(calls, ["reset", "release", "activity", "dispatch"]);
});

test("primary settlement failure stays inside the current generation", async () => {
  const calls: string[] = [];
  await drainPrimaryAfterSettlement({
    readState: async () => { throw new Error("timeout"); },
    closed: () => false,
    isCurrent: () => true,
    activePromptId: () => "prompt",
    traceSettled: () => {},
    traceFailure: () => calls.push("trace-failure"),
    clearPrompt: () => calls.push("clear"),
    adoptState: () => assert.fail("failed read cannot adopt state"),
    isRunning: () => false,
    shouldResetSteering: () => false,
    resetSteering: async () => {},
    releaseDispatch: () => calls.push("release"),
    broadcastActivity: () => assert.fail("App failure port owns broadcast"),
    dispatchNext: () => assert.fail("failed read cannot dispatch"),
    markSettlementFailure: (_, error) => {
      assert.match(String(error), /timeout/);
      calls.push("failure");
    },
  }, "session", 7, "prompt");
  assert.deepEqual(calls, ["trace-failure", "clear", "release", "failure"]);
});
