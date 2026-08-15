import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp } from "../src/server/app";
import type { ResourceManager } from "../src/server/resource-manager";
import type { PiRpcClient, RpcEventSource } from "../src/server/rpc-client";
import { idForPath, type SessionIndex } from "../src/server/session-index";

const sessionPath = "C:\\sessions\\fast-mode.jsonl";
const sessionId = idForPath(sessionPath);

class FastWorker {
  private listener: (event: Record<string, unknown>, source?: RpcEventSource) => void = () => undefined;
  generation = 1;
  running = true;
  active: boolean;
  restartActive: boolean;
  emitOldErrorDuringRestart = false;

  constructor(readonly path: string, active: boolean) {
    this.active = active;
    this.restartActive = active;
  }

  onEvent(listener: (event: Record<string, unknown>, source?: RpcEventSource) => void) {
    this.listener = listener;
    return () => undefined;
  }

  currentGeneration() { return this.generation; }
  isRunning() { return this.running; }
  setDiagnosticSessionId() {}

  emit(event: Record<string, unknown>, generation = this.generation) {
    this.listener(event, { generation });
  }

  emitFast(active = this.active, generation = this.generation) {
    this.emit({
      type: "extension_ui_request",
      method: "setStatus",
      statusKey: "fast",
      ...(active ? { statusText: "⚡" } : null),
    }, generation);
  }

  async start() {
    this.emitFast();
  }

  async restart() {
    const oldGeneration = this.generation;
    this.generation += 1;
    this.running = true;
    this.active = this.restartActive;
    this.emitFast(this.active, this.generation);
    if (this.emitOldErrorDuringRestart)
      this.emit({ type: "pi_chat_process_error", error: "old worker exited" }, oldGeneration);
  }

  async stop() { this.running = false; }

  fail() {
    this.running = false;
    this.emit({ type: "pi_chat_process_error", error: "worker exited" });
  }

  async send(command: Record<string, unknown>) {
    if (command.type === "get_state")
      return { type: "response", success: true, data: { model: null, sessionFile: this.path, sessionId: this.path, isStreaming: false } };
    if (command.type === "get_messages")
      return { type: "response", success: true, data: { messages: [] } };
    if (command.type === "get_commands")
      return { type: "response", success: true, data: { commands: [] } };
    if (command.type === "get_session_stats")
      return { type: "response", success: true, data: { tokens: {} } };
    return { type: "response", success: true };
  }
}

test("Fast extension status is retained per Session for bootstrap and Session views", async () => {
  let generation = 7;
  let emit: (event: Record<string, unknown>, eventGeneration?: number) => void = () => undefined;
  const rpc = {
    onEvent: (listener: (event: Record<string, unknown>, source?: RpcEventSource) => void) => {
      emit = (event, eventGeneration = generation) => listener(event, { generation: eventGeneration });
      return () => undefined;
    },
    currentGeneration: () => generation,
    isRunning: () => true,
    send: async (command: Record<string, unknown>) => {
      if (command.type === "get_state")
        return { type: "response", success: true, data: { model: null, sessionFile: sessionPath, sessionId: "fast-mode", isStreaming: false } };
      if (command.type === "get_messages")
        return { type: "response", success: true, data: { messages: [] } };
      if (command.type === "get_available_models")
        return { type: "response", success: true, data: { models: [] } };
      if (command.type === "get_commands")
        return { type: "response", success: true, data: { commands: [] } };
      if (command.type === "get_session_stats")
        return { type: "response", success: true, data: { tokens: {} } };
      return { type: "response", success: true };
    },
  } as unknown as PiRpcClient;
  const sessions = {
    list: async () => [{ id: sessionId, sessionId: "fast-mode", name: "Fast", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 0, active: true }],
    pathForId: () => sessionPath,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc,
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
  try {
    // Pi extensions emit session_start footer status before get_state binds the
    // Primary child to its exact Session. The pending generation must survive.
    emit({ type: "extension_ui_request", method: "setStatus", statusKey: "fast", statusText: "⚡" });
    const enabledBootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as { state: { fastModeActive?: boolean } };
    const enabledView = await (await fetch(`${origin}/api/sessions/${sessionId}/view`)).json() as { state: { fastModeActive?: boolean } };
    assert.equal(enabledBootstrap.state.fastModeActive, true);
    assert.equal(enabledView.state.fastModeActive, true);
    const enabledWarm = await (await fetch(`${origin}/api/sessions/${sessionId}/warm`, { method: "POST" })).json() as { state: { fastModeActive?: boolean } };
    assert.equal(enabledWarm.state.fastModeActive, true);

    emit({ type: "extension_ui_request", method: "setStatus", statusKey: "fast" });
    const disabledView = await (await fetch(`${origin}/api/sessions/${sessionId}/view`)).json() as { state: { fastModeActive?: boolean } };
    const disabledWarm = await (await fetch(`${origin}/api/sessions/${sessionId}/warm`, { method: "POST" })).json() as { state: { fastModeActive?: boolean } };
    assert.equal(disabledView.state.fastModeActive, false);
    assert.equal(disabledWarm.state.fastModeActive, false);

    generation = 8;
    emit({ type: "extension_ui_request", method: "setStatus", statusKey: "fast", statusText: "⚡" }, 8);
    emit({ type: "pi_chat_process_error", error: "late generation 7 exit" }, 7);
    const rebound = await (await fetch(`${origin}/api/bootstrap`)).json() as { state: { fastModeActive?: boolean } };
    assert.equal(rebound.state.fastModeActive, true, "a delayed old process error cannot erase replacement status");
  } finally {
    server.close();
    await app.close();
  }
});

test("Secondary startup and recovery retain only the exact current generation's Fast status", async () => {
  const primaryPath = "C:\\sessions\\primary-fast.jsonl";
  const fastPath = "C:\\sessions\\secondary-fast.jsonl";
  const standardPath = "C:\\sessions\\secondary-standard.jsonl";
  const primaryId = idForPath(primaryPath);
  const fastId = idForPath(fastPath);
  const standardId = idForPath(standardPath);
  const primary = {
    onEvent: () => () => undefined,
    currentGeneration: () => 1,
    isRunning: () => true,
    send: async (command: Record<string, unknown>) => {
      if (command.type === "get_state")
        return { type: "response", success: true, data: { model: null, sessionFile: primaryPath, sessionId: "primary", isStreaming: false } };
      if (command.type === "get_messages")
        return { type: "response", success: true, data: { messages: [] } };
      if (command.type === "get_available_models")
        return { type: "response", success: true, data: { models: [] } };
      if (command.type === "get_commands")
        return { type: "response", success: true, data: { commands: [] } };
      if (command.type === "get_session_stats")
        return { type: "response", success: true, data: { tokens: {} } };
      return { type: "response", success: true };
    },
  } as unknown as PiRpcClient;
  const fastWorker = new FastWorker(fastPath, true);
  const standardWorker = new FastWorker(standardPath, false);
  const workers = [fastWorker, standardWorker];
  const summaries = [
    { id: primaryId, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 3, messageCount: 0, active: true },
    { id: fastId, sessionId: "fast", name: "Fast", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 0, active: false },
    { id: standardId, sessionId: "standard", name: "Standard", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 0, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => id === primaryId ? primaryPath : id === fastId ? fastPath : id === standardId ? standardPath : null,
    summaryForId: (id: string) => summaries.find((summary) => summary.id === id),
    messagesForId: async () => [],
    snapshotForId: async () => ({ messages: [], usage: { tokens: {}, context: null }, settings: {} }),
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary,
    createRpc: () => workers.shift() as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const fastResponse = await fetch(`${origin}/api/sessions/${fastId}/activate`, { method: "POST" });
    const standardResponse = await fetch(`${origin}/api/sessions/${standardId}/activate`, { method: "POST" });
    assert.equal(fastResponse.status, 200);
    assert.equal(standardResponse.status, 200);
    assert.equal((await fastResponse.json() as { state: { fastModeActive?: boolean } }).state.fastModeActive, true);
    assert.equal((await standardResponse.json() as { state: { fastModeActive?: boolean } }).state.fastModeActive, false);

    fastWorker.restartActive = true;
    fastWorker.emitOldErrorDuringRestart = true;
    fastWorker.fail();
    const recoveryPrompt = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "recover", sessionId: fastId }),
    });
    assert.equal(recoveryPrompt.status, 202);
    const recovered = await fetch(`${origin}/api/sessions/${fastId}/view?fast=1`);
    assert.equal((await recovered.json() as { state: { fastModeActive?: boolean } }).state.fastModeActive, true);

    // A delayed frame from generation 1 must not clear generation 2.
    fastWorker.emitFast(false, 1);
    const afterStale = await fetch(`${origin}/api/sessions/${fastId}/view?fast=1`);
    assert.equal(afterStale.status, 200);
    assert.equal((await afterStale.json() as { state: { fastModeActive?: boolean } }).state.fastModeActive, true);
  } finally {
    server.close();
    await app.close();
  }
});

test("capacity reclaim clears the App-owned Fast projection before a Session becomes cold", async () => {
  const primaryPath = "C:\\sessions\\capacity-primary.jsonl";
  const fastPath = "C:\\sessions\\capacity-fast.jsonl";
  const nextPath = "C:\\sessions\\capacity-next.jsonl";
  const primaryId = idForPath(primaryPath);
  const fastId = idForPath(fastPath);
  const nextId = idForPath(nextPath);
  const primary = {
    onEvent: () => () => undefined,
    currentGeneration: () => 1,
    isRunning: () => true,
    send: async (command: Record<string, unknown>) => {
      if (command.type === "get_state")
        return { type: "response", success: true, data: { model: null, sessionFile: primaryPath, sessionId: "primary", isStreaming: false } };
      if (command.type === "get_messages")
        return { type: "response", success: true, data: { messages: [] } };
      if (command.type === "get_available_models")
        return { type: "response", success: true, data: { models: [] } };
      if (command.type === "get_commands")
        return { type: "response", success: true, data: { commands: [] } };
      if (command.type === "get_session_stats")
        return { type: "response", success: true, data: { tokens: {} } };
      return { type: "response", success: true };
    },
  } as unknown as PiRpcClient;
  const workers = [new FastWorker(fastPath, true), new FastWorker(nextPath, false)];
  const summaries = [
    { id: primaryId, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 3, messageCount: 0, active: true },
    { id: fastId, sessionId: "fast", name: "Fast", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 0, active: false },
    { id: nextId, sessionId: "next", name: "Next", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 0, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => id === primaryId ? primaryPath : id === fastId ? fastPath : id === nextId ? nextPath : null,
    summaryForId: (id: string) => summaries.find((summary) => summary.id === id),
    messagesForId: async () => [],
    snapshotForId: async () => ({ messages: [], usage: { tokens: {}, context: null }, settings: {} }),
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary,
    createRpc: () => workers.shift() as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    maxSecondaryRuntimes: 1,
  });
  const frames: string[] = [];
  const clients = (app as unknown as { sseClients: Map<{ write: (frame: string) => void }, string> }).sseClients;
  clients.set({ write: (frame) => frames.push(frame) }, "");
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(`${origin}/api/sessions/${fastId}/activate`, { method: "POST" })).status, 200);
    frames.length = 0;
    assert.equal((await fetch(`${origin}/api/sessions/${nextId}/activate`, { method: "POST" })).status, 200);
    const events = frames
      .filter((frame) => frame.includes("pi_chat_fast_mode_changed"))
      .map((frame) => JSON.parse(frame.split("data: ")[1]) as { piChatSessionId?: string; active?: boolean });
    assert.ok(events.some((event) => event.piChatSessionId === fastId && event.active === false));
    const cold = await (await fetch(`${origin}/api/sessions/${fastId}/view`)).json() as { state: { fastModeActive?: boolean }; runtimeStatus: string };
    assert.equal(cold.runtimeStatus, "view-only");
    assert.equal(cold.state.fastModeActive, false);
  } finally {
    server.close();
    clients.clear();
    await app.close();
  }
});
