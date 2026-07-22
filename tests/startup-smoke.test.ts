import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const { port } = address;
  server.close();
  return port;
}

async function waitFor(url: string, child: ReturnType<typeof spawn>): Promise<Response> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Pi Chat 在启动冒烟测试中提前退出");
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Server is still binding or Pi is still completing its compatibility probe.
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("Pi Chat 启动冒烟测试超时");
}

const fakeRpcEntry = String.raw`
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.env.PI_CHAT_SMOKE_LOG;
const reply = (id, data) => process.stdout.write(JSON.stringify({ type: "response", id, success: true, data }) + "\n");
const handlers = {
  get_state: () => ({ model: null, isStreaming: false, sessionId: "fake", sessionFile: undefined }),
  get_messages: () => ({ messages: [] }),
  get_available_models: () => ({ models: [] }),
  get_commands: () => ({ commands: [] }),
  get_session_stats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  appendFileSync(log, String(command.type) + "\n");
  reply(command.id, handlers[command.type]?.() || {});
});
`;

test("compiled server starts against fake RPC, probes capabilities, serves guarded API, and shuts down", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-smoke-"));
  const rpcEntry = join(root, "fake-rpc.mjs");
  const rpcLog = join(root, "rpc.log");
  const agentDir = join(root, "agent");
  const port = await freePort();
  await writeFile(rpcEntry, fakeRpcEntry, "utf8");
  const child = spawn(process.execPath, [join(projectRoot, "dist", "server", "server", "index.js"), "--host", "127.0.0.1", "--port", String(port), "--cwd", root], {
    cwd: projectRoot,
    env: { ...process.env, PI_CHAT_PI_ENTRY: rpcEntry, PI_CODING_AGENT_DIR: agentDir, PI_CHAT_SMOKE_LOG: rpcLog },
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    const origin = `http://127.0.0.1:${port}`;
    const bootstrap = await waitFor(`${origin}/api/bootstrap`, child);
    const data = await bootstrap.json() as { requestToken?: string };
    assert.equal(bootstrap.status, 200);
    assert.ok(data.requestToken);
    const guarded = await fetch(`${origin}/api/health`, { headers: { "x-pi-chat-token": data.requestToken } });
    assert.equal(guarded.status, 200);
    assert.equal((await guarded.json() as { service?: string }).service, "pi-chat");
    const rpcCommands = await readFile(rpcLog, "utf8");
    for (const command of ["get_state", "get_messages", "get_available_models", "get_commands", "get_session_stats"]) assert.match(rpcCommands, new RegExp(`^${command}$`, "m"));
  } finally {
    // Register before killing: on fast Windows exits, registering afterwards can
    // miss the event and make a successful graceful shutdown look like a timeout.
    const exited = child.exitCode === null ? once(child, "exit") : Promise.resolve();
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "SIGTERM should terminate the compiled Pi Chat server");
    await rm(root, { recursive: true, force: true });
  }
});
