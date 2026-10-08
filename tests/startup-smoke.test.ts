import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.env.PI_CHAT_SMOKE_LOG;
const reply = (id, data) => process.stdout.write(JSON.stringify({ type: "response", id, success: true, data }) + "\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const handlers = {
  get_state: async () => {
    const holdFile = process.env.PI_CHAT_SMOKE_HOLD_READY_FILE;
    while (holdFile && existsSync(holdFile)) await new Promise((resolve) => setTimeout(resolve, 10));
    return { model: null, isStreaming: false, sessionId: "fake", sessionFile: process.env.PI_CHAT_SMOKE_SESSION_FILE };
  },
  get_messages: () => ({ messages: [] }),
  get_available_models: () => ({ models: [] }),
  get_commands: () => ({ commands: [] }),
  get_session_stats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
  prompt: () => {
    setTimeout(() => {
      emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 1, errorMessage: "provider secret sk-retry-fixture" });
      emit({ type: "agent_start" });
      emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "final provider failure" });
      emit({ type: "agent_settled" });
    }, 5);
    return {};
  },
};
const dispatch = async (command) => {
  appendFileSync(log, String(command.type) + "\n");
  reply(command.id, await handlers[command.type]?.() || {});
};
createInterface({ input: process.stdin }).on("line", (line) => {
  void dispatch(JSON.parse(line));
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
      body: JSON.stringify({ sessionId: data.activeSessionId, message: "retry fixture" }),
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

test("portable compiled server discovers managed Pi without npm, source, or node_modules", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-portable-managed-"));
  const portable = join(root, "Pi Chat's & (portable)");
  const home = join(root, "user-home");
  const agentDir = join(home, ".pi", "agent");
  const install = join(agentDir, "install");
  const piPackage = join(install, "releases", "1.1.0", "node_modules", "@earendil-works", "pi-coding-agent");
  const rpcLog = join(root, "rpc.log");
  const sessionFile = join(agentDir, "session.jsonl");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await mkdir(join(piPackage, "dist"), { recursive: true });
    await writeFile(join(install, "current-version"), "1.1.0\n");
    await writeFile(join(piPackage, "package.json"), JSON.stringify({ type: "module", name: "@earendil-works/pi-coding-agent", version: "1.1.0" }));
    await writeFile(join(piPackage, "dist/rpc-entry.js"), fakeRpcEntry);
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "fake", cwd: root })}\n`);
    await mkdir(portable);
    await cp(compiledDist, join(portable, "dist"), { recursive: true });
    await cp(join(projectRoot, "resources"), join(portable, "resources"), { recursive: true });
    await cp(join(projectRoot, "package.json"), join(portable, "package.json"));
    const port = await freePort();
    const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_CHAT_SMOKE_LOG: rpcLog, PI_CHAT_SMOKE_SESSION_FILE: sessionFile };
    for (const key of ["PI_CHAT_PI_ENTRY", "PI_MANAGED_INSTALL_ROOT", "PI_CHAT_RUNTIME_DIST"])
      delete (env as NodeJS.ProcessEnv)[key];
    child = spawn(process.execPath, [join(portable, "dist/server/server/index.js"), "--port", String(port), "--cwd", root], {
      cwd: portable, env, stdio: "ignore", windowsHide: true,
    });
    const origin = `http://127.0.0.1:${port}`;
    const handshake = await (await waitFor(`${origin}/api/bootstrap/handshake`, child)).json() as { requestToken: string };
    assert.equal((await fetch(origin)).status, 200);
    await waitForCapabilityProbe(rpcLog, child);
    let status: string | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await fetch(`${origin}/api/bootstrap`, { headers: { origin, "x-pi-chat-token": handshake.requestToken } });
      const data = await response.json() as { primaryRuntime?: { status: string } };
      status = data.primaryRuntime?.status;
      if (status === "ready") break;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    assert.equal(status, "ready");
    assert.equal(existsSync(join(portable, "node_modules")), false);
    assert.equal(existsSync(join(portable, "src")), false);
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    await removeWithWindowsRetry(root);
  }
});

test("portable missing-Pi recovery saves an entry and hands off this build without npm or source", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-setup-restart-"));
  const portable = join(root, "portable");
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const piPackage = join(root, "selected-pi");
  const entry = join(piPackage, "dist/rpc-entry.js");
  const handoffFile = join(root, "handoff.json");
  const rpcLog = join(root, "rpc.log");
  const sessionFile = join(agentDir, "session.jsonl");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let child: ReturnType<typeof spawn> | undefined;
  let events: AbortController | undefined;
  try {
    await mkdir(portable);
    await cp(compiledDist, join(portable, "dist"), { recursive: true });
    await cp(join(projectRoot, "resources"), join(portable, "resources"), { recursive: true });
    await cp(join(projectRoot, "package.json"), join(portable, "package.json"));
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(piPackage, "dist"), { recursive: true });
    await writeFile(join(piPackage, "package.json"), JSON.stringify({ type: "module", name: "@earendil-works/pi-coding-agent", version: "1.1.0" }));
    await writeFile(entry, fakeRpcEntry);
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "fake", cwd: root })}\n`);
    // Capture the detached handoff instead of letting a replacement outlive the test.
    // The second child below executes its exact command/args under test ownership.
    await writeFile(join(portable, "dist/server/server/restart-handoff.js"), "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.PI_CHAT_SETUP_HANDOFF, process.argv[2]);\n");
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, PATH: "", Path: "", npm_config_prefix: "", NPM_CONFIG_PREFIX: "",
      PI_CODING_AGENT_DIR: agentDir, PI_CHAT_SMOKE_LOG: rpcLog, PI_CHAT_SMOKE_SESSION_FILE: sessionFile, PI_CHAT_SETUP_HANDOFF: handoffFile,
    };
    for (const key of ["PI_CHAT_PI_ENTRY", "PI_MANAGED_INSTALL_ROOT", "PI_CHAT_RUNTIME_DIST"]) delete env[key];
    child = spawn(process.execPath, [join(portable, "dist/server/server/index.js"), "--port", String(port), "--cwd", root], { cwd: portable, env, stdio: "ignore", windowsHide: true });
    const handshake = await (await waitFor(`${origin}/api/bootstrap/handshake`, child)).json() as { requestToken: string };
    const headers = { origin, "x-pi-chat-token": handshake.requestToken, "x-pi-chat-client": "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "x-pi-chat-page": "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "content-type": "application/json" };
    const setup = await (await fetch(`${origin}/api/runtime/setup`, { headers })).json() as { configured: unknown; configurationRevision: string };
    assert.equal(setup.configured, null);
    events = new AbortController();
    const eventStream = await fetch(`${origin}/api/events`, { headers, signal: events.signal });
    const reader = eventStream.body!.getReader();
    await reader.read();
    const restart = await fetch(`${origin}/api/runtime/restart`, { method: "POST", headers, body: JSON.stringify({ mode: "select", entry, configurationRevision: setup.configurationRevision }) });
    assert.equal(restart.status, 202, await restart.text());
    events.abort();
    await reader.cancel().catch(() => undefined);
    if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 5000))]);
    assert.equal(child.exitCode, 0, "old service must shut down before handing off");
    for (let i = 0; i < 100 && !existsSync(handoffFile); i++) await new Promise(resolve => setTimeout(resolve, 30));
    const payload = JSON.parse(await readFile(handoffFile, "utf8")) as { command: string; args: string[]; runtimeDist: string; promoteAfterExit?: unknown };
    assert.equal(payload.promoteAfterExit, undefined);
    assert.equal(payload.command, process.execPath);
    assert.equal(payload.args[0], join(portable, "dist/server/server/index.js"));
    assert.equal(existsSync(rpcLog), false, "selection must not spawn Pi in the old process");
    child = spawn(payload.command, payload.args, { cwd: portable, env: { ...env, PI_CHAT_RUNTIME_DIST: payload.runtimeDist }, stdio: "ignore", windowsHide: true });
    const replacement = await (await waitFor(`${origin}/api/bootstrap/handshake`, child)).json() as { requestToken: string };
    assert.notEqual(replacement.requestToken, handshake.requestToken);
    await waitForCapabilityProbe(rpcLog, child);
    const next = await (await fetch(`${origin}/api/runtime/setup`, { headers: { ...headers, "x-pi-chat-token": replacement.requestToken } })).json() as { source: string; current: { entry: string; version: string } };
    assert.equal(next.source, "saved");
    assert.equal(next.current.version, "1.1.0");
    assert.equal(next.current.entry, entry);
    assert.equal(existsSync(join(portable, "node_modules")), false);
  } finally {
    events?.abort();
    if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]); }
    await removeWithWindowsRetry(root);
  }
});

test("HTTP handshake is available while Primary capability probing is still blocked", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-startup-ready-"));
  const rpcEntry = join(root, "fake-rpc.mjs");
  const rpcLog = join(root, "rpc.log");
  const holdReadyFile = join(root, "hold-primary-ready");
  const agentDir = join(root, "agent");
  const sessionFile = join(agentDir, "session.jsonl");
  const port = await freePort();
  await mkdir(agentDir, { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "fake", cwd: root })}\n`, "utf8");
  await writeFile(rpcEntry, fakeRpcEntry, "utf8");
  await writeFile(holdReadyFile, "hold", "utf8");
  const child = spawn(process.execPath, [join(compiledDist, "server", "server", "index.js"), "--host", "127.0.0.1", "--port", String(port), "--cwd", root], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PI_CHAT_PI_ENTRY: rpcEntry,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CHAT_SMOKE_LOG: rpcLog,
      PI_CHAT_SMOKE_SESSION_FILE: sessionFile,
      PI_CHAT_SMOKE_HOLD_READY_FILE: holdReadyFile,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    const origin = `http://127.0.0.1:${port}`;
    const handshake = await waitFor(`${origin}/api/bootstrap/handshake`, child);
    assert.equal(handshake.status, 200);
    assert.ok((await handshake.json() as { requestToken?: string }).requestToken);
    assert.equal(existsSync(holdReadyFile), true, "the capability probe must still be blocked when HTTP becomes reachable");
    await rm(holdReadyFile, { force: true });
    await waitForCapabilityProbe(rpcLog, child);
  } finally {
    const exited = child.exitCode === null ? once(child, "exit") : Promise.resolve();
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "SIGTERM should terminate the delayed startup fixture");
    await removeWithWindowsRetry(root);
  }
});
