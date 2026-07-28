import assert from "node:assert/strict";
import test from "node:test";
import { OperationAdmission } from "../src/server/operation-admission";
import { RuntimePool, type SecondaryRuntime } from "../src/server/runtime-pool";

function runtime(stop: () => Promise<void>): SecondaryRuntime {
  return {
    id: "runtime",
    rpc: { stop, isRunning: () => true } as never,
    running: false,
    queuePaused: false,
    dispatching: false,
    promptQueue: [],
    toolStatus: "",
    extensionUiPending: false,
    pendingTerminalMessages: [],
    operationLeases: 0,
    operationAdmission: new OperationAdmission(),
    abortGeneration: 0,
    lastUsedAt: 0,
    unsubscribe: () => {},
    pendingTurnSettings: {},
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function pool(createRpc?: () => SecondaryRuntime["rpc"]): RuntimePool {
  return new RuntimePool({
    now: () => 1,
    cwd: () => process.cwd(),
    refreshSessions: async () => {},
    pathForId: () => null,
    isClosed: () => false,
    canSweep: () => true,
    onSecondaryEvent: () => {},
    activeSessionIds: () => [],
    broadcast: () => {},
    createRpc: createRpc ? () => createRpc() : undefined,
  });
}

test("failed Runtime stop reopens admission and leaves the worker attached", async () => {
  const target = runtime(async () => { throw new Error("locked"); });
  const targetPool = pool();
  targetPool.runtimes.set(target.id, target);
  await assert.rejects(() => targetPool.reclaim(target.id, "idle"), /locked/);
  assert.equal(targetPool.get(target.id), target);
  assert.equal(target.operationAdmission.isClosed, false);
  targetPool.acquireOperation(target)();
});

test("draft handoff lease blocks reclaim while an empty draft probe is pending", async () => {
  const messages = deferred<{ type: string; success: boolean; data: { messages: [] } }>();
  let stopCount = 0;
  const target = runtime(async () => { stopCount += 1; });
  target.draftSession = { id: target.id, sessionId: "draft", name: "新对话", preview: "尚未发送消息", cwd: process.cwd(), updatedAt: 1, messageCount: 0, active: false };
  target.draftOwnerClientId = "client-a";
  target.rpc = {
    ...target.rpc,
    send: async (command: { type: string }) => command.type === "get_messages"
      ? messages.promise
      : { type: "response", success: true },
  } as never;
  const targetPool = pool(() => ({
    onEvent: () => () => {},
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    send: async () => ({ type: "response", success: true, data: { model: null, isStreaming: false, sessionFile: "C:\\sessions\\fresh.jsonl" } }),
  }) as never);
  targetPool.runtimes.set(target.id, target);

  const acquired = targetPool.acquireDraft("client-a");
  await Promise.resolve();
  assert.equal(target.operationLeases, 1);
  assert.equal(await targetPool.reclaim(target.id, "capacity"), false);
  assert.equal(stopCount, 0);

  messages.resolve({ type: "response", success: true, data: { messages: [] } });
  const lease = await acquired;
  assert.equal(lease.runtime, target);
  assert.equal(targetPool.get(target.id), target);
  assert.equal(target.operationLeases, 1, "the probe lease transfers through the draft handoff");
  lease.release();
  assert.equal(target.operationLeases, 0);
  assert.equal(await targetPool.reclaim(target.id, "capacity"), true);
  assert.equal(stopCount, 1);
});

test("concurrent reclaim keeps one stop marker until ensure can safely restart", async () => {
  let releaseStop!: () => void;
  let stopCount = 0;
  let signalStopStarted!: () => void;
  const stopStarted = new Promise<void>((resolve) => { signalStopStarted = resolve; });
  const target = runtime(async () => {
    stopCount += 1;
    signalStopStarted();
    await new Promise<void>((resolve) => { releaseStop = resolve; });
  });
  let starts = 0;
  const targetPool = new RuntimePool({
    now: () => 1,
    cwd: () => process.cwd(),
    refreshSessions: async () => {},
    pathForId: () => "C:\\sessions\\runtime.jsonl",
    isClosed: () => false,
    canSweep: () => true,
    onSecondaryEvent: () => {},
    activeSessionIds: () => [],
    broadcast: () => {},
    createRpc: () => ({
      onEvent: () => () => {},
      start: async () => { starts += 1; },
      send: async () => ({ type: "response", success: true, data: { model: null, isStreaming: false } }),
      isRunning: () => true,
    }) as never,
  });
  targetPool.runtimes.set(target.id, target);
  const first = targetPool.reclaim(target.id, "idle");
  await stopStarted;
  const second = targetPool.reclaim(target.id, "capacity");
  const ensured = targetPool.ensure(target.id);
  await Promise.resolve();
  assert.equal(targetPool.stoppingCount, 1);
  assert.equal(starts, 0, "ensure must wait for the original stop owner");
  releaseStop();
  assert.equal(await first, true);
  assert.equal(await second, true);
  await ensured;
  assert.equal(stopCount, 1);
  assert.equal(starts, 1);
  assert.equal(targetPool.get(target.id)?.operationAdmission.isClosed, false);
});
