import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import type { PiRpcClient } from "../../src/server/rpc-client";
import { idForPath } from "../../src/server/session-index";
import type { SessionIndex } from "../../src/server/session-index";
import type { ResourceManager } from "../../src/server/resource-manager";
import { FakeRpc } from "../helpers/server-app-fixture";

test("ordinary prompt applies its captured Model and Thinking snapshot immediately before Pi prompt", async () => {
  const path = "C:\\sessions\\prompt-settings.jsonl";
  const sessionId = idForPath(path);
  const rpc = new FakeRpc(path, "prompt-settings");
  const summary = {
    id: sessionId,
    sessionId: "prompt-settings",
    name: "Prompt settings",
    preview: "",
    cwd: process.cwd(),
    updatedAt: 1,
    messageCount: 1,
    active: true,
  };
  const sessions = {
    list: async () => [summary],
    pathForId: (id: string) => (id === sessionId ? path : null),
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: rpc as unknown as PiRpcClient,
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
    await fetch(`${origin}/api/bootstrap`);
    const response = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        message: "use captured selection",
        settings: {
          model: { provider: "test", modelId: "next" },
          thinkingLevel: "high",
        },
      }),
    });
    assert.equal(response.status, 202);
    const hotBootstrap = await fetch(`${origin}/api/bootstrap`);
    const hotData = await hotBootstrap.json() as {
      state: { model: { provider?: string; id?: string } | null; thinkingLevel?: string };
    };
    assert.deepEqual(
      hotData.state.model && {
        provider: hotData.state.model.provider,
        id: hotData.state.model.id,
      },
      { provider: "test", id: "next" },
      "busy hot reads adopt the prompt-applied Model instead of an old Runtime cache",
    );
    assert.equal(hotData.state.thinkingLevel, "high");
    assert.deepEqual(
      rpc.commands
        .filter((command) => ["set_model", "set_thinking_level", "prompt"].includes(String(command.type)))
        .map((command) => ({ type: command.type, provider: command.provider, modelId: command.modelId, level: command.level, message: command.message })),
      [
        { type: "set_model", provider: "test", modelId: "next", level: undefined, message: undefined },
        { type: "set_thinking_level", provider: undefined, modelId: undefined, level: "high", message: undefined },
        { type: "prompt", provider: undefined, modelId: undefined, level: undefined, message: "use captured selection" },
      ],
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("legacy setting requests cannot interleave a snapshot-bearing prompt transaction", async () => {
  const path = "C:\\sessions\\serialized-prompt-settings.jsonl";
  const sessionId = idForPath(path);
  const rpc = new FakeRpc(path, "serialized-prompt-settings");
  const originalSend = rpc.send.bind(rpc);
  let releaseModel!: () => void;
  const modelBlocked = new Promise<void>((resolve) => { releaseModel = resolve; });
  let blockSnapshotModel = true;
  rpc.send = async (command, timeoutMs, options) => {
    const result = await originalSend(command, timeoutMs, options);
    if (blockSnapshotModel && command.type === "set_model") {
      blockSnapshotModel = false;
      await modelBlocked;
    }
    return result;
  };
  const sessions = {
    list: async () => [{ id: sessionId, sessionId: "serialized-prompt-settings", name: "Serialized", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: (id: string) => (id === sessionId ? path : null),
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    const snapshotPrompt = fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        message: "snapshot prompt",
        settings: {
          model: { provider: "test", modelId: "next" },
          thinkingLevel: "high",
        },
      }),
    });
    for (let attempt = 0; attempt < 30 && !rpc.commands.some((command) => command.type === "set_model"); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(rpc.commands.some((command) => command.type === "set_model"));
    const legacy = fetch(`${origin}/api/models/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, provider: "test", modelId: "next" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      rpc.commands.filter((command) => command.type === "set_model").length,
      1,
      "the legacy route waits behind the snapshot transaction instead of inserting another set_model",
    );
    releaseModel();
    assert.equal((await snapshotPrompt).status, 202);
    assert.equal((await legacy).status, 200);
    const ordered = rpc.commands
      .filter((command) => ["set_model", "set_thinking_level", "prompt"].includes(String(command.type)))
      .map((command) => command.type);
    assert.deepEqual(
      ordered.slice(0, 3),
      ["set_model", "set_thinking_level", "prompt"],
      "the admitted snapshot remains an indivisible settings-then-prompt sequence",
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("malformed prompt settings fail closed before a Runtime mutation", async () => {
  const path = "C:\\sessions\\bad-prompt-settings.jsonl";
  const sessionId = idForPath(path);
  const rpc = new FakeRpc(path, "bad-prompt-settings");
  const sessions = {
    list: async () => [{ id: sessionId, sessionId: "bad-prompt-settings", name: "Bad settings", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: (id: string) => (id === sessionId ? path : null),
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: "reject", settings: { model: { provider: "test" } } }),
    });
    assert.equal(response.status, 400);
    assert.equal(rpc.commands.length, 0, "invalid settings cannot warm or mutate Pi");
    const unavailable = await fetch(`http://127.0.0.1:${address.port}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        message: "reject unavailable",
        settings: { model: { provider: "test", modelId: "missing" } },
      }),
    });
    assert.equal(unavailable.status, 400);
    assert.equal(
      rpc.commands.some((command) => command.type === "set_model" || command.type === "prompt"),
      false,
      "a well-formed model outside the target Runtime catalogue cannot reach Pi prompt delivery",
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("a queued snapshot preserves a later legacy pending setting for the following prompt", async () => {
  const path = "C:\\sessions\\later-legacy-setting.jsonl";
  const sessionId = idForPath(path);
  const rpc = new FakeRpc(path, "later-legacy-setting");
  const sessions = {
    list: async () => [{ id: sessionId, sessionId: "later-legacy-setting", name: "Later legacy", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: (id: string) => (id === sessionId ? path : null),
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  try {
    const pending = { model: { provider: "test", modelId: "next" } };
    const apply = app as unknown as {
      applyPromptSettings(
        target: PiRpcClient,
        legacy: typeof pending,
        snapshot: { model: { provider: string; modelId: string } },
      ): Promise<unknown>;
    };
    await apply.applyPromptSettings(
      rpc as unknown as PiRpcClient,
      pending,
      { model: { provider: "test", modelId: "next" } },
    );
    assert.deepEqual(
      pending,
      { model: { provider: "test", modelId: "next" } },
      "a legacy setting admitted after a queued snapshot remains pending for the following row",
    );
  } finally {
    await app.close();
  }
});

test("a rejected snapshot does not erase an already-pending legacy setting", async () => {
  const path = "C:\\sessions\\rejected-snapshot.jsonl";
  const sessionId = idForPath(path);
  const rpc = new FakeRpc(path, "rejected-snapshot");
  const sessions = {
    list: async () => [{ id: sessionId, sessionId: "rejected-snapshot", name: "Rejected snapshot", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: (id: string) => (id === sessionId ? path : null),
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (body: Record<string, unknown>) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, ...body }),
  });
  try {
    await fetch(`${origin}/api/bootstrap`);
    assert.equal((await post({ message: "running" })).status, 202);
    for (let index = 0; index < 20; index += 1)
      assert.equal((await post({ message: `queued-${index}` })).status, 202);
    assert.equal((await fetch(`${origin}/api/models/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, provider: "test", modelId: "next" }),
    })).status, 200);
    const rejected = await post({
      message: "rejected snapshot",
      settings: { model: { provider: "test", modelId: "next" } },
    });
    assert.equal(rejected.status, 409);
    assert.deepEqual(
      (app as unknown as {
        scheduler: { primaryPendingTurnSettings: { model?: unknown } };
      }).scheduler.primaryPendingTurnSettings.model,
      { provider: "test", modelId: "next" },
      "a queue-rejected snapshot cannot consume a legacy setting it never admitted",
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("partial prompt-setting failure retains the successfully applied Model in the hot cache", async () => {
  class ThinkingFailureRpc extends FakeRpc {
    override async send(command: Record<string, unknown>, timeoutMs?: number, options?: unknown) {
      if (command.type === "set_thinking_level") throw new Error("thinking rejected");
      return super.send(command, timeoutMs, options as never);
    }
  }
  const path = "C:\\sessions\\partial-prompt-settings.jsonl";
  const sessionId = idForPath(path);
  const rpc = new ThinkingFailureRpc(path, "partial-prompt-settings");
  const sessions = {
    list: async () => [{ id: sessionId, sessionId: "partial-prompt-settings", name: "Partial", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: (id: string) => (id === sessionId ? path : null),
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        message: "partial",
        settings: {
          model: { provider: "test", modelId: "next" },
          thinkingLevel: "high",
        },
      }),
    });
    assert.equal(response.status, 500);
    const hotState = (app as unknown as {
      lastPrimaryState: { model: { provider?: string; id?: string } | null };
    }).lastPrimaryState;
    assert.deepEqual(
      hotState.model && { provider: hotState.model.provider, id: hotState.model.id },
      { provider: "test", id: "next" },
      "the cache records Model even when the later Thinking command failed",
    );
  } finally {
    server.close();
    await app.close();
  }
});
