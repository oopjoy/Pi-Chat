import assert from "node:assert/strict";
import test from "node:test";
import { abortRuntime } from "../../src/server/services/runtime-abort";

function ports(calls: string[], overrides: Partial<Parameters<typeof abortRuntime>[0]> = {}) {
  let running = true;
  return {
    pauseQueueForAbort: () => calls.push("pause"),
    queuePaused: () => true,
    unavailable: () => false,
    unavailableResult: () => ({ ok: true as const, isStreaming: false, queuePaused: true }),
    steeringGeneration: () => 7,
    hasNativeSteeringPending: () => false,
    armNativeSteeringReset: () => calls.push("arm"),
    sendAbort: async () => { calls.push("abort"); },
    abortOutcomeUnknown: () => false,
    running: () => running,
    broadcastUncertainAbort: () => calls.push("uncertain"),
    broadcastBeforeStateProbe: () => calls.push("before-probe"),
    readState: async () => { calls.push("read"); return { isStreaming: false }; },
    setRunning: (value: boolean) => { running = value; calls.push(`running:${value}`); },
    resetNativeSteering: async () => calls.push("reset"),
    broadcastStoppedAbort: () => calls.push("stopped"),
    ...overrides,
  };
}

test("abort runtime confirms abort with a bounded state probe before stopped projection", async () => {
  const calls: string[] = [];
  const result = await abortRuntime(ports(calls));
  assert.deepEqual(result, { ok: true, isStreaming: false, queuePaused: true });
  assert.deepEqual(calls, ["pause", "abort", "before-probe", "read", "running:false", "stopped"]);
});

test("abort timeout retains event-owned running state and reports pending", async () => {
  const calls: string[] = [];
  const result = await abortRuntime(ports(calls, {
    sendAbort: async () => { calls.push("abort"); throw new Error("timeout"); },
    abortOutcomeUnknown: () => true,
  }));
  assert.deepEqual(result, { ok: true, abortPending: true, isStreaming: true, queuePaused: true });
  assert.deepEqual(calls, ["pause", "abort", "uncertain"]);
});

test("abort reset clears a still-pending native Steer before final projection", async () => {
  const calls: string[] = [];
  let pendingChecks = 0;
  const result = await abortRuntime(ports(calls, {
    hasNativeSteeringPending: () => ++pendingChecks <= 2,
  }));
  assert.deepEqual(result, { ok: true, isStreaming: false, queuePaused: true });
  assert.deepEqual(calls, [
    "pause",
    "arm",
    "abort",
    "before-probe",
    "read",
    "running:false",
    "reset",
    "running:false",
    "stopped",
  ]);
});

test("unavailable runtime keeps owner-specific no-RPC result", async () => {
  const calls: string[] = [];
  const result = await abortRuntime(ports(calls, { unavailable: () => true }));
  assert.deepEqual(result, { ok: true, isStreaming: false, queuePaused: true });
  assert.deepEqual(calls, ["pause"]);
});
