import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp } from "../src/server/app";
import type { PiRpcClient } from "../src/server/rpc-client";
import { idForPath } from "../src/server/session-index";
import type { SessionIndex } from "../src/server/session-index";
import type { ResourceManager } from "../src/server/resource-manager";

class FakeRpc {
  readonly commands: Record<string, unknown>[] = [];
  private listeners = new Set<(event: Record<string, unknown>) => void>();
  streaming = false;
  stopCount = 0;

  constructor(readonly path: string, readonly sessionId: string) {}
  onEvent(listener: (event: Record<string, unknown>) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: Record<string, unknown>) { for (const listener of this.listeners) listener(event); }
  async start() {}
  async stop() { this.stopCount += 1; }
  async send(command: Record<string, unknown>) {
    this.commands.push(command);
    if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: this.path, sessionId: this.sessionId, isStreaming: this.streaming } };
    if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [] } };
    if (command.type === "get_available_models") return { type: "response", success: true, data: { models: [] } };
    if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [] } };
    if (command.type === "get_session_stats") return { type: "response", success: true, data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    if (command.type === "prompt") { this.streaming = true; this.emit({ type: "agent_start" }); return { type: "response", success: true }; }
    if (command.type === "abort") { this.streaming = false; this.emit({ type: "agent_settled" }); return { type: "response", success: true }; }
    return { type: "response", success: true, data: {} };
  }
}

test("startup preheats the three most recent saved secondary sessions sequentially", async () => {
  const paths = ["C:\\sessions\\primary.jsonl", "C:\\sessions\\newest.jsonl", "C:\\sessions\\next.jsonl", "C:\\sessions\\third.jsonl", "C:\\sessions\\older.jsonl"];
  const ids = paths.map(idForPath);
  const primary = new FakeRpc(paths[0], "primary");
  const workers = [new FakeRpc(paths[1], "newest"), new FakeRpc(paths[2], "next"), new FakeRpc(paths[3], "third")];
  const created: FakeRpc[] = [];
  const summaries = paths.map((path, index) => ({ id: ids[index], sessionId: `s${index}`, name: `S${index}`, preview: `S${index}`, cwd: process.cwd(), updatedAt: 100 - index, messageCount: 1, active: index === 0 }));
  const sessions = {
    list: async (activePath?: string) => summaries.map((session) => ({ ...session, active: session.id === idForPath(activePath || paths[0]) })),
    pathForId: (id: string) => paths[ids.indexOf(id)] || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => { const worker = workers.shift(); if (!worker) throw new Error("unexpected worker"); created.push(worker); return worker as unknown as PiRpcClient; },
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    maxIdleSecondaryRuntimes: 3,
  });
  try {
    assert.deepEqual(await app.preheatRecentSessions(), ids.slice(1, 4));
    assert.equal(created.length, 3);
    assert.deepEqual(created.map((worker) => worker.path), paths.slice(1, 4));
    assert.deepEqual(await app.preheatRecentSessions(), ids.slice(1, 4));
    assert.equal(created.length, 3);
  } finally {
    await app.close();
  }
});

test("idle secondary workers use LRU capacity reclamation without stopping active work", async () => {
  const pathA = "C:\\sessions\\a.jsonl";
  const pathB = "C:\\sessions\\b.jsonl";
  const pathC = "C:\\sessions\\c.jsonl";
  const idA = idForPath(pathA);
  const idB = idForPath(pathB);
  const idC = idForPath(pathC);
  const primary = new FakeRpc(pathA, "a");
  const firstB = new FakeRpc(pathB, "b");
  const workerC = new FakeRpc(pathC, "c");
  const reopenedB = new FakeRpc(pathB, "b");
  const workers = [firstB, workerC, reopenedB];
  const summaries = [
    { id: idA, sessionId: "a", name: "A", preview: "A", cwd: process.cwd(), updatedAt: 3, messageCount: 1, active: true },
    { id: idB, sessionId: "b", name: "B", preview: "B", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: false },
    { id: idC, sessionId: "c", name: "C", preview: "C", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async (activePath?: string) => summaries.map((session) => ({ ...session, active: session.id === idForPath(activePath || pathA) })),
    pathForId: (id: string) => id === idA ? pathA : id === idB ? pathB : id === idC ? pathC : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => workers.shift() as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    maxIdleSecondaryRuntimes: 1,
    secondaryRuntimeIdleMs: 60_000,
    secondaryRuntimeSweepMs: 60_000,
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/view`)).status, 200);
    assert.equal(firstB.stopCount, 0);
    // Opening C exceeds one idle secondary worker, so the oldest idle B worker is reclaimed.
    assert.equal((await fetch(`${origin}/api/sessions/${idC}/view`)).status, 200);
    assert.equal(firstB.stopCount, 1);
    assert.equal(workerC.stopCount, 0);

    // A running worker is never evicted to make capacity for another viewed Session.
    assert.equal((await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "keep C", sessionId: idC }) })).status, 202);
    assert.equal(workerC.streaming, true);
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/view`)).status, 200);
    assert.equal(workerC.stopCount, 0);
    const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as { activeSessionIds: string[] };
    assert.deepEqual(new Set(bootstrap.activeSessionIds), new Set([idA, idB, idC]));
  } finally {
    server.close();
    await app.close();
  }
});

test("an idle secondary worker is reclaimed after its configured timeout", async () => {
  const pathA = "C:\\sessions\\a.jsonl";
  const pathB = "C:\\sessions\\b.jsonl";
  const idA = idForPath(pathA);
  const idB = idForPath(pathB);
  const primary = new FakeRpc(pathA, "a");
  const secondary = new FakeRpc(pathB, "b");
  const summaries = [
    { id: idA, sessionId: "a", name: "A", preview: "A", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: idB, sessionId: "b", name: "B", preview: "B", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async (activePath?: string) => summaries.map((session) => ({ ...session, active: session.id === idForPath(activePath || pathA) })),
    pathForId: (id: string) => id === idA ? pathA : id === idB ? pathB : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => secondary as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    secondaryRuntimeIdleMs: 0,
    secondaryRuntimeSweepMs: 100,
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/view`)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(secondary.stopCount, 1);
    const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as { activeSessionIds: string[] };
    assert.deepEqual(bootstrap.activeSessionIds, [idA]);
    assert.equal(primary.stopCount, 0);
  } finally {
    server.close();
    await app.close();
  }
});

test("all opened sessions route prompts, events and aborts to independent RPC workers", async () => {
  const pathA = "C:\\sessions\\a.jsonl";
  const pathB = "C:\\sessions\\b.jsonl";
  const pathC = "C:\\sessions\\c.jsonl";
  const idA = idForPath(pathA);
  const idB = idForPath(pathB);
  const idC = idForPath(pathC);
  const primary = new FakeRpc(pathA, "a");
  const secondary = new FakeRpc(pathB, "b");
  const third = new FakeRpc(pathC, "c");
  const summaries = [
    { id: idA, sessionId: "a", name: "A", preview: "A", cwd: process.cwd(), updatedAt: 3, messageCount: 0, active: true },
    { id: idB, sessionId: "b", name: "B", preview: "B", cwd: process.cwd(), updatedAt: 2, messageCount: 0, active: false },
    { id: idC, sessionId: "c", name: "C", preview: "C", cwd: process.cwd(), updatedAt: 1, messageCount: 0, active: false },
  ];
  const workers = [secondary, third];
  const sessions = {
    list: async (activePath?: string) => summaries.map((session) => ({ ...session, active: session.id === idForPath(activePath || pathA) })),
    pathForId: (id: string) => id === idA ? pathA : id === idB ? pathB : id === idC ? pathC : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => workers.shift() as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: object = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as { activeSessionIds: string[] };
    assert.deepEqual(bootstrap.activeSessionIds, [idA]);
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/view`)).status, 200);
    assert.equal((await fetch(`${origin}/api/sessions/${idC}/view`)).status, 200);

    assert.equal((await post("/api/chat/prompt", { message: "for A", sessionId: idA })).status, 202);
    assert.equal((await post("/api/chat/prompt", { message: "for B", sessionId: idB })).status, 202);
    assert.equal((await post("/api/chat/prompt", { message: "for C", sessionId: idC })).status, 202);
    assert.deepEqual(primary.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for A"]);
    assert.deepEqual(secondary.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for B"]);
    assert.deepEqual(third.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for C"]);
    assert.equal(primary.streaming, true);
    assert.equal(secondary.streaming, true);
    assert.equal(third.streaming, true);

    const queuedB2 = await post("/api/chat/prompt", { message: "B queued then cancelled", sessionId: idB });
    const queuedB2Data = await queuedB2.json() as { queued: boolean; id: string };
    assert.equal(queuedB2.status, 202);
    assert.equal(queuedB2Data.queued, true);
    const queuedB3 = await post("/api/chat/prompt", { message: "B queued then dispatched", sessionId: idB });
    assert.equal((await queuedB3.json() as { queued: boolean }).queued, true);
    const cancelled = await fetch(`${origin}/api/chat/queue/${queuedB2Data.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: idB }) });
    assert.equal(cancelled.status, 200);
    assert.deepEqual((await cancelled.json() as { queue: Array<{ message: string }> }).queue.map((item) => item.message), ["B queued then dispatched"]);

    const abortedB = await post("/api/chat/abort", { sessionId: idB });
    assert.equal(abortedB.status, 200);
    assert.equal((await abortedB.json() as { queuePaused: boolean }).queuePaused, true);
    assert.equal(primary.streaming, true);
    assert.equal(secondary.streaming, false);
    assert.equal(primary.commands.filter((item) => item.type === "abort").length, 0);
    assert.equal(secondary.commands.filter((item) => item.type === "abort").length, 1);

    const resumed = await post("/api/chat/queue/resume", { sessionId: idB });
    assert.equal(resumed.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(secondary.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for B", "B queued then dispatched"]);
    assert.deepEqual(primary.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for A"]);
    assert.deepEqual(third.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for C"]);
  } finally {
    server.close();
    await app.close();
  }
});
