import assert from "node:assert/strict";
import test from "node:test";
import { PromptScheduler } from "../src/server/prompt-scheduler.ts";

test("enqueue limits protect queue length and image payload size", () => {
  const events: Record<string, unknown>[] = [];
  const scheduler = new PromptScheduler({
    isClosed: () => false,
    isLifecycleIdle: () => true,
    primaryRpc: () => ({ send: async () => ({ type: "response", success: true }) } as never),
    activeSessionId: () => "primary",
    ensurePrimaryRuntime: async () => {},
    recoverRuntime: async () => {},
    touchRuntime: () => {},
    applyPendingTurnSettings: async () => {},
    broadcast: (event) => events.push(event),
    onPrimaryPromptAccepted: () => {},
    onSecondaryPromptAccepted: () => {},
  });

  for (let i = 0; i < 20; i += 1) {
    assert.equal(scheduler.assertCanEnqueue(scheduler.primaryQueue, []), null);
    scheduler.enqueuePrimary(`m${i}`, []);
  }
  assert.equal(scheduler.primaryQueue.length, 20);
  assert.match(scheduler.assertCanEnqueue(scheduler.primaryQueue, []) || "", /队列已满/);

  const huge = [{ type: "image", data: "x".repeat(45_000_001), mimeType: "image/png" }];
  scheduler.primaryQueue.length = 0;
  assert.match(scheduler.assertCanEnqueue(scheduler.primaryQueue, huge as never) || "", /32 MB/);
  assert.ok(events.some((event) => event.type === "pi_chat_queue_update"));
});

test("publicQueue strips image payloads", () => {
  const scheduler = new PromptScheduler({
    isClosed: () => false,
    isLifecycleIdle: () => true,
    primaryRpc: () => ({ send: async () => ({}) } as never),
    activeSessionId: () => "primary",
    ensurePrimaryRuntime: async () => {},
    recoverRuntime: async () => {},
    touchRuntime: () => {},
    applyPendingTurnSettings: async () => {},
    broadcast: () => {},
    onPrimaryPromptAccepted: () => {},
    onSecondaryPromptAccepted: () => {},
  });
  const item = scheduler.enqueuePrimary("hi", [{ type: "image", data: "abc", mimeType: "image/png" } as never]);
  assert.deepEqual(scheduler.publicQueue()[0], {
    id: item.id,
    message: "hi",
    imageCount: 1,
    createdAt: item.createdAt,
  });
});
