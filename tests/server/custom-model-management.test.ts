import assert from "node:assert/strict";
import test from "node:test";
import { createCustomModelManagement } from "../../src/server/services/custom-model-management";

test("custom model management keeps file transaction and bootstrap behind ports", async () => {
  const calls: string[] = [];
  const service = createCustomModelManagement({
    manager: {
      getCustomConfig: async () => ({ provider: "p", id: "m" }),
      add: async () => { calls.push("add"); return { provider: "p", id: "m" }; },
      update: async () => { calls.push("update"); return { provider: "p2", id: "m2" }; },
      remove: async () => { calls.push("remove"); },
    } as never,
    withLifecycle: async (_description, mutation) => mutation(),
    withModelFileTransaction: async (mutation) => mutation(),
    primaryState: async () => ({ model: { provider: "p", id: "m" } } as never),
    primaryTurnActive: () => false,
    setPrimaryModel: async () => { calls.push("reselect"); },
    bootstrap: async () => { calls.push("bootstrap"); return { ok: true }; },
  });
  await service.add({});
  await service.update("p", "m", {});
  assert.deepEqual(calls, ["add", "bootstrap", "update", "reselect", "bootstrap"]);
});

test("deleting the model a conversation still selects is a plain file edit", async () => {
  const calls: string[] = [];
  const service = createCustomModelManagement({
    manager: {
      getCustomConfig: async () => ({ provider: "p", id: "m" }),
      add: async () => ({ provider: "p", id: "m" }),
      update: async () => ({ provider: "p", id: "m" }),
      remove: async () => { calls.push("remove"); },
    } as never,
    withLifecycle: async (_description, mutation) => mutation(),
    withModelFileTransaction: async (mutation) => mutation(),
    // The send path owns the "当前模型不存在" report, not this delete.
    primaryState: async () => ({ model: { provider: "p", id: "m" } } as never),
    primaryTurnActive: () => false,
    setPrimaryModel: async () => { calls.push("reselect"); },
    bootstrap: async () => { calls.push("bootstrap"); return { ok: true }; },
  });

  await service.remove("p", "m");
  assert.deepEqual(calls, ["remove", "bootstrap"]);
});
