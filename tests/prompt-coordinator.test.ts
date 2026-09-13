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
  const settled = coordinator.observeServerLifecycle("server-p1", "agent_settled", 8);
  assert.equal(settled?.phase, "settled");
  assert.equal(settled?.serverPromptId, "server-p1");
  assert.equal(coordinator.observeServerLifecycle("server-p1", "agent_start"), settled);
});

test("PromptCoordinator adopts a combined draft admission and replays earlier Server facts", () => {
  const coordinator = new PromptCoordinator();
  coordinator.observeServerLifecycle(
    "server-draft",
    "agent_start",
    0,
    input.sessionId,
    "epoch-a",
  );
  coordinator.observeRetry(
    "server-draft",
    "scheduled",
    0,
    input.sessionId,
    "epoch-a",
    1,
    3,
  );
  coordinator.adoptAccepted(
    {
      ...input,
      promptId: "draft-operation",
      runEpoch: "epoch-a",
      runtimeGeneration: 0,
    },
    { type: "uncertain" },
  );
  const bound = coordinator.bindServerPromptId("draft-operation", "server-draft");
  assert.equal(bound.phase, "running");
  assert.equal(bound.serverPromptId, "server-draft");
  assert.deepEqual(bound.retry, {
    phase: "scheduled",
    attempt: 1,
    maxAttempts: 3,
  });
});

test("PromptCoordinator fences an SSE lifecycle fact that beats HTTP identity binding", async () => {
  const coordinator = new PromptCoordinator();
  await coordinator.admit(input, async () => "ok");
  coordinator.observeServerLifecycle("server-race", "agent_settled", 8);
  coordinator.bindServerPromptId("p1", "server-race");
  assert.equal(coordinator.get("p1")?.phase, "settled");
});

test("PromptCoordinator refuses a lifecycle fact attributed to another Session", async () => {
  const coordinator = new PromptCoordinator();
  await coordinator.admit(input, async () => "ok");
  coordinator.bindServerPromptId("p1", "server-session-a");
  const ignored = coordinator.observeServerLifecycle(
    "server-session-a",
    "agent_settled",
    9,
    "bbbbbbbbbbbbbbbbbbbb",
  );
  assert.equal(ignored?.phase, "running");
  const settled = coordinator.observeServerLifecycle(
    "server-session-a",
    "agent_settled",
    8,
    input.sessionId,
  );
  assert.equal(settled?.phase, "settled");
});

test("PromptCoordinator fences lifecycle facts by run epoch and active generation", async () => {
  const coordinator = new PromptCoordinator();
  await coordinator.admit({ ...input, promptId: "epoch", runEpoch: "epoch-a" }, async () => "ok");
  coordinator.bindServerPromptId("epoch", "server-epoch");
  assert.equal(
    coordinator.observeServerLifecycle("server-epoch", "agent_settled", 8, input.sessionId, "epoch-b")?.phase,
    "running",
  );
  assert.equal(
    coordinator.observeServerLifecycle("server-epoch", "agent_start", 9, input.sessionId, "epoch-a")?.phase,
    "running",
  );
  assert.equal(
    coordinator.observeServerLifecycle("server-epoch", "agent_settled", 8, input.sessionId, "epoch-a")?.phase,
    "running",
  );
  assert.equal(
    coordinator.observeServerLifecycle("server-epoch", "agent_settled", 9, input.sessionId, "epoch-a")?.phase,
    "settled",
  );
});

test("PromptCoordinator retires a settled Server identity against duplicate late SSE", async () => {
  const coordinator = new PromptCoordinator();
  await coordinator.admit(input, async () => "ok");
  coordinator.bindServerPromptId("p1", "server-retired");
  coordinator.markSettled("p1");
  coordinator.clearTerminal();
  assert.equal(coordinator.observeServerLifecycle("server-retired", "agent_start", 8, input.sessionId), undefined);
  await coordinator.admit({ ...input, promptId: "replacement" }, async () => ({ queued: true }), {
    phaseForResult: () => ({ type: "queue" }),
  });
  coordinator.bindServerPromptId("replacement", "server-retired");
  assert.equal(coordinator.get("replacement")?.phase, "queued");
});

test("PromptCoordinator projects retry metadata without changing Prompt phase", async () => {
  const coordinator = new PromptCoordinator();
  await coordinator.admit(input, async () => "ok");
  coordinator.bindServerPromptId("p1", "server-retry");
  assert.equal(
    coordinator.observeRetry("server-retry", "scheduled", 9, input.sessionId)?.phase,
    "running",
  );
  assert.equal(coordinator.get("p1")?.retry?.phase, "scheduled");
  assert.equal(
    coordinator.observeRetry("server-retry", "running", 9, input.sessionId, undefined, 2, 3)?.retry?.phase,
    "running",
  );
  assert.equal(
    coordinator.observeRetry("server-retry", "running", 9, "other-session")?.retry?.phase,
    "running",
  );
  assert.equal(
    coordinator.observeRetry("server-retry", "scheduled", 8, input.sessionId)?.retry?.phase,
    "running",
  );
  assert.equal(
    coordinator.observeRetry("server-retry", "exhausted", 9, input.sessionId, undefined, 3)?.phase,
    "running",
  );
  assert.equal(coordinator.get("p1")?.retry?.phase, "exhausted");
  assert.equal(
    coordinator.observeRetry("server-retry", "scheduled", 9, input.sessionId)?.retry?.phase,
    "exhausted",
  );
  assert.equal(
    coordinator.observeRetry("server-retry", "running", 9, input.sessionId)?.retry?.phase,
    "exhausted",
  );
  assert.equal(
    coordinator.observeRetry("server-retry", "exhausted", 9, input.sessionId, undefined, 2)?.retry?.attempt,
    3,
  );
  coordinator.markSettled("p1");
  assert.equal(
    coordinator.observeRetry("server-retry", "scheduled", 9, input.sessionId)?.retry?.phase,
    "exhausted",
  );
});

test("PromptCoordinator replays a retry fact that beats HTTP identity binding", async () => {
  const coordinator = new PromptCoordinator();
  coordinator.observeRetry("server-retry-race", "scheduled", 9, input.sessionId, undefined, 1, 3, 25);
  await coordinator.admit(input, async () => "ok");
  coordinator.bindServerPromptId("p1", "server-retry-race");
  assert.deepEqual(coordinator.get("p1")?.retry, {
    phase: "scheduled",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 25,
  });
});

test("PromptCoordinator keeps terminal lifecycle ahead of late retry metadata", async () => {
  const coordinator = new PromptCoordinator();
  await coordinator.admit(input, async () => "ok");
  coordinator.bindServerPromptId("p1", "server-terminal-retry");
  coordinator.observeRetry("server-terminal-retry", "exhausted", 9, input.sessionId, undefined, 3, 3);
  const failed = coordinator.observeServerLifecycle(
    "server-terminal-retry",
    "pi_chat_process_error",
    9,
    input.sessionId,
  );
  assert.equal(failed?.phase, "failed");
  assert.equal(
    coordinator.observeRetry(
      "server-terminal-retry",
      "scheduled",
      9,
      input.sessionId,
      undefined,
      4,
      3,
    )?.retry?.phase,
    "exhausted",
  );
  coordinator.clearTerminal();
  assert.equal(
    coordinator.observeRetry("server-terminal-retry", "scheduled", 9, input.sessionId),
    undefined,
  );
});

test("PromptCoordinator does not let an older pending retry attempt overwrite a newer fact", async () => {
  const coordinator = new PromptCoordinator();
  coordinator.observeRetry("server-pending-retry", "scheduled", 9, input.sessionId, undefined, 2, 3);
  coordinator.observeRetry("server-pending-retry", "scheduled", 9, input.sessionId, undefined, 1, 3);
  await coordinator.admit({ ...input, promptId: "pending-retry" }, async () => "ok");
  coordinator.bindServerPromptId("pending-retry", "server-pending-retry");
  assert.equal(coordinator.get("pending-retry")?.retry?.attempt, 2);
});

test("PromptCoordinator preserves terminal facts through a late HTTP admission", async () => {
  const coordinator = new PromptCoordinator();
  let resolveAdmission!: (value: string) => void;
  const pendingAdmission = new Promise<string>((resolve) => {
    resolveAdmission = resolve;
  });
  const request = coordinator.admit(
    { ...input, promptId: "late-admission" },
    async () => pendingAdmission,
  );
  await Promise.resolve();
  coordinator.bindServerPromptId("late-admission", "server-late-admission");
  const failed = coordinator.observeServerLifecycle(
    "server-late-admission",
    "pi_chat_process_error",
    8,
    input.sessionId,
  );
  assert.equal(failed?.phase, "failed");
  coordinator.clearTerminal();
  assert.equal(coordinator.get("late-admission")?.phase, "failed");
  resolveAdmission("accepted-late");
  assert.equal(await request, "accepted-late");
  assert.equal(coordinator.get("late-admission"), undefined);
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

test("PromptCoordinator deletes all operation state for an authoritative Session deletion", async () => {
  const coordinator = new PromptCoordinator();
  await coordinator.admit({ ...input, promptId: "deleted" }, async () => "ok");
  coordinator.bindServerPromptId("deleted", "server-deleted");
  coordinator.observeServerLifecycle("server-pending", "agent_start", 8, input.sessionId);
  coordinator.deleteSession(input.sessionId);
  assert.equal(coordinator.get("deleted"), undefined);
  assert.equal(coordinator.getByServerPromptId("server-deleted"), undefined);
  await coordinator.admit({ ...input, promptId: "replacement" }, async () => ({ queued: true }), {
    phaseForResult: () => ({ type: "queue" }),
  });
  coordinator.bindServerPromptId("replacement", "server-pending");
  assert.equal(coordinator.get("replacement")?.phase, "queued");
  assert.equal(
    coordinator.observeServerLifecycle("server-pending", "agent_start", 8, input.sessionId),
    undefined,
  );
});

test("PromptCoordinator cancels a still-queued item and ignores its late dispatch", async () => {
  const coordinator = new PromptCoordinator();
  await coordinator.admit({ ...input, promptId: "queued" }, async () => ({ queued: true }), {
    phaseForResult: () => ({ type: "queue" }),
  });
  coordinator.bindServerPromptId("queued", "server-queued");
  assert.equal(coordinator.cancelQueued("server-queued")?.phase, "aborted");
  assert.equal(
    coordinator.observeServerLifecycle("server-queued", "agent_start", 10, input.sessionId)?.phase,
    "aborted",
  );
});

test("PromptCoordinator aborts only the latest active turn and preserves older uncertainty", async () => {
  const coordinator = new PromptCoordinator();
  await assert.rejects(
    coordinator.admit({ ...input, promptId: "uncertain" }, async () => { throw new Error("timeout"); }, {
      phaseForError: () => ({ type: "uncertain" }),
    }),
  );
  coordinator.bindServerPromptId("uncertain", "server-uncertain");
  await coordinator.admit({ ...input, promptId: "active", createdAt: 200 }, async () => "ok");
  coordinator.bindServerPromptId("active", "server-active");
  await coordinator.admit({ ...input, promptId: "queued" }, async () => ({ queued: true }), {
    phaseForResult: () => ({ type: "queue" }),
  });
  coordinator.bindServerPromptId("queued", "server-queued");
  assert.deepEqual(
    coordinator.abortRunning(input.sessionId).map((operation) => operation.promptId),
    ["active"],
  );
  assert.equal(coordinator.get("uncertain")?.phase, "uncertain");
  assert.equal(coordinator.get("active")?.phase, "aborted");
  assert.equal(coordinator.get("queued")?.phase, "queued");
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
