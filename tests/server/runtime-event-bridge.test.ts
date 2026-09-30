import assert from "node:assert/strict";
import test from "node:test";
import { forwardRuntimeEvent } from "../../src/server/services/runtime-event-bridge";

test("runtime event bridge filters cumulative/retry events and stamps trusted identity/timing", () => {
  const broadcasts: Record<string, unknown>[] = [];
  forwardRuntimeEvent({
    runEpoch: () => "epoch",
    traceRejected: () => {},
    eventRunTiming: () => ({ startedAt: 10, durationMs: 20, endedAt: 30 }),
    broadcast: (event) => broadcasts.push(event),
  }, { type: "agent_settled", piChatSessionId: "spoof", piChatRunEpoch: "spoof" }, "session", 4);
  assert.deepEqual(broadcasts[0], {
    type: "agent_settled",
    piChatSessionId: "session",
    piChatRunEpoch: "epoch",
    piChatRunGeneration: 4,
    piChatRunStartedAt: 10,
    piChatRunDurationMs: 20,
    piChatRunEndedAt: 30,
  });
  forwardRuntimeEvent({ runEpoch: () => "epoch", traceRejected: () => {}, eventRunTiming: () => ({}), broadcast: () => { throw new Error("filtered"); } }, { type: "tool_execution_update" }, "session");
});

test("runtime event bridge redacts process errors before broadcast", () => {
  let result: Record<string, unknown> | undefined;
  forwardRuntimeEvent({
    runEpoch: () => "epoch",
    traceRejected: () => {},
    eventRunTiming: () => ({}),
    broadcast: (event) => { result = event; },
  }, { type: "pi_chat_process_error", error: "OpenAI API error (401): sk-test-secret", errorCode: "MODEL_UNAVAILABLE" }, "session");
  assert.notEqual(result?.error, "OpenAI API error (401): sk-test-secret");
  assert.ok(result?.failure);
});
