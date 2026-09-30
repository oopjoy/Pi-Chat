import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeSettingsService } from "../../src/server/services/runtime-settings";

test("runtime settings service keeps Model mutation behind Runtime ports", async () => {
  const calls: string[] = [];
  const model = { provider: "p", id: "m", name: "Model" };
  const service = createRuntimeSettingsService({
    activeSessionId: () => "primary",
    primaryRpc: () => ({ send: async () => ({ data: model }) } as never),
    primaryRunning: () => false,
    secondaryRuntime: () => null,
    ensurePrimaryRuntime: async () => {},
    recoverSecondary: async () => {},
    withSecondaryOperation: async (_runtime, operation) => operation(),
    acquirePrimaryOperation: () => () => calls.push("release"),
    mutationOutcomePending: () => false,
    availableModels: async () => [model],
    lateRpcOutcomeHandler: () => () => {},
    markRpcOutcomePending: () => {},
    rethrowResultPending: (error) => { throw error; },
    rememberRuntimeModel: () => {},
    rememberPrimaryModel: () => { calls.push("remember-model"); },
    rememberRuntimeThinking: () => {},
    rememberPrimaryThinking: () => {},
    updateRuntimeState: () => {},
    updatePrimaryState: () => {},
  });
  const result = await service.setModel("primary", "p", "m");
  assert.deepEqual(result, { model, pending: false });
  assert.deepEqual(calls, ["remember-model", "release"]);
});
