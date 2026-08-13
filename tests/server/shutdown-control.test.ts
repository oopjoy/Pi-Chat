import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import { RpcRequestTimeoutError, type PiRpcClient } from "../../src/server/rpc-client";
import { idForPath } from "../../src/server/session-index";
import type { SessionIndex } from "../../src/server/session-index";
import type { ResourceManager } from "../../src/server/resource-manager";
import { ModelManager } from "../../src/server/model-manager";
import type { SessionSummary } from "../../src/shared/types";

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

test("a final window close never shuts down an actively streaming Pi worker", async () => {
  const path = "C:\\sessions\\active-close.jsonl";
  const primary = new FakeRpc(path, "primary");
  primary.streaming = true;
  const shutdownReasons: string[] = [];
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions: {} as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    lastWindowShutdownGraceMs: 25,
    lastWindowShutdownPollMs: 5,
    applicationShutdown: (reason) => { shutdownReasons.push(reason); },
  });
  const client = "11111111-1111-4111-8111-111111111111";
  const page = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const internals = app as unknown as { connectedClients: Map<string, number>; connectedPageClients: Map<string, string>; activeSessionId: string; primaryBoundSessionId: string; running: boolean };
  internals.connectedClients.set(client, 1);
  internals.connectedPageClients.set(page, client);
  internals.activeSessionId = idForPath(path);
  internals.primaryBoundSessionId = idForPath(path);
  internals.running = true;
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/window/close?page=${page}`, { method: "POST", headers: { "x-pi-chat-client": client } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { shuttingDown: false, closeWindow: true, rested: false, remainingWindows: 0, autoShutdownPending: true });
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.deepEqual(shutdownReasons, []);
    assert.equal(primary.stopCount, 0, "auto shutdown must not stop a still-streaming worker");

    primary.streaming = false;
    internals.running = false;
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(shutdownReasons, [], "a full grace begins only after the worker becomes idle");
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.deepEqual(shutdownReasons, ["last-window-close"]);
  } finally {
    server.close();
    await app.close();
  }
});

test("last-window auto shutdown waits for dispatch to finish before starting its grace", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const primary = new FakeRpc(path, "primary");
  let shutdowns = 0;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), lastWindowShutdownGraceMs: 25, lastWindowShutdownPollMs: 5, applicationShutdown: (_reason) => { shutdowns += 1; } });
  const client = "11111111-1111-4111-8111-111111111111";
  const internals = app as unknown as { connectedClients: Map<string, number>; dispatching: boolean };
  internals.connectedClients.set(client, 1);
  internals.dispatching = true;
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/window/close`, { method: "POST", headers: { "x-pi-chat-client": client } });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(shutdowns, 0);
    internals.dispatching = false;
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(shutdowns, 0, "the grace starts only after dispatch becomes idle");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(shutdowns, 1);
  } finally {
    server.close();
    await app.close();
  }
});

test("global shutdown refuses while any conversation is still busy", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const primary = new FakeRpc(path, "primary");
  let shutdowns = 0;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), applicationShutdown: (_reason) => { shutdowns += 1; } });
  (app as unknown as { dispatching: boolean }).dispatching = true;
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/shutdown`, { method: "POST" });
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /仍有 1 个对话/);
    assert.equal(shutdowns, 0);
  } finally {
    server.close();
    await app.close();
  }
});

test("app close releases browser resources but preserves an unconfirmed Runtime failure", async () => {
  const primary = new FakeRpc("primary");
  const secondary = new FakeRpc("secondary");
  secondary.stop = async () => { throw new Error("Pi RPC 进程退出无法确认"); };
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions: {} as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    createRpc: () => secondary as unknown as PiRpcClient,
  });
  const internal = app as unknown as {
    runtimePool: { runtimes: Map<string, unknown> };
    sseHub: { closeAll(): void };
    closed: boolean;
  };
  internal.runtimePool.runtimes.set("secondary", {
    id: "secondary",
    rpc: secondary,
    recovery: null,
    unsubscribe: () => undefined,
    draftSession: false,
    prompted: true,
  });
  let hubClosed = false;
  internal.sseHub.closeAll = () => { hubClosed = true; };

  await assert.rejects(app.close(), /退出无法确认/);
  assert.equal(internal.closed, true);
  assert.equal(hubClosed, true);
  assert.equal(internal.runtimePool.runtimes.has("secondary"), true);
});

test("global shutdown broadcasts to every window before stopping the application", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const primary = new FakeRpc(path, "primary");
  const shutdownReasons: string[] = [];
  const frames: string[] = [];
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), applicationShutdown: (reason) => { shutdownReasons.push(reason); } });
  const clients = (app as unknown as { sseClients: Map<{ write: (frame: string) => void }, string> }).sseClients;
  clients.set({ write: (frame) => { frames.push(frame); } }, "11111111-1111-4111-8111-111111111111");
  clients.set({ write: (frame) => { frames.push(frame); } }, "22222222-2222-4222-8222-222222222222");
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/shutdown`, { method: "POST" });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { shuttingDown: true });
    assert.deepEqual(shutdownReasons, ["api-shutdown"]);
    assert.equal(frames.filter((frame) => frame.includes("pi_chat_application_closing")).length, 2);
  } finally {
    server.close();
    clients.clear();
    await app.close();
  }
});

test("control-change SSE marks only the owning browser window as writable", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const ownerFrames: string[] = [];
  const observerFrames: string[] = [];
  const clients = (app as unknown as { sseClients: Map<{ write: (frame: string) => void }, string> }).sseClients;
  const sessionControl = (app as unknown as { sessionControl: { clientConnected: (id: string) => void } }).sessionControl;
  const owner = "11111111-1111-4111-8111-111111111111";
  const observer = "22222222-2222-4222-8222-222222222222";
  // Presence comes from live SSE leases; seed both broadcast targets and connected maps.
  clients.set({ write: (frame) => { ownerFrames.push(frame); } }, owner);
  clients.set({ write: (frame) => { observerFrames.push(frame); } }, observer);
  sessionControl.clientConnected(owner);
  sessionControl.clientConnected(observer);
  sessionControl.noteClientPresence(owner);
  sessionControl.noteClientPresence(observer);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`, { headers: { "x-pi-chat-client": owner } })).status, 200);
    assert.equal((await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json", "x-pi-chat-client": owner }, body: JSON.stringify({ message: "owner", sessionId: id }) })).status, 202);
    const controlEvent = (frames: string[]) => JSON.parse(frames.find((frame) => frame.includes("pi_chat_session_control_changed"))?.split("data: ")[1] || "{}") as { controlOwner?: string; controlledByThisWindow?: boolean };
    assert.deepEqual(controlEvent(ownerFrames), { type: "pi_chat_session_control_changed", sessionId: id, controlOwner: owner, controlledByThisWindow: true });
    assert.deepEqual(controlEvent(observerFrames), { type: "pi_chat_session_control_changed", sessionId: id, controlOwner: owner, controlledByThisWindow: false });
  } finally {
    server.close();
    clients.clear();
    await app.close();
  }
});

test("a closed browser window releases Session control after its SSE lease expires", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), controllerReleaseMs: 10 });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const owner = "11111111-1111-4111-8111-111111111111";
  const observer = "22222222-2222-4222-8222-222222222222";
  const controller = new AbortController();
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`, { headers: { "x-pi-chat-client": owner } })).status, 200);
    const events = fetch(`${origin}/api/events`, { headers: { "x-pi-chat-client": owner }, signal: controller.signal }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json", "x-pi-chat-client": owner }, body: JSON.stringify({ message: "owner", sessionId: id }) })).status, 202);
    primary.streaming = false;
    primary.emit({ type: "agent_settled" });
    assert.equal((await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json", "x-pi-chat-client": observer }, body: JSON.stringify({ message: "blocked", sessionId: id }) })).status, 409);
    controller.abort();
    await events;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const released = await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json", "x-pi-chat-client": observer }, body: JSON.stringify({ message: "released", sessionId: id }) });
    const releasedText = await released.text();
    assert.equal(released.status, 202, releasedText);
  } finally {
    controller.abort();
    server.close();
    await app.close();
  }
});
