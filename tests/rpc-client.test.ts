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

function fakeChild() {
  const writes: string[] = [];
  const child = new EventEmitter() as EventEmitter & { exitCode: number | null; killed: boolean; stdin: { write: (value: string, callback?: (error?: Error | null) => void) => boolean }; kill: (signal: string) => boolean };
  child.exitCode = null;
  child.killed = false;
  child.stdin = { write: (value, callback) => { writes.push(value); callback?.(null); return true; } };
  child.kill = () => { child.killed = true; child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0, null)); return true; };
  return { child, writes };
}

test("stopping RPC rejects pending requests immediately instead of leaking timers", async () => {
  const { child } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  const pending = client.send({ type: "never_answers" }, 60_000);
  await client.stop();
  await assert.rejects(pending, /Pi RPC 已停止/);
});

test("concurrent identical read queries share one RPC command", async () => {
  const { child, writes } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  const first = client.send({ type: "get_state" }, 1_000);
  const second = client.send({ type: "get_state" }, 1_000);
  assert.equal(writes.length, 1);
  const id = (JSON.parse(writes[0]) as { id: string }).id;
  (client as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify({ type: "response", id, success: true, data: { isStreaming: false } }));
  assert.deepEqual(await first, await second);
  await client.stop();
});

test("a coalesced read caller keeps its own shorter timeout budget", async () => {
  const { child, writes } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  const long = client.send({ type: "get_state" }, 1_000);
  const short = client.send({ type: "get_state" }, 5);
  await assert.rejects(short, /请求超时/);
  assert.equal(writes.length, 1);
  const id = (JSON.parse(writes[0]) as { id: string }).id;
  (client as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify({ type: "response", id, success: true, data: { isStreaming: false } }));
  await long;
  await client.stop();
});

test("timed-out read queries reject duplicates until their late response is consumed", async () => {
  const { child, writes } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  const events: Record<string, unknown>[] = [];
  client.onEvent((event) => events.push(event));
  const pending = client.send({ type: "get_commands" }, 5);
  const id = (JSON.parse(writes[0]) as { id: string }).id;
  await assert.rejects(pending, /请求超时/);
  await assert.rejects(client.send({ type: "get_commands" }, 5), /仍在处理中/);
  assert.equal(writes.length, 1);
  (client as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify({ type: "response", id, success: true, data: { commands: [] } }));
  assert.deepEqual(events, []);
  const next = client.send({ type: "get_commands" }, 1_000);
  assert.equal(writes.length, 2);
  const nextId = (JSON.parse(writes[1]) as { id: string }).id;
  (client as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify({ type: "response", id: nextId, success: true, data: { commands: [] } }));
  await next;
  await client.stop();
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
