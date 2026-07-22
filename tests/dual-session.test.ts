import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiChatApp } from "../src/server/app";
import type { PiRpcClient } from "../src/server/rpc-client";
import { idForPath } from "../src/server/session-index";
import type { SessionIndex } from "../src/server/session-index";
import type { ResourceManager } from "../src/server/resource-manager";
import { ModelManager } from "../src/server/model-manager";

class FakeRpc {
  readonly commands: Record<string, unknown>[] = [];
  private listeners = new Set<(event: Record<string, unknown>) => void>();
  streaming = false;
  stopCount = 0;
  restartCount = 0;
  restartFailures = 0;
  alive = true;

  constructor(readonly path: string, readonly sessionId: string) {}
  onEvent(listener: (event: Record<string, unknown>) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: Record<string, unknown>) { for (const listener of this.listeners) listener(event); }
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
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), applicationShutdown: () => { shutdowns += 1; } });
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const internals = app as unknown as { connectedClients: Map<string, number>; viewedSessionsByClient: Map<string, string> };
  internals.connectedClients.set(first, 1);
  internals.connectedClients.set(second, 1);
  internals.viewedSessionsByClient.set(first, id);
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
    assert.equal(internals.connectedClients.has(first), false);
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
  const internals = app as unknown as { connectedClients: Map<string, number>; viewedSessionsByClient: Map<string, string>; lifecycleCoordinator: { beginMutation(): () => void } };
  internals.connectedClients.set(first, 1);
  internals.connectedClients.set(second, 1);
  internals.viewedSessionsByClient.set(first, id);
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

test("closing the last connected window shuts down the Pi Chat application", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  let shutdowns = 0;
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), applicationShutdown: () => { shutdowns += 1; } });
  const client = "11111111-1111-4111-8111-111111111111";
  (app as unknown as { connectedClients: Map<string, number> }).connectedClients.set(client, 1);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/window/close`, { method: "POST", headers: { "x-pi-chat-client": client } });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { shuttingDown: true, closeWindow: true, remainingWindows: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(shutdowns, 1);
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
    await new Promise((resolve) => setTimeout(resolve, 5));
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "pi-chat", lifecycle: "restarting" });
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

test("an in-flight mutation lease prevents restart before the Prompt body is complete", async () => {
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
    assert.equal(restart.status, 409);
    assert.equal((await restart.json() as { code?: string }).code, "APPLICATION_BUSY");
    const health = await fetch(`${origin}/api/health`);
    assert.equal((await health.json() as { lifecycle: string }).lifecycle, "idle");
  } finally {
    slowPrompt.destroy();
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

test("paused Secondary queue blocks workspace and resource reload operations", async () => {
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
    assert.equal(workspace.status, 409);
    const resource = await fetch(`${origin}/api/resources/skills`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "skill", enabled: true }) });
    assert.equal(resource.status, 409);
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

test("workspace change restores the previous Runtime when the new workspace restart fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-rollback-"));
  const previousCwd = join(root, "old");
  const nextCwd = join(root, "new");
  await Promise.all([mkdir(previousCwd), mkdir(nextCwd)]);
  const path = "C:\\sessions\\primary.jsonl";
  const primary = new FakeRpc(path, "primary");
  primary.restartFailures = 1;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: previousCwd, webRoot: process.cwd() });
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
    assert.equal(response.status, 500);
    assert.match((await response.json() as { error: string }).error, /已恢复原工作目录/);
    assert.equal((app as unknown as { currentCwd: string }).currentCwd, previousCwd);
    assert.equal(primary.restartCount, 2);
    assert.equal(primary.alive, true);
  } finally {
    server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("last-window close refuses while a prompt is dispatching", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const primary = new FakeRpc(path, "primary");
  let shutdowns = 0;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), applicationShutdown: () => { shutdowns += 1; } });
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
    assert.equal(response.status, 409);
    assert.equal(shutdowns, 0);
    assert.equal(internals.connectedClients.has(client), true);
  } finally {
    server.close();
    await app.close();
  }
});

test("global shutdown refuses while any conversation is still busy", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const primary = new FakeRpc(path, "primary");
  let shutdowns = 0;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), applicationShutdown: () => { shutdowns += 1; } });
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
  let shutdowns = 0;
  const frames: string[] = [];
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), applicationShutdown: () => { shutdowns += 1; } });
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
    assert.equal(shutdowns, 1);
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
  const owner = "11111111-1111-4111-8111-111111111111";
  const observer = "22222222-2222-4222-8222-222222222222";
  clients.set({ write: (frame) => { ownerFrames.push(frame); } }, owner);
  clients.set({ write: (frame) => { observerFrames.push(frame); } }, observer);
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

test("a crashed primary RPC clears stale state and recovers on the next bootstrap", async () => {
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
    assert.equal(primary.restartCount, 1);
    assert.equal(recovered.state.isStreaming, false);
    assert.equal(recovered.sessions.find((session) => session.id === id)?.running, false);
  } finally {
    server.close();
    await app.close();
  }
});

test("Session list recovers a crashed primary while cold history view stays read-only", async () => {
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
      assert.equal(primary.restartCount, endpoint === "view" ? 0 : 1);
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

test("startup preheats the three most recent saved secondary sessions sequentially", async () => {
  const paths = ["C:\\sessions\\primary.jsonl", "C:\\sessions\\newest.jsonl", "C:\\sessions\\next.jsonl", "C:\\sessions\\third.jsonl", "C:\\sessions\\older.jsonl"];
  const ids = paths.map(idForPath);
  const primary = new FakeRpc(paths[0], "primary");
  const workers = [new FakeRpc(paths[1], "newest"), new FakeRpc(paths[2], "next"), new FakeRpc(paths[3], "third")];
  const created: FakeRpc[] = [];
  const summaries = paths.map((path, index) => ({ id: ids[index], sessionId: `s${index}`, name: `S${index}`, preview: `S${index}`, cwd: process.cwd(), updatedAt: 100 - index, messageCount: 1, active: index === 0 }));
  const sessions = {
    list: async (activePath?: string) => summaries.map((session) => ({ ...session, active: session.id === idForPath(activePath || paths[0]) })),
    pathForId: (id: string) => paths[ids.indexOf(id)] || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => { const worker = workers.shift(); if (!worker) throw new Error("unexpected worker"); created.push(worker); return worker as unknown as PiRpcClient; },
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    maxIdleSecondaryRuntimes: 3,
  });
  try {
    assert.deepEqual(await app.preheatRecentSessions(), ids.slice(1, 4));
    assert.equal(created.length, 3);
    assert.deepEqual(created.map((worker) => worker.path), paths.slice(1, 4));
    assert.deepEqual(await app.preheatRecentSessions(), ids.slice(1, 4));
    assert.equal(created.length, 3);
  } finally {
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

test("four viewed idle Sessions still obey the hard cap of three Secondary Runtimes", async () => {
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
