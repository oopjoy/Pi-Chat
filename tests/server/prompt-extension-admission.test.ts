import assert from "node:assert/strict";
import test from "node:test";
import { admitPromptExtension } from "../../src/server/services/prompt-extension-admission";
import { RpcRequestTimeoutError } from "../../src/server/rpc-client";

test("Extension admission writes, confirms state, and projects Gate mode in order", async () => {
  const calls: string[] = [];
  const result = await admitPromptExtension({
    clearPromptDiagnostic: () => calls.push("clear"),
    newOutcomeToken: () => "token",
    sendPrompt: async (message, token) => { calls.push(`send:${message}:${token}`); },
    outcomeUnknown: () => false,
    markOutcomePending: () => calls.push("pending"),
    rethrowResultPending: () => { throw new Error("unexpected"); },
    requestedGateMode: () => "open",
    setGateMode: (mode) => calls.push(`gate:${mode}`),
    noteUserPrompt: () => calls.push("note"),
    readState: async () => { calls.push("state"); return { model: null, isStreaming: false }; },
    confirmState: async () => calls.push("confirm"),
  }, {
    sessionId: "session",
    message: "/gate open",
    images: [],
    commandName: "gate",
    commandDescription: "Gate",
    promptAt: 1,
  });
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, {
    accepted: true,
    queued: false,
    extension: true,
    command: "gate",
    description: "Gate",
    isStreaming: false,
  });
  assert.deepEqual(calls, ["clear", "send:/gate open:token", "gate:open", "note", "state", "confirm"]);
});

test("Extension admission rejects images before mutating diagnostics or RPC", async () => {
  const result = await admitPromptExtension({
    clearPromptDiagnostic: () => assert.fail("must not clear"),
    newOutcomeToken: () => assert.fail("must not allocate"),
    sendPrompt: async () => assert.fail("must not send"),
    outcomeUnknown: () => false,
    markOutcomePending: () => {},
    rethrowResultPending: () => { throw new Error("unexpected"); },
    requestedGateMode: () => null,
    setGateMode: () => {},
    noteUserPrompt: () => {},
    readState: async () => ({ model: null, isStreaming: false }),
    confirmState: async () => {},
  }, {
    sessionId: "session",
    message: "/ask",
    images: [{ type: "image", data: "a", mimeType: "image/png" }],
    commandName: "ask",
    commandDescription: "Ask",
    promptAt: 1,
  });
  assert.deepEqual(result, { status: 400, body: { error: "Extension 指令不能同时附加图片" } });
});

test("unknown Extension write becomes RESULT_PENDING while read-only confirmation does not create a new fence", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => admitPromptExtension({
      clearPromptDiagnostic: () => calls.push("clear"),
      newOutcomeToken: () => "token",
      sendPrompt: async () => { throw new RpcRequestTimeoutError("prompt"); },
      outcomeUnknown: (error) => error instanceof RpcRequestTimeoutError,
      markOutcomePending: () => calls.push("pending"),
      rethrowResultPending: () => { throw new Error("pending"); },
      requestedGateMode: () => null,
      setGateMode: () => {},
      noteUserPrompt: () => {},
      readState: async () => ({ model: null, isStreaming: false }),
      confirmState: async () => {},
    }, {
      sessionId: "session",
      message: "/ask",
      images: [],
      commandName: "ask",
      commandDescription: "Ask",
      promptAt: 1,
    }),
    /pending/,
  );
  assert.deepEqual(calls, ["clear", "pending"]);
});
