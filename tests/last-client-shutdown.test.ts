import assert from "node:assert/strict";
import test from "node:test";
import type { ServerResponse } from "node:http";
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

  emit(event: Record<string, unknown>) {
    for (const listener of this.listeners) listener(event);
  }

  isRunning() { return !this.stopped; }
  async stop() { this.stopped = true; }
  async send(command: Record<string, unknown>) {
    if (command.type === "get_state") return { type: "response", success: true, data: { model: null, isStreaming: false } };
    return { type: "response", success: true, data: {} };
  }
}

interface AppInternals {
  clientConnected(clientId: string): void;
  clientDisconnected(clientId: string): void;
  sseClients: Map<ServerResponse, string>;
}

function createApp(shutdown: () => void) {
  const rpc = new IdleRpc();
  const app = new PiChatApp({
    rpc: rpc as unknown as PiRpcClient,
    sessions: {} as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    applicationShutdown: shutdown,
    lastClientShutdownGraceMs: 25,
    lastClientIdlePollMs: 10,
  });
  return { app, rpc, internals: app as unknown as AppInternals };
}

function connect(internals: AppInternals, clientId: string): ServerResponse {
  const response = {} as ServerResponse;
  internals.sseClients.set(response, clientId);
  internals.clientConnected(clientId);
  return response;
}

function disconnect(internals: AppInternals, response: ServerResponse, clientId: string): void {
  internals.sseClients.delete(response);
  internals.clientDisconnected(clientId);
}

test("last SSE client leaving gracefully shuts down an idle Pi Chat service", async () => {
  let shutdowns = 0;
  const { app, internals } = createApp(() => { shutdowns += 1; });
  const response = connect(internals, "11111111-1111-4111-8111-111111111111");
  try {
    disconnect(internals, response, "11111111-1111-4111-8111-111111111111");
    await sleep(70);
    assert.equal(shutdowns, 1);
  } finally {
    await app.close();
  }
});

test("a reconnect during the final-client grace period cancels automatic shutdown", async () => {
  let shutdowns = 0;
  const { app, internals } = createApp(() => { shutdowns += 1; });
  const first = connect(internals, "11111111-1111-4111-8111-111111111111");
  try {
    disconnect(internals, first, "11111111-1111-4111-8111-111111111111");
    await sleep(10);
    const returning = connect(internals, "22222222-2222-4222-8222-222222222222");
    await sleep(55);
    assert.equal(shutdowns, 0);
    disconnect(internals, returning, "22222222-2222-4222-8222-222222222222");
    await sleep(70);
    assert.equal(shutdowns, 1);
  } finally {
    await app.close();
  }
});

test("automatic shutdown waits for a running Pi task to settle, then gives a fresh grace period", async () => {
  let shutdowns = 0;
  const { app, rpc, internals } = createApp(() => { shutdowns += 1; });
  const response = connect(internals, "11111111-1111-4111-8111-111111111111");
  try {
    rpc.emit({ type: "agent_start" });
    disconnect(internals, response, "11111111-1111-4111-8111-111111111111");
    await sleep(70);
    assert.equal(shutdowns, 0);
    rpc.emit({ type: "agent_settled" });
    await sleep(80);
    assert.equal(shutdowns, 1);
  } finally {
    await app.close();
  }
});
