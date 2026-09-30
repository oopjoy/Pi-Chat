import assert from "node:assert/strict";
import test from "node:test";
import { finalizeAcceptedRuntimeEvent } from "../../src/server/services/runtime-event-lifecycle";
import type {
  RuntimeEventLifecyclePorts,
} from "../../src/server/services/runtime-event-lifecycle";
import type { RuntimeEventTransition } from "../../src/server/runtime-event-transition";

function transition(
  broadcastEvent: Record<string, unknown> | null,
  effects: RuntimeEventTransition["effects"] = [],
): RuntimeEventTransition {
  return {
    state: {
      runGeneration: 9,
      running: false,
      dispatching: false,
      failed: false,
      queuePaused: false,
      queueLength: 0,
      toolStatus: "",
      pendingTerminalMessages: [],
    },
    broadcastEvent,
    effects,
  };
}

function portsFor(
  result: RuntimeEventTransition,
  calls: string[],
  delivered: Record<string, unknown>[],
): RuntimeEventLifecyclePorts {
  return {
    transition: () => result,
    beginRunTiming: () => calls.push("begin"),
    finishRunTiming: () => calls.push("finish"),
    traceRejected: () => calls.push("reject"),
    activePromptId: () => "prompt-id",
    broadcastPromptFailure: () => calls.push("failure"),
    touch: () => calls.push("touch"),
    tracePrompt: (phase) => { calls.push(`trace:${phase}`); return "prompt-id"; },
    clearPrompt: () => calls.push("clear"),
    broadcastRpc: (event) => { calls.push("broadcast"); delivered.push(event); },
    broadcastSessionCreated: () => calls.push("created"),
    scheduleModelRuntimeSync: () => calls.push("sync"),
    afterSettled: () => calls.push("after-settled"),
    hasNativeSteeringPending: () => true,
    noteNativeSteeringReset: () => calls.push("note-reset"),
    isDispatching: () => false,
    beginSettlementDispatch: () => calls.push("begin-dispatch"),
    broadcastActivity: () => calls.push("activity"),
    drainAfterSettlement: () => calls.push("drain"),
    releaseAfterProcessFailure: () => calls.push("release-crash"),
  };
}

test("accepted settlement keeps diagnostic, transport, and FIFO barrier order", () => {
  const calls: string[] = [];
  const delivered: Record<string, unknown>[] = [];
  finalizeAcceptedRuntimeEvent(
    portsFor(transition({ type: "agent_settled" }, [
      { type: "session-created" },
      { type: "settled" },
    ]), calls, delivered),
    { eventType: "agent_settled", consumedNativeSteering: "steer-id" },
  );

  assert.deepEqual(calls, [
    "finish",
    "failure",
    "touch",
    "broadcast",
    "created",
    "sync",
    "trace:settled",
    "after-settled",
    "note-reset",
    "begin-dispatch",
    "activity",
    "drain",
  ]);
  assert.deepEqual(delivered, [{
    type: "agent_settled",
    piChatPromptId: "prompt-id",
    nativeSteeringConsumed: true,
    nativeSteeringId: "steer-id",
  }]);
});

test("malformed terminal events are diagnosed after timing without side effects", () => {
  const calls: string[] = [];
  const delivered: Record<string, unknown>[] = [];
  finalizeAcceptedRuntimeEvent(
    portsFor(transition(null), calls, delivered),
    { eventType: "pi_chat_process_error" },
  );
  assert.deepEqual(calls, ["finish", "reject"]);
  assert.deepEqual(delivered, []);
});

test("process failure releases the owner queue only after its visible frame", () => {
  const calls: string[] = [];
  const delivered: Record<string, unknown>[] = [];
  finalizeAcceptedRuntimeEvent(
    portsFor(transition({ type: "pi_chat_process_error" }), calls, delivered),
    { eventType: "pi_chat_process_error", droppedNativeSteering: 2 },
  );
  assert.deepEqual(calls, [
    "finish",
    "failure",
    "touch",
    "trace:process-failed",
    "clear",
    "broadcast",
    "release-crash",
  ]);
  assert.deepEqual(delivered[0], {
    type: "pi_chat_process_error",
    piChatPromptId: "prompt-id",
    nativeSteeringDroppedCount: 2,
  });
});
