import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp, promptImages } from "../src/server/app";
import { parsePickerOutput } from "../src/server/file-picker";
import type { PiRpcClient } from "../src/server/rpc-client";
import type { SessionIndex } from "../src/server/session-index";
import type { ResourceManager } from "../src/server/resource-manager";
import { commandMatches, fileReferences, windowsPathsFromText } from "../src/web/components/ChatInput";

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
  assert.deepEqual(commandMatches("/compact ", commands), []);
  assert.deepEqual(commandMatches("text", commands), []);
});

test("local prompt queue can cancel, pause on abort and resume", async () => {
  const commands: Record<string, unknown>[] = [];
  const rpc = {
    onEvent: () => () => {},
    send: async (command: Record<string, unknown>) => {
      commands.push(command);
      if (command.type === "get_state") return { type: "response", success: true, data: { model: null, isStreaming: false } };
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
    assert.equal((await post("/api/chat/prompt", { message: "first" })).status, 202);
    const queuedResponse = await post("/api/chat/prompt", { message: "second" });
    const queued = await queuedResponse.json() as { id: string };
    assert.ok(queued.id);
    assert.equal((await fetch(`${origin}/api/chat/queue/${queued.id}`, { method: "DELETE" })).status, 200);
    const third = await (await post("/api/chat/prompt", { message: "third" })).json() as { queued: boolean };
    assert.equal(third.queued, true);
    const aborted = await (await post("/api/chat/abort")).json() as { queuePaused: boolean };
    assert.equal(aborted.queuePaused, true);
    const resumed = await (await post("/api/chat/queue/resume")).json() as { paused: boolean };
    assert.equal(resumed.paused, false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(commands.filter((command) => command.type === "prompt").length, 2);
    assert.equal(commands.filter((command) => command.type === "abort").length, 1);
  } finally {
    server.close();
    await app.close();
  }
});

test("extension slash commands execute immediately without entering the local queue", async () => {
  const commands: Record<string, unknown>[] = [];
  const rpc = {
    onEvent: () => () => {},
    send: async (command: Record<string, unknown>) => {
      commands.push(command);
      if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [{ name: "gate", source: "extension", description: "Control file permission gate: /gate status|open|strict|once" }] } };
      if (command.type === "get_state") return { type: "response", success: true, data: { model: null, isStreaming: false } };
      return { type: "response", command: command.type, success: true };
    },
  } as unknown as PiRpcClient;
  const app = new PiChatApp({ rpc, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "/gate open" }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true, queued: false, extension: true, command: "gate", description: "Control file permission gate: /gate status|open|strict|once", isStreaming: false });
    assert.equal(commands.filter((command) => command.type === "prompt").length, 1);
  } finally {
    server.close();
    await app.close();
  }
});

test("read-only session view does not switch or interrupt the active Pi session", async () => {
  const commands: Record<string, unknown>[] = [];
  const activePath = "C:\\sessions\\active.jsonl";
  const historyId = "0123456789abcdefabcd";
  const rpc = {
    onEvent: () => () => {},
    send: async (command: Record<string, unknown>) => {
      commands.push(command);
      if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: activePath, sessionId: "active", isStreaming: true } };
      throw new Error(`Unexpected RPC command: ${String(command.type)}`);
    },
  } as unknown as PiRpcClient;
  const sessions = {
    list: async () => [
      { id: historyId, sessionId: "history", name: "History", preview: "old", cwd: process.cwd(), updatedAt: 1, messageCount: 2, active: false },
    ],
    messagesForId: async (id: string) => id === historyId ? [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ] : null,
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${historyId}/view`);
    assert.equal(response.status, 200);
    const view = await response.json() as { isActive: boolean; isStreaming: boolean; messages: Array<{ content: string }> };
    assert.equal(view.isActive, false);
    assert.equal(view.isStreaming, false);
    assert.deepEqual(view.messages.map((message) => message.content), ["old question", "old answer"]);
    assert.equal(commands.some((command) => command.type === "switch_session"), false);
    const stalePrompt = await fetch(`http://127.0.0.1:${address.port}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "must not reach active session", sessionId: historyId }),
    });
    assert.equal(stalePrompt.status, 409);
    assert.equal(commands.some((command) => command.type === "prompt"), false);
    assert.deepEqual(commands.map((command) => command.type), ["get_state"]);
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
      queueMicrotask(() => {
        listener({ type: "agent_start" });
        listener({ type: "message_update", message: { role: "assistant", content: "partial answer" } });
        listener({ type: "tool_execution_start", toolName: "read" });
      });
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
  await new Promise((resolve) => setTimeout(resolve, 0));
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

test("chat prompt API forwards validated images to Pi RPC", async () => {
  const commands: Record<string, unknown>[] = [];
  const rpc = {
    onEvent: () => () => {},
    send: async (command: Record<string, unknown>) => {
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
      body: JSON.stringify({ message: "查看图片", images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(commands, [{ type: "prompt", message: "查看图片", images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }]);
  } finally {
    server.close();
    await app.close();
  }
});
