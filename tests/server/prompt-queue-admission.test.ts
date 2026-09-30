import assert from "node:assert/strict";
import test from "node:test";
import { admitPromptToQueue } from "../../src/server/services/prompt-queue-admission";
import type { QueuedPrompt } from "../../src/shared/types";

function item(id = "queue-id"): QueuedPrompt {
  return { id, message: "queued", createdAt: 1, imageCount: 0 };
}

test("queue admission records the immutable item before publishing its public snapshot", () => {
  const calls: string[] = [];
  const result = admitPromptToQueue({
    isBusy: () => true,
    assertCanEnqueue: () => null,
    enqueue: () => item(),
    supersedePendingSettings: () => calls.push("supersede"),
    publicQueue: () => [item()],
    traceAdmitted: (id) => calls.push(`admitted:${id}`),
    traceQueued: (id) => calls.push(`queued:${id}`),
    noteUserPrompt: () => calls.push("note"),
  }, {
    message: "queued",
    images: [],
    promptAt: 1,
  });
  assert.equal(result.kind, "queued");
  assert.deepEqual(calls, ["supersede", "admitted:queue-id", "queued:queue-id", "note"]);
  if (result.kind === "queued") assert.deepEqual(result.queue, [item()]);
});

test("queue admission preserves owner busy and capacity errors", () => {
  const notBusy = admitPromptToQueue({
    isBusy: () => false,
    assertCanEnqueue: () => assert.fail("not busy must not validate capacity"),
    enqueue: () => assert.fail("not busy must not enqueue"),
    supersedePendingSettings: () => {},
    publicQueue: () => [],
    traceAdmitted: () => {},
    traceQueued: () => {},
    noteUserPrompt: () => {},
  }, { message: "x", images: [], promptAt: 1 });
  assert.deepEqual(notBusy, { kind: "not-busy" });

  const conflict = admitPromptToQueue({
    isBusy: () => true,
    assertCanEnqueue: () => "队列已满",
    enqueue: () => assert.fail("capacity error must not enqueue"),
    supersedePendingSettings: () => {},
    publicQueue: () => [],
    traceAdmitted: () => {},
    traceQueued: () => {},
    noteUserPrompt: () => {},
  }, { message: "x", images: [], promptAt: 1 });
  assert.deepEqual(conflict, { kind: "conflict", error: "队列已满" });
});
