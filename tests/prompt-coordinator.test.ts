import assert from "node:assert/strict";
import test from "node:test";
import { PromptCoordinator } from "../src/web/application/prompt-coordinator";

const input = {
  promptId: "p1",
  sessionId: "aaaaaaaaaaaaaaaaaaaa",
  navigationEpoch: 3,
  runtimeGeneration: 8,
  delivery: "queue" as const,
  createdAt: 100,
};

test("PromptCoordinator admits a result without owning transport semantics", async () => {
  const coordinator = new PromptCoordinator();
  const result = await coordinator.admit(
    input,
    async (operation) => {
      assert.equal(operation.phase, "dispatching");
      return { queued: true };
    },
    { phaseForResult: () => ({ type: "queue" }) },
  );
  assert.deepEqual(result, { queued: true });
  assert.equal(coordinator.get("p1")?.phase, "queued");
});

test("PromptCoordinator binds Server identity and settles from explicit lifecycle facts", async () => {
  const coordinator = new PromptCoordinator();
  await coordinator.admit(input, async () => "ok");
  coordinator.bindServerPromptId("p1", "server-p1");
  assert.equal(coordinator.getByServerPromptId("server-p1")?.promptId, "p1");
  const settled = coordinator.observeServerLifecycle("server-p1", "agent_settled", 9);
  assert.equal(settled?.phase, "settled");
  assert.equal(settled?.serverPromptId, "server-p1");
  assert.equal(coordinator.observeServerLifecycle("server-p1", "agent_start"), settled);
});

test("PromptCoordinator fences an SSE lifecycle fact that beats HTTP identity binding", async () => {
  const coordinator = new PromptCoordinator();
  await coordinator.admit(input, async () => "ok");
  coordinator.observeServerLifecycle("server-race", "agent_settled", 9);
  coordinator.bindServerPromptId("p1", "server-race");
  assert.equal(coordinator.get("p1")?.phase, "settled");
});

test("PromptCoordinator preserves unknown delivery as uncertain", async () => {
  const coordinator = new PromptCoordinator();
  const failure = new Error("request timeout");
  await assert.rejects(
    coordinator.admit(input, async () => { throw failure; }, {
      phaseForError: () => ({ type: "uncertain" }),
    }),
    (error) => error === failure,
  );
  assert.equal(coordinator.get("p1")?.phase, "uncertain");
  assert.equal(coordinator.isCurrent("p1", {
    sessionId: input.sessionId,
    navigationEpoch: input.navigationEpoch,
    runtimeGeneration: input.runtimeGeneration,
  }), true);
});

test("PromptCoordinator removes terminal operations without touching live operations", async () => {
  const coordinator = new PromptCoordinator();
  await coordinator.admit({ ...input, promptId: "done" }, async () => "ok");
  coordinator.markSettled("done");
  await coordinator.admit({ ...input, promptId: "live" }, async () => "ok");
  coordinator.clearTerminal();
  assert.equal(coordinator.get("done"), undefined);
  assert.equal(coordinator.get("live")?.phase, "running");
});
