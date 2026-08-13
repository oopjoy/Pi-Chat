import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import { RpcRequestTimeoutError, type PiRpcClient } from "../../src/server/rpc-client";
import { idForPath } from "../../src/server/session-index";
import type { SessionIndex } from "../../src/server/session-index";
import type { ResourceManager } from "../../src/server/resource-manager";
import { ModelManager } from "../../src/server/model-manager";
import type { SessionSummary } from "../../src/shared/types";
import { FakeRpc } from "../helpers/server-app-fixture";

test("sidebar defaults to at most fifteen rows per directory and can explicitly load the complete snapshot", async () => {
  const path = "C:\\sessions\\old-active.jsonl";
  const activeId = idForPath(path);
  const primary = new FakeRpc(path, "old-active");
  const summaries = Array.from({ length: 25 }, (_, index) => ({
    id: index === 24 ? activeId : index.toString(16).padStart(20, "0"),
    sessionId: `session-${index}`,
    name: `Session ${index}`,
    preview: "",
    cwd: process.cwd(),
    updatedAt: index === 24 ? 0 : 100 - index,
    messageCount: 1,
    active: index === 24,
  }));
  const sessions = {
    list: async () => summaries,
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const recent = await (await fetch(`${origin}/api/sessions`)).json() as { sessions: Array<{ id: string }>; total: number };
    assert.equal(recent.total, 25);
    assert.equal(recent.sessions.length, 15);
    assert.equal(recent.sessions.some((session) => session.id === activeId), false);
    const all = await (await fetch(`${origin}/api/sessions?all=1`)).json() as { sessions: Array<{ id: string }>; total: number };
    assert.equal(all.total, 25);
    assert.equal(all.sessions.length, 25);
    assert.equal(all.sessions.some((session) => session.id === activeId), true);
  } finally {
    server.close();
    await app.close();
  }
});

test("busy bootstrap uses persisted JSONL history without queueing get_messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-busy-bootstrap-"));
  const path = join(root, "primary.jsonl");
  const id = idForPath(path);
  const persisted = [{ role: "user", content: [{ type: "text", text: "persisted" }] }];
  await writeFile(path, [
    { type: "session", version: 3, id: "primary-busy-bootstrap", timestamp: "2026-01-01T00:00:00Z", cwd: process.cwd() },
    { type: "message", id: "1", message: persisted[0] },
  ].map(JSON.stringify).join("\n") + "\n");
  const primary = new FakeRpc(path, "primary-busy-bootstrap");
  primary.streaming = true;
  const sessions = {
    list: async () => [{ id, sessionId: "primary-busy-bootstrap", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => persisted,
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await (await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`)).json() as { messages: unknown[] };
    assert.deepEqual(result.messages, persisted);
    assert.equal(primary.commands.some((command) => command.type === "get_messages"), false);
  } finally {
    server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("empty terminal assistant SSE events retain the cumulative answer payload", async () => {
  const path = "C:\\sessions\\primary-terminal-repair.jsonl";
  const primary = new FakeRpc(path, "primary-terminal-repair");
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const frames: string[] = [];
  const clients = (app as unknown as { sseClients: Map<{ write: (frame: string) => boolean }, string> }).sseClients;
  clients.set({ write: (frame) => { frames.push(frame); return true; } }, "11111111-1111-4111-8111-111111111111");
  try {
    await (app as unknown as { ensurePrimaryIdentity(): Promise<void> }).ensurePrimaryIdentity();
    primary.emit({ type: "agent_start" });
    primary.emit({ type: "message_update", message: { role: "assistant", content: "cumulative answer", timestamp: 1 } });
    primary.emit({ type: "message_end", message: { role: "assistant", content: [], timestamp: 2 } });
    primary.emit({ type: "agent_settled" });
    primary.emit({ type: "agent_start" });
    primary.emit({ type: "message_end", message: { role: "assistant", content: "second answer", timestamp: 3 } });
    const terminals = frames.filter((frame) => frame.includes('"type":"message_end"'));
    assert.match(terminals[0] || "", /"content":"cumulative answer"/);
    assert.match(terminals[0] || "", /"piChatSessionId"/);
    assert.match(terminals[0] || "", /"piChatRunEpoch":"[A-Za-z0-9_-]+"/);
    assert.match(terminals[0] || "", /"piChatRunGeneration":1/);
    assert.match(terminals[1] || "", /"piChatRunGeneration":2/);
  } finally {
    clients.clear();
    await app.close();
  }
});

test("cumulative tool execution updates never enter the browser SSE fanout", async () => {
  const path = "C:\\sessions\\primary-tool-flood.jsonl";
  const primary = new FakeRpc(path, "primary-tool-flood");
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const frames: string[] = [];
  const clients = (app as unknown as { sseClients: Map<{ write: (frame: string) => boolean }, string> }).sseClients;
  clients.set({ write: (frame) => { frames.push(frame); return true; } }, "11111111-1111-4111-8111-111111111111");
  try {
    await (app as unknown as { ensurePrimaryIdentity(): Promise<void> }).ensurePrimaryIdentity();
    primary.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" });
    primary.emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: { content: "x".repeat(600_000) } });
    primary.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: "done" }, isError: false });
    assert.equal(frames.some((frame) => frame.includes("tool_execution_update")), false);
    assert.equal(frames.some((frame) => frame.includes("tool_execution_start")), true);
    assert.equal(frames.some((frame) => frame.includes("tool_execution_end")), true);
  } finally {
    clients.clear();
    await app.close();
  }
});

test("SSE emits visible heartbeats and a local New composer can release its viewed Session pin", async () => {
  const path = "C:\\sessions\\primary-heartbeat.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary-heartbeat");
  const client = "11111111-1111-4111-8111-111111111111";
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), sseHeartbeatMs: 10 });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const controller = new AbortController();
  try {
    const response = await fetch(`${origin}/api/events`, { headers: { "x-pi-chat-client": client }, signal: controller.signal });
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let frames = "";
    const deadline = Date.now() + 1_000;
    while (!frames.includes("pi_chat_heartbeat") && Date.now() < deadline) {
      const next = await reader.read();
      if (next.done) break;
      frames += decoder.decode(next.value, { stream: true });
    }
    assert.match(frames, /event: ready/);
    assert.match(frames, /"type":"pi_chat_heartbeat"/);
    assert.equal((await fetch(`${origin}/api/sessions/${id}/viewing`, { method: "POST", headers: { "x-pi-chat-client": client } })).status, 200);
    const internals = app as unknown as { viewedSessionsByClient: Map<string, string> };
    assert.equal(internals.viewedSessionsByClient.get(client), id);
    const headers = { "content-type": "application/json", "x-pi-chat-client": client };
    const cleared = await fetch(`${origin}/api/sessions/viewing/clear`, { method: "POST", headers, body: JSON.stringify({ sessionId: id }) });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { viewing: "" });
    assert.equal(internals.viewedSessionsByClient.has(client), false);

    const newerId = "fedcba9876543210abcd";
    internals.viewedSessionsByClient.set(client, newerId);
    const staleClear = await fetch(`${origin}/api/sessions/viewing/clear`, { method: "POST", headers, body: JSON.stringify({ sessionId: id }) });
    assert.equal(staleClear.status, 200);
    assert.deepEqual(await staleClear.json(), { viewing: newerId });
    assert.equal(internals.viewedSessionsByClient.get(client), newerId);
    await reader.cancel();
  } finally {
    controller.abort();
    server.close();
    await app.close();
  }
});

test("an abandoned Gate confirmation is safely cancelled after its timeout", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), gateRequestTimeoutMs: 10 });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    primary.streaming = true;
    primary.emit({ type: "extension_ui_request", id: "stale-gate", method: "select", title: "Write file?", options: ["Allow", "Block"] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(primary.commands.find((command) => command.type === "extension_ui_response"), { type: "extension_ui_response", id: "stale-gate", cancelled: true });
    const view = await (await fetch(`${origin}/api/sessions/${id}/view`)).json() as { pendingExtensionRequest?: unknown; session: { pendingConfirmation?: boolean } };
    assert.equal(view.pendingExtensionRequest, undefined);
    assert.equal(view.session.pendingConfirmation, false);
  } finally {
    server.close();
    await app.close();
  }
});

test("a pending extension confirmation belongs to one Session and only its first response is forwarded", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  const sessions = {
    list: async (activePath?: string) => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: id === idForPath(activePath || path) }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (body: object) => fetch(`${origin}/api/extension-ui/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    primary.emit({ type: "extension_ui_request", id: "gate-1", method: "select", title: "Write file?", options: ["Allow", "Block"] });
    const view = await (await fetch(`${origin}/api/sessions/${id}/view`)).json() as { pendingExtensionRequest?: { id: string }; session: { pendingConfirmation?: boolean } };
    assert.equal(view.pendingExtensionRequest?.id, "gate-1");
    assert.equal(view.session.pendingConfirmation, true);
    assert.equal((await post({ id: "gate-1", value: "Allow", sessionId: id })).status, 200);
    const second = await post({ id: "gate-1", value: "Block", sessionId: id });
    assert.equal(second.status, 409);
    assert.equal(primary.commands.filter((command) => command.type === "extension_ui_response").length, 1);
    assert.deepEqual(primary.commands.find((command) => command.type === "extension_ui_response"), { type: "extension_ui_response", id: "gate-1", value: "Allow" });
  } finally {
    server.close();
    await app.close();
  }
});
