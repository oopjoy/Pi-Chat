import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp, promptImages } from "../src/server/app";
import { parsePickerOutput } from "../src/server/file-picker";
import type { PiRpcClient } from "../src/server/rpc-client";
import { idForPath, type SessionIndex } from "../src/server/session-index";
import type { ResourceManager } from "../src/server/resource-manager";
import { commandMatches, fileReferences, windowsPathsFromText } from "../src/web/components/ChatInput";

test("production web entry advertises standalone install metadata", async () => {
  const html = await (await import("node:fs/promises")).readFile(new URL("../src/web/index.html", import.meta.url), "utf8");
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../src/web/public/manifest.webmanifest", import.meta.url), "utf8")) as { display: string; start_url: string; icons: Array<{ src: string }> };
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest(?:\?[^\"]+)?"/);
  assert.match(html, /rel="icon" href="\/icons\/pi-chat-[^\"]+\.png(?:\?[^\"]+)?"/);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.icons.length >= 2, true);
  assert.ok(manifest.icons.every((icon) => icon.src.startsWith("/icons/pi-chat-")));
});

test("production build splits React, Markdown and KaTeX into cacheable chunks", async () => {
  const config = await (await import("node:fs/promises")).readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /codeSplitting/);
  for (const name of ["react", "markdown", "katex"]) assert.match(config, new RegExp(`name: ["']${name}["']`));
});

test("session sidebar switches sessions without link navigation", async () => {
  const files = await import("node:fs/promises");
  const sidebar = await files.readFile(new URL("../src/web/components/SessionSidebar.tsx", import.meta.url), "utf8");
  const app = await files.readFile(new URL("../src/web/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(sidebar, /href=\{`\?session=/);
  assert.match(sidebar, /type="button"[\s\S]*onClick=\{\(\) => onView\(session\.id\)\}/);
  assert.match(app, /matchMedia\?\.\("\(max-width: 760px\)"\)\.matches[\s\S]*setSidebarOpen\(false\)[\s\S]*viewSession\(id\)/);
  assert.doesNotMatch(app, /onView=\{\(id\) => \{\s*setSidebarOpen\(false\);/);
  const styles = await files.readFile(new URL("../src/web/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.message-assistant \.markdown-body blockquote\s*\{[^}]*border-left-color:\s*var\(--text\)[^}]*color:\s*var\(--text\)[^}]*font-weight:\s*650/);
});

test("prompt image validation accepts Pi image content and rejects unsafe payloads", () => {
  assert.deepEqual(promptImages([{ type: "image", data: "aGVsbG8=", mimeType: "image/png", fileName: "ignored.png" }]), [
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  ]);
  assert.throws(() => promptImages([{ data: "aGVsbG8=", mimeType: "image/svg+xml" }]), /仅支持/);
  assert.throws(() => promptImages(Array.from({ length: 5 }, () => ({ data: "YQ==", mimeType: "image/png" }))), /最多/);
  assert.throws(() => promptImages([{ data: "not base64!", mimeType: "image/png" }]), /Base64/);
});

test("Windows file picker output keeps only absolute drive paths", () => {
  assert.deepEqual(parsePickerOutput('["C:\\\\Users\\\\me\\\\note.md","D:\\\\资料\\\\文档.pdf"]'), [
    "C:\\Users\\me\\note.md",
    "D:\\资料\\文档.pdf",
  ]);
  assert.deepEqual(parsePickerOutput('"C:\\\\single.txt"'), ["C:\\single.txt"]);
  assert.deepEqual(parsePickerOutput('["relative.txt","/tmp/a"]'), []);
});

test("attachment path helpers preserve Windows absolute paths", () => {
  assert.deepEqual(windowsPathsFromText('"C:\\Users\\me\\paper.pdf"\nfile:///D:/notes/data.csv\nrelative.txt'), [
    "C:\\Users\\me\\paper.pdf",
    "D:\\notes\\data.csv",
  ]);
  assert.equal(fileReferences(["C:\\Users\\me\\paper.pdf"]), "请按需使用工具读取以下本地文件：\n- `C:\\Users\\me\\paper.pdf`");
});

test("slash command matching prioritizes prefixes and closes after arguments begin", () => {
  const commands = [
    { name: "compact", source: "builtin" as const },
    { name: "skill:compact-note", source: "skill" as const },
    { name: "compare", source: "extension" as const },
  ];
  assert.deepEqual(commandMatches("/comp", commands).map((item) => item.name), ["compact", "compare", "skill:compact-note"]);
  assert.deepEqual(commandMatches("/pc", [{ name: "pi-chat", source: "extension" }]).map((item) => item.name), ["pi-chat"]);
  assert.deepEqual(commandMatches("/compact ", commands), []);
  assert.deepEqual(commandMatches("text", commands), []);
});

test("local prompt queue can cancel, pause on abort and resume", async () => {
  const commands: Record<string, unknown>[] = [];
  const activePath = "C:\\sessions\\local-queue.jsonl";
  const activeId = idForPath(activePath);
  const rpc = {
    onEvent: () => () => {},
    send: async (command: Record<string, unknown>) => {
      commands.push(command);
      if (command.type === "get_state") return { type: "response", success: true, data: { model: null, isStreaming: false, sessionFile: activePath, sessionId: "local-queue" } };
      return { type: "response", command: command.type, success: true };
    },
  } as unknown as PiRpcClient;
  const app = new PiChatApp({ rpc, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const post = (path: string, body: object = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("/api/chat/prompt", { message: "first", sessionId: activeId })).status, 202);
    const queuedResponse = await post("/api/chat/prompt", { message: "second", sessionId: activeId });
    const queued = await queuedResponse.json() as { id: string };
    assert.ok(queued.id);
    assert.equal((await fetch(`${origin}/api/chat/queue/${queued.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: activeId }) })).status, 200);
    const third = await (await post("/api/chat/prompt", { message: "third", sessionId: activeId })).json() as { queued: boolean };
    assert.equal(third.queued, true);
    const aborted = await (await post("/api/chat/abort", { sessionId: activeId })).json() as { queuePaused: boolean };
    assert.equal(aborted.queuePaused, true);
    const resumed = await (await post("/api/chat/queue/resume", { sessionId: activeId })).json() as { paused: boolean };
    assert.equal(resumed.paused, false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(commands.filter((command) => command.type === "prompt").length, 2);
    assert.equal(commands.filter((command) => command.type === "abort").length, 1);
  } finally {
    server.close();
    await app.close();
  }
});

test("extension slash commands execute immediately and Gate mode survives browser refresh", async () => {
  const commands: Record<string, unknown>[] = [];
  const path = "C:\\sessions\\gate.jsonl";
  const id = idForPath(path);
  let emit: (event: Record<string, unknown>) => void = () => {};
  const rpc = {
    onEvent: (listener: (event: Record<string, unknown>) => void) => { emit = listener; return () => {}; },
    send: async (command: Record<string, unknown>) => {
      commands.push(command);
      if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [{ name: "gate", source: "extension", description: "Control file permission gate: /gate status|open|strict" }] } };
      if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: path, sessionId: "gate", isStreaming: false } };
      if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [] } };
      if (command.type === "get_available_models") return { type: "response", success: true, data: { models: [] } };
      if (command.type === "get_session_stats") return { type: "response", success: true, data: { tokens: {} } };
      return { type: "response", command: command.type, success: true };
    },
  } as unknown as PiRpcClient;
  const sessions = {
    list: async () => [{ id, sessionId: "gate", name: "Gate", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 0, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "/gate open", sessionId: id }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true, queued: false, extension: true, command: "gate", description: "Control file permission gate: /gate status|open|strict", isStreaming: false });
    assert.deepEqual(commands.filter((command) => command.type === "prompt"), [{ type: "prompt", message: "/gate open" }]);

    const bootstrap = await (await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`)).json() as { gateMode?: string };
    assert.equal(bootstrap.gateMode, "open", "browser refresh must show the Runtime's actual open mode");

    const unsupported = await fetch(`http://127.0.0.1:${address.port}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "/gate once", sessionId: id }),
    });
    assert.equal(unsupported.status, 202, "Pi still receives the command so its extension can present usage");
    const view = await (await fetch(`http://127.0.0.1:${address.port}/api/sessions/${id}/view`)).json() as { gateMode?: string };
    assert.equal(view.gateMode, "open", "an unsupported once command must not alter the authoritative mode");
    assert.equal(commands.filter((command) => command.type === "prompt").at(-1)?.message, "/gate once");
    emit({ type: "extension_ui_request", method: "notify", message: "Usage: /gate status|open|strict" });
    assert.equal((await (await fetch(`http://127.0.0.1:${address.port}/api/sessions/${id}/view`)).json() as { gateMode?: string }).gateMode, "open");
  } finally {
    server.close();
    await app.close();
  }
});

test("Gate mode broadcasts before post-command state probing can fail", async () => {
  const path = "C:\\sessions\\gate-failure.jsonl";
  const id = idForPath(path);
  let failNextState = false;
  const rpc = {
    onEvent: () => () => {},
    send: async (command: Record<string, unknown>) => {
      if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [{ name: "gate", source: "extension" }] } };
      if (command.type === "prompt") { failNextState = true; return { type: "response", success: true }; }
      if (command.type === "get_state") {
        if (failNextState) { failNextState = false; throw new Error("post-command state failed"); }
        return { type: "response", success: true, data: { model: null, sessionFile: path, sessionId: "gate-failure", isStreaming: false } };
      }
      if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [] } };
      if (command.type === "get_available_models") return { type: "response", success: true, data: { models: [] } };
      if (command.type === "get_session_stats") return { type: "response", success: true, data: { tokens: {} } };
      return { type: "response", success: true };
    },
  } as unknown as PiRpcClient;
  const sessions = {
    list: async () => [{ id, sessionId: "gate-failure", name: "Gate", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 0, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const frames: string[] = [];
  const clients = (app as unknown as { sseClients: Map<{ write: (frame: string) => void }, string> }).sseClients;
  clients.set({ write: (frame) => { frames.push(frame); } }, "");
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`)).status, 200);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "/gate open", sessionId: id }),
    });
    assert.equal(response.status, 500);
    const frame = frames.find((candidate) => candidate.includes("pi_chat_gate_mode_changed"));
    assert.ok(frame);
    const event = JSON.parse(frame.split("data: ")[1]) as { mode?: string; piChatSessionId?: string };
    assert.equal(event.mode, "open");
    assert.equal(event.piChatSessionId, id);
    const bootstrap = await (await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`)).json() as { gateMode?: string };
    assert.equal(bootstrap.gateMode, "open");
  } finally {
    server.close();
    clients.clear();
    await app.close();
  }
});

test("viewing a cold session returns history before its runtime finishes restoring", async () => {
  const mainCommands: Record<string, unknown>[] = [];
  const workerCommands: Record<string, unknown>[] = [];
  const activePath = "C:\\sessions\\active.jsonl";
  const historyPath = "C:\\sessions\\history.jsonl";
  const historyId = "0123456789abcdefabcd";
  const mainRpc = {
    onEvent: () => () => {},
    send: async (command: Record<string, unknown>) => {
      mainCommands.push(command);
      if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: activePath, sessionId: "active", isStreaming: false } };
      throw new Error(`Unexpected main RPC command: ${String(command.type)}`);
    },
  } as unknown as PiRpcClient;
  const workerRpc = {
    onEvent: () => () => {}, start: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }, stop: async () => {},
    send: async (command: Record<string, unknown>) => {
      workerCommands.push(command);
      if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: historyPath, sessionId: "history", isStreaming: false } };
      if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [{ role: "user", content: "old question" }] } };
      if (command.type === "get_session_stats") return { type: "response", success: true, data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [] } };
      if (command.type === "prompt") return { type: "response", success: true };
      throw new Error(`Unexpected worker RPC command: ${String(command.type)}`);
    },
  } as unknown as PiRpcClient;
  const historySummary = { id: historyId, sessionId: "history", name: "History", preview: "old", cwd: process.cwd(), updatedAt: 1, messageCount: 2, active: false };
  const historyMessages = [
    { role: "user", content: "old question" },
    { role: "assistant", content: "new answer written outside Pi Chat" },
  ];
  const sessions = {
    list: async () => [historySummary],
    pathForId: (id: string) => id === historyId ? historyPath : null,
    summaryForId: (id: string) => id === historyId ? historySummary : null,
    snapshotForId: async (id: string) => id === historyId ? { messages: historyMessages, usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, context: null } } : null,
    messagesForId: async (id: string) => id === historyId ? historyMessages : null,
  } as unknown as SessionIndex;
  let workerCreations = 0;
  const app = new PiChatApp({ rpc: mainRpc, createRpc: () => { workerCreations += 1; return workerRpc; }, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const [response, concurrentResponse] = await Promise.all([
      fetch(`${origin}/api/sessions/${historyId}/view`),
      fetch(`${origin}/api/sessions/${historyId}/view`),
    ]);
    assert.equal(response.status, 200);
    assert.equal(concurrentResponse.status, 200);
    assert.equal(workerCreations, 0);
    assert.deepEqual(mainCommands, []);
    const view = await response.json() as { isActive: boolean; runtimeStatus: string; messages: Array<{ content: string }> };
    assert.equal(view.isActive, false);
    assert.equal(view.runtimeStatus, "view-only");
    assert.deepEqual(view.messages.map((message) => message.content), ["old question", "new answer written outside Pi Chat"]);
    assert.equal(workerCommands.some((command) => command.type === "get_messages"), false);
    const activated = await fetch(`${origin}/api/sessions/${historyId}/activate`, { method: "POST" });
    assert.equal(activated.status, 200);
    assert.equal(workerCreations, 1);
    const activeView = await activated.json() as { isActive: boolean; runtimeStatus: string; messages: Array<{ content: string }> };
    assert.equal(activeView.isActive, true);
    assert.equal(activeView.runtimeStatus, "active");
    assert.deepEqual(activeView.messages.map((message) => message.content), ["old question", "new answer written outside Pi Chat"]);
    const prompt = await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "continue here", sessionId: historyId }) });
    assert.equal(prompt.status, 202);
    assert.equal(mainCommands.some((command) => command.type === "switch_session" || command.type === "prompt"), false);
    assert.equal(workerCommands.some((command) => command.type === "prompt"), true);
  } finally {
    server.close();
    await app.close();
  }
});

test("busy secondary Session view uses persisted snapshot and does not wait on its busy RPC", async () => {
  const primaryPath = "C:\\sessions\\primary.jsonl";
  const secondaryPath = "C:\\sessions\\secondary.jsonl";
  const { idForPath } = await import("../src/server/session-index");
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = {
    onEvent: () => () => {},
    isRunning: () => true,
    send: async (command: Record<string, unknown>) => {
      if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: primaryPath, sessionId: "primary", isStreaming: false } };
      throw new Error(`Unexpected primary RPC command: ${String(command.type)}`);
    },
  } as unknown as PiRpcClient;
  const secondaryCommands: string[] = [];
  const secondary = {
    onEvent: () => () => {},
    isRunning: () => true,
    start: async () => {},
    stop: async () => {},
    send: async (command: Record<string, unknown>) => {
      secondaryCommands.push(String(command.type));
      if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: secondaryPath, sessionId: "secondary", isStreaming: true } };
      // A busy worker would make these slow in production. The regression is that
      // navigation must not issue them at all once a persisted snapshot exists.
      if (["get_commands", "get_messages", "get_session_stats"].includes(String(command.type))) return new Promise<Record<string, unknown>>(() => {});
      throw new Error(`Unexpected secondary RPC command: ${String(command.type)}`);
    },
  } as unknown as PiRpcClient;
  const primarySummary = { id: primaryId, sessionId: "primary", name: "Primary", preview: "primary", cwd: process.cwd(), updatedAt: 1, lastUserPromptAt: 1, messageCount: 1, active: true };
  const secondarySummary = { id: secondaryId, sessionId: "secondary", name: "Secondary", preview: "secondary", cwd: process.cwd(), updatedAt: 2, lastUserPromptAt: 2, messageCount: 1, active: false };
  const snapshot = {
    messages: [{ role: "user", content: "secondary question" }],
    usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, context: null },
    settings: {},
  };
  const sessions = {
    list: async () => [primarySummary, secondarySummary],
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    summaryForId: (id: string) => id === secondaryId ? secondarySummary : id === primaryId ? primarySummary : null,
    cachedSnapshotForId: (id: string) => id === secondaryId ? snapshot : null,
    snapshotForId: async (id: string) => id === secondaryId ? snapshot : null,
    messagesForId: async () => null,
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary,
    createRpc: () => secondary,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    // Activate first so PiChatApp owns a known Secondary Runtime, then make its
    // process appear busy before requesting the view again.
    const activated = await fetch(`${origin}/api/sessions/${secondaryId}/activate`, { method: "POST" });
    assert.equal(activated.status, 200);
    secondaryCommands.length = 0;
    const fastStarted = Date.now();
    const fastResponse = await fetch(`${origin}/api/sessions/${secondaryId}/view?fast=1`);
    assert.equal(fastResponse.status, 200);
    assert.ok(Date.now() - fastStarted < 250, "hot-memory Session view should not wait for RPC probes");
    const fastView = await fastResponse.json() as { viewSource?: string; reconcilePending?: boolean; messages: Array<{ content: string }> };
    assert.equal(fastView.viewSource, "hot-memory");
    assert.equal(fastView.reconcilePending, true, "fast view marks missing stats/commands for later reconciliation");
    assert.deepEqual(fastView.messages.map((message) => message.content), ["secondary question"]);
    assert.deepEqual(secondaryCommands, [], "fast view must not issue RPC probes");

    const started = Date.now();
    const response = await fetch(`${origin}/api/sessions/${secondaryId}/view`);
    assert.equal(response.status, 200);
    assert.ok(Date.now() - started < 250, "busy Session view should not wait for RPC probes");
    const view = await response.json() as { isStreaming: boolean; messages: Array<{ content: string }> };
    assert.equal(view.isStreaming, true);
    assert.deepEqual(view.messages.map((message) => message.content), ["secondary question"]);
    assert.deepEqual(secondaryCommands, []);

    // Even before the index owns a parsed snapshot, a known busy Runtime must
    // return promptly rather than synchronously parse its continuously-written
    // JSONL or wait on a queued read RPC. SSE supplies the live assistant draft.
    const mutableSessions = sessions as unknown as {
      cachedSnapshotForId: () => null;
      snapshotForId: () => Promise<never>;
      messagesForId: () => Promise<never>;
    };
    mutableSessions.cachedSnapshotForId = () => null;
    mutableSessions.snapshotForId = async () => { throw new Error("busy view must not read a cold snapshot"); };
    mutableSessions.messagesForId = async () => { throw new Error("busy view must not read messages"); };
    secondaryCommands.length = 0;
    const uncachedStarted = Date.now();
    const uncachedResponse = await fetch(`${origin}/api/sessions/${secondaryId}/view`);
    assert.equal(uncachedResponse.status, 200);
    assert.ok(Date.now() - uncachedStarted < 250, "cold busy Session view should still return immediately");
    const uncachedView = await uncachedResponse.json() as { messages: Array<{ content: string }>; isStreaming: boolean };
    assert.deepEqual(uncachedView.messages.map((message) => message.content), ["secondary question"]);
    assert.equal(uncachedView.isStreaming, true);
    assert.deepEqual(secondaryCommands, []);
  } finally {
    server.close();
    await app.close();
  }
});

test("busy secondary views retain terminal assistant and tool-result messages before settlement", async () => {
  const primaryPath = "C:\\sessions\\terminal-primary.jsonl";
  const secondaryPath = "C:\\sessions\\terminal-secondary.jsonl";
  const { idForPath } = await import("../src/server/session-index");
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = {
    onEvent: () => () => {},
    isRunning: () => true,
    send: async (command: Record<string, unknown>) => {
      if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: primaryPath, sessionId: "primary", isStreaming: false } };
      throw new Error(`Unexpected primary RPC command: ${String(command.type)}`);
    },
  } as unknown as PiRpcClient;
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  const secondaryCommands: string[] = [];
  const secondary = {
    onEvent: (next: (event: Record<string, unknown>) => void) => { listener = next; return () => {}; },
    isRunning: () => true,
    start: async () => {},
    stop: async () => {},
    send: async (command: Record<string, unknown>) => {
      secondaryCommands.push(String(command.type));
      if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: secondaryPath, sessionId: "secondary", isStreaming: false } };
      if (command.type === "get_session_stats") return { type: "response", success: true, data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [] } };
      if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [{ role: "user", content: "inspect" }] } };
      throw new Error(`Unexpected secondary RPC command: ${String(command.type)}`);
    },
  } as unknown as PiRpcClient;
  const primarySummary = { id: primaryId, sessionId: "primary", name: "Primary", preview: "primary", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true };
  const secondarySummary = { id: secondaryId, sessionId: "secondary", name: "Secondary", preview: "inspect", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: false };
  const snapshot = { messages: [{ role: "user", content: "inspect", timestamp: 1 }], usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, context: null }, settings: {} };
  const sessions = {
    list: async () => [primarySummary, secondarySummary],
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    summaryForId: (id: string) => id === secondaryId ? secondarySummary : id === primaryId ? primarySummary : null,
    cachedSnapshotForId: (id: string) => id === secondaryId ? snapshot : null,
    snapshotForId: async (id: string) => id === secondaryId ? snapshot : null,
    messagesForId: async (id: string) => id === secondaryId ? snapshot.messages : null,
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary, createRpc: () => secondary, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    assert.equal((await fetch(`${origin}/api/sessions/${secondaryId}/activate`, { method: "POST" })).status, 200);
    secondaryCommands.length = 0;
    listener?.({ type: "agent_start" });
    listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "read it" }, { type: "toolCall", id: "read-terminal", name: "read", arguments: { path: "file.ts" } }], timestamp: 2 } });
    listener?.({ type: "message_end", message: { role: "toolResult", toolCallId: "read-terminal", toolName: "read", content: "contents", timestamp: 3 } });

    const response = await fetch(`${origin}/api/sessions/${secondaryId}/view`);
    assert.equal(response.status, 200);
    const view = await response.json() as { isStreaming: boolean; messages: Array<{ role: string }> };
    assert.equal(view.isStreaming, true);
    assert.deepEqual(view.messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
    assert.deepEqual(secondaryCommands, []);

    // agent_settled can arrive before JSONL/get_messages exposes the final rows.
    // The first idle view must retain the terminal SSE tail instead of snapping
    // back to the old persisted prefix.
    listener?.({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    secondaryCommands.length = 0;
    const settledResponse = await fetch(`${origin}/api/sessions/${secondaryId}/view`);
    assert.equal(settledResponse.status, 200);
    const settledView = await settledResponse.json() as { isStreaming: boolean; messages: Array<{ role: string }> };
    assert.equal(settledView.isStreaming, false);
    assert.deepEqual(settledView.messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
    assert.deepEqual(secondaryCommands, ["get_state", "get_session_stats", "get_commands"]);
  } finally {
    server.close();
    await app.close();
  }
});

test("a rejected prompt does not reorder sidebar recency", async () => {
  const { idForPath } = await import("../src/server/session-index");
  const primaryPath = "C:\\sessions\\rejected-primary.jsonl";
  const secondaryPath = "C:\\sessions\\rejected-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = {
    onEvent: () => () => {},
    isRunning: () => true,
    send: async (command: Record<string, unknown>) => {
      if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: primaryPath, sessionId: "primary", isStreaming: false } };
      if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [] } };
      if (command.type === "get_available_models") return { type: "response", success: true, data: { models: [] } };
      if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [] } };
      if (command.type === "get_session_stats") return { type: "response", success: true, data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      if (command.type === "prompt") throw new Error("provider rejected prompt");
      throw new Error(`Unexpected RPC command: ${String(command.type)}`);
    },
  } as unknown as PiRpcClient;
  const sessions = {
    list: async () => [
      { id: primaryId, sessionId: "primary", name: "Primary", preview: "primary", cwd: process.cwd(), updatedAt: 10, lastUserPromptAt: 10, messageCount: 1, active: true },
      { id: secondaryId, sessionId: "secondary", name: "Secondary", preview: "secondary", cwd: process.cwd(), updatedAt: 20, lastUserPromptAt: 20, messageCount: 1, active: false },
    ],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), now: () => 100 });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    const rejected = await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "will fail", sessionId: primaryId }) });
    assert.equal(rejected.status, 500);
    const sidebar = await (await fetch(`${origin}/api/sessions`)).json() as { sessions: Array<{ id: string }> };
    assert.deepEqual(sidebar.sessions.map((session) => session.id), [secondaryId, primaryId]);
  } finally {
    server.close();
    await app.close();
  }
});

test("active session view restores the cached streaming draft after returning", async () => {
  const activePath = "C:\\sessions\\streaming.jsonl";
  const activeId = (await import("../src/server/session-index")).idForPath(activePath);
  const rpc = {
    onEvent: (listener: (event: Record<string, unknown>) => void) => {
      setTimeout(() => {
        listener({ type: "agent_start" });
        listener({ type: "message_update", message: { role: "assistant", content: "partial answer" } });
        listener({ type: "tool_execution_start", toolName: "read" });
      }, 0);
      return () => {};
    },
    send: async (command: Record<string, unknown>) => {
      if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: activePath, sessionId: "active", isStreaming: true } };
      if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [{ role: "user", content: "question" }] } };
      if (command.type === "get_session_stats") return { type: "response", success: true, data: { tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } } };
      throw new Error(`Unexpected RPC command: ${String(command.type)}`);
    },
  } as unknown as PiRpcClient;
  const sessions = {
    list: async () => [{ id: activeId, sessionId: "active", name: "Active", preview: "question", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await (app as unknown as { ensurePrimaryIdentity(): Promise<void> }).ensurePrimaryIdentity();
  await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${activeId}/view`);
    assert.equal(response.status, 200);
    const view = await response.json() as { isActive: boolean; isStreaming: boolean; liveMessage: { content: string }; toolStatus: string };
    assert.equal(view.isActive, true);
    assert.equal(view.isStreaming, true);
    assert.equal(view.liveMessage.content, "partial answer");
    assert.equal(view.toolStatus, "正在运行工具：read");
  } finally {
    server.close();
    await app.close();
  }
});

test("chat prompt API skips redundant strict Gate synchronization before forwarding validated images", async () => {
  const commands: Record<string, unknown>[] = [];
  const activePath = "C:\\sessions\\validated-image-primary.jsonl";
  const activeId = (await import("../src/server/session-index")).idForPath(activePath);
  const rpc = {
    onEvent: () => () => {},
    send: async (command: Record<string, unknown>) => {
      if (command.type === "get_state") return { type: "response", command: command.type, success: true, data: { model: null, isStreaming: false, sessionFile: activePath, sessionId: "primary" } };
      commands.push(command);
      return { type: "response", command: command.type, success: true };
    },
  } as unknown as PiRpcClient;
  const app = new PiChatApp({
    rpc,
    sessions: {} as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "查看图片", sessionId: activeId, gateMode: "strict", images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(commands, [
      { type: "prompt", message: "查看图片", images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
    ]);
  } finally {
    server.close();
    await app.close();
  }
});
