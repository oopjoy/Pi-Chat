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
  private listeners = new Set<(event: Record<string, unknown>) => void>();
  /** Captures callbacks once registered so a test can model an already-buffered old-child frame after unsubscribe. */
  private readonly historicalListeners = new Set<(event: Record<string, unknown>) => void>();
  streaming = false;
  stopCount = 0;
  restartCount = 0;
  restartFailures = 0;
  alive = true;

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
  async send(command: Record<string, unknown>) {
    this.commands.push(command);
    if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: this.path, sessionId: this.sessionId, isStreaming: this.streaming } };
    if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [] } };
    if (command.type === "get_available_models") return { type: "response", success: true, data: { models: [{ provider: "test", id: "next", name: "Next", reasoning: true }] } };
    if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [] } };
    if (command.type === "get_session_stats") return { type: "response", success: true, data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    if (command.type === "prompt") { this.streaming = true; this.emit({ type: "agent_start" }); return { type: "response", success: true }; }
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

test("warm starts a dedicated Runtime without full-view probes and same-mode Gate is a no-op", async () => {
  const primaryPath = "C:\\sessions\\warm-primary.jsonl";
  const secondaryPath = "C:\\sessions\\warm-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "warm-primary");
  const secondary = new FakeRpc(secondaryPath, "warm-secondary");
  const summaries = [
    { id: primaryId, sessionId: "warm-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "warm-secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    summaryForId: (id: string) => summaries.find((summary) => summary.id === id) || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => secondary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    const warm = await fetch(`${origin}/api/sessions/${secondaryId}/warm`, { method: "POST" });
    assert.equal(warm.status, 200);
    assert.deepEqual(secondary.commands.map((command) => command.type), ["get_state"], "warm must not request history, commands, or stats");

    const prompted = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello", sessionId: secondaryId, gateMode: "strict" }),
    });
    assert.equal(prompted.status, 202);
    assert.equal(secondary.commands.filter((command) => command.type === "prompt" && command.message === "/gate strict").length, 0);
  } finally {
    server.close();
    await app.close();
  }
});

test("a running persisted Session retains its indexed sidebar summary while a refresh omits it", async () => {
  const primaryPath = "C:\\sessions\\summary-primary.jsonl";
  const secondaryPath = "C:\\sessions\\summary-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "summary-primary");
  const secondary = new FakeRpc(secondaryPath, "summary-secondary");
  const primarySummary = { id: primaryId, sessionId: "summary-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true };
  const secondarySummary = { id: secondaryId, sessionId: "summary-secondary", name: "Persisted title", preview: "persisted preview", cwd: process.cwd(), updatedAt: 8, messageCount: 24, turnCount: 8, active: false };
  const sessions = {
    // Model the short SessionIndex refresh gap: Runtime activation knows the
    // secondary summary, but the following sidebar list has not republished it.
    list: async () => [primarySummary],
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    summaryForId: (id: string) => id === secondaryId ? secondarySummary : id === primaryId ? primarySummary : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => secondary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    assert.equal((await fetch(`${origin}/api/sessions/${secondaryId}/warm`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "continue", sessionId: secondaryId }),
    })).status, 202);

    const sidebar = await (await fetch(`${origin}/api/sessions`)).json() as { sessions: SessionSummary[] };
    const row = sidebar.sessions.find((session) => session.id === secondaryId);
    assert.ok(row);
    assert.equal(row.name, "Persisted title");
    assert.equal(row.preview, "persisted preview");
    assert.equal(row.messageCount, 24);
    assert.equal(row.turnCount, 8);
  } finally {
    server.close();
    await app.close();
  }
});

test("known cold history returns without waiting for global inventory, usage fallback, or Gate discovery", async () => {
  const primaryPath = "C:\\sessions\\cold-fast-primary.jsonl";
  const coldPath = "C:\\sessions\\cold-fast-target.jsonl";
  const primaryId = idForPath(primaryPath);
  const coldId = idForPath(coldPath);
  const primary = new FakeRpc(primaryPath, "cold-fast-primary");
  const coldSummary = { id: coldId, sessionId: "cold-fast", name: "Cold fast", preview: "saved", cwd: process.cwd(), updatedAt: 1, messageCount: 2, active: false };
  const sessions = {
    summaryForId: (id: string) => id === coldId ? coldSummary : id === primaryId ? { ...coldSummary, id: primaryId, sessionId: "cold-fast-primary", active: true } : null,
    snapshotForId: async (id: string) => id === coldId ? {
      messages: [{ role: "user", content: "saved question" }, { role: "assistant", content: "saved answer" }],
      usage: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, context: null },
      settings: {},
    } : null,
    messagesForId: async () => { throw new Error("target snapshot should satisfy history"); },
    usageForId: async () => new Promise<never>(() => undefined),
    list: async () => new Promise<SessionSummary[]>(() => undefined),
  } as unknown as SessionIndex;
  const resources = {
    systemGateEnabled: async () => new Promise<boolean>(() => undefined),
  } as unknown as ResourceManager;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${coldId}/view`, { signal: AbortSignal.timeout(500) });
    assert.equal(response.status, 200);
    const view = await response.json() as { viewSource: string; runtimeStatus: string; messages: Array<{ content: string }>; gateAvailable: boolean };
    assert.equal(view.viewSource, "cold-jsonl");
    assert.equal(view.runtimeStatus, "view-only");
    assert.deepEqual(view.messages.map((message) => message.content), ["saved question", "saved answer"]);
    assert.equal(view.gateAvailable, true);
  } finally {
    server.close();
    await app.close();
  }
});

test("new-session initial submit accepts a >1 MB image body and performs model, thinking, Gate, and user prompt", async () => {
  const primaryPath = "C:\\sessions\\initial-primary.jsonl";
  const draftPath = "C:\\sessions\\initial-draft.jsonl";
  const primaryId = idForPath(primaryPath);
  const primary = new FakeRpc(primaryPath, "initial-primary");
  const draft = new FakeRpc(draftPath, "initial-draft");
  const sessions = {
    list: async () => [{ id: primaryId, sessionId: "initial-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => primaryPath,
    summaryForId: () => null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => draft as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const imageData = "A".repeat(1_100_000);
  try {
    await fetch(`${origin}/api/bootstrap`);
    const response = await fetch(`${origin}/api/sessions/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initial: {
        message: "first",
        images: [{ type: "image", data: imageData, mimeType: "image/png" }],
        model: { provider: "test", modelId: "next" },
        thinkingLevel: "high",
        gateMode: "open",
      } }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(
      draft.commands.filter((command) => ["set_model", "set_thinking_level", "prompt"].includes(String(command.type))).map((command) => [command.type, command.message]),
      [["set_model", undefined], ["set_thinking_level", undefined], ["prompt", "/gate open"], ["prompt", "first"]],
    );
    const prompt = draft.commands.find((command) => command.type === "prompt" && command.message === "first") as { images?: Array<{ data: string }> } | undefined;
    assert.equal(prompt?.images?.[0]?.data.length, imageData.length);
  } finally {
    server.close();
    await app.close();
  }
});

test("a settled first draft retries JSONL visibility before replacing its provisional title", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-draft-title-"));
  const primaryPath = join(root, "primary.jsonl");
  const draftPath = join(root, "draft.jsonl");
  const primaryId = idForPath(primaryPath);
  const draftId = idForPath(draftPath);
  const primary = new FakeRpc(primaryPath, "title-primary");
  const draft = new FakeRpc(draftPath, "title-draft");
  let persisted = false;
  const durableSummary: SessionSummary = {
    id: draftId,
    sessionId: "title-draft",
    name: "durable first prompt",
    preview: "durable first prompt",
    cwd: root,
    updatedAt: 2,
    lastUserPromptAt: 2,
    messageCount: 1,
    turnCount: 1,
    active: false,
  };
  const sessions = {
    list: async () => [
      { id: primaryId, sessionId: "title-primary", name: "Primary", preview: "", cwd: root, updatedAt: 1, messageCount: 1, active: true },
      ...(persisted ? [durableSummary] : []),
    ],
    pathForId: (id: string) => id === primaryId ? primaryPath : persisted && id === draftId ? draftPath : null,
    summaryForId: (id: string) => persisted && id === draftId ? durableSummary : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => draft as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: root, webRoot: root });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/api/sessions/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initial: { message: "durable first prompt" } }),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json() as { session: { name: string } }).session.name, "新对话");

    draft.streaming = false;
    draft.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    persisted = true;
    await writeFile(draftPath, `${JSON.stringify({ type: "message", message: { role: "user", content: "durable first prompt" } })}\n`, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 180));

    const sidebar = await (await fetch(`${origin}/api/sessions`)).json() as { sessions: SessionSummary[] };
    assert.equal(sidebar.sessions.find((session) => session.id === draftId)?.name, "durable first prompt");
    assert.equal((app as unknown as { runtimes: Map<string, { draftSession?: unknown }> }).runtimes.get(draftId)?.draftSession, undefined);
  } finally {
    server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gate modes stay isolated per Runtime and survive Secondary recovery", async () => {
  const primaryPath = "C:\\sessions\\gate-primary.jsonl";
  const secondaryPath = "C:\\sessions\\gate-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new GateFakeRpc(primaryPath, "gate-primary");
  const secondary = new GateFakeRpc(secondaryPath, "gate-secondary");
  const summaries = [
    { id: primaryId, sessionId: "gate-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "gate-secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
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
  const post = (path: string, body: object) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    assert.equal((await post(`/api/sessions/${secondaryId}/activate`, {})).status, 200);
    assert.equal((await post("/api/chat/prompt", { message: "/gate open", sessionId: secondaryId })).status, 202);

    const primaryView = await (await fetch(`${origin}/api/sessions/${primaryId}/view`)).json() as { gateMode?: string };
    const secondaryView = await (await fetch(`${origin}/api/sessions/${secondaryId}/view`)).json() as { gateMode?: string };
    assert.equal(primaryView.gateMode, "strict");
    assert.equal(secondaryView.gateMode, "open");

    secondary.crash();
    assert.equal((await post("/api/chat/prompt", { message: "recover", sessionId: secondaryId })).status, 202);
    const gatePrompts = secondary.commands.filter((command) => command.type === "prompt" && typeof command.message === "string" && command.message.startsWith("/gate "));
    assert.equal(gatePrompts.at(-1)?.message, "/gate open");
    const recoveredView = await (await fetch(`${origin}/api/sessions/${secondaryId}/view`)).json() as { gateMode?: string };
    assert.equal(recoveredView.gateMode, "open");
  } finally {
    server.close();
    await app.close();
  }
});

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

test("a same-window refresh during grace cancels last-window auto shutdown", async () => {
  const primary = new FakeRpc("C:\\sessions\\refresh.jsonl", "primary");
  const shutdownReasons: string[] = [];
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), lastWindowShutdownGraceMs: 30, lastWindowShutdownPollMs: 5, applicationShutdown: (reason) => { shutdownReasons.push(reason); } });
  const client = "11111111-1111-4111-8111-111111111111";
  const internals = app as unknown as { connectedClients: Map<string, number>; clientConnected(clientId: string): void; clientDisconnected(clientId: string): void };
  internals.connectedClients.set(client, 1);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fetch(`http://127.0.0.1:${address.port}/api/window/close`, { method: "POST", headers: { "x-pi-chat-client": client } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    internals.clientConnected(client);
    internals.clientDisconnected(client);
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.deepEqual(shutdownReasons, []);
    assert.equal(internals.connectedClients.get(client), 1);
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

test("restart barrier rejects new mutations throughout a long build and commits only after recheck", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  let resolveBuild: (() => void) | undefined;
  let promotions = 0;
  let handoffs = 0;
  let discards = 0;
  const build = new Promise<void>((resolve) => { resolveBuild = resolve; });
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    applicationRestart: async () => {
      await build;
      return {
        promote: async () => { promotions += 1; },
        handoff: () => { handoffs += 1; },
        discard: async () => { discards += 1; },
      };
    },
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    const restart = fetch(`${origin}/api/restart`, { method: "POST" });
    let healthData: { ok?: boolean; service?: string; lifecycle?: string } = {};
    const healthDeadline = Date.now() + 1_000;
    do {
      const health = await fetch(`${origin}/api/health`);
      assert.equal(health.status, 200);
      healthData = await health.json() as typeof healthData;
      if (healthData.lifecycle !== "restarting") await new Promise((resolve) => setTimeout(resolve, 5));
    } while (healthData.lifecycle !== "restarting" && Date.now() < healthDeadline);
    assert.equal(healthData.ok, true);
    assert.equal(healthData.service, "pi-chat");
    assert.equal(healthData.lifecycle, "restarting");
    const maintenanceBootstrap = await fetch(`${origin}/api/bootstrap`);
    assert.equal(maintenanceBootstrap.status, 503);
    const maintenanceData = await maintenanceBootstrap.json() as { lifecycle?: string; requestToken?: string };
    assert.equal(maintenanceData.lifecycle, "restarting");
    assert.ok(maintenanceData.requestToken);
    assert.equal((await fetch(`${origin}/api/sessions`)).status, 200);
    assert.equal((await fetch(`${origin}/api/sessions/${id}/view`)).status, 200);
    for (const [url, body] of [
      ["/api/chat/prompt", { message: "must be rejected", sessionId: id }],
      ["/api/thinking/set", { level: "high", sessionId: id }],
      [`/api/sessions/${id}/activate`, {}],
      ["/api/extension-ui/respond", { id: "pending", sessionId: id, confirmed: true }],
    ] as const) {
      const blocked = await fetch(`${origin}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(blocked.status, 503, `${url} should be blocked`);
      assert.equal((await blocked.json() as { code?: string }).code, "APPLICATION_LIFECYCLE_BLOCKED");
    }
    assert.equal(primary.commands.some((command) => command.type === "prompt"), false);
    resolveBuild?.();
    const response = await restart;
    assert.equal(response.status, 202);
    assert.equal(promotions, 1);
    assert.equal(handoffs, 1);
    assert.equal(discards, 0);
  } finally {
    resolveBuild?.();
    server.close();
    await app.close();
  }
});

test("an incomplete request with no valid session identity does not block restart admission", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const primary = new FakeRpc(path, "primary");
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), applicationRestart: async () => ({ promote: async () => undefined, handoff: () => undefined, discard: async () => undefined }) });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const slowPrompt = httpRequest(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } });
  slowPrompt.on("error", () => undefined);
  slowPrompt.write('{"message":"still uploading"');
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const restart = await fetch(`${origin}/api/restart`, { method: "POST" });
    assert.equal(restart.status, 202);
    const health = await fetch(`${origin}/api/health`);
    assert.equal((await health.json() as { lifecycle: string }).lifecycle, "restarting");
  } finally {
    slowPrompt.destroy();
    server.close();
    await app.close();
  }
});

test("an incomplete new-session body does not block restart admission", async () => {
  const path = "C:\\sessions\\primary-new.jsonl";
  const primary = new FakeRpc(path, "primary-new");
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions: {} as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    applicationRestart: async () => ({ promote: async () => undefined, handoff: () => undefined, discard: async () => undefined }),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const slowNew = httpRequest(`${origin}/api/sessions/new`, {
    method: "POST",
    headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
  });
  slowNew.on("error", () => undefined);
  slowNew.write('{"cwd":"');
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const restart = await fetch(`${origin}/api/restart`, { method: "POST" });
    assert.equal(restart.status, 202);
  } finally {
    slowNew.destroy();
    server.close();
    await app.close();
  }
});

test("restart build failure restores idle admission", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), applicationRestart: async () => { throw new Error("build failed"); } });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    assert.equal((await fetch(`${origin}/api/restart`, { method: "POST" })).status, 500);
    const health = await fetch(`${origin}/api/health`);
    assert.equal((await health.json() as { lifecycle: string }).lifecycle, "idle");
    assert.equal((await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "works after failure", sessionId: id }) })).status, 202);
  } finally {
    server.close();
    await app.close();
  }
});

test("paused Secondary queue does not block future-default workspace changes", async () => {
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
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    assert.equal((await fetch(`${origin}/api/sessions/${secondaryId}/activate`, { method: "POST" })).status, 200);
    const runtime = (app as unknown as { runtimes: Map<string, { queuePaused: boolean; promptQueue: object[] }> }).runtimes.get(secondaryId);
    assert.ok(runtime);
    runtime.queuePaused = true;
    runtime.promptQueue.push({ id: "queued" });
    const workspace = await fetch(`${origin}/api/workspace/set`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: process.cwd() }) });
    assert.equal(workspace.status, 200);
    for (const kind of ["skills", "extensions", "packages"]) {
      const resource = await fetch(`${origin}/api/resources/${kind}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "resource", enabled: true }) });
      assert.equal(resource.status, 405);
    }
    assert.equal(secondary.stopCount, 0);
  } finally {
    server.close();
    await app.close();
  }
});

test("model file mutation rolls back and restores the primary Runtime when reload fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-model-rollback-"));
  const path = "C:\\sessions\\primary.jsonl";
  const primary = new FakeRpc(path, "primary");
  const models = new ModelManager(root);
  await models.add({ provider: "local", id: "old", baseUrl: "http://127.0.0.1:1", api: "openai-completions" });
  const before = await readFile(models.path, "utf8");
  primary.restartFailures = 1;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, modelManager: models, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/api/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "local", id: "new", baseUrl: "http://127.0.0.1:1", api: "openai-completions" }),
    });
    assert.equal(response.status, 500);
    assert.match((await response.json() as { error: string }).error, /原配置已自动恢复/);
    assert.equal(await readFile(models.path, "utf8"), before);
    assert.equal(primary.restartCount, 2);
    assert.equal(primary.alive, true);
    const health = await fetch(`${origin}/api/health`);
    assert.equal((await health.json() as { lifecycle: string }).lifecycle, "idle");
  } finally {
    server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace default change never restarts or rebinds a live Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-rollback-"));
  const previousCwd = join(root, "old");
  const nextCwd = join(root, "new");
  await Promise.all([mkdir(previousCwd), mkdir(nextCwd)]);
  const path = "C:\\sessions\\primary.jsonl";
  const primary = new FakeRpc(path, "primary");
  primary.restartFailures = 1;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources: {} as ResourceManager,
    cwd: previousCwd,
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/workspace/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: nextCwd }),
    });
    assert.equal(response.status, 200);
    assert.equal((app as unknown as { currentCwd: string }).currentCwd, nextCwd);
    assert.equal(primary.restartCount, 0);
    assert.equal(primary.alive, true);
  } finally {
    server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace commits serialize concurrent defaults and respect an active lifecycle barrier", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-commit-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await Promise.all([mkdir(first), mkdir(second)]);
  const app = new PiChatApp({
    rpc: new FakeRpc("C:\\sessions\\workspace.jsonl", "workspace") as unknown as PiRpcClient,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources: {} as ResourceManager,
    cwd: root,
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const setWorkspace = (path: string) => fetch(`${origin}/api/workspace/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const [firstResult, secondResult] = await Promise.all([setWorkspace(first), setWorkspace(second)]);
    assert.equal(firstResult.status, 200);
    assert.equal(secondResult.status, 200);
    assert.equal((app as unknown as { currentCwd: string }).currentCwd, second);
    assert.equal(JSON.parse(await readFile(join(agentDir, "pi-chat-workspace.json"), "utf8")).cwd, second);

    const lifecycle = app as unknown as { lifecycleCoordinator: { begin: (kind: "restarting") => void; end: (kind: "restarting") => void } };
    lifecycle.lifecycleCoordinator.begin("restarting");
    const blocked = await setWorkspace(first);
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json() as { code: string }).code, "APPLICATION_LIFECYCLE_BLOCKED");
    lifecycle.lifecycleCoordinator.end("restarting");
  } finally {
    server.close();
    await app.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace picker retains the former bootstrap response for older browser bundles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-picker-contract-"));
  const selected = join(root, "selected");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(selected);
  const app = new PiChatApp({
    rpc: new FakeRpc("C:\\sessions\\picker.jsonl", "picker") as unknown as PiRpcClient,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources: {} as ResourceManager,
    cwd: root,
    webRoot: process.cwd(),
    pickWorkspaceFolder: async () => selected,
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/workspace/pick`, { method: "POST" });
    assert.equal(response.status, 200);
    const data = await response.json() as { cancelled: boolean; cwd: string; workspaceEpoch: string; workspaceRevision: number; data?: { workspaceCwd?: string; workspaceEpoch?: string; workspaceRevision?: number } };
    assert.equal(data.cancelled, false);
    assert.equal(data.cwd, selected);
    assert.equal(data.data?.workspaceCwd, selected, "older clients still read the nested bootstrap workspace path");
    assert.equal(data.data?.workspaceEpoch, data.workspaceEpoch);
    assert.equal(data.data?.workspaceRevision, data.workspaceRevision);
  } finally {
    server.close();
    await app.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("a delayed workspace picker responds with one latest snapshot for legacy and revision-aware clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-picker-snapshot-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await Promise.all([mkdir(first), mkdir(second)]);
  const app = new PiChatApp({
    rpc: new FakeRpc("C:\\sessions\\picker-snapshot.jsonl", "picker-snapshot") as unknown as PiRpcClient,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources: {} as ResourceManager,
    cwd: root,
    webRoot: process.cwd(),
    pickWorkspaceFolder: async () => first,
  });
  const internals = app as unknown as { bootstrap: (clientId?: string) => Promise<unknown> };
  const originalBootstrap = internals.bootstrap.bind(app);
  let releaseBootstrap!: () => void;
  const heldBootstrap = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
  let bootstrapStarted!: () => void;
  const startedBootstrap = new Promise<void>((resolve) => { bootstrapStarted = resolve; });
  internals.bootstrap = async (clientId = "") => {
    bootstrapStarted();
    await heldBootstrap;
    return originalBootstrap(clientId);
  };
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const pickerResponse = fetch(`${origin}/api/workspace/pick`, { method: "POST" });
    await startedBootstrap;
    const newerCommit = await fetch(`${origin}/api/workspace/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: second }),
    });
    assert.equal(newerCommit.status, 200);
    releaseBootstrap();
    const response = await pickerResponse;
    assert.equal(response.status, 200);
    const data = await response.json() as { cwd: string; workspaceEpoch: string; workspaceRevision: number; data: { workspaceCwd: string; workspaceEpoch?: string; workspaceRevision?: number } };
    assert.equal(data.cwd, second, "a picker response cannot restore its earlier committed cwd");
    assert.equal(data.workspaceRevision, 2);
    assert.equal(data.data.workspaceCwd, data.cwd, "legacy and new clients receive the same workspace snapshot");
    assert.equal(data.data.workspaceEpoch, data.workspaceEpoch);
    assert.equal(data.data.workspaceRevision, data.workspaceRevision);
  } finally {
    releaseBootstrap?.();
    server.close();
    await app.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace resource inventory remains rooted at the Primary cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-resources-"));
  const primaryCwd = join(root, "primary");
  const laterDefault = join(root, "later-default");
  await Promise.all([mkdir(primaryCwd), mkdir(laterDefault)]);
  const calls: string[] = [];
  const resources = {
    listSkills: async (cwd: string) => { calls.push(`skills:${cwd}`); return { resources: [], diagnostics: [] }; },
    listExtensions: async (cwd: string) => { calls.push(`extensions:${cwd}`); return { resources: [], diagnostics: [] }; },
    listPackages: async (cwd: string) => { calls.push(`packages:${cwd}`); return { resources: [], diagnostics: [] }; },
  } as unknown as ResourceManager;
  const app = new PiChatApp({
    rpc: new FakeRpc("C:\\sessions\\resources.jsonl", "resources") as unknown as PiRpcClient,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources,
    cwd: primaryCwd,
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const changed = await fetch(`${origin}/api/workspace/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: laterDefault }),
    });
    assert.equal(changed.status, 200);
    for (const kind of ["skills", "extensions", "packages"]) assert.equal((await fetch(`${origin}/api/resources/${kind}`)).status, 200);
    assert.deepEqual(calls, [`skills:${primaryCwd}`, `extensions:${primaryCwd}`, `packages:${primaryCwd}`]);
  } finally {
    server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

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

test("sidebar defaults to at most fifteen rows per directory and can explicitly load the complete snapshot", async () => {
  const path = "C:\\sessions\\old-active.jsonl";
  const activeId = idForPath(path);
  const primary = new FakeRpc(path, "old-active");
  const summaries = Array.from({ length: 25 }, (_, index) => ({
    id: index === 24 ? activeId : index.toString(16).padStart(20, "0"),
    sessionId: `session-${index}`,
    name: `Session ${index}`,
    preview: "",
    cwd: process.cwd(),
    updatedAt: index === 24 ? 0 : 100 - index,
    messageCount: 1,
    active: index === 24,
  }));
  const sessions = {
    list: async () => summaries,
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
    const recent = await (await fetch(`${origin}/api/sessions`)).json() as { sessions: Array<{ id: string }>; total: number };
    assert.equal(recent.total, 25);
    assert.equal(recent.sessions.length, 15);
    assert.equal(recent.sessions.some((session) => session.id === activeId), false);
    const all = await (await fetch(`${origin}/api/sessions?all=1`)).json() as { sessions: Array<{ id: string }>; total: number };
    assert.equal(all.total, 25);
    assert.equal(all.sessions.length, 25);
    assert.equal(all.sessions.some((session) => session.id === activeId), true);
  } finally {
    server.close();
    await app.close();
  }
});

test("busy bootstrap uses persisted JSONL history without queueing get_messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-busy-bootstrap-"));
  const path = join(root, "primary.jsonl");
  const id = idForPath(path);
  const persisted = [{ role: "user", content: [{ type: "text", text: "persisted" }] }];
  await writeFile(path, [
    { type: "session", version: 3, id: "primary-busy-bootstrap", timestamp: "2026-01-01T00:00:00Z", cwd: process.cwd() },
    { type: "message", id: "1", message: persisted[0] },
  ].map(JSON.stringify).join("\n") + "\n");
  const primary = new FakeRpc(path, "primary-busy-bootstrap");
  primary.streaming = true;
  const sessions = {
    list: async () => [{ id, sessionId: "primary-busy-bootstrap", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => persisted,
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await (await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`)).json() as { messages: unknown[] };
    assert.deepEqual(result.messages, persisted);
    assert.equal(primary.commands.some((command) => command.type === "get_messages"), false);
  } finally {
    server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("empty terminal assistant SSE events retain the cumulative answer payload", async () => {
  const path = "C:\\sessions\\primary-terminal-repair.jsonl";
  const primary = new FakeRpc(path, "primary-terminal-repair");
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const frames: string[] = [];
  const clients = (app as unknown as { sseClients: Map<{ write: (frame: string) => boolean }, string> }).sseClients;
  clients.set({ write: (frame) => { frames.push(frame); return true; } }, "11111111-1111-4111-8111-111111111111");
  try {
    await (app as unknown as { ensurePrimaryIdentity(): Promise<void> }).ensurePrimaryIdentity();
    primary.emit({ type: "agent_start" });
    primary.emit({ type: "message_update", message: { role: "assistant", content: "cumulative answer", timestamp: 1 } });
    primary.emit({ type: "message_end", message: { role: "assistant", content: [], timestamp: 2 } });
    primary.emit({ type: "agent_settled" });
    primary.emit({ type: "agent_start" });
    primary.emit({ type: "message_end", message: { role: "assistant", content: "second answer", timestamp: 3 } });
    const terminals = frames.filter((frame) => frame.includes('"type":"message_end"'));
    assert.match(terminals[0] || "", /"content":"cumulative answer"/);
    assert.match(terminals[0] || "", /"piChatSessionId"/);
    assert.match(terminals[0] || "", /"piChatRunEpoch":"[A-Za-z0-9_-]+"/);
    assert.match(terminals[0] || "", /"piChatRunGeneration":1/);
    assert.match(terminals[1] || "", /"piChatRunGeneration":2/);
  } finally {
    clients.clear();
    await app.close();
  }
});

test("cumulative tool execution updates never enter the browser SSE fanout", async () => {
  const path = "C:\\sessions\\primary-tool-flood.jsonl";
  const primary = new FakeRpc(path, "primary-tool-flood");
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const frames: string[] = [];
  const clients = (app as unknown as { sseClients: Map<{ write: (frame: string) => boolean }, string> }).sseClients;
  clients.set({ write: (frame) => { frames.push(frame); return true; } }, "11111111-1111-4111-8111-111111111111");
  try {
    await (app as unknown as { ensurePrimaryIdentity(): Promise<void> }).ensurePrimaryIdentity();
    primary.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" });
    primary.emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: { content: "x".repeat(600_000) } });
    primary.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: "done" }, isError: false });
    assert.equal(frames.some((frame) => frame.includes("tool_execution_update")), false);
    assert.equal(frames.some((frame) => frame.includes("tool_execution_start")), true);
    assert.equal(frames.some((frame) => frame.includes("tool_execution_end")), true);
  } finally {
    clients.clear();
    await app.close();
  }
});

test("SSE emits visible heartbeats and a local New composer can release its viewed Session pin", async () => {
  const path = "C:\\sessions\\primary-heartbeat.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary-heartbeat");
  const client = "11111111-1111-4111-8111-111111111111";
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), sseHeartbeatMs: 10 });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const controller = new AbortController();
  try {
    const response = await fetch(`${origin}/api/events`, { headers: { "x-pi-chat-client": client }, signal: controller.signal });
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let frames = "";
    const deadline = Date.now() + 1_000;
    while (!frames.includes("pi_chat_heartbeat") && Date.now() < deadline) {
      const next = await reader.read();
      if (next.done) break;
      frames += decoder.decode(next.value, { stream: true });
    }
    assert.match(frames, /event: ready/);
    assert.match(frames, /"type":"pi_chat_heartbeat"/);
    assert.equal((await fetch(`${origin}/api/sessions/${id}/viewing`, { method: "POST", headers: { "x-pi-chat-client": client } })).status, 200);
    const internals = app as unknown as { viewedSessionsByClient: Map<string, string> };
    assert.equal(internals.viewedSessionsByClient.get(client), id);
    const headers = { "content-type": "application/json", "x-pi-chat-client": client };
    const cleared = await fetch(`${origin}/api/sessions/viewing/clear`, { method: "POST", headers, body: JSON.stringify({ sessionId: id }) });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { viewing: "" });
    assert.equal(internals.viewedSessionsByClient.has(client), false);

    const newerId = "fedcba9876543210abcd";
    internals.viewedSessionsByClient.set(client, newerId);
    const staleClear = await fetch(`${origin}/api/sessions/viewing/clear`, { method: "POST", headers, body: JSON.stringify({ sessionId: id }) });
    assert.equal(staleClear.status, 200);
    assert.deepEqual(await staleClear.json(), { viewing: newerId });
    assert.equal(internals.viewedSessionsByClient.get(client), newerId);
    await reader.cancel();
  } finally {
    controller.abort();
    server.close();
    await app.close();
  }
});

test("an abandoned Gate confirmation is safely cancelled after its timeout", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), gateRequestTimeoutMs: 10 });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    primary.streaming = true;
    primary.emit({ type: "extension_ui_request", id: "stale-gate", method: "select", title: "Write file?", options: ["Allow", "Block"] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(primary.commands.find((command) => command.type === "extension_ui_response"), { type: "extension_ui_response", id: "stale-gate", cancelled: true });
    const view = await (await fetch(`${origin}/api/sessions/${id}/view`)).json() as { pendingExtensionRequest?: unknown; session: { pendingConfirmation?: boolean } };
    assert.equal(view.pendingExtensionRequest, undefined);
    assert.equal(view.session.pendingConfirmation, false);
  } finally {
    server.close();
    await app.close();
  }
});

test("a pending extension confirmation belongs to one Session and only its first response is forwarded", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  const sessions = {
    list: async (activePath?: string) => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: id === idForPath(activePath || path) }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (body: object) => fetch(`${origin}/api/extension-ui/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    primary.emit({ type: "extension_ui_request", id: "gate-1", method: "select", title: "Write file?", options: ["Allow", "Block"] });
    const view = await (await fetch(`${origin}/api/sessions/${id}/view`)).json() as { pendingExtensionRequest?: { id: string }; session: { pendingConfirmation?: boolean } };
    assert.equal(view.pendingExtensionRequest?.id, "gate-1");
    assert.equal(view.session.pendingConfirmation, true);
    assert.equal((await post({ id: "gate-1", value: "Allow", sessionId: id })).status, 200);
    const second = await post({ id: "gate-1", value: "Block", sessionId: id });
    assert.equal(second.status, 409);
    assert.equal(primary.commands.filter((command) => command.type === "extension_ui_response").length, 1);
    assert.deepEqual(primary.commands.find((command) => command.type === "extension_ui_response"), { type: "extension_ui_response", id: "gate-1", value: "Allow" });
  } finally {
    server.close();
    await app.close();
  }
});

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
    const recovered = await (await fetch(`${origin}/api/bootstrap`)).json() as { state: { isStreaming: boolean }; sessions: Array<{ id: string; running?: boolean }> };
    assert.equal(primary.restartCount, 0, "reading bootstrap must not wake a failed Primary Runtime");
    assert.equal(recovered.state.isStreaming, false);
    assert.equal(recovered.sessions.find((session) => session.id === id)?.running, false);
    const prompt = await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "recover on write", sessionId: id }) });
    assert.equal(prompt.status, 202);
    assert.equal(primary.restartCount, 1);
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
      assert.deepEqual(rpc.commands.filter((command) => command.type === "prompt").map((command) => command.message), [`${prefix}-A`, `${prefix}-B`]);
      await settle(rpc);
      assert.deepEqual(rpc.commands.filter((command) => command.type === "prompt").map((command) => command.message), [`${prefix}-A`, `${prefix}-B`, `${prefix}-C`]);
    }
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
