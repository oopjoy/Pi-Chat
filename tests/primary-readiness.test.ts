import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp } from "../src/server/app";
import { PrimaryRuntimeReadinessController, PrimaryRuntimeUnavailableError, type PrimaryRuntimeReadinessBridge } from "../src/server/primary-runtime-readiness";
import { RpcRequestTimeoutError, type PiRpcClient } from "../src/server/rpc-client";
import { idForPath } from "../src/server/session-index";
import type { SessionIndex } from "../src/server/session-index";
import type { ResourceManager } from "../src/server/resource-manager";
import type { PiState, PrimaryRuntimeReadiness } from "../src/shared/types";

class ReadinessFakeRpc {
  readonly commands: Record<string, unknown>[] = [];
  alive = true;
  restartCount = 0;
  model: PiState["model"] = null;
  private listeners = new Set<(event: Record<string, unknown>) => void>();

  constructor(readonly path: string, readonly sessionId: string) {}
  onEvent(listener: (event: Record<string, unknown>) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: Record<string, unknown>) { for (const listener of this.listeners) listener(event); }
  async start() { this.alive = true; }
  async stop() { this.alive = false; }
  async restart() { this.restartCount += 1; this.alive = true; }
  isRunning() { return this.alive; }
  async send(command: Record<string, unknown>) {
    this.commands.push(command);
    if (command.type === "get_state") return { type: "response", success: true, data: { model: this.model, sessionFile: this.path, sessionId: this.sessionId, isStreaming: false } };
    if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [] } };
    if (command.type === "get_available_models") return { type: "response", success: true, data: { models: [] } };
    if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [] } };
    if (command.type === "get_session_stats") return { type: "response", success: true, data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    return { type: "response", success: true, data: {} };
  }
}

class ControllerRpc {
  starts = 0;
  restarts = 0;
  stops = 0;
  probes = 0;
  stateProbes = 0;
  compatible = true;
  startFailure: Error | null = null;
  startResponse: Record<string, unknown> = {
    type: "response",
    success: true,
    data: { model: null, sessionId: "controller", isStreaming: false },
  };
  async start() {
    this.starts += 1;
    if (this.startFailure) {
      const error = this.startFailure;
      this.startFailure = null;
      throw error;
    }
    return this.startResponse;
  }
  async restart() { this.restarts += 1; return this.startResponse; }
  async stop() { this.stops += 1; }
  async probeCompatibility(initialState?: Record<string, unknown>) {
    if (initialState) this.stateProbes += 1;
    this.probes += 1;
    return this.compatible
      ? { compatible: true, diagnostics: [] }
      : { compatible: false, diagnostics: ["missing capability"] };
  }
}

class ReadinessBridge implements PrimaryRuntimeReadinessBridge {
  private listeners = new Set<(value: PrimaryRuntimeReadiness) => void>();
  recoverFailure: PrimaryRuntimeReadiness | null = null;
  recoverCalls = 0;
  onRecover: (() => void) | undefined;
  constructor(private value: PrimaryRuntimeReadiness) {}
  snapshot() { return this.value; }
  async waitUntilReady() {
    if (this.value.status !== "ready") throw new PrimaryRuntimeUnavailableError(this.value);
  }
  async recover(_sessionFile?: string, _cwd?: string) {
    this.recoverCalls += 1;
    if (this.recoverFailure) {
      this.set(this.recoverFailure);
      throw new PrimaryRuntimeUnavailableError(this.recoverFailure);
    }
    if (this.value.status === "failed") {
      this.onRecover?.();
      this.set({ status: "ready", generation: this.value.generation + 1 });
      return;
    }
    await this.waitUntilReady();
  }
  markFailed(error: unknown) {
    const event = error && typeof error === "object"
      ? error as Record<string, unknown>
      : null;
    this.set({
      status: "failed",
      generation: this.value.generation + 1,
      error: error instanceof Error
        ? error.message
        : typeof event?.error === "string"
          ? event.error
          : String(error),
      ...(typeof event?.incidentId === "string"
        ? { incidentId: event.incidentId }
        : null),
    });
  }
  subscribe(listener: (value: PrimaryRuntimeReadiness) => void) { this.listeners.add(listener); listener(this.value); return () => this.listeners.delete(listener); }
  set(value: PrimaryRuntimeReadiness) { this.value = value; for (const listener of this.listeners) listener(value); }
}

async function fixture(readiness: PrimaryRuntimeReadiness) {
  const path = "C:\\sessions\\readiness.jsonl";
  const id = idForPath(path);
  const rpc = new ReadinessFakeRpc(path, "readiness");
  const bridge = new ReadinessBridge(readiness);
  const sessions = {
    list: async () => [{ id, sessionId: "readiness", name: "Readiness", preview: "saved", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [{ role: "assistant", content: "saved history", timestamp: 1 }],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), primaryRuntime: bridge });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { app, bridge, rpc, id, origin: `http://127.0.0.1:${address.port}`, close: async () => { server.close(); await app.close(); } };
}

test("Primary recovery repeats compatibility probing before reporting ready", async () => {
  const rpc = new ControllerRpc();
  const controller = new PrimaryRuntimeReadinessController(rpc as unknown as PiRpcClient);
  await controller.start();
  assert.deepEqual(controller.snapshot(), {
    status: "ready",
    generation: 1,
    model: null,
    sessionId: "controller",
  });
  assert.equal(rpc.probes, 1);
  assert.equal(rpc.stateProbes, 1);

  rpc.compatible = false;
  await assert.rejects(() => controller.recover(), PrimaryRuntimeUnavailableError);
  const incompatible = controller.snapshot();
  assert.equal(incompatible.status, "failed");
  assert.equal(incompatible.generation, 2);
  assert.equal(incompatible.error, "当前 Pi RPC 协议不兼容 Pi Chat：missing capability");
  assert.match(incompatible.incidentId || "", /^PC-/);
  assert.equal(rpc.restarts, 1);
  assert.equal(rpc.probes, 2);
  assert.equal(rpc.stops, 1);
});

test("a current-child failure while adoption is blocked latches the startup operation failed", async () => {
  const rpc = new ControllerRpc();
  const controller = new PrimaryRuntimeReadinessController(
    rpc as unknown as PiRpcClient,
  );
  let releaseAdoption: (() => void) | undefined;
  const adoption = new Promise<void>((resolve) => {
    releaseAdoption = resolve;
  });
  controller.setAdopter(async () => adoption);
  const transitions: PrimaryRuntimeReadiness[] = [];
  controller.subscribe((value) => transitions.push(value));

  const start = controller.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const processFailure = {
    type: "pi_chat_process_error",
    error: "child exited during adoption",
    incidentId: "PC-START001",
    errorCode: "RPC_CHILD_EXIT",
  };
  controller.markFailed(processFailure);
  const failed = controller.snapshot() as PrimaryRuntimeReadiness & {
    errorCode?: string;
  };
  assert.equal(failed.status, "failed");
  assert.equal(failed.generation, 1);
  assert.equal(failed.error, "child exited during adoption");
  assert.equal(failed.incidentId, "PC-START001");
  assert.equal(failed.errorCode, "RPC_CHILD_EXIT");

  releaseAdoption!();
  await assert.rejects(start, PrimaryRuntimeUnavailableError);
  assert.equal(controller.snapshot().status, "failed");
  assert.equal(
    transitions.some((value) => value.status === "ready"),
    false,
    "the failed startup operation must never publish ready after adoption releases",
  );
});

test("Primary publishes ready only after the App adopts the startup state", async () => {
  const rpc = new ControllerRpc();
  rpc.startResponse = {
    type: "response",
    success: true,
    data: {
      model: {
        provider: "test",
        id: "image-model",
        name: "Image model",
        input: ["text", "image"],
      },
      thinkingLevel: "high",
      sessionId: "adopted-session",
      isStreaming: false,
    },
  };
  const controller = new PrimaryRuntimeReadinessController(
    rpc as unknown as PiRpcClient,
  );
  const transitions: PrimaryRuntimeReadiness[] = [];
  controller.subscribe((value) => transitions.push(value));
  let releaseAdoption: (() => void) | undefined;
  const adoption = new Promise<void>((resolve) => {
    releaseAdoption = resolve;
  });
  controller.setAdopter(async (response) => {
    assert.equal(response, rpc.startResponse);
    await adoption;
  });
  const start = controller.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(controller.snapshot(), { status: "starting", generation: 1 });
  assert.equal(transitions.some((value) => value.status === "ready"), false);
  releaseAdoption!();
  await start;
  assert.deepEqual(controller.snapshot(), {
    status: "ready",
    generation: 1,
    model: {
      provider: "test",
      id: "image-model",
      name: "Image model",
      input: ["text", "image"],
    },
    thinkingLevel: "high",
    sessionId: "adopted-session",
  });
});

test("a startup timeout retries only by replacing the whole Pi process", async () => {
  const rpc = new ControllerRpc();
  rpc.startFailure = new RpcRequestTimeoutError("get_state");
  const controller = new PrimaryRuntimeReadinessController(
    rpc as unknown as PiRpcClient,
  );
  let adoptions = 0;
  controller.setAdopter(() => {
    adoptions += 1;
  });
  await controller.start();
  assert.equal(rpc.starts, 1);
  assert.equal(rpc.restarts, 1);
  assert.equal(rpc.stops, 1);
  assert.equal(adoptions, 1);
  assert.equal(controller.snapshot().status, "ready");
});

test("a live Primary child failure advances readiness before recovery", async () => {
  const rpc = new ControllerRpc();
  const controller = new PrimaryRuntimeReadinessController(rpc as unknown as PiRpcClient);
  await controller.start();
  controller.markFailed(new Error("worker exited"));
  const failed = controller.snapshot();
  assert.equal(failed.status, "failed");
  assert.equal(failed.generation, 2);
  assert.equal(failed.error, "worker exited");
  assert.match(failed.incidentId || "", /^PC-/);
  await controller.recover();
  assert.deepEqual(controller.snapshot(), {
    status: "ready",
    generation: 3,
    model: null,
    sessionId: "controller",
  });
  assert.equal(rpc.restarts, 1);
});

for (const readiness of [
  { status: "starting" as const, generation: 1 },
  { status: "failed" as const, generation: 1, error: "protocol mismatch" },
]) {
  test(`${readiness.status} Primary leaves Session reads JSONL-only`, async () => {
    const f = await fixture(readiness);
    try {
      const bootstrap = await fetch(`${f.origin}/api/bootstrap`);
      assert.equal(bootstrap.status, 200);
      assert.equal((await bootstrap.json() as { primaryRuntime: PrimaryRuntimeReadiness }).primaryRuntime.status, readiness.status);
      assert.equal((await fetch(`${f.origin}/api/sessions`)).status, 200);
      const view = await fetch(`${f.origin}/api/sessions/${f.id}/view`);
      assert.equal(view.status, 200);
      assert.match(JSON.stringify(await view.json()), /saved history/);
      assert.deepEqual(f.rpc.commands, [], "read projections must not probe an unready Primary RPC");
    } finally { await f.close(); }
  });
}

test("bootstrap never mixes a starting state projection with a later ready generation", async () => {
  const path = "C:\\sessions\\coherent-bootstrap.jsonl";
  const id = idForPath(path);
  const rpc = new ReadinessFakeRpc(path, "coherent-bootstrap");
  const bridge = new ReadinessBridge({ status: "starting", generation: 1 });
  let releaseList: (() => void) | undefined;
  let listCalls = 0;
  const firstList = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  const sessions = {
    list: async () => {
      listCalls += 1;
      if (listCalls === 1) await firstList;
      return [{
        id,
        sessionId: "coherent-bootstrap",
        name: "Coherent",
        preview: "saved",
        cwd: process.cwd(),
        updatedAt: 1,
        messageCount: 1,
        active: true,
      }];
    },
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: rpc as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    primaryRuntime: bridge,
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const pending = fetch(`http://127.0.0.1:${address.port}/api/bootstrap`);
    for (let attempt = 0; attempt < 20 && listCalls === 0; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(listCalls, 1, "the first starting-generation projection is blocked mid-request");
    rpc.model = {
      provider: "test",
      id: "ready",
      name: "Ready",
      input: ["text", "image"],
    };
    bridge.set({
      status: "ready",
      generation: 1,
      model: rpc.model,
      sessionId: id,
    });
    releaseList!();
    const body = await (await pending).json() as {
      primaryRuntime: PrimaryRuntimeReadiness;
      state: { model: { id: string } | null };
    };
    assert.equal(body.primaryRuntime.status, "ready");
    assert.equal(body.primaryRuntime.model?.id, "ready");
    assert.equal(body.state.model?.id, "ready");
    assert.equal(listCalls, 2, "one coherence rebuild replaces the mixed snapshot");
  } finally {
    server.close();
    await app.close();
  }
});

test("an unbound Primary exit is visible as failed readiness to bootstrap", async () => {
  const f = await fixture({ status: "ready", generation: 1 });
  try {
    // No bootstrap has bound get_state to a Session yet. The process event must
    // still update readiness even though it cannot be broadcast as Session SSE.
    f.rpc.alive = false;
    f.rpc.emit({ type: "pi_chat_process_error", error: "worker exited before binding" });
    const response = await fetch(`${f.origin}/api/bootstrap`);
    assert.equal(response.status, 200);
    const body = await response.json() as { primaryRuntime: PrimaryRuntimeReadiness };
    assert.deepEqual(body.primaryRuntime, {
      status: "failed",
      generation: 2,
      error: "worker exited before binding",
    });
    assert.deepEqual(f.rpc.commands, [], "bootstrap must not probe a failed unbound Primary");
  } finally { await f.close(); }
});

test("failed recovery preserves the 503 readiness contract", async () => {
  const f = await fixture({ status: "ready", generation: 1 });
  try {
    // Bind the active Primary identity while it is healthy, then simulate a
    // crash whose controller-managed restart/re-probe fails compatibility.
    assert.equal((await fetch(`${f.origin}/api/bootstrap`)).status, 200);
    f.bridge.recoverFailure = { status: "failed", generation: 2, error: "compatibility failed after recovery" };
    f.rpc.emit({ type: "pi_chat_process_error", error: "worker crashed" });
    const response = await fetch(`${f.origin}/api/chat/prompt`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: f.id, message: "must not recover-send" }),
    });
    const body = await response.json();
    assert.equal(response.status, 503, JSON.stringify(body));
    assert.equal(body.error, "Pi Runtime 不可用：compatibility failed after recovery");
    assert.equal(body.code, "PRIMARY_RUNTIME_UNAVAILABLE");
    assert.match(body.incidentId, /^PC-/);
    assert.deepEqual(body.primaryRuntime, { status: "failed", generation: 2, error: "compatibility failed after recovery" });
    assert.equal(f.rpc.commands.some((command) => command.type === "prompt"), false);
  } finally { await f.close(); }
});

test("failed Primary does not prevent activating an existing Secondary Runtime", async () => {
  const primaryPath = "C:\\sessions\\primary-readiness.jsonl";
  const secondaryPath = "C:\\sessions\\secondary-readiness.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new ReadinessFakeRpc(primaryPath, "primary-readiness");
  const secondary = new ReadinessFakeRpc(secondaryPath, "secondary-readiness");
  const bridge = new ReadinessBridge({ status: "failed", generation: 4, error: "primary unavailable" });
  const sessions = {
    list: async () => [
      { id: primaryId, sessionId: "primary-readiness", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
      { id: secondaryId, sessionId: "secondary-readiness", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
    ],
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    messagesForId: async () => [{ role: "assistant", content: "saved history", timestamp: 1 }],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => secondary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), primaryRuntime: bridge });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    // Create this Secondary while the test bridge is temporarily ready, then
    // simulate a later Primary compatibility failure before reopening it.
    bridge.set({ status: "ready", generation: 3 });
    assert.equal((await fetch(`${origin}/api/sessions/${secondaryId}/activate`, { method: "POST" })).status, 200);
    bridge.set({ status: "failed", generation: 4, error: "primary unavailable" });
    primary.commands.length = 0;
    assert.equal((await fetch(`${origin}/api/sessions/${secondaryId}/activate`, { method: "POST" })).status, 200);
    assert.deepEqual(primary.commands, []);
  } finally { server.close(); await app.close(); }
});

test("failed Primary retries recovery before spawning a new draft", async () => {
  const path = "C:\\sessions\\blocked-new-draft.jsonl";
  const primary = new ReadinessFakeRpc(path, "primary");
  const draft = new ReadinessFakeRpc(path, "draft");
  let draftCreates = 0;
  const bridge = new ReadinessBridge({ status: "failed", generation: 2, error: "protocol mismatch" });
  const sessions = {
    list: async () => [],
    pathForId: () => null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => { draftCreates += 1; return draft as unknown as PiRpcClient; },
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    primaryRuntime: bridge,
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initial: { message: "must not send" } }),
    });
    const body = await response.json();
    assert.equal(response.status, 202, JSON.stringify(body));
    assert.equal(draftCreates, 1);
    assert.equal(draft.commands.some((command) => command.type === "prompt"), true);
  } finally { server.close(); await app.close(); }
});

test("New uses the complete Primary recovery finalizer after a bound crash", async () => {
  const primaryPath = "C:\\sessions\\primary-new-recovery.jsonl";
  const draftPath = "C:\\sessions\\draft-new-recovery.jsonl";
  const primaryId = idForPath(primaryPath);
  const primary = new ReadinessFakeRpc(primaryPath, "primary-new-recovery");
  const draft = new ReadinessFakeRpc(draftPath, "draft-new-recovery");
  const bridge = new ReadinessBridge({ status: "ready", generation: 1 });
  bridge.onRecover = () => { primary.alive = true; };
  const sessions = {
    list: async () => [{ id: primaryId, sessionId: "primary-new-recovery", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: (id: string) => id === primaryId ? primaryPath : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => draft as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    primaryRuntime: bridge,
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    // Bootstrap binds the healthy Primary. Its crash then sets both the App
    // failure state and controller failure projection.
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    primary.alive = false;
    primary.emit({ type: "pi_chat_process_error", error: "worker crashed" });

    const created = await fetch(`${origin}/api/sessions/new`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    assert.equal(created.status, 200);
    assert.equal(bridge.recoverCalls, 1);
    assert.equal(primary.commands.filter((command) => command.type === "get_state").length >= 2, true, "legacy bridge recovery refreshes Primary state before allocating the draft");

    const afterNew = await (await fetch(`${origin}/api/bootstrap`)).json() as { primaryRuntime: PrimaryRuntimeReadiness };
    assert.deepEqual(afterNew.primaryRuntime, {
      status: "ready",
      generation: 3,
      sessionId: primaryId,
    });
    assert.equal((await fetch(`${origin}/api/sessions/${primaryId}/warm`, { method: "POST" })).status, 200);
    assert.equal(bridge.recoverCalls, 1, "returning to Primary must reuse the recovery finalized for New");
  } finally { server.close(); await app.close(); }
});

test("failed Primary mutation returns stable unavailable response without restart or prompt", async () => {
  const f = await fixture({ status: "failed", generation: 2, error: "protocol mismatch" });
  f.bridge.recoverFailure = { status: "failed", generation: 3, error: "recovery still unavailable" };
  try {
    const response = await fetch(`${f.origin}/api/chat/prompt`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: f.id, message: "must not send" }),
    });
    const body = await response.json();
    assert.equal(response.status, 503, JSON.stringify(body));
    assert.equal(body.error, "Pi Runtime 不可用：recovery still unavailable");
    assert.equal(body.code, "PRIMARY_RUNTIME_UNAVAILABLE");
    assert.match(body.incidentId, /^PC-/);
    assert.deepEqual(body.primaryRuntime, { status: "failed", generation: 3, error: "recovery still unavailable" });
    assert.equal(f.rpc.restartCount, 0);
    assert.equal(f.rpc.commands.some((command) => command.type === "prompt"), false);
  } finally { await f.close(); }
});
