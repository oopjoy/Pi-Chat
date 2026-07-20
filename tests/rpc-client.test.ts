import assert from "node:assert/strict";
import test from "node:test";
import { PiRpcClient, resolvePiEntry, rpcData } from "../src/server/rpc-client";

const piEntry = resolvePiEntry();

test("RPC compatibility probe reports missing required capabilities", async () => {
  const client = new PiRpcClient({ cwd: process.cwd() });
  const responses: Record<string, unknown> = {
    get_state: { isStreaming: false },
    get_messages: { messages: [] },
    get_available_models: { models: [] },
    get_commands: { commands: [] },
    get_session_stats: { tokens: {} },
  };
  Object.assign(client, { send: async (command: Record<string, unknown>) => ({ type: "response", success: true, data: responses[command.type as string] }) });
  assert.deepEqual(await client.probeCompatibility(), { compatible: true, diagnostics: [] });
  responses.get_commands = {};
  const incompatible = await client.probeCompatibility();
  assert.equal(incompatible.compatible, false);
  assert.match(incompatible.diagnostics.join("\n"), /get_commands/);
});

test("global Pi RPC starts and answers state requests", { skip: !piEntry, timeout: 30_000 }, async () => {
  assert.ok(piEntry);
  const client = new PiRpcClient({
    cwd: process.cwd(),
    piEntry,
    args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"],
  });
  try {
    await client.start();
    const state = rpcData<{ isStreaming: boolean }>(await client.send({ type: "get_state" }));
    assert.equal(state.isStreaming, false);
    const models = rpcData<{ models: unknown[] }>(await client.send({ type: "get_available_models" }));
    assert.ok(Array.isArray(models.models));
  } finally {
    await client.stop();
  }
});
