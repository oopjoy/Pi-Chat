import assert from "node:assert/strict";
import test from "node:test";
import { drainSecondaryAfterSettlement } from "../../src/server/services/secondary-settlement-drain";

test("secondary settlement drain releases dispatch after FIFO state barrier", async () => {
  const calls: string[] = [];
  const runtime = {
    id: "s",
    rpc: { send: async () => ({ data: { isStreaming: false } }) },
    dispatching: true,
    running: true,
    promptQueue: [],
  } as never;
  await drainSecondaryAfterSettlement({
    closed: () => false,
    isCurrent: () => true,
    activePromptId: () => "p",
    traceSettled: () => calls.push("trace"),
    traceFailure: () => {},
    clearPrompt: () => calls.push("clear"),
    adoptState: (target, state) => { target.running = state.isStreaming; },
    shouldResetSteering: () => false,
    resetSteering: async () => {},
    broadcastActivity: () => calls.push("activity"),
    dispatchNext: () => calls.push("dispatch"),
    sweep: () => calls.push("sweep"),
    markSettlementFailure: () => {},
    timeoutMs: () => 1,
  }, runtime, 1, "p");
  assert.equal(runtime.dispatching, false);
  assert.deepEqual(calls, ["trace", "clear", "activity", "dispatch", "sweep"]);
});
