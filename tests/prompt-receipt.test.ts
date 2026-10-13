import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { promptPersistenceReceipt, type PromptPersistenceReceipt } from "../src/server/prompt-receipt";
import { resolvePiEntry } from "../src/server/rpc-client";

const overlay = await import(new URL("../resources/runtime/pi-chat-rpc-loader.mjs", import.meta.url).href) as {
  piChatPromptReceipt(message: unknown): PromptPersistenceReceipt | undefined;
  patchPiPromptReceiptSource(source: string): string;
  patchPiPromptResponseSource(source: string): string;
};

const receipt: PromptPersistenceReceipt = { version: 1, timestamp: 1234, payloadFingerprint: "a".repeat(64) };
const response = { command: "prompt", success: true, data: { disposition: "started", piChatUserMessage: receipt } };

test("prompt receipts are accepted only from successful started request responses", () => {
  assert.deepEqual(promptPersistenceReceipt(response), receipt);
  for (const invalid of [
    { ...response, success: false }, { ...response, command: "steer" },
    { ...response, data: { ...response.data, disposition: "queued" } },
    { ...response, data: { ...response.data, disposition: "handled" } },
    { ...response, data: { disposition: "started" } },
    { ...response, data: { ...response.data, piChatUserMessage: { ...receipt, timestamp: NaN } } },
    { ...response, data: { ...response.data, piChatUserMessage: { ...receipt, payloadFingerprint: "invalid" } } },
  ]) assert.equal(promptPersistenceReceipt(invalid), undefined);
});

test("prompt receipt carries the exact canonical payload hash but no image bytes", () => {
  const canonical = { role: "user", timestamp: 1234, content: [{ type: "text", text: "normalized input" }, { type: "image", data: "canonical-image", mimeType: "image/png" }] };
  const result = overlay.piChatPromptReceipt(canonical)!;
  assert.equal(result.payloadFingerprint, createHash("sha256").update(JSON.stringify([["text", "normalized input"], ["image", "canonical-image", "image/png"]])).digest("hex"));
  assert.equal(result.timestamp, canonical.timestamp);
  assert.equal(JSON.stringify(result).includes("canonical-image"), false);
  assert.deepEqual(Object.keys(result).sort(), ["payloadFingerprint", "timestamp", "version"]);
});

/** Run the real installed method bodies, substituting only image I/O and agent execution. */
async function exerciseNativePreflight(path: string) {
  const original = await readFile(path, "utf8");
  const patched = overlay.patchPiPromptReceiptSource(original);
  assert.notEqual(patched, original, "the verified native source must expose a post-normalization preflight witness");
  assert.equal(overlay.patchPiPromptReceiptSource(patched), patched, "loader patch is idempotent");
  const ast = ts.createSourceFile(path, patched, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = ast.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "AgentSession");
  assert.ok(declaration);
  const methods = declaration.members.filter(member => ts.isMethodDeclaration(member) && member.name && ["prompt", "_startRun", "_prepareRun"].includes(member.name.getText(ast))).map(member => member.getText(ast));
  const preamble = ast.statements.filter(node =>
    ts.isImportDeclaration(node) && node.getText(ast).includes("__piChatCreateHash")
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === "__piChatPromptReceipt")
  ).map(node => node.getText(ast)).join("\n");
  const moduleSource = preamble + `\nexport class AgentSession { ${methods.join("\n")} }`;
  const module = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`) as {
    AgentSession: new () => { prompt(text: string, options: Record<string, unknown>): Promise<void> };
  };
  const instance = new module.AgentSession();
  let accepted: unknown[] = [];
  let produced: Array<{ role: string; content?: unknown; timestamp?: number }> = [];
  Object.assign(instance, {
    model: { provider: "fixture" }, _modelRuntime: { hasConfiguredAuth: () => true },
    _runInputHandlers: async (text: string) => ({ text, images: [] }),
    _findLastAssistantMessage: () => undefined,
    _baseSystemPromptOptions: { selectedTools: [] },
    _extensionRunner: { emitBeforeAgentStart: async () => ({ systemPromptOptions: { selectedTools: [] }, messages: [] }) },
    getActiveToolNames: () => [], _pendingNextTurnMessages: [], _pendingToolNames: new Set(),
    _normalizePromptImages: async () => ({ hints: ["[Image: resized by Pi]"], images: [{ type: "image", data: "normalized-pixels", mimeType: "image/jpeg" }] }),
    _preparePromptAndToolLoadout: () => undefined,
    _flushPendingBashMessages() {}, _flushPendingCustomMessages() {}, _recordSelection() {},
    _handlePostAgentRun: async () => false, _runBeforeSettleBoundary: async () => false, _emitAgentSettled: async () => {},
    _runAgentPrompt: async (messages: typeof produced) => { produced = messages; },
    agent: { prompt: async (messages: typeof produced) => { produced = messages; } },
  });
  await instance.prompt("inspect", { expandPromptTemplates: false, preflightResult: (...args: unknown[]) => { accepted = args; } });
  assert.equal(accepted[0], "started");
  const canonical = produced.find(message => message.role === "user");
  assert.ok(canonical);
  assert.deepEqual(accepted[1], overlay.piChatPromptReceipt(canonical));
  assert.equal(await readFile(path, "utf8"), original, "Pi files on disk must remain unchanged");
}

test("RPC response adapter keeps the canonical receipt on its originating request", async () => {
  const source = `export async function run(session, command, output) {
    const id = command.id;
    const success = (id, command, data) => ({ id, type: "response", command, success: true, data });
    return session.prompt(command.message, { preflightResult: (disposition) => {
      output(success(id, "prompt", { disposition }));
    }});
  }`;
  const patched = overlay.patchPiPromptResponseSource(source);
  assert.equal(overlay.patchPiPromptResponseSource(patched), patched);
  const mod = await import(`data:text/javascript;base64,${Buffer.from(patched).toString("base64")}`);
  const records: Array<Record<string, unknown>> = [];
  await mod.run({ prompt: async (_text: string, options: { preflightResult: (kind: string, receipt: PromptPersistenceReceipt) => void }) => options.preflightResult("started", receipt) }, { id: "request-a", message: "inspect" }, (record: Record<string, unknown>) => records.push(record));
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "request-a");
  assert.deepEqual(promptPersistenceReceipt(records[0]), receipt);
  const entry = resolvePiEntry();
  if (entry) {
    const native = await readFile(resolve(dirname(entry), "modes/rpc/rpc-mode.js"), "utf8");
    assert.notEqual(overlay.patchPiPromptResponseSource(native), native, "the installed RPC response forwards the receipt");
  }
});

test("unrecognized Pi source is left intact instead of guessing a prompt boundary", () => {
  const unknown = "export class AgentSession { async prompt() {} }";
  assert.equal(overlay.patchPiPromptReceiptSource(unknown), unknown);
  assert.equal(overlay.patchPiPromptResponseSource(unknown), unknown);
});

test("Pi 1.0 preflight receipt follows native image normalization", async () => {
  await exerciseNativePreflight(resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js"));
});

test("installed Pi preflight receipt follows the current native run-preparation boundary", { skip: !resolvePiEntry() }, async () => {
  await exerciseNativePreflight(resolve(dirname(resolvePiEntry()!), "core/agent-session.js"));
});
