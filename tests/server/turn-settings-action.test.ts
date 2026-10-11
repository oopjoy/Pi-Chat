import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInfo, PiState } from "../../src/shared/types";
import { PiChatApp } from "../../src/server/app";
import type { PiRpcClient } from "../../src/server/rpc-client";
import type { SessionIndex } from "../../src/server/session-index";
import type { ResourceManager } from "../../src/server/resource-manager";
import { FakeRpc } from "../helpers/server-app-fixture";
import { HttpRequestError } from "../../src/server/http-transport";
import { PartialTurnSettingsError } from "../../src/server/runtime-pool";
import type { RpcLateResponseHandler, RpcSendOptions } from "../../src/server/rpc-client";
import { createTurnSettingsAction, type TurnSettingsCommand, type TurnSettingsPorts, type TurnSettingsRpc, type TurnSettingsSnapshot } from "../../src/server/services/turn-settings-action";

function fixture() {
  const model: ModelInfo = { provider: "provider", id: "model", name: "Model", api: "openai-responses", reasoning: true, contextWindow: 128000 };
  const settings: TurnSettingsSnapshot = Object.freeze({ model: Object.freeze({ provider: model.provider, modelId: model.id, api: model.api }), thinkingLevel: "high" });
  const calls: Array<{ command: Readonly<TurnSettingsCommand>; timeout?: number; options?: Pick<RpcSendOptions, "onLateResponse"> }> = [];
  const handlers: Array<{ sessionId: string; token: string; handler: RpcLateResponseHandler }> = [];
  const failures: Array<{ sessionId: string; error: unknown; token: string }> = [];
  const remembered: ModelInfo[] = [];
  let available: ModelInfo[] = [model];
  let state: PiState = { model, isStreaming: false, thinkingLevel: "medium" };
  let failure: { type: TurnSettingsCommand["type"]; error: Error } | undefined;
  const ports: TurnSettingsPorts = {
    lateRpcOutcomeHandler: (sessionId, token) => {
      const handler: RpcLateResponseHandler = () => {};
      handlers.push({ sessionId, token, handler });
      return handler;
    },
    markRpcOutcomePending: (sessionId, error, token) => { failures.push({ sessionId, error, token }); },
    rememberModelContextWindows: models => { remembered.push(...models); },
  };
  const rpc: TurnSettingsRpc = { send: async (command, timeout, options) => {
    calls.push({ command, timeout, options });
    if (failure?.type === command.type) throw failure.error;
    return { type: "response", success: true, data: command.type === "get_available_models" ? { models: available } : command.type === "get_state" ? state : {} };
  } };
  return { model, settings, calls, handlers, failures, remembered, rpc, apply: createTurnSettingsAction(ports),
    catalog: (models: ModelInfo[]) => { available = models; }, state: (next: PiState) => { state = next; },
    fail: (type: TurnSettingsCommand["type"], error = new Error("fixture failure")) => { failure = { type, error }; return error; } };
}

test("App exposes only a send capability while preserving the real RPC receiver and arguments", async t => {
  const rpc = new FakeRpc("fixture", "fixture");
  const settings: TurnSettingsSnapshot = Object.freeze({ thinkingLevel: "high" });
  const handler: RpcLateResponseHandler = () => {};
  const originalSend = rpc.send.bind(rpc);
  t.mock.method(rpc, "send", async function(this: FakeRpc, command: Record<string, unknown>, timeout?: number, options?: RpcSendOptions) {
    assert.equal(this, rpc);
    assert.deepEqual(command, { type: "get_state" });
    assert.equal(timeout, 123);
    assert.equal(options?.onLateResponse, handler);
    return originalSend(command, timeout, options);
  });
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const internals = app as unknown as {
    turnSettingsAction(): ReturnType<typeof createTurnSettingsAction>;
    applyTurnSettings: ReturnType<typeof createTurnSettingsAction>;
  };
  t.mock.method(internals, "turnSettingsAction", () => async (transport, snapshot, sessionId) => {
    assert.deepEqual(Object.keys(transport), ["send"]);
    assert.notEqual(transport, rpc);
    assert.equal(snapshot, settings);
    assert.equal(sessionId, "target");
    await transport.send({ type: "get_state" }, 123, { onLateResponse: handler });
    return {};
  });
  try { assert.deepEqual(await internals.applyTurnSettings(rpc, settings, "target"), {}); }
  finally { await app.close(); }
});

test("turn settings preserves exact RPC order, write identities and Runtime-clamped thinking", async () => {
  const f = fixture();
  assert.deepEqual(await f.apply(f.rpc, f.settings, "session"), { model: f.model, thinkingLevel: "medium" });
  assert.deepEqual(f.calls.map(call => call.command), [
    { type: "get_available_models" }, { type: "set_model", provider: "provider", modelId: "model" },
    { type: "set_thinking_level", level: "high" }, { type: "get_state" },
  ]);
  assert.deepEqual(f.remembered, [f.model]);
  assert.deepEqual(f.failures, []);
  assert.equal(f.handlers.length, 2);
  assert.ok(f.handlers.every(entry => entry.sessionId === "session" && /^[a-f0-9-]{36}$/.test(entry.token)));
  assert.notEqual(f.handlers[0].token, f.handlers[1].token);
  assert.equal(f.calls[1].options?.onLateResponse, f.handlers[0].handler);
  assert.equal(f.calls[2].options?.onLateResponse, f.handlers[1].handler);
  assert.ok(f.calls.every(call => call.timeout === undefined));
});

for (const mismatch of ["provider", "api", "id"] as const) {
  test(`turn settings rejects an unavailable route before any mutation: ${mismatch}`, async () => {
    const f = fixture();
    const selected = { provider: "provider", modelId: "model", api: "openai-responses", [mismatch === "id" ? "modelId" : mismatch]: "other" };
    await assert.rejects(f.apply(f.rpc, { model: selected }, "session"), error => error instanceof HttpRequestError && error.code === "MODEL_UNAVAILABLE" && error.status === 400);
    assert.deepEqual(f.calls.map(call => call.command.type), ["get_available_models"]);
    assert.deepEqual(f.handlers, []);
    assert.deepEqual(f.failures, []);
  });
}

test("ambiguous provider/model API routes are not silently selected", async () => {
  const f = fixture();
  f.catalog([f.model, { ...f.model, api: "another-api" }]);
  await assert.rejects(f.apply(f.rpc, f.settings), error => error instanceof HttpRequestError && error.code === "MODEL_ROUTE_AMBIGUOUS");
  assert.deepEqual(f.calls.map(call => call.command.type), ["get_available_models"]);
});

test("legacy model inventories without API retain pair-only compatibility", async () => {
  const f = fixture();
  const legacy = { ...f.model, api: undefined };
  f.catalog([legacy]);
  assert.equal((await f.apply(f.rpc, { model: { provider: "provider", modelId: "model" } })).model, legacy);
  assert.deepEqual(f.calls[1].command, { type: "set_model", provider: "provider", modelId: "model" });
});

test("catalogue read errors do not create mutating outcome fences", async () => {
  const f = fixture(); const error = f.fail("get_available_models");
  await assert.rejects(f.apply(f.rpc, f.settings), cause => cause === error);
  assert.deepEqual(f.failures, []);
  assert.deepEqual(f.remembered, []);
  assert.deepEqual(f.handlers, []);
});

test("model write failures retain their exact late-response token without claiming an applied model", async () => {
  const f = fixture(); const error = f.fail("set_model");
  await assert.rejects(f.apply(f.rpc, f.settings, "target"), cause => cause === error);
  assert.deepEqual(f.failures, [{ sessionId: "target", error, token: f.handlers[0].token }]);
  assert.deepEqual(f.remembered, []);
  assert.deepEqual(f.calls.map(call => call.command.type), ["get_available_models", "set_model"]);
});

test("Thinking failure after Model success reports exactly the acknowledged partial change", async () => {
  const f = fixture(); const error = f.fail("set_thinking_level");
  await assert.rejects(f.apply(f.rpc, f.settings, "target"), cause => {
    assert.ok(cause instanceof PartialTurnSettingsError);
    assert.equal(cause.cause, error);
    assert.deepEqual(cause.applied, { model: f.model });
    return true;
  });
  assert.deepEqual(f.remembered, [f.model]);
  assert.deepEqual(f.failures, [{ sessionId: "target", error, token: f.handlers[1].token }]);
  assert.equal(f.calls.some(call => call.command.type === "get_state"), false);
});

test("non-reasoning models clamp off without sending Thinking or a redundant probe", async () => {
  const f = fixture(); const model = { ...f.model, reasoning: false };
  f.catalog([model]);
  assert.deepEqual(await f.apply(f.rpc, f.settings), { model, thinkingLevel: "off" });
  assert.deepEqual(f.calls.map(call => call.command.type), ["get_available_models", "set_model"]);
});

test("post-write read failures preserve confirmed writes instead of marking them uncertain", async t => {
  t.mock.method(console, "warn", () => {});
  const f = fixture(); f.fail("get_state");
  assert.deepEqual(await f.apply(f.rpc, f.settings), { model: f.model, thinkingLevel: "high" });
  assert.deepEqual(f.failures, []);
});

test("post-write confirmation ignores another model or an unknown Thinking value", async () => {
  const f = fixture();
  f.state({ model: { ...f.model, id: "other" }, isStreaming: false, thinkingLevel: "low" });
  assert.equal((await f.apply(f.rpc, f.settings)).thinkingLevel, "high");
  f.state({ model: f.model, isStreaming: false, thinkingLevel: "unsupported" });
  assert.equal((await f.apply(f.rpc, f.settings)).thinkingLevel, "high");
});

test("empty and Thinking-only snapshots require no Model access", async () => {
  const f = fixture();
  assert.deepEqual(await f.apply(f.rpc, {}), {});
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.apply(f.rpc, { thinkingLevel: "low" }), { thinkingLevel: "low" });
  assert.deepEqual(f.calls.map(call => call.command), [{ type: "set_thinking_level", level: "low" }]);
  assert.equal(f.handlers[0].sessionId, "");
  const error = f.fail("set_thinking_level");
  await assert.rejects(f.apply(f.rpc, { thinkingLevel: "low" }), cause => cause === error && !(cause instanceof PartialTurnSettingsError));
});
