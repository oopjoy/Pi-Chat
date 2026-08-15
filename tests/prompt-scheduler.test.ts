import assert from "node:assert/strict";
import test from "node:test";
import { PromptScheduler } from "../src/server/prompt-scheduler.ts";
import { RpcRequestTimeoutError } from "../src/server/rpc-client.ts";

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

test("a timed-out Primary prompt remains conservatively running because Pi may have received it", async () => {
  let accepted = 0;
  const scheduler = new PromptScheduler({
    isClosed: () => false,
    isLifecycleIdle: () => true,
    primaryRpc: () => ({
      send: async () => {
        throw new RpcRequestTimeoutError("prompt");
      },
    } as never),
    activeSessionId: () => "primary",
    ensurePrimaryRuntime: async () => {},
    recoverRuntime: async () => {},
    acquirePrimaryOperation: () => () => {},
    acquireRuntimeOperation: () => () => {},
    touchRuntime: () => {},
    applyPendingTurnSettings: async () => {},
    syncGateMode: async () => {},
    broadcast: () => {},
    onPrimaryPromptAccepted: () => { accepted += 1; },
    onSecondaryPromptAccepted: () => {},
  });

  assert.equal(await scheduler.sendPrimaryPrompt("possibly accepted", []), "unknown");
  assert.equal(scheduler.primaryRunning, true);
  assert.equal(accepted, 1);
});

test("a timed-out queued Primary prompt emits an asynchronous uncertainty verdict", async () => {
  const events: Record<string, unknown>[] = [];
  const traces: Array<{ sessionId: string; promptId: string; name: string }> = [];
  const scheduler = new PromptScheduler({
    isClosed: () => false,
    isLifecycleIdle: () => true,
    primaryRpc: () => ({
      send: async () => {
        throw new RpcRequestTimeoutError("prompt");
      },
    } as never),
    activeSessionId: () => "primary",
    ensurePrimaryRuntime: async () => {},
    recoverRuntime: async () => {},
    acquirePrimaryOperation: () => () => {},
    acquireRuntimeOperation: () => () => {},
    touchRuntime: () => {},
    applyPendingTurnSettings: async () => {},
    syncGateMode: async () => {},
    tracePrompt: (sessionId, promptId, name) => traces.push({ sessionId, promptId, name }),
    broadcast: (event) => events.push(event),
    onPrimaryPromptAccepted: () => {},
    onSecondaryPromptAccepted: () => {},
  });
  const queued = scheduler.enqueuePrimary("possibly accepted", []);

  await scheduler.dispatchPrimaryNext();

  assert.equal(scheduler.primaryRunning, true);
  assert.equal(scheduler.primaryDispatching, false);
  assert.equal(scheduler.primaryQueue.length, 0);
  assert.deepEqual(traces, [
    { sessionId: "primary", promptId: queued.id, name: "dispatch" },
    { sessionId: "primary", promptId: queued.id, name: "delivery-uncertain" },
  ]);
  assert.ok(
    events.some(
      (event) =>
        event.type === "pi_chat_prompt_delivery_uncertain" &&
        event.id === queued.id,
    ),
  );
});

test("a timed-out queued Secondary prompt is not requeued and remains conservatively running", async () => {
  let accepted = 0;
  const events: Record<string, unknown>[] = [];
  const rpc = {
    send: async (command: { type: string }) => {
      if (command.type === "prompt") throw new RpcRequestTimeoutError("prompt");
      return { type: "response", success: true };
    },
    isRunning: () => true,
  };
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
    broadcast: (event) => events.push(event),
    onPrimaryPromptAccepted: () => {},
    onSecondaryPromptAccepted: () => { accepted += 1; },
  });
  scheduler.enqueueRuntime(runtime as never, "possibly accepted", [], 1234);

  await scheduler.dispatchRuntimeNext(runtime as never);

  assert.equal((runtime as { running: boolean }).running, true);
  assert.equal((runtime as { dispatching: boolean }).dispatching, false);
  assert.equal((runtime as { queuePaused: boolean }).queuePaused, false);
  assert.equal((runtime as { promptQueue: unknown[] }).promptQueue.length, 0);
  assert.equal(accepted, 1);
  assert.ok(
    events.some(
      (event) =>
        event.type === "pi_chat_prompt_delivery_uncertain" &&
        event.piChatSessionId === "secondary",
    ),
  );
});

test("failed queued dispatch reports the requeued prompt for transcript rollback", async () => {
  const events: Record<string, unknown>[] = [];
  const traces: Array<{ sessionId: string; promptId: string; name: string }> = [];
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
    tracePrompt: (sessionId, promptId, name) => traces.push({ sessionId, promptId, name }),
    broadcast: (event) => events.push(event),
    onPrimaryPromptAccepted: () => {},
    onSecondaryPromptAccepted: () => {},
  });
  const queued = scheduler.enqueuePrimary("later", []);

  await scheduler.dispatchPrimaryNext();

  assert.equal(scheduler.primaryQueuePaused, true);
  assert.equal(scheduler.primaryQueue[0]?.id, queued.id);
  assert.deepEqual(traces, [
    { sessionId: "primary", promptId: queued.id, name: "dispatch" },
    { sessionId: "primary", promptId: queued.id, name: "requeued" },
  ]);
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

test("diagnostic callbacks are fail-open and cannot replace scheduler delivery", async () => {
  let sends = 0;
  const rpc = {
    send: async () => {
      sends += 1;
      return { type: "response", success: true };
    },
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
    promptRpcObserver: () => { throw new Error("observer setup failed"); },
    tracePrompt: () => { throw new Error("trace failed"); },
    abandonPromptDiagnostic: () => { throw new Error("cleanup failed"); },
    broadcast: () => {},
    onPrimaryPromptAccepted: () => {},
    onSecondaryPromptAccepted: () => {},
  });

  assert.equal(await scheduler.sendPrimaryPrompt(
    "delivered once",
    [],
    1,
    undefined,
    "11111111-1111-4111-8111-111111111111",
  ), "confirmed");
  assert.equal(sends, 1);
});

test("Primary dispatch observation follows settings and Gate preflight immediately before send", async () => {
  const steps: string[] = [];
  const rpc = {
    send: async () => {
      steps.push("send");
      return { type: "response", success: true };
    },
  };
  const scheduler = new PromptScheduler({
    isClosed: () => false,
    isLifecycleIdle: () => true,
    primaryRpc: () => rpc as never,
    activeSessionId: () => "primary",
    ensurePrimaryRuntime: async () => { steps.push("ready"); },
    recoverRuntime: async () => {},
    acquirePrimaryOperation: () => () => {},
    acquireRuntimeOperation: () => () => {},
    touchRuntime: () => {},
    applyPendingTurnSettings: async () => { steps.push("settings"); },
    syncGateMode: async () => { steps.push("gate"); },
    promptRpcObserver: () => {
      steps.push("observer");
      return () => {};
    },
    tracePrompt: (_sessionId, _promptId, name) => steps.push(name),
    broadcast: () => {},
    onPrimaryPromptAccepted: () => {},
    onSecondaryPromptAccepted: () => {},
  });

  await scheduler.sendPrimaryPrompt(
    "next",
    [],
    1,
    "strict",
    "22222222-2222-4222-8222-222222222222",
  );
  assert.deepEqual(steps, [
    "ready",
    "settings",
    "gate",
    "observer",
    "dispatch",
    "send",
  ]);
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
  const traces: Array<{ promptId: string; name: string }> = [];
  const abandoned: string[] = [];
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
    tracePrompt: (_sessionId, promptId, name) => traces.push({ promptId, name }),
    abandonPromptDiagnostic: (_sessionId, promptId) => abandoned.push(promptId),
    broadcast: () => {},
    onPrimaryPromptAccepted: () => {},
    onSecondaryPromptAccepted: () => { accepted += 1; },
  });
  const queued = scheduler.enqueueRuntime(runtime as never, "rejected from queue", [], 1234);

  await scheduler.dispatchRuntimeNext(runtime as never);

  assert.equal(accepted, 0);
  assert.equal((runtime as { queuePaused: boolean }).queuePaused, true);
  assert.deepEqual(traces, [
    { promptId: queued.id, name: "dispatch" },
    { promptId: queued.id, name: "requeued" },
  ]);
  assert.deepEqual(abandoned, [queued.id]);
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
