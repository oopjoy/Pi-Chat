import assert from "node:assert/strict";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import type { PiRpcClient } from "../../src/server/rpc-client";
import type { ResourceManager } from "../../src/server/resource-manager";
import type { SessionIndex } from "../../src/server/session-index";

const SESSION_ID = "0123456789abcdefabcd";

function payload(frame: string): Record<string, unknown> {
  return JSON.parse(frame.split("data: ")[1]?.trim() || "{}");
}

test("App stamps browser SSE events with process epoch and Session generation", async () => {
  const rpc = {
    onEvent: () => () => undefined,
    send: async () => ({
      type: "response",
      success: true,
      data: { model: null, isStreaming: false },
    }),
  } as unknown as PiRpcClient;
  const app = new PiChatApp({
    rpc,
    sessions: {} as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    runEpoch: "epoch-test",
  });
  const frames: string[] = [];
  const clients = (app as unknown as {
    sseClients: Map<{ write: (frame: string) => boolean }, string>;
  }).sseClients;
  clients.set({ write: (frame) => { frames.push(frame); return true; } }, "client");
  const internals = app as unknown as {
    broadcast(event: Record<string, unknown>): void;
    runGenerationsBySession: Map<string, number>;
  };
  internals.runGenerationsBySession.set(SESSION_ID, 7);

  try {
    internals.broadcast({
      type: "pi_chat_queue_update",
      piChatSessionId: SESSION_ID,
      queue: [],
      paused: false,
    });
    const queue = payload(frames.at(-1) || "");
    assert.equal(queue.piChatRunEpoch, "epoch-test");
    assert.equal(queue.piChatRunGeneration, 7);

    internals.broadcast({
      type: "pi_chat_sessions_changed",
      sessionId: SESSION_ID,
      action: "prompted",
    });
    const global = payload(frames.at(-1) || "");
    assert.equal(global.piChatRunEpoch, "epoch-test");
    assert.equal("piChatRunGeneration" in global, false);
  } finally {
    clients.clear();
    await app.close();
  }
});
