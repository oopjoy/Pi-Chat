import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");
const compiledDist = resolve(projectRoot, process.env.PI_CHAT_DIST_DIR || "dist");

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

async function removeWithWindowsRetry(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function waitForCapabilityProbe(rpcLog: string, child: ReturnType<typeof spawn>): Promise<string> {
  const expected = ["get_state", "get_messages", "get_available_models", "get_commands", "get_session_stats"];
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Pi Chat 在 capability probe 完成前退出");
    try {
      const commands = await readFile(rpcLog, "utf8");
      if (expected.every((command) => new RegExp(`^${command}$`, "m").test(commands))) return commands;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Primary starts asynchronously after the HTTP listener. The log does not
      // exist until its fake RPC receives the first capability command.
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("Pi RPC capability probe did not complete during startup smoke test");
}

function parseSsePayloads(buffer: string): Record<string, unknown>[] {
  return buffer
    .split(/\r?\n\r?\n/)
    .flatMap((frame) => {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data) return [];
      try {
        const value = JSON.parse(data) as unknown;
        return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
}

const fakeRpcEntry = String.raw`
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.env.PI_CHAT_SMOKE_LOG;
const reply = (id, data) => process.stdout.write(JSON.stringify({ type: "response", id, success: true, data }) + "\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const handlers = {
  get_state: () => ({ model: null, isStreaming: false, sessionId: "fake", sessionFile: process.env.PI_CHAT_SMOKE_SESSION_FILE }),
  get_messages: () => ({ messages: [] }),
  get_available_models: () => ({ models: [] }),
  get_commands: () => ({ commands: [] }),
  get_session_stats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
  prompt: () => {
    setTimeout(() => {
      emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 1, errorMessage: "provider secret sk-bundled-fixture" });
      emit({ type: "agent_start" });
      emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "final provider failure" });
      emit({ type: "agent_settled" });
    }, 5);
    return {};
  },
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  appendFileSync(log, String(command.type) + "\n");
  reply(command.id, handlers[command.type]?.() || {});
});
`;

test("compiled server starts against fake RPC, probes capabilities, serves guarded API, and shuts down", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-smoke-"));
  const rpcEntry = join(root, "fake-rpc.mjs");
  const rpcLog = join(root, "rpc.log");
  const agentDir = join(root, "agent");
  const sessionFile = join(agentDir, "session.jsonl");
  const port = await freePort();
  await mkdir(agentDir, { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "fake", cwd: root })}\n`, "utf8");
  await writeFile(rpcEntry, fakeRpcEntry, "utf8");
  const child = spawn(process.execPath, [join(compiledDist, "server", "server", "index.js"), "--host", "127.0.0.1", "--port", String(port), "--cwd", root], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PI_CHAT_PI_ENTRY: rpcEntry,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CHAT_SMOKE_LOG: rpcLog,
      PI_CHAT_SMOKE_SESSION_FILE: sessionFile,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  let eventController: AbortController | undefined;
  let eventPump: Promise<void> | undefined;
  try {
    const origin = `http://127.0.0.1:${port}`;
    const browserHeaders = {
      origin,
      "x-pi-chat-client": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "x-pi-chat-page": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    // Only the fixed-shape handshake is tokenless. The full bootstrap must
    // retain the request-token guard even during cold service startup.
    const handshake = await waitFor(`${origin}/api/bootstrap/handshake`, child);
    const handshakeData = await handshake.json() as { requestToken?: string };
    assert.equal(handshake.status, 200);
    assert.ok(handshakeData.requestToken);
    assert.equal((await fetch(`${origin}/api/bootstrap/handshake`, { headers: browserHeaders })).status, 200);
    const guardedHeaders = { ...browserHeaders, "x-pi-chat-token": handshakeData.requestToken };
    // The listener can become healthy before the Primary readiness controller
    // has copied its verified Session identity. Poll the same guarded bootstrap
    // instead of treating that short startup window as a broken artifact.
    let bootstrap: Response | undefined;
    let data: { requestToken?: string; activeSessionId?: string } = {};
    const bootstrapDeadline = Date.now() + 15_000;
    while (Date.now() < bootstrapDeadline) {
      bootstrap = await fetch(`${origin}/api/bootstrap`, { headers: guardedHeaders });
      data = await bootstrap.json() as { requestToken?: string; activeSessionId?: string };
      if (bootstrap.status === 200 && data.requestToken === handshakeData.requestToken && data.activeSessionId)
        break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    assert.ok(bootstrap);
    assert.equal(bootstrap.status, 200);
    assert.equal(data.requestToken, handshakeData.requestToken);
    assert.ok(data.activeSessionId);
    const guarded = await fetch(`${origin}/api/health`, { headers: guardedHeaders });
    assert.equal(guarded.status, 200);
    assert.equal((await guarded.json() as { service?: string }).service, "pi-chat");
    await waitForCapabilityProbe(rpcLog, child);
    eventController = new AbortController();
    const eventResponse = await fetch(
      `${origin}/api/events?token=${encodeURIComponent(handshakeData.requestToken)}&client=${encodeURIComponent(browserHeaders["x-pi-chat-client"])}&page=${encodeURIComponent(browserHeaders["x-pi-chat-page"])}`,
      { headers: guardedHeaders, signal: eventController.signal },
    );
    assert.equal(eventResponse.status, 200);
    const eventReader = eventResponse.body?.getReader();
    assert.ok(eventReader);
    const firstEvent = await eventReader.read();
    assert.match(new TextDecoder().decode(firstEvent.value), /event: ready/);
    const eventFrames: Record<string, unknown>[] = [];
    let eventBuffer = new TextDecoder().decode(firstEvent.value);
    eventFrames.push(...parseSsePayloads(eventBuffer));
    eventPump = (async () => {
      while (true) {
        const next = await eventReader.read();
        if (next.done) return;
        eventBuffer += new TextDecoder().decode(next.value);
        eventFrames.splice(0, eventFrames.length, ...parseSsePayloads(eventBuffer));
      }
    })().catch((error) => {
      if (!eventController?.signal.aborted) throw error;
    });
    const prompt = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { ...guardedHeaders, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: data.activeSessionId, message: "bundled retry fixture" }),
    });
    assert.equal(prompt.status, 202);
    const promptBody = await prompt.json() as { promptId?: string };
    assert.match(promptBody.promptId || "", /^[a-f0-9-]{36}$/);
    let promptFacts: string[] = [];
    let diagnosticEvidence: unknown;
    let diagnosticEntries: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const diagnostics = await fetch(`${origin}/api/diagnostics/snapshot`, {
        headers: guardedHeaders,
      });
      const diagnosticBody = await diagnostics.json() as {
        entries?: unknown;
        promptEvidence?: { records?: Array<{ facts?: string[] }> };
      };
      diagnosticEvidence = diagnosticBody.promptEvidence;
      diagnosticEntries = diagnosticBody.entries;
      promptFacts = (diagnosticBody.promptEvidence?.records || []).flatMap((record) => record.facts || []);
      if (promptFacts.includes("retry-scheduled") && promptFacts.includes("retry-started") && promptFacts.includes("retry-exhausted")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const rpcCommands = await readFile(rpcLog, "utf8");
    assert.ok(promptFacts.includes("retry-scheduled"), JSON.stringify({ rpcCommands, diagnosticEvidence, diagnosticEntries }));
    assert.ok(promptFacts.includes("retry-started"), JSON.stringify({ promptFacts, diagnosticEvidence, diagnosticEntries }));
    assert.ok(promptFacts.includes("retry-exhausted"), JSON.stringify({ promptFacts, diagnosticEvidence, diagnosticEntries }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    eventController.abort();
    await eventPump;
    const retryEvents = eventFrames.filter((event) => typeof event.type === "string" && event.type.startsWith("pi_chat_prompt_retry_"));
    assert.deepEqual(retryEvents.map((event) => event.type), [
      "pi_chat_prompt_retry_scheduled",
      "pi_chat_prompt_retry_started",
      "pi_chat_prompt_retry_exhausted",
    ]);
    assert.ok(retryEvents.every((event) => event.piChatPromptId === promptBody.promptId));
    assert.equal(JSON.stringify(retryEvents).includes("provider secret"), false);
  } finally {
    eventController?.abort();
    if (eventPump) await eventPump.catch(() => undefined);
    // Register before killing: on fast Windows exits, registering afterwards can
    // miss the event and make a successful graceful shutdown look like a timeout.
    const exited = child.exitCode === null ? once(child, "exit") : Promise.resolve();
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "SIGTERM should terminate the compiled Pi Chat server");
    await removeWithWindowsRetry(root);
  }
});
