import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import { RpcProcessExitUnconfirmedError, RpcRequestTimeoutError, type PiRpcClient } from "../../src/server/rpc-client";
import { idForPath } from "../../src/server/session-index";
import type { SessionIndex } from "../../src/server/session-index";
import type { ResourceManager } from "../../src/server/resource-manager";
import { FakeRpc } from "../helpers/server-app-fixture";
import { PartialTurnSettingsError } from "../../src/server/runtime-pool";

class UnknownSettingRpc extends FakeRpc {
  private unresolved = true;
  lateResponse?: (response: Record<string, unknown>, requestId: string) => void;

  constructor(
    path: string,
    sessionId: string,
    private readonly unknownType: "set_model" | "set_thinking_level",
  ) {
    super(path, sessionId);
  }

  override async send(command: Record<string, unknown>, timeoutMs?: number, options?: Parameters<FakeRpc["send"]>[2]) {
    if (command.type === this.unknownType && this.unresolved) {
      this.lateResponse = (options as unknown as { onLateResponse?: (response: Record<string, unknown>, requestId: string) => void })?.onLateResponse;
      this.commands.push(command);
      throw new RpcRequestTimeoutError(this.unknownType);
    }
    return super.send(command, timeoutMs, options);
  }

  resolveLate(): void {
    this.unresolved = false;
    this.lateResponse?.({ type: "response", success: true }, "late-setting");
  }
}

test("nested unconfirmed setting failures map to RESULT_PENDING", async () => {
  const path = "C:\\sessions\\nested-unknown-setting.jsonl";
  const app = new PiChatApp({
    rpc: new FakeRpc(path, "nested-unknown-setting") as unknown as PiRpcClient,
    sessions: {} as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const internals = app as unknown as {
    rethrowResultPending(error: unknown, operation: string): never;
    rpcOutcomePendingBySession: Set<string>;
    rpcOutcomeTokensBySession: Map<string, string>;
    lateRpcOutcomeHandler(sessionId: string, token: string, kind: "generic" | "compact" | "extension", requestId?: string): (response: Record<string, unknown>) => void;
  };
  try {
    assert.throws(
      () => internals.rethrowResultPending(
        new PartialTurnSettingsError(
          { model: { provider: "test", id: "next", name: "Next" } },
          new RpcProcessExitUnconfirmedError(9876),
        ),
        "准备 Prompt 设置",
      ),
      (error) => error instanceof Error && (error as { code?: string }).code === "RESULT_PENDING",
    );
    const oldToken = "late-setting-old-token";
    const newToken = "late-setting-new-token";
    internals.rpcOutcomePendingBySession.add("session");
    internals.rpcOutcomeTokensBySession.set("session", newToken);
    internals.lateRpcOutcomeHandler("session", oldToken, "generic")({ type: "response", success: true });
    assert.equal(internals.rpcOutcomePendingBySession.has("session"), true, "an old late response cannot clear a newer fence");
    internals.lateRpcOutcomeHandler("session", newToken, "generic")({ type: "response", success: true });
    assert.equal(internals.rpcOutcomePendingBySession.has("session"), false);
    assert.equal(internals.rpcOutcomeTokensBySession.has("session"), false);
  } finally {
    await app.close();
  }
});

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

test("an unknown prompt Model write fences later mutations as RESULT_PENDING", async () => {
  const path = "C:\\sessions\\unknown-prompt-model.jsonl";
  const sessionId = idForPath(path);
  const rpc = new UnknownSettingRpc(path, "unknown-prompt-model", "set_model");
  const sessions = {
    list: async () => [{ id: sessionId, sessionId: "unknown-prompt-model", name: "Unknown model", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: (id: string) => (id === sessionId ? path : null),
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (message: string) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, message, settings: { model: { provider: "test", modelId: "next" } } }),
  });
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    const first = await post("uncertain model prompt");
    assert.equal(first.status, 409);
    const firstBody = await first.json() as { code?: string; outcomeUnknown?: boolean };
    assert.equal(firstBody.code, "RESULT_PENDING");
    assert.equal(firstBody.outcomeUnknown, undefined, "the user prompt itself was never written; only preflight is uncertain");
    const second = await post("must not overtake model write");
    assert.equal(second.status, 409);
    const secondBody = await second.json() as { code?: string; outcomeUnknown?: boolean };
    assert.equal(secondBody.code, "RESULT_PENDING");
    assert.equal(secondBody.outcomeUnknown, undefined);
    assert.equal(rpc.commands.filter((command) => command.type === "set_model").length, 1);
    assert.equal(rpc.commands.some((command) => command.type === "prompt"), false);
  } finally {
    server.close();
    await app.close();
  }
});

test("an unknown direct Model write fences every competing Session mutation", async () => {
  const path = "C:\\sessions\\unknown-direct-model.jsonl";
  const sessionId = idForPath(path);
  const rpc = new UnknownSettingRpc(path, "unknown-direct-model", "set_model");
  const sessions = {
    list: async () => [{ id: sessionId, sessionId: "unknown-direct-model", name: "Unknown direct model", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: (id: string) => (id === sessionId ? path : null),
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (route: string, body: Record<string, unknown>) => fetch(`${origin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, ...body }),
  });
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    const first = await post("/api/models/set", { provider: "test", modelId: "next" });
    assert.equal(first.status, 409);
    assert.equal((await first.json() as { code?: string }).code, "RESULT_PENDING");
    for (const [route, body] of [
      ["/api/models/set", { provider: "test", modelId: "next" }],
      ["/api/thinking/set", { level: "high" }],
      ["/api/chat/compact", {}],
      ["/api/chat/prompt", { message: "must not overtake the setting" }],
    ] as const) {
      const response = await post(route, body);
      assert.equal(response.status, 409, `${route} must be fenced after an uncertain Model write`);
      assert.equal((await response.json() as { code?: string }).code, "RESULT_PENDING");
    }
    assert.equal(rpc.commands.filter((command) => command.type === "set_model").length, 1);
    assert.equal(rpc.commands.some((command) => command.type === "set_thinking_level" || command.type === "compact" || command.message === "must not overtake the setting"), false);
  } finally {
    server.close();
    await app.close();
  }
});

test("a read-only model catalogue timeout does not create a mutation fence", async () => {
  class CatalogueTimeoutRpc extends FakeRpc {
    override async send(command: Record<string, unknown>, timeoutMs?: number, options?: Parameters<FakeRpc["send"]>[2]) {
      if (command.type === "get_available_models")
        throw new RpcRequestTimeoutError("get_available_models");
      return super.send(command, timeoutMs, options);
    }
  }
  const path = "C:\\sessions\\catalogue-read-timeout.jsonl";
  const sessionId = idForPath(path);
  const rpc = new CatalogueTimeoutRpc(path, "catalogue-read-timeout");
  const sessions = {
    list: async () => [{ id: sessionId, sessionId: "catalogue-read-timeout", name: "Catalogue timeout", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: (id: string) => (id === sessionId ? path : null),
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`)).status, 200);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: "catalogue is unavailable", settings: { model: { provider: "test", modelId: "next" } } }),
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { code?: string; outcomeUnknown?: boolean };
    assert.equal(body.code, "RESULT_PENDING");
    assert.equal(body.outcomeUnknown, undefined, "the user prompt was not written");
    assert.equal((app as unknown as { rpcOutcomePendingBySession: Set<string> }).rpcOutcomePendingBySession.has(sessionId), false);
  } finally {
    server.close();
    await app.close();
  }
});

test("a late successful Model response releases only its matching outcome fence", async () => {
  const path = "C:\\sessions\\late-model-response.jsonl";
  const sessionId = idForPath(path);
  const rpc = new UnknownSettingRpc(path, "late-model-response", "set_model");
  const sessions = {
    list: async () => [{ id: sessionId, sessionId: "late-model-response", name: "Late model", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: (id: string) => (id === sessionId ? path : null),
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (route: string, body: Record<string, unknown>) => fetch(`${origin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, ...body }),
  });
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    const first = await post("/api/models/set", { provider: "test", modelId: "next" });
    assert.equal(first.status, 409);
    rpc.resolveLate();
    const second = await post("/api/models/set", { provider: "test", modelId: "next" });
    assert.equal(second.status, 200, "a matching late response releases its own fence");
    assert.equal(rpc.commands.filter((command) => command.type === "set_model").length, 2);
  } finally {
    server.close();
    await app.close();
  }
});

test("an unknown direct Thinking write fences later Model and prompt mutations", async () => {
  const path = "C:\\sessions\\unknown-direct-thinking.jsonl";
  const sessionId = idForPath(path);
  const rpc = new UnknownSettingRpc(path, "unknown-direct-thinking", "set_thinking_level");
  const sessions = {
    list: async () => [{ id: sessionId, sessionId: "unknown-direct-thinking", name: "Unknown direct thinking", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: (id: string) => (id === sessionId ? path : null),
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (route: string, body: Record<string, unknown>) => fetch(`${origin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, ...body }),
  });
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    const first = await post("/api/thinking/set", { level: "high" });
    assert.equal(first.status, 409);
    assert.equal((await first.json() as { code?: string }).code, "RESULT_PENDING");
    const model = await post("/api/models/set", { provider: "test", modelId: "next" });
    assert.equal(model.status, 409);
    assert.equal((await model.json() as { code?: string }).code, "RESULT_PENDING");
    const prompt = await post("/api/chat/prompt", { message: "must remain fenced" });
    assert.equal(prompt.status, 409);
    assert.equal((await prompt.json() as { code?: string }).code, "RESULT_PENDING");
    assert.equal(rpc.commands.filter((command) => command.type === "set_thinking_level").length, 1);
    assert.equal(rpc.commands.some((command) => command.type === "set_model" || command.message === "must remain fenced"), false);
  } finally {
    server.close();
    await app.close();
  }
});

test("a post-setting read timeout does not fence a later prompt", async () => {
  class ThinkingReadTimeoutRpc extends FakeRpc {
    private settingApplied = false;
    private failConfirmation = true;

    override async send(command: Record<string, unknown>, timeoutMs?: number, options?: Parameters<FakeRpc["send"]>[2]) {
      if (command.type === "set_thinking_level") {
        const result = await super.send(command, timeoutMs, options);
        this.settingApplied = true;
        return result;
      }
      if (command.type === "get_state" && this.settingApplied && this.failConfirmation) {
        this.failConfirmation = false;
        throw new RpcRequestTimeoutError("get_state");
      }
      return super.send(command, timeoutMs, options);
    }
  }
  const path = "C:\\sessions\\thinking-read-timeout.jsonl";
  const sessionId = idForPath(path);
  const rpc = new ThinkingReadTimeoutRpc(path, "thinking-read-timeout");
  const sessions = {
    list: async () => [{ id: sessionId, sessionId: "thinking-read-timeout", name: "Thinking read timeout", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: (id: string) => (id === sessionId ? path : null),
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`)).status, 200);
    const setting = await fetch(`http://127.0.0.1:${address.port}/api/thinking/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, level: "high" }),
    });
    assert.equal(setting.status, 409);
    assert.equal((app as unknown as { rpcOutcomePendingBySession: Set<string> }).rpcOutcomePendingBySession.has(sessionId), false);
    const prompt = await fetch(`http://127.0.0.1:${address.port}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: "send after read timeout" }),
    });
    assert.equal(prompt.status, 202);
  } finally {
    server.close();
    await app.close();
  }
});

test("an unknown Gate preflight write fences the following Session mutations", async () => {
  class UnknownGateRpc extends FakeRpc {
    override async send(command: Record<string, unknown>, timeoutMs?: number, options?: Parameters<FakeRpc["send"]>[2]) {
      if (command.type === "prompt" && command.message === "/gate open") {
        this.commands.push(command);
        throw new RpcRequestTimeoutError("prompt");
      }
      return super.send(command, timeoutMs, options);
    }
  }
  const path = "C:\\sessions\\unknown-gate-preflight.jsonl";
  const sessionId = idForPath(path);
  const rpc = new UnknownGateRpc(path, "unknown-gate-preflight");
  const sessions = {
    list: async () => [{ id: sessionId, sessionId: "unknown-gate-preflight", name: "Unknown Gate", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
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
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    const first = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: "gate preflight", gateMode: "open" }),
    });
    assert.equal(first.status, 409);
    assert.equal((await first.json() as { code?: string }).code, "RESULT_PENDING");
    const model = await fetch(`${origin}/api/models/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, provider: "test", modelId: "next" }),
    });
    assert.equal(model.status, 409);
    assert.equal((await model.json() as { code?: string }).code, "RESULT_PENDING");
    assert.equal(rpc.commands.filter((command) => command.message === "/gate open").length, 1);
    assert.equal(rpc.commands.some((command) => command.type === "set_model"), false);
  } finally {
    server.close();
    await app.close();
  }
});

test("HTTP abort invalidates an in-flight Primary Gate preflight before prompt dispatch", async () => {
  let releaseGate!: () => void;
  let gateEntered!: () => void;
  const gateReady = new Promise<void>((resolve) => { gateEntered = resolve; });
  const gateRelease = new Promise<void>((resolve) => { releaseGate = resolve; });
  class BlockingGateRpc extends FakeRpc {
    override async send(command: Record<string, unknown>, timeoutMs?: number, options?: Parameters<FakeRpc["send"]>[2]) {
      if (command.type === "prompt" && command.message === "/gate open") {
        gateEntered();
        await gateRelease;
      }
      return super.send(command, timeoutMs, options);
    }
  }
  const path = "C:\\sessions\\abort-during-gate.jsonl";
  const sessionId = idForPath(path);
  const rpc = new BlockingGateRpc(path, "abort-during-gate");
  const sessions = {
    list: async () => [{ id: sessionId, sessionId: "abort-during-gate", name: "Abort during Gate", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: (id: string) => (id === sessionId ? path : null),
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (route: string, body: Record<string, unknown>) => fetch(`${origin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, ...body }),
  });
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    const prompt = post("/api/chat/prompt", { message: "must not dispatch", gateMode: "open" });
    await gateReady;
    const abort = await post("/api/chat/abort", {});
    assert.equal(abort.status, 200);
    releaseGate();
    const promptResponse = await prompt;
    assert.notEqual(promptResponse.status, 202, "an invalidated preflight cannot report prompt acceptance");
    assert.equal(rpc.commands.some((command) => command.message === "must not dispatch"), false);
    assert.equal(rpc.commands.some((command) => command.type === "abort"), true);
  } finally {
    releaseGate();
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
