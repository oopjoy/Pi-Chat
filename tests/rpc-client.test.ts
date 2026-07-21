import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

test("stopping RPC rejects pending requests immediately instead of leaking timers", async () => {
  const child = new EventEmitter() as EventEmitter & { exitCode: number | null; killed: boolean; stdin: { write: (value: string, callback?: (error?: Error | null) => void) => boolean }; kill: (signal: string) => boolean };
  child.exitCode = 0;
  child.killed = false;
  child.stdin = { write: (_value, callback) => { callback?.(null); return true; } };
  child.kill = () => { child.killed = true; child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0, null)); return true; };
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  child.exitCode = null;
  const pending = client.send({ type: "never_answers" }, 60_000);
  await client.stop();
  await assert.rejects(pending, /Pi RPC 已停止/);
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
