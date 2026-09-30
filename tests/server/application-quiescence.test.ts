import assert from "node:assert/strict";
import test from "node:test";
import { assertApplicationQuiescent, verifyApplicationQuiescent } from "../../src/server/services/application-quiescence";

function ports(overrides: Record<string, unknown> = {}) {
  return {
    busyConversationCount: () => 0,
    transitioningCount: () => 0,
    activeMutationRequests: () => 0,
    primaryReadReady: () => false,
    primaryState: async () => ({ data: { isStreaming: false } }),
    secondaryStates: async () => [],
    ...overrides,
  };
}

test("application quiescence accepts an idle fleet and rejects busy counters", async () => {
  assert.doesNotThrow(() => assertApplicationQuiescent(ports(), "重启"));
  await verifyApplicationQuiescent(ports(), "重启");
  assert.throws(() => assertApplicationQuiescent(ports({ busyConversationCount: () => 1 }), "重启"), /仍有/);
});

test("application quiescence checks Primary and Secondary Runtime states", async () => {
  await assert.rejects(
    () => verifyApplicationQuiescent(ports({ primaryReadReady: () => true, primaryState: async () => ({ data: { isStreaming: true } }) }), "重启"),
    /仍有对话正在执行/,
  );
  await assert.rejects(
    () => verifyApplicationQuiescent(ports({ secondaryStates: async () => [{ data: { isStreaming: true } }] }), "重启"),
    /仍有对话正在执行/,
  );
});
