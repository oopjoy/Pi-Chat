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
