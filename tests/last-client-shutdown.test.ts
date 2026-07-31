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
  connectedClients: Map<string, number>;
}

function createApp(shutdown: (reason: "api-shutdown" | "last-window-close") => void) {
  const rpc = new IdleRpc();
  const app = new PiChatApp({
    rpc: rpc as unknown as PiRpcClient,
    sessions: {} as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    applicationShutdown: shutdown,
    controllerReleaseMs: 25,
  });
  return { app, internals: app as unknown as AppInternals };
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

test("last SSE client leaving releases presence but keeps an idle Pi Chat service alive", async () => {
  let shutdowns = 0;
  const { app, internals } = createApp(() => { shutdowns += 1; });
  const clientId = "11111111-1111-4111-8111-111111111111";
  const response = connect(internals, clientId);
  try {
    disconnect(internals, response, clientId);
    await sleep(70);
    assert.equal(shutdowns, 0);
    assert.equal(internals.connectedClients.has(clientId), false);
  } finally {
    await app.close();
  }
});

test("an SSE reconnect after a transport drop keeps the same service available", async () => {
  let shutdowns = 0;
  const { app, internals } = createApp(() => { shutdowns += 1; });
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  const first = connect(internals, firstId);
  try {
    disconnect(internals, first, firstId);
    await sleep(40);
    const returning = connect(internals, secondId);
    assert.equal(shutdowns, 0);
    assert.equal(internals.connectedClients.get(secondId), 1);
    disconnect(internals, returning, secondId);
    await sleep(40);
    assert.equal(shutdowns, 0);
  } finally {
    await app.close();
  }
});

test("an idle Runtime after the final SSE disconnect is not an implicit shutdown request", async () => {
  let shutdowns = 0;
  const { app, internals } = createApp(() => { shutdowns += 1; });
  const clientId = "11111111-1111-4111-8111-111111111111";
  const response = connect(internals, clientId);
  try {
    disconnect(internals, response, clientId);
    await sleep(70);
    assert.equal(shutdowns, 0);
  } finally {
    await app.close();
  }
});
