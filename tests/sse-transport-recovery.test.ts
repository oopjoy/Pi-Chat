import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PiChatApp } from "../src/server/app";
import type { PiRpcClient } from "../src/server/rpc-client";
import type { ResourceManager } from "../src/server/resource-manager";
import type { SessionIndex } from "../src/server/session-index";

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

class IdleRpc {
  private readonly listeners = new Set<(event: Record<string, unknown>) => void>();
  stopped = false;

  onEvent(listener: (event: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isRunning() { return !this.stopped; }
  async stop() { this.stopped = true; }
  async send(command: Record<string, unknown>) {
    if (command.type === "get_state") return { type: "response", success: true, data: { model: null, isStreaming: false } };
    if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [] } };
    if (command.type === "get_available_models") return { type: "response", success: true, data: { models: [] } };
    if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [] } };
    if (command.type === "get_session_stats") return { type: "response", success: true, data: {} };
    return { type: "response", success: true, data: {} };
  }
}

async function startApp() {
  const rpc = new IdleRpc();
  const app = new PiChatApp({
    rpc: rpc as unknown as PiRpcClient,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    app,
    origin,
    close: async () => {
      await app.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function openEvents(origin: string, client: string) {
  const bootstrap = await fetch(`${origin}/api/bootstrap`);
  assert.equal(bootstrap.status, 200);
  const token = (await bootstrap.json() as { requestToken: string }).requestToken;
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/events?token=${encodeURIComponent(token)}&client=${encodeURIComponent(client)}`, {
    headers: { origin, "x-pi-chat-client": client },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  assert.ok(reader);
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: ready/);
  return { controller, reader };
}

test("a real sole SSE transport drop leaves health, bootstrap, and a replacement SSE available", async () => {
  const fixture = await startApp();
  const firstClient = "11111111-1111-4111-8111-111111111111";
  const secondClient = "22222222-2222-4222-8222-222222222222";
  try {
    const first = await openEvents(fixture.origin, firstClient);
    first.controller.abort();
    await first.reader.cancel().catch(() => undefined);
    await sleep(60);

    assert.equal((await fetch(`${fixture.origin}/api/health`)).status, 200);
    assert.equal((await fetch(`${fixture.origin}/api/bootstrap`)).status, 200);

    const replacement = await openEvents(fixture.origin, secondClient);
    replacement.controller.abort();
    await replacement.reader.cancel().catch(() => undefined);
  } finally {
    await fixture.close();
  }
});

test("a sole backpressured SSE client is dropped without taking down the application", async () => {
  const fixture = await startApp();
  const appInternals = fixture.app as unknown as {
    sseClients: Map<object, string>;
    broadcast(event: Record<string, unknown>): void;
  };
  const client = new EventEmitter() as EventEmitter & { ended: boolean; write(frame: string): boolean; end(): void };
  client.ended = false;
  client.write = () => false;
  client.end = () => { client.ended = true; };
  appInternals.sseClients.set(client, "backpressured-client");
  try {
    // The first false write enters backpressure; later non-coalescible frames
    // deliberately exceed the 2 MiB retention cap and force this client away.
    for (let index = 0; index < 6; index += 1) {
      appInternals.broadcast({ type: "tool_execution_end", sequence: index, payload: "x".repeat(450_000) });
    }
    assert.equal(client.ended, true);
    assert.equal(appInternals.sseClients.size, 0);
    assert.equal((await fetch(`${fixture.origin}/api/health`)).status, 200);
    assert.equal((await fetch(`${fixture.origin}/api/bootstrap`)).status, 200);
  } finally {
    await fixture.close();
  }
});
