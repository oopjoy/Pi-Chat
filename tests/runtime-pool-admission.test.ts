import assert from "node:assert/strict";
import test from "node:test";
import { OperationAdmission } from "../src/server/operation-admission";
import { RuntimePool, type SecondaryRuntime } from "../src/server/runtime-pool";
import { idForPath } from "../src/server/session-index";

function runtime(stop: () => Promise<void>): SecondaryRuntime {
  return {
    id: "runtime",
    cwd: process.cwd(),
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

test("stopAll retains ownership and rejects when a child exit is unconfirmed", async () => {
  let healthyUnsubscribed = 0;
  let failedUnsubscribed = 0;
  const healthy = runtime(async () => {});
  healthy.id = "healthy";
  healthy.unsubscribe = () => { healthyUnsubscribed += 1; };
  const failed = runtime(async () => { throw new Error("exit unconfirmed"); });
  failed.id = "failed";
  failed.unsubscribe = () => { failedUnsubscribed += 1; };
  const targetPool = pool();
  targetPool.runtimes.set(healthy.id, healthy);
  targetPool.runtimes.set(failed.id, failed);
  await assert.rejects(() => targetPool.stopAll(), /exit unconfirmed/);
  assert.equal(targetPool.get(healthy.id), undefined);
  assert.equal(targetPool.get(failed.id), failed);
  assert.equal(healthyUnsubscribed, 1);
  assert.equal(failedUnsubscribed, 0);
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

test("deletion waits for an admitted operation and stop failure reopens dedicated Runtime admission", async () => {
  let releaseStop!: () => void;
  let stopCount = 0;
  const target = runtime(async () => {
    stopCount += 1;
    await new Promise<void>((resolve) => { releaseStop = resolve; });
  });
  const targetPool = pool();
  targetPool.runtimes.set(target.id, target);
  const operation = targetPool.acquireOperation(target);
  const deleting = targetPool.releaseForDeletion(target.id);
  await Promise.resolve();
  assert.equal(stopCount, 0, "deletion waits for the admitted operation to drain");
  assert.throws(() => targetPool.acquireOperation(target), /休眠|closed/i, "closed deletion admission rejects a competing mutation");
  operation();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopCount, 1);
  releaseStop();
  assert.equal(await deleting, target);
  assert.equal(targetPool.get(target.id), undefined);

  const failed = runtime(async () => { throw new Error("locked"); });
  const failedPool = pool();
  failedPool.runtimes.set(failed.id, failed);
  await assert.rejects(() => failedPool.releaseForDeletion(failed.id), /locked/);
  assert.equal(failedPool.get(failed.id), failed, "a failed stop leaves the Session process owned by its Runtime");
  assert.equal(failed.operationAdmission.isClosed, false, "a failed stop reopens admission");
});

test("four reserved cold starts run concurrently without exceeding the Secondary cap", async () => {
  const starts = Array.from({ length: 5 }, () => deferred<void>());
  let started = 0;
  const paths = starts.map((_, index) => `C:\\sessions\\parallel-${index}.jsonl`);
  const targetPool = new RuntimePool({
    now: () => 1,
    cwd: () => process.cwd(),
    maxSecondaryRuntimes: 4,
    createRpc: () => {
      const index = started++;
      return {
        onEvent: () => () => {},
        start: async () => starts[index].promise,
        stop: async () => {},
        isRunning: () => true,
        send: async () => ({ type: "response", success: true, data: { model: null, isStreaming: false, sessionFile: paths[index], sessionId: String(index) } }),
      } as never;
    },
    refreshSessions: async () => {},
    pathForId: (id) => paths.find((path) => id === idForPath(path)) || null,
    isClosed: () => false,
    canSweep: () => true,
    onSecondaryEvent: () => {},
    activeSessionIds: () => [],
    broadcast: () => {},
  });
  const firstFour = paths.slice(0, 4).map((path) => targetPool.ensure(idForPath(path)));
  for (let turn = 0; turn < 20 && started < 4; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started, 4, "every free slot starts before any slow readiness resolves");
  await assert.rejects(() => targetPool.ensure(idForPath(paths[4])), /热对话上限/);
  assert.equal(started, 4, "the fifth Session never spawns without a reservation");
  for (const start of starts.slice(0, 4)) start.resolve();
  await Promise.all(firstFour);
  assert.equal(targetPool.size, 4);
  assert.equal(targetPool.reservedStartCount, 0);
});

test("failed reserved start releases capacity for a later Session", async () => {
  const firstPath = "C:\\sessions\\failed-reservation.jsonl";
  const secondPath = "C:\\sessions\\released-reservation.jsonl";
  let starts = 0;
  const targetPool = new RuntimePool({
    now: () => 1,
    cwd: () => process.cwd(),
    maxSecondaryRuntimes: 1,
    createRpc: () => {
      const fail = starts++ === 0;
      return {
        onEvent: () => () => {},
        start: async () => { if (fail) throw new Error("start failed"); },
        stop: async () => {},
        isRunning: () => true,
        send: async () => ({ type: "response", success: true, data: { model: null, isStreaming: false, sessionFile: secondPath, sessionId: "second" } }),
      } as never;
    },
    refreshSessions: async () => {},
    pathForId: (id) => id === idForPath(firstPath) ? firstPath : id === idForPath(secondPath) ? secondPath : null,
    isClosed: () => false,
    canSweep: () => true,
    onSecondaryEvent: () => {},
    activeSessionIds: () => [],
    broadcast: () => {},
  });
  await assert.rejects(() => targetPool.ensure(idForPath(firstPath)), /start failed/);
  await targetPool.ensure(idForPath(secondPath));
  assert.equal(targetPool.size, 1);
  assert.equal(targetPool.reservedStartCount, 0);
});

test("known cached Session starts without a global index refresh and reuses Pi readiness state", async () => {
  const path = "C:\\sessions\\cached.jsonl";
  const id = idForPath(path);
  let refreshes = 0;
  let stateQueries = 0;
  const readiness = { type: "response", success: true, data: { model: null, isStreaming: false, sessionFile: path, sessionId: "cached" } };
  const targetPool = new RuntimePool({
    now: () => 1,
    cwd: () => process.cwd(),
    createRpc: () => ({
      onEvent: () => () => {},
      start: async () => readiness,
      stop: async () => {},
      isRunning: () => true,
      send: async (command: Record<string, unknown>) => {
        if (command.type === "get_state") stateQueries += 1;
        return readiness;
      },
    }) as never,
    refreshSessions: async () => { refreshes += 1; },
    pathForId: (candidate) => candidate === id ? path : null,
    summaryForId: (candidate) => candidate === id ? { id, sessionId: "cached", name: "Cached", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false } : null,
    isClosed: () => false,
    canSweep: () => true,
    onSecondaryEvent: () => {},
    activeSessionIds: () => [],
    broadcast: () => {},
  });
  const runtime = await targetPool.ensure(id);
  assert.equal(refreshes, 0, "known Session identity must not force a global JSONL scan");
  assert.equal(stateQueries, 0, "RuntimePool consumes the state PiRpcClient.start already proved");
  assert.equal(runtime.lastState?.sessionFile, path);
});

test("unknown Session refreshes once before failing closed", async () => {
  let refreshes = 0;
  const targetPool = new RuntimePool({
    now: () => 1,
    cwd: () => process.cwd(),
    createRpc: () => { throw new Error("must not spawn"); },
    refreshSessions: async () => { refreshes += 1; },
    pathForId: () => null,
    isClosed: () => false,
    canSweep: () => true,
    onSecondaryEvent: () => {},
    activeSessionIds: () => [],
    broadcast: () => {},
  });
  await assert.rejects(() => targetPool.ensure("missing"), /会话不存在/);
  assert.equal(refreshes, 1);
});

test("secondary recovery always retains its dedicated Session cwd", async () => {
  const workspaceA = "C:\\workspace-a";
  const workspaceB = "D:\\workspace-b";
  const path = `${workspaceA}\\session.jsonl`;
  const id = idForPath(path);
  let applicationCwd = workspaceA;
  const restarts: Array<{ path?: string; cwd?: string }> = [];
  const rpc = {
    onEvent: () => () => {},
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    restart: async (sessionPath?: string, cwd?: string) => { restarts.push({ path: sessionPath, cwd }); },
    send: async (command: Record<string, unknown>) => ({
      type: "response",
      success: true,
      data: command.type === "get_state"
        ? { model: null, isStreaming: false, sessionFile: path, sessionId: id }
        : {},
    }),
  } as never;
  const targetPool = new RuntimePool({
    now: () => 1,
    cwd: () => applicationCwd,
    createRpc: (cwd) => {
      assert.equal(cwd, workspaceA, "the original Session starts in its summary cwd");
      return rpc;
    },
    refreshSessions: async () => {},
    pathForId: (candidate) => candidate === id ? path : null,
    summaryForId: (candidate) => candidate === id ? { id, sessionId: "session", name: "Session", preview: "", cwd: workspaceA, updatedAt: 1, messageCount: 1, active: false } : null,
    isClosed: () => false,
    canSweep: () => true,
    onSecondaryEvent: () => {},
    activeSessionIds: () => [],
    broadcast: () => {},
  });
  const target = await targetPool.ensure(id);
  applicationCwd = workspaceB;
  target.failed = true;
  await targetPool.ensure(id);
  assert.deepEqual(restarts, [{ path, cwd: workspaceA }], "recovery never inherits a later application workspace");
});

test("a newer abort pause survives Secondary recovery completion", async () => {
  const path = "C:\\sessions\\recover-abort.jsonl";
  const restart = deferred<Record<string, unknown>>();
  const target = runtime(async () => {});
  target.sessionPath = path;
  target.promptQueue.push({
    id: "00000000-0000-4000-8000-000000000901",
    message: "remain paused",
    images: [],
    imageCount: 0,
    createdAt: 1,
  });
  target.rpc = {
    restart: async () => restart.promise,
    currentGeneration: () => 2,
    isRunning: () => true,
    send: async () => ({
      type: "response",
      success: true,
      data: { model: null, isStreaming: false, sessionFile: path },
    }),
  } as never;
  const targetPool = pool();
  targetPool.runtimes.set(target.id, target);
  const recovering = targetPool.recover(target);
  await Promise.resolve();
  target.abortGeneration += 1;
  target.queuePaused = true;
  restart.resolve({
    type: "response",
    success: true,
    data: { model: null, isStreaming: false, sessionFile: path },
  });
  await recovering;
  assert.equal(target.queuePaused, true);
  assert.deepEqual(target.promptQueue.map((item) => item.message), [
    "remain paused",
  ]);
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
