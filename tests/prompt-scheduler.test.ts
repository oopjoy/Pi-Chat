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
    acquirePrimaryOperation: () => () => {},
    acquireRuntimeOperation: () => () => {},
    touchRuntime: () => {},
    applyPendingTurnSettings: async () => {},
    syncGateMode: async () => {},
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
  const lastQueuedId = scheduler.primaryQueue.at(-1)?.id;

  const huge = [{ type: "image", data: "x".repeat(45_000_001), mimeType: "image/png" }];
  scheduler.primaryQueue.length = 0;
  assert.match(scheduler.assertCanEnqueue(scheduler.primaryQueue, huge as never) || "", /32 MB/);
  assert.ok(events.some((event) => event.type === "pi_chat_queue_update"));
  const lastAdmission = [...events].reverse().find((event) => event.type === "pi_chat_queue_update");
  assert.equal(lastAdmission?.admittedId, lastQueuedId);
});

test("failed queued dispatch reports the requeued prompt for transcript rollback", async () => {
  const events: Record<string, unknown>[] = [];
  const scheduler = new PromptScheduler({
    isClosed: () => false,
    isLifecycleIdle: () => true,
    primaryRpc: () => ({ send: async () => { throw new Error("rejected"); } } as never),
    activeSessionId: () => "primary",
    ensurePrimaryRuntime: async () => {},
    recoverRuntime: async () => {},
    acquirePrimaryOperation: () => () => {},
    acquireRuntimeOperation: () => () => {},
    touchRuntime: () => {},
    applyPendingTurnSettings: async () => {},
    syncGateMode: async () => {},
    broadcast: (event) => events.push(event),
    onPrimaryPromptAccepted: () => {},
    onSecondaryPromptAccepted: () => {},
  });
  const queued = scheduler.enqueuePrimary("later", []);

  await scheduler.dispatchPrimaryNext();

  assert.equal(scheduler.primaryQueuePaused, true);
  assert.equal(scheduler.primaryQueue[0]?.id, queued.id);
  const dispatchIndex = events.findIndex((event) => event.type === "pi_chat_queue_dispatch");
  const errorIndex = events.findIndex((event) => event.type === "pi_chat_queue_error");
  assert.ok(dispatchIndex >= 0 && errorIndex > dispatchIndex);
  assert.deepEqual(events[errorIndex], {
    type: "pi_chat_queue_error",
    id: queued.id,
    queue: scheduler.publicQueue(),
    paused: true,
    piChatSessionId: "primary",
    error: "rejected",
  });
});

test("Gate mode is synchronized immediately before the next Primary prompt", async () => {
  const commands: string[] = [];
  const rpc = { send: async (command: { type: string; message?: string }) => { commands.push(command.message || command.type); return { type: "response", success: true }; } };
  const scheduler = new PromptScheduler({
    isClosed: () => false,
    isLifecycleIdle: () => true,
    primaryRpc: () => rpc as never,
    activeSessionId: () => "primary",
    ensurePrimaryRuntime: async () => {},
    recoverRuntime: async () => {},
    acquirePrimaryOperation: () => () => {},
    acquireRuntimeOperation: () => () => {},
    touchRuntime: () => {},
    applyPendingTurnSettings: async () => {},
    syncGateMode: async (target, _sessionId, mode) => { if (mode) await target.send({ type: "prompt", message: `/gate ${mode}` }); },
    broadcast: () => {},
    onPrimaryPromptAccepted: () => {},
    onSecondaryPromptAccepted: () => {},
  });

  await scheduler.sendPrimaryPrompt("next turn", [], 1, "strict");

  assert.deepEqual(commands, ["/gate strict", "next turn"]);
});

test("queued Secondary turns retain Gate mode until actual dispatch", async () => {
  const commands: string[] = [];
  const rpc = { send: async (command: { type: string; message?: string }) => { commands.push(command.message || command.type); return { type: "response", success: true }; }, isRunning: () => true };
  const runtime = {
    id: "secondary",
    rpc,
    running: false,
    queuePaused: false,
    dispatching: false,
    promptQueue: [],
    pendingTurnSettings: {},
    abortGeneration: 0,
    failed: false,
  };
  const scheduler = new PromptScheduler({
    isClosed: () => false,
    isLifecycleIdle: () => true,
    primaryRpc: () => rpc as never,
    activeSessionId: () => "primary",
    ensurePrimaryRuntime: async () => {},
    recoverRuntime: async () => {},
    acquirePrimaryOperation: () => () => {},
    acquireRuntimeOperation: () => () => {},
    touchRuntime: () => {},
    applyPendingTurnSettings: async () => {},
    syncGateMode: async (target, _sessionId, mode) => { if (mode) await target.send({ type: "prompt", message: `/gate ${mode}` }); },
    broadcast: () => {},
    onPrimaryPromptAccepted: () => {},
    onSecondaryPromptAccepted: () => {},
  });
  const queued = scheduler.enqueueRuntime(runtime as never, "queued next", [], 1, "open");
  assert.deepEqual(commands, [], "enqueue must not alter the Gate during the current turn");
  assert.equal((scheduler.publicQueue(runtime.promptQueue as never)[0] as Record<string, unknown>).gateMode, undefined);

  await scheduler.dispatchRuntimeNext(runtime as never);

  assert.equal(queued.gateMode, "open");
  assert.deepEqual(commands, ["/gate open", "queued next"]);
});

test("successful queued Secondary dispatch performs acceptance bookkeeping with its admission time", async () => {
  const accepted: Array<{ runtime: unknown; promptAt: number }> = [];
  const rpc = { send: async () => ({ type: "response", success: true }), isRunning: () => true };
  const runtime = {
    id: "secondary",
    rpc,
    running: false,
    queuePaused: false,
    dispatching: false,
    promptQueue: [],
    pendingTurnSettings: {},
    abortGeneration: 0,
    failed: false,
  };
  const scheduler = new PromptScheduler({
    isClosed: () => false,
    isLifecycleIdle: () => true,
    primaryRpc: () => rpc as never,
    activeSessionId: () => "primary",
    ensurePrimaryRuntime: async () => {},
    recoverRuntime: async () => {},
    acquirePrimaryOperation: () => () => {},
    acquireRuntimeOperation: () => () => {},
    touchRuntime: () => {},
    applyPendingTurnSettings: async () => {},
    syncGateMode: async () => {},
    broadcast: () => {},
    onPrimaryPromptAccepted: () => {},
    onSecondaryPromptAccepted: (acceptedRuntime, promptAt) => accepted.push({ runtime: acceptedRuntime, promptAt }),
  });
  const queued = scheduler.enqueueRuntime(runtime as never, "accepted from queue", [], 1234);

  await scheduler.dispatchRuntimeNext(runtime as never);

  assert.deepEqual(accepted, [{ runtime, promptAt: queued.createdAt }]);
});

test("failed queued Secondary dispatch does not perform acceptance bookkeeping", async () => {
  let accepted = 0;
  const rpc = { send: async () => { throw new Error("rejected"); }, isRunning: () => true };
  const runtime = {
    id: "secondary",
    rpc,
    running: false,
    queuePaused: false,
    dispatching: false,
    promptQueue: [],
    pendingTurnSettings: {},
    abortGeneration: 0,
    failed: false,
  };
  const scheduler = new PromptScheduler({
    isClosed: () => false,
    isLifecycleIdle: () => true,
    primaryRpc: () => rpc as never,
    activeSessionId: () => "primary",
    ensurePrimaryRuntime: async () => {},
    recoverRuntime: async () => {},
    acquirePrimaryOperation: () => () => {},
    acquireRuntimeOperation: () => () => {},
    touchRuntime: () => {},
    applyPendingTurnSettings: async () => {},
    syncGateMode: async () => {},
    broadcast: () => {},
    onPrimaryPromptAccepted: () => {},
    onSecondaryPromptAccepted: () => { accepted += 1; },
  });
  scheduler.enqueueRuntime(runtime as never, "rejected from queue", [], 1234);

  await scheduler.dispatchRuntimeNext(runtime as never);

  assert.equal(accepted, 0);
  assert.equal((runtime as { queuePaused: boolean }).queuePaused, true);
});

test("publicQueue strips image payloads", () => {
  const scheduler = new PromptScheduler({
    isClosed: () => false,
    isLifecycleIdle: () => true,
    primaryRpc: () => ({ send: async () => ({}) } as never),
    activeSessionId: () => "primary",
    ensurePrimaryRuntime: async () => {},
    recoverRuntime: async () => {},
    acquirePrimaryOperation: () => () => {},
    acquireRuntimeOperation: () => () => {},
    touchRuntime: () => {},
    applyPendingTurnSettings: async () => {},
    syncGateMode: async () => {},
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
