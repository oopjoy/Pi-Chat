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

test("one browser window controls a Session until another explicitly takes over", async () => {
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
  const headers = (client: string) => ({ "content-type": "application/json", "x-pi-chat-client": client });
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  try {
    await fetch(`${origin}/api/bootstrap`, { headers: headers(first) });
    assert.equal((await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: headers(first), body: JSON.stringify({ message: "owned by first", sessionId: id }) })).status, 202);
    const blocked = await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: headers(second), body: JSON.stringify({ message: "blocked second", sessionId: id }) });
    assert.equal(blocked.status, 409);
    assert.match((await blocked.json() as { error: string }).error, /另一窗口/);
    primary.streaming = false;
    primary.emit({ type: "agent_settled" });
    const takeover = await fetch(`${origin}/api/sessions/${id}/control`, { method: "POST", headers: headers(second) });
    assert.deepEqual(await takeover.json(), { controlOwner: second, controlledByThisWindow: true });
    assert.equal((await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: headers(second), body: JSON.stringify({ message: "owned by second", sessionId: id }) })).status, 202);
    assert.deepEqual(primary.commands.filter((command) => command.type === "prompt").map((command) => command.message), ["owned by first", "owned by second"]);
  } finally {
    server.close();
    await app.close();
  }
});

test("closing one of multiple windows rests its exclusive idle Session without shutting down Pi Chat", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  let shutdowns = 0;
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), applicationShutdown: (_reason) => { shutdowns += 1; } });
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const internals = app as unknown as { sessionControl: { clientConnected(clientId: string): void; noteClientPresence(clientId: string): boolean; markViewed(clientId: string, sessionId: string): void }; connectedClients: Map<string, number>; connectedPageClients: Map<string, string>; viewedSessionsByClient: Map<string, string> };
  internals.sessionControl.clientConnected(first);
  internals.sessionControl.clientConnected(second);
  internals.connectedPageClients.set(first, first);
  internals.connectedPageClients.set(second, second);
  internals.sessionControl.noteClientPresence(first);
  internals.sessionControl.noteClientPresence(second);
  internals.sessionControl.markViewed(first, id);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`, { headers: { "x-pi-chat-client": first } })).status, 200);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/window/close`, { method: "POST", headers: { "x-pi-chat-client": first } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { shuttingDown: false, closeWindow: true, sessionId: id, rested: true, remainingWindows: 1 });
    assert.equal(shutdowns, 0);
    assert.equal(primary.stopCount, 1);
    assert.equal(internals.connectedClients.has(first), true, "the unload socket remains counted until its actual TCP close");
    assert.equal(internals.connectedPageClients.has(first), false, "the closing page no longer counts as open");
    assert.equal(internals.connectedClients.has(second), true);
  } finally {
    server.close();
    await app.close();
  }
});

test("closing one window does not rest its Session while an admitted mutation is in flight", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const internals = app as unknown as { sessionControl: { clientConnected(clientId: string): void; noteClientPresence(clientId: string): boolean; markViewed(clientId: string, sessionId: string): void }; connectedClients: Map<string, number>; viewedSessionsByClient: Map<string, string>; lifecycleCoordinator: { beginMutation(): () => void } };
  internals.sessionControl.clientConnected(first);
  internals.sessionControl.clientConnected(second);
  internals.sessionControl.noteClientPresence(first);
  internals.sessionControl.noteClientPresence(second);
  internals.sessionControl.markViewed(first, id);
  const releaseMutation = internals.lifecycleCoordinator.beginMutation();
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`)).status, 200);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/window/close`, { method: "POST", headers: { "x-pi-chat-client": first } });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { rested?: boolean }).rested, false);
    assert.equal(primary.stopCount, 0);
  } finally {
    releaseMutation();
    server.close();
    await app.close();
  }
});

test("an open background transport still prevents last-window auto shutdown", async () => {
  const path = "C:\\sessions\\presence-close.jsonl";
  const primary = new FakeRpc(path, "primary");
  const shutdownReasons: string[] = [];
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), lastWindowShutdownGraceMs: 25, lastWindowShutdownPollMs: 5, applicationShutdown: (reason) => { shutdownReasons.push(reason); } });
  const background = "11111111-1111-4111-8111-111111111111";
  const closing = "22222222-2222-4222-8222-222222222222";
  const internals = app as unknown as { connectedClients: Map<string, number>; connectedPageClients: Map<string, string> };
  internals.connectedClients.set(background, 1);
  internals.connectedClients.set(closing, 1);
  internals.connectedPageClients.set(background, background);
  internals.connectedPageClients.set(closing, closing);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/window/close`, { method: "POST", headers: { "x-pi-chat-client": closing } });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { remainingWindows: number }).remainingWindows, 1);
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.deepEqual(shutdownReasons, []);
  } finally {
    server.close();
    await app.close();
  }
});

test("closing the last window waits for a quiescent grace before shutting down", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const primary = new FakeRpc(path, "primary");
  const shutdownReasons: string[] = [];
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), lastWindowShutdownGraceMs: 30, lastWindowShutdownPollMs: 5, applicationShutdown: (reason) => { shutdownReasons.push(reason); } });
  const client = "11111111-1111-4111-8111-111111111111";
  (app as unknown as { connectedClients: Map<string, number> }).connectedClients.set(client, 1);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/window/close`, { method: "POST", headers: { "x-pi-chat-client": client } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { shuttingDown: false, closeWindow: true, rested: false, remainingWindows: 0, autoShutdownPending: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(shutdownReasons, []);
    for (let attempt = 0; attempt < 20 && shutdownReasons.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(shutdownReasons, ["last-window-close"]);
  } finally {
    server.close();
    await app.close();
  }
});

test("a reload handshake during grace cancels last-window auto shutdown", async () => {
  const primary = new FakeRpc("C:\\sessions\\refresh.jsonl", "primary");
  const shutdownReasons: string[] = [];
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), handshakePageTimeoutMs: 15, lastWindowShutdownGraceMs: 30, lastWindowShutdownPollMs: 5, applicationShutdown: (reason) => { shutdownReasons.push(reason); } });
  const client = "11111111-1111-4111-8111-111111111111";
  const oldPage = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const newPage = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const internals = app as unknown as {
    connectedClients: Map<string, number>;
    connectedPageClients: Map<string, string>;
    pendingWindowPageTimers: Map<string, NodeJS.Timeout>;
    clientConnected(clientId: string, pageId?: string): void;
    clientDisconnected(clientId: string): void;
  };
  internals.connectedClients.set(client, 1);
  internals.connectedPageClients.set(oldPage, client);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fetch(`http://127.0.0.1:${address.port}/api/window/close?page=${oldPage}`, { method: "POST", headers: { "x-pi-chat-client": client } });
    // The closing renderer's SSE disconnect removes its one real transport
    // lease before the replacement has reached EventSource.
    internals.clientDisconnected(client);
    assert.equal(internals.connectedClients.has(client), false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const handshake = await fetch(`http://127.0.0.1:${address.port}/api/bootstrap/handshake`, {
      headers: { "x-pi-chat-client": client, "x-pi-chat-page": newPage },
    });
    assert.equal(handshake.status, 200);
    assert.equal(
      internals.connectedClients.has(client),
      false,
      "a handshake registers the page but must not leak an SSE transport lease",
    );
    internals.clientConnected(client, newPage);
    assert.equal(internals.pendingWindowPageTimers.has(newPage), false, "SSE promotes and consumes the temporary handshake lease");
    assert.equal(internals.connectedClients.get(client), 1);
    internals.clientDisconnected(client);
    assert.equal(internals.connectedClients.has(client), false);
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.deepEqual(shutdownReasons, []);
    assert.equal(internals.connectedPageClients.get(newPage), client);
  } finally {
    server.close();
    await app.close();
  }
});

test("a handshake-only page expires instead of permanently holding the last-window lease", async () => {
  const primary = new FakeRpc("C:\\sessions\\handshake-expiry.jsonl", "primary");
  const shutdownReasons: string[] = [];
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions: {} as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    handshakePageTimeoutMs: 15,
    lastWindowShutdownGraceMs: 15,
    lastWindowShutdownPollMs: 5,
    applicationShutdown: (reason) => { shutdownReasons.push(reason); },
  });
  const client = "11111111-1111-4111-8111-111111111111";
  const page = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const internals = app as unknown as {
    connectedClients: Map<string, number>;
    connectedPageClients: Map<string, string>;
    pendingWindowPageTimers: Map<string, NodeJS.Timeout>;
  };
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const handshake = await fetch(`http://127.0.0.1:${address.port}/api/bootstrap/handshake`, {
      headers: { "x-pi-chat-client": client, "x-pi-chat-page": page },
    });
    assert.equal(handshake.status, 200);
    assert.equal(internals.connectedClients.has(client), false, "handshake is not an SSE lease");
    assert.equal(internals.connectedPageClients.get(page), client);
    assert.equal(internals.pendingWindowPageTimers.has(page), true);
    await waitForCondition(
      () => shutdownReasons.length > 0,
      500,
      "handshake expiry and last-window shutdown",
    );
    assert.equal(internals.connectedPageClients.has(page), false, "a crashed pre-SSE renderer must release its temporary page record");
    assert.equal(internals.pendingWindowPageTimers.has(page), false);
    assert.deepEqual(shutdownReasons, ["last-window-close"]);
  } finally {
    server.close();
    await app.close();
  }
});

test("a delayed old-page close beacon cannot close its replacement page", async () => {
  const primary = new FakeRpc("C:\\sessions\\late-beacon.jsonl", "primary");
  const shutdownReasons: string[] = [];
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), lastWindowShutdownGraceMs: 25, lastWindowShutdownPollMs: 5, applicationShutdown: (reason) => { shutdownReasons.push(reason); } });
  const client = "11111111-1111-4111-8111-111111111111";
  const oldPage = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const newPage = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const internals = app as unknown as { connectedClients: Map<string, number>; connectedPageClients: Map<string, string>; clientConnected(clientId: string, pageId: string): void };
  internals.connectedClients.set(client, 1);
  internals.connectedPageClients.set(oldPage, client);
  // Replacement SSE wins the race and registers before the old unload beacon.
  internals.clientConnected(client, newPage);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/window/close?page=${oldPage}`, { method: "POST", headers: { "x-pi-chat-client": client } });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { remainingWindows: number }).remainingWindows, 1);
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.deepEqual(shutdownReasons, []);
    assert.equal(internals.connectedPageClients.get(newPage), client);
  } finally {
    server.close();
    await app.close();
  }
});
