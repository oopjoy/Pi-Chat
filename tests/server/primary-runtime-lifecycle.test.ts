import assert from "node:assert/strict";
import test from "node:test";
import {
  reloadPrimaryResources,
  restartPrimaryRuntime,
} from "../../src/server/services/primary-runtime-lifecycle";

test("primary lifecycle restart uses readiness recovery and preserves the Gate port", async () => {
  const calls: string[] = [];
  const rpc = { setDiagnosticSessionId: () => calls.push("diagnostic"), send: async () => ({}) } as never;
  await restartPrimaryRuntime({
    closed: () => false,
    primaryRuntime: {} as never,
    isConcreteReadinessController: () => true,
    rpc,
    primaryRuntimeCwd: () => "C:\\work",
    activeSessionId: () => "session",
    currentGateMode: () => "strict",
    recoverPrimary: async () => { calls.push("recover"); },
    legacyRestart: async () => { calls.push("legacy"); },
    lateRpcOutcomeHandler: () => () => {},
    markRpcOutcomePending: () => {},
    isOutcomeUnknown: () => false,
    fencePrimaryOperation: () => { calls.push("fence"); },
    setPrimaryGateMode: (mode) => calls.push(`gate:${mode}`),
  }, "C:\\session.jsonl");
  assert.deepEqual(calls, ["diagnostic", "recover"]);
});

test("primary lifecycle resource reload drains Secondary then restarts Primary", async () => {
  const calls: string[] = [];
  await reloadPrimaryResources({
    getPrimaryState: async () => ({ sessionFile: "C:\\session.jsonl", isStreaming: false } as never),
    stopSecondaryRuntimes: async () => { calls.push("stop-secondary"); },
    restartPrimary: async () => { calls.push("restart-primary"); },
    rethrowResultPending: (error) => { throw error; },
    broadcastReloaded: () => { calls.push("broadcast"); },
  });
  assert.deepEqual(calls, ["stop-secondary", "restart-primary", "broadcast"]);
});

test("primary lifecycle restart rejects cwd rebinding before touching the RPC", async () => {
  await assert.rejects(
    () => restartPrimaryRuntime({
      closed: () => false,
      rpc: { restart: async () => { throw new Error("must not restart"); } } as never,
      primaryRuntimeCwd: () => "C:\\work",
      activeSessionId: () => "session",
      currentGateMode: () => "strict",
      recoverPrimary: async () => {},
      legacyRestart: async () => {},
      lateRpcOutcomeHandler: () => () => {},
      markRpcOutcomePending: () => {},
      isOutcomeUnknown: () => false,
      fencePrimaryOperation: () => {},
      setPrimaryGateMode: () => {},
    }, undefined, "C:\\other"),
    /重绑定/,
  );
});
