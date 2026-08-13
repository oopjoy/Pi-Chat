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
