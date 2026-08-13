import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiChatApp } from "../src/server/app";
import { RpcRequestTimeoutError, type PiRpcClient } from "../src/server/rpc-client";
import { idForPath } from "../src/server/session-index";
import type { SessionIndex } from "../src/server/session-index";
import type { ResourceManager } from "../src/server/resource-manager";
import { ModelManager } from "../src/server/model-manager";
import type { SessionSummary } from "../src/shared/types";

class FakeRpc {
  readonly commands: Record<string, unknown>[] = [];
  readonly requestTimeouts: Array<{ type: unknown; timeoutMs: number | undefined; independentRead: boolean }> = [];
  private listeners = new Set<(event: Record<string, unknown>) => void>();
  /** Captures callbacks once registered so a test can model an already-buffered old-child frame after unsubscribe. */
  private readonly historicalListeners = new Set<(event: Record<string, unknown>) => void>();
  streaming = false;
  stopCount = 0;
  restartCount = 0;
  restartFailures = 0;
  alive = true;
  /** Faithful Pi steering queue: queue_update carries the whole backlog, and consumption removes one message before message_start. */
  readonly steeringQueue: string[] = [];

  constructor(readonly path: string, readonly sessionId: string) {}
  onEvent(listener: (event: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    this.historicalListeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: Record<string, unknown>) { for (const listener of this.listeners) listener(event); }
  /** A stopped child can already have a stdout callback queued when unsubscribe runs. */
  emitLate(event: Record<string, unknown>) { for (const listener of this.historicalListeners) listener(event); }
  async start() { this.alive = true; }
  async stop() { this.stopCount += 1; this.alive = false; }
  isRunning() { return this.alive; }
  async restart() {
    this.restartCount += 1;
    if (this.restartFailures > 0) {
      this.restartFailures -= 1;
      this.alive = false;
      throw new Error("simulated restart failure");
    }
    this.alive = true;
    this.streaming = false;
  }
  sendRaw(command: Record<string, unknown>) { this.commands.push(command); }
  crash() { this.alive = false; this.emit({ type: "pi_chat_process_error", error: "worker crashed" }); }
  async send(
    command: Record<string, unknown>,
    timeoutMs?: number,
    options?: { independentRead?: boolean },
  ) {
    this.commands.push(command);
    this.requestTimeouts.push({
      type: command.type,
      timeoutMs,
      independentRead: options?.independentRead === true,
    });
    if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: this.path, sessionId: this.sessionId, isStreaming: this.streaming } };
    if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [] } };
    if (command.type === "get_available_models") return { type: "response", success: true, data: { models: [{ provider: "test", id: "next", name: "Next", reasoning: true }] } };
    if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [] } };
    if (command.type === "get_session_stats") return { type: "response", success: true, data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    if (command.type === "prompt") { this.streaming = true; this.emit({ type: "agent_start" }); return { type: "response", success: true }; }
    if (command.type === "steer") {
      this.steeringQueue.push(String(command.message));
      this.emit({ type: "queue_update", steering: [...this.steeringQueue], followUp: [] });
      return { type: "response", success: true };
    }
    if (command.type === "abort") { this.streaming = false; this.emit({ type: "agent_settled" }); return { type: "response", success: true }; }
    return { type: "response", success: true, data: {} };
  }
}

class PersistedDraftRpc extends FakeRpc {
  private hasPrompt = false;

  override async send(command: Record<string, unknown>) {
    if (command.type === "prompt") this.hasPrompt = true;
    if (command.type === "get_messages" && this.hasPrompt) {
      this.commands.push(command);
      return { type: "response", success: true, data: { messages: [{ role: "user", content: "hello" }] } };
    }
    return super.send(command);
  }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class GateFakeRpc extends FakeRpc {
  override async send(command: Record<string, unknown>) {
    if (command.type === "get_commands") {
      this.commands.push(command);
      return { type: "response", success: true, data: { commands: [{ name: "gate", source: "extension" }] } };
    }
    if (command.type === "prompt" && typeof command.message === "string" && command.message.startsWith("/gate ")) {
      this.commands.push(command);
      return { type: "response", success: true };
    }
    return super.send(command);
  }
}

test("a crashed primary RPC leaves persisted history readable until the next write recovers it", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    primary.streaming = true;
    primary.emit({ type: "agent_start" });
    primary.crash();
    const failedBootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as {
      state: { isStreaming: boolean };
      sessions: Array<{
        id: string;
        running?: boolean;
        activity?: { execution?: string; error?: string };
      }>;
    };
    assert.equal(primary.restartCount, 0, "reading bootstrap must not wake a failed Primary Runtime");
    assert.equal(failedBootstrap.state.isStreaming, false);
    const failedSession = failedBootstrap.sessions.find((session) => session.id === id);
    assert.equal(failedSession?.running, false);
    assert.equal(failedSession?.activity?.execution, "failed");
    assert.equal(failedSession?.activity?.error, "worker crashed");
    const prompt = await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "recover on write", sessionId: id }) });
    assert.equal(prompt.status, 202);
    assert.equal(primary.restartCount, 1);
    const recovered = await (await fetch(`${origin}/api/bootstrap`)).json() as {
      sessions: Array<{ id: string; activity?: { execution?: string; error?: string } }>;
    };
    const recoveredSession = recovered.sessions.find((session) => session.id === id);
    assert.notEqual(recoveredSession?.activity?.execution, "failed");
    assert.equal(recoveredSession?.activity?.error, undefined);
  } finally {
    server.close();
    await app.close();
  }
});

test("Session list and history view keep a crashed primary dormant until a write", async () => {
  for (const endpoint of ["/api/sessions", "view"] as const) {
    const path = "C:\\sessions\\primary.jsonl";
    const id = idForPath(path);
    const primary = new FakeRpc(path, "primary");
    const sessions = {
      list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
      pathForId: () => path,
      messagesForId: async () => [],
    } as unknown as SessionIndex;
    const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
    const server = createServer((request, response) => void app.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
      primary.crash();
      const url = endpoint === "view" ? `/api/sessions/${id}/view` : endpoint;
      assert.equal((await fetch(`${origin}${url}`)).status, 200);
      assert.equal(primary.restartCount, 0, `${endpoint} must remain read-only`);
    } finally {
      server.close();
      await app.close();
    }
  }
});

test("a crashed secondary RPC clears stale running state and recovers once on the next prompt", async () => {
  const primaryPath = "C:\\sessions\\primary.jsonl";
  const secondaryPath = "C:\\sessions\\secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "primary");
  const secondary = new FakeRpc(secondaryPath, "secondary");
  const summaries = [
    { id: primaryId, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => secondary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/sessions/${secondaryId}/activate`, { method: "POST" })).status, 200);
    secondary.streaming = true;
    secondary.emit({ type: "agent_start" });
    secondary.crash();
    const afterCrash = await (await fetch(`${origin}/api/sessions`)).json() as { sessions: Array<{ id: string; running?: boolean }> };
    assert.equal(afterCrash.sessions.find((session) => session.id === secondaryId)?.running, false);
    const prompt = await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "recover", sessionId: secondaryId }) });
    assert.equal(prompt.status, 202);
    assert.equal(secondary.restartCount, 1);
    assert.equal(secondary.commands.filter((command) => command.type === "prompt").at(-1)?.message, "recover");
  } finally {
    server.close();
    await app.close();
  }
});

test("running Sessions stage model and thinking changes until their next prompt", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  primary.streaming = true;
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (url: string, body: object) => fetch(`${origin}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    assert.deepEqual(await (await post("/api/models/set", { provider: "test", modelId: "next", sessionId: id })).json(), { model: { provider: "test", id: "next", name: "Next", reasoning: true }, pending: true });
    assert.deepEqual(await (await post("/api/thinking/set", { level: "high", sessionId: id })).json(), { level: "high", pending: true });
    // Busy bootstrap/view calls intentionally do not queue get_state behind the
    // turn. They must therefore expose the accepted pending selections rather
    // than replay the cached model/thinking snapshot from the previous turn.
    const busyBootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as { state: { model: { id: string } | null; thinkingLevel?: string } };
    assert.equal(busyBootstrap.state.model?.id, "next");
    assert.equal(busyBootstrap.state.thinkingLevel, "high");
    const busyView = await (await fetch(`${origin}/api/sessions/${id}/view`)).json() as { state: { model: { id: string } | null; thinkingLevel?: string } };
    assert.equal(busyView.state.model?.id, "next");
    assert.equal(busyView.state.thinkingLevel, "high");
    assert.equal(primary.commands.some((command) => command.type === "set_model" || command.type === "set_thinking_level"), false);
    primary.streaming = false;
    primary.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const prompt = await post("/api/chat/prompt", { message: "next turn", sessionId: id });
    assert.equal(prompt.status, 202);
    const types = primary.commands.map((command) => command.type);
    assert.deepEqual(types.slice(-3), ["set_model", "set_thinking_level", "prompt"]);
  } finally {
    server.close();
    await app.close();
  }
});

test("a crash during a settlement barrier recovers and dispatches existing Secondary queue work", async () => {
  const primaryPath = "C:\\sessions\\barrier-primary.jsonl";
  const secondaryPath = "C:\\sessions\\barrier-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "primary");
  const secondary = new FakeRpc(secondaryPath, "secondary");
  const summaries = [
    { id: primaryId, sessionId: "barrier-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "barrier-secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => secondary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/sessions/${secondaryId}/activate`, { method: "POST" })).status, 200);
    // Simulate a settlement FIFO barrier holding the dispatch lock when the
    // live child dies mid-turn.
    const internals = app as unknown as {
      runtimePool: {
        get(id: string): {
          dispatching: boolean;
          queuePaused: boolean;
          promptQueue: Array<{
            id: string;
            message: string;
            images: [];
            imageCount: number;
            createdAt: number;
          }>;
        } | undefined;
      };
    };
    const runtime = internals.runtimePool.get(secondaryId);
    assert.ok(runtime, "activated Secondary exists");
    runtime.promptQueue.push({
      id: "00000000-0000-4000-8000-000000000701",
      message: "queued before crash",
      images: [],
      imageCount: 0,
      createdAt: 1,
    });
    runtime.dispatching = true;
    secondary.crash();
    assert.equal(
      runtime.dispatching,
      false,
      "process_error releases the stale dispatch lock",
    );
    assert.equal(runtime.queuePaused, false, "the crash does not pause the queue");
    // The next prompt must recover the worker and actually dispatch instead of
    // being silently swallowed behind the stale lock.
    const prompt = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "after crash", sessionId: secondaryId }),
    });
    assert.equal(prompt.status, 202);
    assert.equal(secondary.restartCount, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      secondary.commands
        .filter((command) => command.type === "prompt")
        .map((command) => command.message),
      ["queued before crash"],
      "recovery dispatches the pre-crash FIFO head exactly once",
    );
    assert.deepEqual(
      runtime.promptQueue.map((item) => item.message),
      ["after crash"],
      "the new request queues behind the recovered head rather than stranding both",
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("a Primary crash recovers and dispatches existing queue work", async () => {
  const path = "C:\\sessions\\barrier-primary-queued.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "barrier-primary-queued");
  const sessions = {
    list: async () => [{ id, sessionId: "barrier-primary-queued", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const internals = app as unknown as {
    promptQueue: Array<{
      id: string;
      message: string;
      images: [];
      imageCount: number;
      createdAt: number;
    }>;
    dispatching: boolean;
    queuePaused: boolean;
  };
  try {
    await fetch(`${origin}/api/bootstrap`);
    internals.promptQueue.push({
      id: "00000000-0000-4000-8000-000000000702",
      message: "primary queued before crash",
      images: [],
      imageCount: 0,
      createdAt: 1,
    });
    internals.dispatching = true;
    primary.crash();
    assert.equal(internals.dispatching, false);
    assert.equal(internals.queuePaused, false);

    const prompt = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "primary after crash" }),
    });
    assert.equal(prompt.status, 202);
    assert.equal(primary.restartCount, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      primary.commands
        .filter((command) => command.type === "prompt")
        .map((command) => command.message),
      ["primary queued before crash"],
      "Primary recovery dispatches the pre-crash FIFO head exactly once",
    );
    assert.deepEqual(
      internals.promptQueue.map((item) => item.message),
      ["primary after crash"],
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("model and thinking changes do not claim or transfer Session control", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  primary.streaming = true;
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const post = (url: string, client: string, body: object) => fetch(`${origin}${url}`, { method: "POST", headers: { "content-type": "application/json", "x-pi-chat-client": client }, body: JSON.stringify(body) });
  const controllers = (app as unknown as { sessionControllers: Map<string, string> }).sessionControllers;
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`, { headers: { "x-pi-chat-client": first } })).status, 200);
    assert.equal((await post("/api/models/set", first, { provider: "test", modelId: "next", sessionId: id })).status, 200);
    assert.equal((await post("/api/thinking/set", first, { level: "high", sessionId: id })).status, 200);
    assert.equal(controllers.has(id), false);
    assert.equal((await post("/api/thinking/set", second, { level: "low", sessionId: id })).status, 200);
    assert.equal(controllers.has(id), false);
    assert.equal((await post("/api/chat/prompt", second, { message: "claim by sending", sessionId: id })).status, 202);
    assert.equal(controllers.get(id), second);
    const foreignThinking = await post("/api/thinking/set", first, { level: "max", sessionId: id });
    assert.equal(foreignThinking.status, 409);
    assert.match((await foreignThinking.json() as { error: string }).error, /另一窗口/);
    assert.equal(controllers.get(id), second);
  } finally {
    server.close();
    await app.close();
  }
});

test("idle secondary workers use LRU capacity reclamation without stopping active work", async () => {
  const pathA = "C:\\sessions\\a.jsonl";
  const pathB = "C:\\sessions\\b.jsonl";
  const pathC = "C:\\sessions\\c.jsonl";
  const idA = idForPath(pathA);
  const idB = idForPath(pathB);
  const idC = idForPath(pathC);
  const primary = new FakeRpc(pathA, "a");
  const firstB = new FakeRpc(pathB, "b");
  const workerC = new FakeRpc(pathC, "c");
  const reopenedB = new FakeRpc(pathB, "b");
  const workers = [firstB, workerC, reopenedB];
  const summaries = [
    { id: idA, sessionId: "a", name: "A", preview: "A", cwd: process.cwd(), updatedAt: 3, messageCount: 1, active: true },
    { id: idB, sessionId: "b", name: "B", preview: "B", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: false },
    { id: idC, sessionId: "c", name: "C", preview: "C", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async (activePath?: string) => summaries.map((session) => ({ ...session, active: session.id === idForPath(activePath || pathA) })),
    pathForId: (id: string) => id === idA ? pathA : id === idB ? pathB : id === idC ? pathC : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => workers.shift() as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    maxIdleSecondaryRuntimes: 1,
    secondaryRuntimeIdleMs: 60_000,
    secondaryRuntimeSweepMs: 60_000,
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/activate`, { method: "POST" })).status, 200);
    assert.equal(firstB.stopCount, 0);
    // Activating C exceeds one idle secondary worker, so the oldest idle B worker is reclaimed.
    assert.equal((await fetch(`${origin}/api/sessions/${idC}/activate`, { method: "POST" })).status, 200);
    assert.equal(firstB.stopCount, 1);
    assert.equal(workerC.stopCount, 0);

    // A running worker is never evicted to make capacity for another viewed Session.
    assert.equal((await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "keep C", sessionId: idC }) })).status, 202);
    assert.equal(workerC.streaming, true);
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/activate`, { method: "POST" })).status, 200);
    assert.equal(workerC.stopCount, 0);
    const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as { activeSessionIds: string[] };
    assert.deepEqual(new Set(bootstrap.activeSessionIds), new Set([idA, idB, idC]));
  } finally {
    server.close();
    await app.close();
  }
});

test("a reclaimed Runtime's late terminal, settlement, and error frames cannot contaminate another Session", async () => {
  const primaryPath = "C:\\sessions\\primary-stale-reclaim.jsonl";
  const pathA = "C:\\sessions\\stale-a.jsonl";
  const pathB = "C:\\sessions\\clean-b.jsonl";
  const primaryId = idForPath(primaryPath);
  const idA = idForPath(pathA);
  const idB = idForPath(pathB);
  const primary = new FakeRpc(primaryPath, "primary-stale-reclaim");
  const workerA = new FakeRpc(pathA, "stale-a");
  const workerB = new FakeRpc(pathB, "clean-b");
  const workers = [workerA, workerB];
  const summaries = [
    { id: primaryId, sessionId: "primary-stale-reclaim", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 3, messageCount: 1, active: true },
    { id: idA, sessionId: "stale-a", name: "A", preview: "A persisted", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: false },
    { id: idB, sessionId: "clean-b", name: "B", preview: "B persisted", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async (activePath?: string) => summaries.map((session) => ({ ...session, active: session.id === idForPath(activePath || primaryPath) })),
    pathForId: (id: string) => id === primaryId ? primaryPath : id === idA ? pathA : id === idB ? pathB : null,
    messagesForId: async (id: string) => [{ role: "user", content: id === idB ? "B persisted" : "A persisted" }],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => workers.shift() as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    secondaryRuntimeSweepMs: 60_000,
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const frames: string[] = [];
  const clients = (app as unknown as { sseClients: Map<{ write: (frame: string) => boolean }, string> }).sseClients;
  clients.set({ write: (frame) => { frames.push(frame); return true; } }, "observer");
  try {
    assert.equal((await fetch(`${origin}/api/sessions/${idA}/activate`, { method: "POST" })).status, 200);
    const pool = (app as unknown as {
      runtimePool: { get(id: string): { running: boolean; dispatching: boolean; failed?: boolean; promptQueue: unknown[]; pendingTerminalMessages: unknown[] } | undefined; reclaim(id: string, reason: "idle"): Promise<boolean> };
    }).runtimePool;
    assert.equal(await pool.reclaim(idA, "idle"), true);
    assert.equal(workerA.stopCount, 1);
    assert.equal(pool.get(idA), undefined);

    assert.equal((await fetch(`${origin}/api/sessions/${idB}/activate`, { method: "POST" })).status, 200);
    const runtimeB = pool.get(idB);
    assert.ok(runtimeB);
    const before = {
      frames: frames.length,
      running: runtimeB.running,
      dispatching: runtimeB.dispatching,
      failed: runtimeB.failed,
      queue: [...runtimeB.promptQueue],
      terminals: [...runtimeB.pendingTerminalMessages],
    };

    // Models stdout callbacks already queued by A's stopped child: the Runtime
    // object has been detached, so none may route through B or reach SSE.
    workerA.emitLate({ type: "message_end", message: { role: "assistant", content: "A_STALE_MARKER" } });
    workerA.emitLate({ type: "agent_settled" });
    workerA.emitLate({ type: "pi_chat_process_error", error: "A_STALE_MARKER" });
    await new Promise((resolve) => setTimeout(resolve, 15));

    assert.equal(frames.length, before.frames, "stale A events must not publish an SSE frame for B");
    assert.equal(runtimeB.running, before.running);
    assert.equal(runtimeB.dispatching, before.dispatching);
    assert.equal(runtimeB.failed, before.failed);
    assert.deepEqual(runtimeB.promptQueue, before.queue);
    assert.deepEqual(runtimeB.pendingTerminalMessages, before.terminals);
    const view = await (await fetch(`${origin}/api/sessions/${idB}/view`)).json() as { messages: Array<{ content?: unknown }>; liveMessage?: { content?: unknown }; activity?: unknown };
    assert.doesNotMatch(JSON.stringify(view), /A_STALE_MARKER/);
    assert.equal(view.liveMessage, undefined);
  } finally {
    clients.clear();
    server.close();
    await app.close();
  }
});

test("four viewed idle Sessions still obey a configured cap of three idle Secondary Runtimes", async () => {
  const paths = ["C:\\sessions\\primary.jsonl", "C:\\sessions\\one.jsonl", "C:\\sessions\\two.jsonl", "C:\\sessions\\three.jsonl", "C:\\sessions\\four.jsonl"];
  const ids = paths.map(idForPath);
  const primary = new FakeRpc(paths[0], "primary");
  const workers = paths.slice(1).map((path, index) => new FakeRpc(path, `secondary-${index}`));
  const pendingWorkers = [...workers];
  const summaries = paths.map((path, index) => ({ id: ids[index], sessionId: `s${index}`, name: `S${index}`, preview: "", cwd: process.cwd(), updatedAt: 10 - index, messageCount: 1, active: index === 0 }));
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => paths[ids.indexOf(id)] || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => pendingWorkers.shift() as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    maxIdleSecondaryRuntimes: 3,
    secondaryRuntimeIdleMs: 60_000,
    secondaryRuntimeSweepMs: 60_000,
  });
  const internals = app as unknown as { connectedClients: Map<string, number>; viewedSessionsByClient: Map<string, string>; runtimes: Map<string, unknown> };
  for (let index = 1; index <= 4; index += 1) {
    const client = `${index}`.repeat(8) + "-1111-4111-8111-111111111111";
    internals.connectedClients.set(client, 1);
    internals.viewedSessionsByClient.set(client, ids[index]);
  }
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const activations = await Promise.all(ids.slice(1).map((id) => fetch(`${origin}/api/sessions/${id}/activate`, { method: "POST" })));
    assert.ok(activations.every((response) => response.status === 200));
    assert.equal(internals.runtimes.size, 3);
    assert.equal(workers.reduce((count, worker) => count + worker.stopCount, 0), 1);
    const reclaimedIndex = workers.findIndex((worker) => worker.stopCount === 1);
    assert.ok(reclaimedIndex >= 0);
    const reclaimedId = ids[reclaimedIndex + 1];
    assert.equal(internals.runtimes.has(reclaimedId), false);
    const oldHistory = await fetch(`${origin}/api/sessions/${reclaimedId}/view`);
    assert.equal(oldHistory.status, 200);
    assert.equal((await oldHistory.json() as { runtimeStatus?: string }).runtimeStatus, "view-only");
  } finally {
    server.close();
    await app.close();
  }
});

test("concurrent activation never exceeds four Secondary workers or five hot conversations total", async () => {
  const paths = [
    "C:\\sessions\\primary-cap.jsonl",
    "C:\\sessions\\hot-one.jsonl",
    "C:\\sessions\\hot-two.jsonl",
    "C:\\sessions\\hot-three.jsonl",
    "C:\\sessions\\hot-four.jsonl",
    "C:\\sessions\\hot-five.jsonl",
  ];
  const ids = paths.map(idForPath);
  const primary = new FakeRpc(paths[0], "primary-cap");
  const workers = paths.slice(1).map((path, index) => {
    const worker = new FakeRpc(path, `hot-${index + 1}`);
    worker.streaming = true;
    return worker;
  });
  let created = 0;
  const summaries = paths.map((path, index) => ({ id: ids[index], sessionId: `cap-${index}`, name: `Cap ${index}`, preview: "", cwd: process.cwd(), updatedAt: 10 - index, messageCount: 1, active: index === 0 }));
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => paths[ids.indexOf(id)] || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => workers[created++] as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    secondaryRuntimeIdleMs: 60_000,
    secondaryRuntimeSweepMs: 60_000,
  });
  const internals = app as unknown as { runtimes: Map<string, { rpc: FakeRpc }> };
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const responses = await Promise.all(ids.slice(1).map((id) => fetch(`${origin}/api/sessions/${id}/activate`, { method: "POST" })));
    assert.equal(responses.filter((response) => response.status === 200).length, 4);
    assert.equal(responses.filter((response) => response.status === 409).length, 1);
    const rejectedIndex = responses.findIndex((response) => response.status === 409);
    const rejected = responses[rejectedIndex];
    assert.ok(rejected);
    assert.match((await rejected.json() as { error: string }).error, /5 个热对话上限/);
    assert.equal(internals.runtimes.size, 4);
    assert.equal(created, 4);
    assert.equal(workers.slice(0, 4).every((worker) => worker.stopCount === 0), true);

    const releasedIndex = responses.findIndex((response) => response.status === 200);
    const releasedWorker = internals.runtimes.get(ids[releasedIndex + 1])?.rpc;
    assert.ok(releasedWorker);
    releasedWorker.streaming = false;
    releasedWorker.emit({ type: "agent_settled" });
    const admitted = await fetch(`${origin}/api/sessions/${ids[rejectedIndex + 1]}/activate`, { method: "POST" });
    assert.equal(admitted.status, 200);
    assert.equal(releasedWorker.stopCount, 1);
    assert.equal(internals.runtimes.size, 4);
    assert.equal(created, 5);
  } finally {
    server.close();
    await app.close();
  }
});

test("a visible cold history remains readable after its idle Runtime is reclaimed", async () => {
  const pathA = "C:\\sessions\\a.jsonl";
  const pathB = "C:\\sessions\\b.jsonl";
  const idA = idForPath(pathA);
  const idB = idForPath(pathB);
  const primary = new FakeRpc(pathA, "a");
  const secondary = new FakeRpc(pathB, "b");
  const summaries = [
    { id: idA, sessionId: "a", name: "A", preview: "A", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: idB, sessionId: "b", name: "B", preview: "B", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async (activePath?: string) => summaries.map((session) => ({ ...session, active: session.id === idForPath(activePath || pathA) })),
    pathForId: (id: string) => id === idA ? pathA : id === idB ? pathB : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => secondary as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    secondaryRuntimeIdleMs: 0,
    secondaryRuntimeSweepMs: 100,
    controllerReleaseMs: 10,
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const client = "11111111-1111-4111-8111-111111111111";
  const controller = new AbortController();
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`, { headers: { "x-pi-chat-client": client } })).status, 200);
    const events = fetch(`${origin}/api/events`, { headers: { "x-pi-chat-client": client }, signal: controller.signal }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/view`, { headers: { "x-pi-chat-client": client } })).status, 200);
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/activate`, { method: "POST", headers: { "x-pi-chat-client": client } })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(secondary.stopCount, 1);
    const history = await fetch(`${origin}/api/sessions/${idB}/view`, { headers: { "x-pi-chat-client": client } });
    assert.equal(history.status, 200);
    assert.equal((await history.json() as { runtimeStatus?: string }).runtimeStatus, "view-only");
    controller.abort();
    await events;
  } finally {
    controller.abort();
    server.close();
    await app.close();
  }
});

test("an idle secondary worker is reclaimed after its configured timeout", async () => {
  const pathA = "C:\\sessions\\a.jsonl";
  const pathB = "C:\\sessions\\b.jsonl";
  const idA = idForPath(pathA);
  const idB = idForPath(pathB);
  const primary = new FakeRpc(pathA, "a");
  const secondary = new FakeRpc(pathB, "b");
  const summaries = [
    { id: idA, sessionId: "a", name: "A", preview: "A", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: idB, sessionId: "b", name: "B", preview: "B", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async (activePath?: string) => summaries.map((session) => ({ ...session, active: session.id === idForPath(activePath || pathA) })),
    pathForId: (id: string) => id === idA ? pathA : id === idB ? pathB : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => secondary as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    secondaryRuntimeIdleMs: 0,
    secondaryRuntimeSweepMs: 100,
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/activate`, { method: "POST" })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(secondary.stopCount, 1);
    const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as { activeSessionIds: string[] };
    assert.deepEqual(bootstrap.activeSessionIds, [idA]);
    assert.equal(primary.stopCount, 0);
  } finally {
    server.close();
    await app.close();
  }
});

test("New creates an independent draft while the primary Session is running", async () => {
  const primaryPath = "C:\\sessions\\primary.jsonl";
  const draftPath = "C:\\sessions\\draft.jsonl";
  const primaryId = idForPath(primaryPath);
  const draftId = idForPath(draftPath);
  const primary = new FakeRpc(primaryPath, "primary");
  primary.streaming = true;
  const draft = new FakeRpc(draftPath, "draft");
  const sessions = {
    list: async (activePath?: string) => [{ id: primaryId, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: primaryId === idForPath(activePath || primaryPath) }],
    pathForId: (id: string) => id === primaryId ? primaryPath : id === draftId ? draftPath : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => draft as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/api/sessions/new`, { method: "POST" });
    assert.equal(response.status, 200);
    const view = await response.json() as { session: { id: string; name: string }; isStreaming: boolean };
    assert.equal(view.session.id, draftId);
    assert.equal(view.session.name, "新对话");
    assert.equal(view.isStreaming, false);
    assert.equal(primary.commands.some((command) => command.type === "new_session"), false);
    assert.equal(draft.commands.some((command) => command.type === "new_session"), false);
    assert.equal((await fetch(`${origin}/api/sessions`)).status, 200);
  } finally {
    server.close();
    await app.close();
  }
});

test("a prompted draft stays in its selected cwd group before SessionIndex catches up", async () => {
  const selectedCwd = await mkdtemp(join(tmpdir(), "pi-chat-draft-cwd-"));
  const primaryPath = "C:\\sessions\\primary.jsonl";
  const draftPath = join(selectedCwd, "draft.jsonl");
  const primaryId = idForPath(primaryPath);
  const draftId = idForPath(draftPath);
  const primary = new FakeRpc(primaryPath, "primary");
  const draft = new PersistedDraftRpc(draftPath, "draft");
  const sessions = {
    // Deliberately omit the new draft to reproduce the scan-lag window.
    list: async (activePath?: string) => [{ id: primaryId, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: primaryId === idForPath(activePath || primaryPath) }],
    pathForId: (id: string) => id === primaryId ? primaryPath : null,
    summaryForId: () => null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  let createdCwd = "";
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: (cwd) => { createdCwd = cwd; return draft as unknown as PiRpcClient; },
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const client = "11111111-1111-4111-8111-111111111111";
  const headers = { "content-type": "application/json", "x-pi-chat-client": client };
  try {
    const created = await fetch(`${origin}/api/sessions/new`, { method: "POST", headers, body: JSON.stringify({ cwd: selectedCwd }) });
    assert.equal(created.status, 200);
    assert.equal((await created.json() as { session: { id: string } }).session.id, draftId);
    assert.equal(createdCwd, selectedCwd);
    const prompted = await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers, body: JSON.stringify({ message: "hello", sessionId: draftId }) });
    assert.equal(prompted.status, 202);
    draft.streaming = false;
    draft.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sidebar = await (await fetch(`${origin}/api/sessions`, { headers })).json() as { sessions: SessionSummary[]; directories: Array<{ cwd: string }> };
    assert.equal(sidebar.sessions.find((session) => session.id === draftId)?.cwd, selectedCwd);
    assert.equal(sidebar.directories.some((directory) => directory.cwd === selectedCwd), true);
  } finally {
    server.close();
    await app.close();
    await rm(selectedCwd, { recursive: true, force: true });
  }
});

test("Primary and Secondary settlement dispatch every queued follow-up", async () => {
  const pathA = "C:\\sessions\\queue-primary.jsonl";
  const pathB = "C:\\sessions\\queue-secondary.jsonl";
  const idA = idForPath(pathA);
  const idB = idForPath(pathB);
  const primary = new FakeRpc(pathA, "queue-primary");
  const secondary = new FakeRpc(pathB, "queue-secondary");
  const sessions = {
    list: async (activePath?: string) => [
      { id: idA, sessionId: "queue-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: idForPath(activePath || pathA) === idA },
      { id: idB, sessionId: "queue-secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
    ],
    pathForId: (id: string) => id === idA ? pathA : id === idB ? pathB : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => secondary as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const prompt = (sessionId: string, message: string) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, message }),
  });
  const settle = async (rpc: FakeRpc) => {
    rpc.streaming = false;
    rpc.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  try {
    await fetch(`${origin}/api/bootstrap`);
    await fetch(`${origin}/api/sessions/${idB}/view`);
    for (const [id, rpc, prefix] of [[idA, primary, "primary"], [idB, secondary, "secondary"]] as const) {
      await prompt(id, `${prefix}-A`);
      await prompt(id, `${prefix}-B`);
      await prompt(id, `${prefix}-C`);
      await settle(rpc);
      assert.ok(
        rpc.requestTimeouts.some(
          ({ type, timeoutMs, independentRead }) =>
            type === "get_state" &&
            timeoutMs === 60_000 &&
            independentRead,
        ),
        "the post-settlement FIFO barrier must be a long independent state read",
      );
      assert.deepEqual(rpc.commands.filter((command) => command.type === "prompt").map((command) => command.message), [`${prefix}-A`, `${prefix}-B`]);
      await settle(rpc);
      assert.deepEqual(rpc.commands.filter((command) => command.type === "prompt").map((command) => command.message), [`${prefix}-A`, `${prefix}-B`, `${prefix}-C`]);
    }
  } finally {
    server.close();
    await app.close();
  }
});

test("steering bypasses local queues for running Primary and Secondary only", async () => {
  const primaryPath = "C:\\sessions\\steer-primary.jsonl";
  const secondaryPath = "C:\\sessions\\steer-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "steer-primary");
  const secondary = new FakeRpc(secondaryPath, "steer-secondary");
  const summaries = [
    { id: primaryId, sessionId: "steer-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "steer-secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    summaryForId: (id: string) => summaries.find((session) => session.id === id) || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => secondary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const steer = (sessionId: string, message: string) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, message, delivery: "steer" }),
  });
  try {
    await fetch(`${origin}/api/bootstrap`);
    await fetch(`${origin}/api/sessions/${secondaryId}/warm`, { method: "POST" });

    const idle = await steer(primaryId, "too late");
    assert.equal(idle.status, 409);
    assert.match((await idle.json() as { error: string }).error, /未在运行/);
    assert.equal(primary.commands.some((command) => command.type === "steer"), false);

    primary.streaming = true;
    secondary.streaming = true;
    primary.emit({ type: "agent_start" });
    secondary.emit({ type: "agent_start" });
    const primarySteer = await steer(primaryId, "redirect primary");
    const secondarySteer = await steer(secondaryId, "redirect secondary");
    assert.equal(primarySteer.status, 202);
    assert.deepEqual(await primarySteer.json(), {
      accepted: true,
      queued: false,
      steered: true,
    });
    assert.equal(secondarySteer.status, 202);
    assert.deepEqual(await secondarySteer.json(), {
      accepted: true,
      queued: false,
      steered: true,
    });
    assert.deepEqual(
      primary.commands.filter((command) => command.type === "steer").map((command) => command.message),
      ["redirect primary"],
    );
    assert.deepEqual(
      secondary.commands.filter((command) => command.type === "steer").map((command) => command.message),
      ["redirect secondary"],
    );
    assert.deepEqual((app as unknown as { promptQueue: unknown[] }).promptQueue, []);
    assert.deepEqual(
      (app as unknown as { runtimePool: { get(id: string): { promptQueue: unknown[] } | undefined } }).runtimePool.get(secondaryId)?.promptQueue,
      [],
    );

    const abortSecondary = await fetch(`${origin}/api/chat/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: secondaryId }),
    });
    assert.equal(abortSecondary.status, 200);
    assert.equal(secondary.restartCount, 1, "Stop must reset an unconsumed native steering queue");
  } finally {
    server.close();
    await app.close();
  }
});

test("a Steer that reaches an already-settled Pi is rejected and cleared without becoming a prompt", async () => {
  const path = "C:\\sessions\\steer-settle-race.jsonl";
  const id = idForPath(path);
  class SettledBeforeSteerAckRpc extends FakeRpc {
    override async send(command: Record<string, unknown>, timeoutMs?: number) {
      if (command.type === "steer") {
        const response = await super.send(command, timeoutMs);
        this.streaming = false;
        this.emit({ type: "agent_settled" });
        return response;
      }
      return super.send(command, timeoutMs);
    }
  }
  const primary = new SettledBeforeSteerAckRpc(path, "steer-settle-race");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-settle-race", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const response = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "too late", delivery: "steer" }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /已结束/);
    assert.equal(primary.restartCount, 1);
    assert.equal(
      primary.commands.some(
        (command) => command.type === "prompt" && command.message === "too late",
      ),
      false,
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("settlement clears native steering even when the post-Steer state snapshot was still running", async () => {
  const path = "C:\\sessions\\steer-late-settle.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-late-settle");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-late-settle", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const response = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "accepted before late settle", delivery: "steer" }),
    });
    assert.equal(response.status, 202);
    primary.streaming = false;
    primary.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(primary.restartCount, 1);
    assert.equal(
      primary.commands.some(
        (command) =>
          command.type === "prompt" &&
          command.message === "accepted before late settle",
      ),
      false,
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("a crashed worker's stale steering state cannot reset the recovered Runtime", async () => {
  const path = "C:\\sessions\\steer-crash-recover.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-crash-recover");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-crash-recover", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const prompt = (message: string, delivery?: string) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: id, message, ...(delivery ? { delivery } : {}) }),
  });
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const steer = await prompt("queued before crash", "steer");
    assert.equal(steer.status, 202);
    // The worker crashes before consuming: process-error must clear the stale
    // steering bookkeeping instead of leaving it for the replacement worker.
    primary.crash();
    // A later ordinary prompt recovers the Runtime and runs normally.
    const recovered = await prompt("recover me");
    assert.equal(recovered.status, 202);
    // The recovered worker settles; stale steering must not reset it again.
    primary.streaming = false;
    primary.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(primary.restartCount, 1, "only the recovery restart may occur");
  } finally {
    server.close();
    await app.close();
  }
});

test("only a verified dequeue consumes a Steer admission, never a same-text ordinary prompt", async () => {
  const path = "C:\\sessions\\steer-verified-consume.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-verified-consume");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-verified-consume", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const state = app as unknown as {
    nativeSteeringAdmissionsBySession: Map<string, { generation: number; items: Array<{ message: string; promptAt: number }> }>;
    lastUserPromptAtBySession: Map<string, number>;
  };
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const steer = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "继续", delivery: "steer" }),
    });
    assert.equal(steer.status, 202);
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id)?.items.length, 1);
    // An ordinary prompt with the identical text emits message_start without a
    // prior dequeue; it must not consume the admission.
    primary.emit({ type: "message_start", message: { role: "user", content: "继续" } });
    assert.equal(
      state.nativeSteeringAdmissionsBySession.get(id)?.items.length,
      1,
      "text-only message_start must not consume a Steer admission",
    );
    // Pi consumes the steer: it dequeues (queue_update shrinks) immediately
    // before the consuming message_start.
    primary.emit({ type: "queue_update", steering: [], followUp: [] });
    primary.emit({ type: "message_start", message: { role: "user", content: "继续" } });
    assert.equal(
      state.nativeSteeringAdmissionsBySession.get(id),
      undefined,
      "verified dequeue + message_start consumes the admission",
    );
    assert.equal(state.lastUserPromptAtBySession.has(id), true);
  } finally {
    server.close();
    await app.close();
  }
});

test("identical native Steers are consumed as distinct queue occurrences", async () => {
  const path = "C:\\sessions\\steer-identical.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-identical");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-identical", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const state = app as unknown as {
    pendingNativeSteeringBySession: Map<string, { messages: string[]; dequeued: string[] }>;
    nativeSteeringAdmissionsBySession: Map<string, { items: Array<{ message: string }> }>;
  };
  const steer = () => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: id, message: "继续", delivery: "steer" }),
  });
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    assert.equal((await steer()).status, 202);
    assert.equal((await steer()).status, 202);
    assert.deepEqual(primary.steeringQueue, ["继续", "继续"]);
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id)?.items.length, 2);

    primary.steeringQueue.shift();
    primary.emit({ type: "queue_update", steering: [...primary.steeringQueue], followUp: [] });
    primary.emit({ type: "message_start", message: { role: "user", content: "继续" } });
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id)?.items.length, 1);
    assert.deepEqual(state.pendingNativeSteeringBySession.get(id), {
      generation: 0,
      messages: ["继续"],
      dequeued: [],
    });

    primary.steeringQueue.shift();
    primary.emit({ type: "queue_update", steering: [], followUp: [] });
    primary.emit({ type: "message_start", message: { role: "user", content: "继续" } });
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id), undefined);
    assert.equal(state.pendingNativeSteeringBySession.get(id), undefined);
  } finally {
    server.close();
    await app.close();
  }
});

test("a verified Steer dequeue survives an intervening queue_update", async () => {
  const path = "C:\\sessions\\steer-dequeue-gap.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-dequeue-gap");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-dequeue-gap", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const state = app as unknown as {
    pendingNativeSteeringBySession: Map<string, { messages: string[]; dequeued: string[] }>;
    nativeSteeringAdmissionsBySession: Map<string, { items: Array<{ message: string }> }>;
  };
  const steer = (message: string) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: id, message, delivery: "steer" }),
  });
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    assert.equal((await steer("A")).status, 202);
    assert.equal((await steer("B")).status, 202);
    primary.steeringQueue.shift();
    primary.emit({ type: "queue_update", steering: [...primary.steeringQueue], followUp: [] });
    assert.deepEqual(state.pendingNativeSteeringBySession.get(id)?.dequeued, ["A"]);

    assert.equal((await steer("C")).status, 202);
    assert.deepEqual(
      state.pendingNativeSteeringBySession.get(id),
      { generation: 0, messages: ["B", "C"], dequeued: ["A"] },
      "a later queue_update must retain the earlier verified dequeue",
    );
    primary.emit({ type: "message_start", message: { role: "user", content: "A" } });
    assert.deepEqual(
      state.nativeSteeringAdmissionsBySession.get(id)?.items.map((item) => item.message),
      ["B", "C"],
    );
    assert.deepEqual(state.pendingNativeSteeringBySession.get(id), {
      generation: 0,
      messages: ["B", "C"],
      dequeued: [],
    });
  } finally {
    server.close();
    await app.close();
  }
});

test("failed settlement reset still clears lost native Steers and broadcasts the reason", async () => {
  const path = "C:\\sessions\\steer-reset-failure.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-reset-failure");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-reset-failure", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const frames: string[] = [];
  const clients = (app as unknown as { sseClients: Map<{ write: (frame: string) => boolean }, string> }).sseClients;
  clients.set({ write: (frame) => { frames.push(frame); return true; } }, "11111111-1111-4111-8111-111111111111");
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const state = app as unknown as {
    pendingNativeSteeringBySession: Map<string, unknown>;
    nativeSteeringAdmissionsBySession: Map<string, unknown>;
  };
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const accepted = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "lost during reset", delivery: "steer" }),
    });
    assert.equal(accepted.status, 202);
    primary.restartFailures = 1;
    primary.streaming = false;
    primary.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(primary.restartCount, 1);
    assert.equal(state.pendingNativeSteeringBySession.get(id), undefined);
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id), undefined);
    const cleared = frames.find((frame) =>
      frame.includes('"type":"pi_chat_native_steering_cleared"'),
    );
    assert.ok(cleared, "restart failure must settle accepted Steers");
    assert.match(cleared, /"reason":"process-error"/);
    assert.match(cleared, /"droppedCount":1/);
    const processError = frames.find((frame) =>
      frame.includes('"type":"pi_chat_process_error"'),
    );
    assert.match(
      processError || "",
      /"nativeSteeringDroppedCount":1/,
      "the synthesized process error must preserve the specific drop verdict",
    );
  } finally {
    clients.clear();
    server.close();
    await app.close();
  }
});

test("a post-Steer get_state timeout keeps the accepted Steer as 202", async () => {
  const path = "C:\\sessions\\steer-probe-timeout.jsonl";
  const id = idForPath(path);
  class StateTimeoutAfterSteerRpc extends FakeRpc {
    override async send(command: Record<string, unknown>, timeoutMs?: number) {
      if (
        command.type === "get_state" &&
        this.commands.some((candidate) => candidate.type === "steer")
      ) {
        this.commands.push(command);
        throw new RpcRequestTimeoutError("get_state");
      }
      return super.send(command, timeoutMs);
    }
  }
  const primary = new StateTimeoutAfterSteerRpc(path, "steer-probe-timeout");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-probe-timeout", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const response = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "accepted under timeout", delivery: "steer" }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      accepted: true,
      queued: false,
      steered: true,
    });
  } finally {
    server.close();
    await app.close();
  }
});

test("a timed-out Steer write retains its admission for later verified consumption", async () => {
  const path = "C:\\sessions\\steer-write-timeout.jsonl";
  const id = idForPath(path);
  class SteerTimeoutRpc extends FakeRpc {
    override async send(command: Record<string, unknown>, timeoutMs?: number) {
      if (command.type === "steer") {
        await super.send(command, timeoutMs);
        throw new RpcRequestTimeoutError("steer");
      }
      return super.send(command, timeoutMs);
    }
  }
  const primary = new SteerTimeoutRpc(path, "steer-write-timeout");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-write-timeout", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const state = app as unknown as {
    nativeSteeringAdmissionsBySession: Map<string, { items: unknown[] }>;
  };
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const response = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "possibly queued", delivery: "steer" }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      accepted: true,
      queued: false,
      steered: true,
      deliveryUncertain: true,
    });
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id)?.items.length, 1);
    primary.steeringQueue.shift();
    primary.emit({ type: "queue_update", steering: [], followUp: [] });
    primary.emit({ type: "message_start", message: { role: "user", content: "possibly queued" } });
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id), undefined);
  } finally {
    server.close();
    await app.close();
  }
});

test("a timed-out Steer without queue_update is cleared when the active turn settles", async () => {
  const path = "C:\\sessions\\steer-timeout-no-snapshot.jsonl";
  const id = idForPath(path);
  class LostSteerTimeoutRpc extends FakeRpc {
    override async send(command: Record<string, unknown>, timeoutMs?: number) {
      if (command.type === "steer") {
        // Model a write that reached an indeterminate transport boundary: no
        // queue_update proves Pi accepted it, but the local admission remains.
        this.commands.push(command);
        throw new RpcRequestTimeoutError("steer");
      }
      return super.send(command, timeoutMs);
    }
  }
  const primary = new LostSteerTimeoutRpc(path, "steer-timeout-no-snapshot");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-timeout-no-snapshot", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const state = app as unknown as {
    pendingNativeSteeringBySession: Map<string, unknown>;
    nativeSteeringAdmissionsBySession: Map<string, { items: unknown[] }>;
  };
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const response = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "possibly lost", delivery: "steer" }),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json() as { deliveryUncertain?: boolean }).deliveryUncertain, true);
    assert.equal(state.pendingNativeSteeringBySession.get(id), undefined);
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id)?.items.length, 1);

    primary.streaming = false;
    primary.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(primary.restartCount, 1);
    assert.equal(state.pendingNativeSteeringBySession.get(id), undefined);
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id), undefined);
  } finally {
    server.close();
    await app.close();
  }
});

test("native steering backlog is bounded and rejects the 21st Steer", async () => {
  const path = "C:\\sessions\\steer-backlog.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-backlog");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-backlog", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const steer = (message: string) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: id, message, delivery: "steer" }),
  });
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    for (let index = 0; index < 20; index += 1) {
      const response = await steer(`steer ${index}`);
      assert.equal(response.status, 202, `steer ${index} should be accepted`);
    }
    const overflow = await steer("steer overflow");
    assert.equal(overflow.status, 409);
    assert.match((await overflow.json() as { error: string }).error, /已满/);
    assert.equal(
      primary.commands.filter((command) => command.type === "steer").length,
      20,
      "the 21st Steer must never reach Pi",
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("native steering image payload is bounded", async () => {
  const path = "C:\\sessions\\steer-image-bound.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-image-bound");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-image-bound", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const steerWithImages = (message: string, imageData: string[]) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: id,
      message,
      delivery: "steer",
      images: imageData.map((data) => ({ mimeType: "image/png", data })),
    }),
  });
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    // ~33 MB chars of queued images stay under the 45 MB bound.
    const accepted = await steerWithImages("look", ["a".repeat(11_000_000), "a".repeat(11_000_000), "a".repeat(11_000_000)]);
    assert.equal(accepted.status, 202);
    // The next payload pushes the queued total over the bound.
    const overflow = await steerWithImages("look again", ["b".repeat(6_100_000), "b".repeat(6_100_000)]);
    assert.equal(overflow.status, 409);
    assert.match((await overflow.json() as { error: string }).error, /图片总量/);
  } finally {
    server.close();
    await app.close();
  }
});

test("a Steer admitted while abort is in flight is reset by the live pending re-check", async () => {
  const path = "C:\\sessions\\steer-during-abort.jsonl";
  const id = idForPath(path);
  class GatedAbortRpc extends FakeRpc {
    releaseAbort!: () => void;
    private readonly abortGate = new Promise<void>((resolve) => {
      this.releaseAbort = resolve;
    });
    override async send(command: Record<string, unknown>) {
      if (command.type === "abort") {
        this.commands.push(command);
        await this.abortGate;
        this.streaming = false;
        return { type: "response", success: true };
      }
      return super.send(command);
    }
  }
  const primary = new GatedAbortRpc(path, "steer-during-abort");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-during-abort", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const abort = fetch(`${origin}/api/chat/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
    });
    // Steer arrives while the abort command is still in flight.
    const steer = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "during abort", delivery: "steer" }),
    });
    assert.equal(steer.status, 202);
    primary.releaseAbort();
    const abortResponse = await abort;
    assert.equal(abortResponse.status, 200);
    assert.equal(primary.restartCount, 1, "the live pending re-check must reset the unconsumed Steer");
  } finally {
    server.close();
    await app.close();
  }
});

test("a timed-out Primary prompt returns deliveryUncertain and queues the next message safely", async () => {
  const path = "C:\\sessions\\primary-prompt-timeout.jsonl";
  const id = idForPath(path);
  class PromptTimeoutRpc extends FakeRpc {
    override async send(command: Record<string, unknown>, timeoutMs?: number) {
      if (command.type === "prompt") {
        this.commands.push(command);
        this.streaming = true;
        this.emit({ type: "agent_start" });
        throw new RpcRequestTimeoutError("prompt");
      }
      return super.send(command, timeoutMs);
    }
  }
  const primary = new PromptTimeoutRpc(path, "primary-prompt-timeout");
  const summaries = [
    { id, sessionId: "primary-prompt-timeout", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const prompt = (message: string) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: id, message }),
  });
  try {
    await fetch(`${origin}/api/bootstrap`);
    const uncertain = await prompt("possibly accepted");
    assert.equal(uncertain.status, 202);
    assert.deepEqual(await uncertain.json(), {
      accepted: true,
      queued: false,
      deliveryUncertain: true,
    });
    const queued = await prompt("must wait behind uncertain turn");
    assert.equal(queued.status, 202);
    const body = await queued.json() as {
      accepted: boolean;
      queued: boolean;
      queue: Array<{ message: string }>;
    };
    assert.equal(body.queued, true);
    assert.deepEqual(body.queue.map((item) => item.message), [
      "must wait behind uncertain turn",
    ]);
    assert.deepEqual(
      primary.commands
        .filter((command) => command.type === "prompt")
        .map((command) => command.message),
      ["possibly accepted"],
      "the next prompt must not race a command Pi may already be executing",
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("abort timeouts remain accepted while Primary and Secondary wait to settle", async () => {
  const primaryPath = "C:\\sessions\\abort-primary.jsonl";
  const secondaryPath = "C:\\sessions\\abort-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  class SlowAbortRpc extends FakeRpc {
    override async send(command: Record<string, unknown>) {
      if (command.type === "abort") {
        this.commands.push(command);
        throw new RpcRequestTimeoutError("abort");
      }
      return super.send(command);
    }
  }
  const primary = new SlowAbortRpc(primaryPath, "abort-primary");
  const secondary = new SlowAbortRpc(secondaryPath, "abort-secondary");
  primary.streaming = true;
  secondary.streaming = true;
  const summaries = [
    { id: primaryId, sessionId: "abort-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "abort-secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    summaryForId: (id: string) => summaries.find((session) => session.id === id) || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => secondary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const postAbort = (sessionId: string) => fetch(`${origin}/api/chat/abort`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId }) });
  try {
    await fetch(`${origin}/api/bootstrap`);
    await fetch(`${origin}/api/sessions/${secondaryId}/warm`, { method: "POST" });
    for (const sessionId of [primaryId, secondaryId]) {
      const response = await postAbort(sessionId);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        abortPending: true,
        isStreaming: true,
        queuePaused: false,
      });
    }
  } finally {
    server.close();
    await app.close();
  }
});

test("all opened sessions route prompts, events and aborts to independent RPC workers", async () => {
  const pathA = "C:\\sessions\\a.jsonl";
  const pathB = "C:\\sessions\\b.jsonl";
  const pathC = "C:\\sessions\\c.jsonl";
  const idA = idForPath(pathA);
  const idB = idForPath(pathB);
  const idC = idForPath(pathC);
  const primary = new FakeRpc(pathA, "a");
  const secondary = new FakeRpc(pathB, "b");
  const third = new FakeRpc(pathC, "c");
  const summaries = [
    { id: idA, sessionId: "a", name: "A", preview: "A", cwd: process.cwd(), updatedAt: 3, messageCount: 0, active: true },
    { id: idB, sessionId: "b", name: "B", preview: "B", cwd: process.cwd(), updatedAt: 2, messageCount: 0, active: false },
    { id: idC, sessionId: "c", name: "C", preview: "C", cwd: process.cwd(), updatedAt: 1, messageCount: 0, active: false },
  ];
  const workers = [secondary, third];
  const sessions = {
    list: async (activePath?: string) => summaries.map((session) => ({ ...session, active: session.id === idForPath(activePath || pathA) })),
    pathForId: (id: string) => id === idA ? pathA : id === idB ? pathB : id === idC ? pathC : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => workers.shift() as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: object = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as { activeSessionIds: string[] };
    assert.deepEqual(bootstrap.activeSessionIds, [idA]);
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/view`)).status, 200);
    assert.equal((await fetch(`${origin}/api/sessions/${idC}/view`)).status, 200);

    assert.equal((await post("/api/chat/prompt", { message: "for A", sessionId: idA })).status, 202);
    assert.equal((await post("/api/chat/prompt", { message: "for B", sessionId: idB })).status, 202);
    assert.equal((await post("/api/chat/prompt", { message: "for C", sessionId: idC })).status, 202);
    assert.deepEqual(primary.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for A"]);
    assert.deepEqual(secondary.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for B"]);
    assert.deepEqual(third.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for C"]);
    assert.equal(primary.streaming, true);
    assert.equal(secondary.streaming, true);
    assert.equal(third.streaming, true);

    const queuedB2 = await post("/api/chat/prompt", { message: "B queued then cancelled", sessionId: idB });
    const queuedB2Data = await queuedB2.json() as { queued: boolean; id: string };
    assert.equal(queuedB2.status, 202);
    assert.equal(queuedB2Data.queued, true);
    const queuedB3 = await post("/api/chat/prompt", { message: "B queued then dispatched", sessionId: idB });
    assert.equal((await queuedB3.json() as { queued: boolean }).queued, true);
    const cancelled = await fetch(`${origin}/api/chat/queue/${queuedB2Data.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: idB }) });
    assert.equal(cancelled.status, 200);
    assert.deepEqual((await cancelled.json() as { queue: Array<{ message: string }> }).queue.map((item) => item.message), ["B queued then dispatched"]);

    const abortedB = await post("/api/chat/abort", { sessionId: idB });
    assert.equal(abortedB.status, 200);
    assert.equal((await abortedB.json() as { queuePaused: boolean }).queuePaused, true);
    assert.equal(primary.streaming, true);
    assert.equal(secondary.streaming, false);
    assert.equal(primary.commands.filter((item) => item.type === "abort").length, 0);
    assert.equal(secondary.commands.filter((item) => item.type === "abort").length, 1);

    secondary.crash();
    const resumed = await post("/api/chat/queue/resume", { sessionId: idB });
    assert.equal(resumed.status, 200);
    assert.equal(secondary.restartCount, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(secondary.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for B", "B queued then dispatched"]);
    assert.deepEqual(primary.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for A"]);
    assert.deepEqual(third.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for C"]);
  } finally {
    server.close();
    await app.close();
  }
});
