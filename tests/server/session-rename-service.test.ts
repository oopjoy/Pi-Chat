import assert from "node:assert/strict";
import test from "node:test";
import { renameSession } from "../../src/server/services/session-rename-service";

test("session rename service keeps Runtime operation and outcome ports explicit", async () => {
  const calls: string[] = [];
  const runtime = {
    rpc: { send: async () => { calls.push("send"); } },
    running: false,
    draftSession: undefined,
  } as never;
  const result = await renameSession({
    sessionMutationOutcomePending: () => false,
    activeSessionId: () => "primary",
    knownRuntime: () => undefined,
    ensureRuntime: async () => runtime,
    primaryRpc: () => runtime.rpc,
    acquireRuntimeOperation: () => { calls.push("acquire"); return () => calls.push("release"); },
    acquirePrimaryOperation: () => () => {},
    lateRpcOutcomeHandler: () => () => {},
    markRpcOutcomePending: () => {},
    rethrowResultPending: (error) => { throw error; },
    clearNativeSteeringState: () => calls.push("clear-steering"),
    reclaimRuntime: async () => { calls.push("reclaim"); },
    updateRuntimeName: (_id, name) => calls.push(`name:${name}`),
    broadcastRenamed: (id) => calls.push(`broadcast:${id}`),
  }, "session", "Renamed");
  assert.deepEqual(result, { id: "session", name: "Renamed" });
  assert.deepEqual(calls, ["acquire", "send", "release", "clear-steering", "reclaim", "name:Renamed", "broadcast:session"]);
});
