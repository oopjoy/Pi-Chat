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

test("a crashed primary RPC leaves persisted history readable until the next write recovers it", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
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
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    primary.streaming = true;
    primary.emit({ type: "agent_start" });
    primary.crash();
    const failedBootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as {
      state: { isStreaming: boolean };
      sessions: Array<{
        id: string;
        running?: boolean;
        activity?: { execution?: string; error?: string };
      }>;
    };
    assert.equal(primary.restartCount, 0, "reading bootstrap must not wake a failed Primary Runtime");
    assert.equal(failedBootstrap.state.isStreaming, false);
    const failedSession = failedBootstrap.sessions.find((session) => session.id === id);
    assert.equal(failedSession?.running, false);
    assert.equal(failedSession?.activity?.execution, "failed");
    assert.equal(failedSession?.activity?.error, "worker crashed");
    const prompt = await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "recover on write", sessionId: id }) });
    assert.equal(prompt.status, 202);
    assert.equal(primary.restartCount, 1);
    const recovered = await (await fetch(`${origin}/api/bootstrap`)).json() as {
      sessions: Array<{ id: string; activity?: { execution?: string; error?: string } }>;
    };
    const recoveredSession = recovered.sessions.find((session) => session.id === id);
    assert.notEqual(recoveredSession?.activity?.execution, "failed");
    assert.equal(recoveredSession?.activity?.error, undefined);
  } finally {
    server.close();
    await app.close();
  }
});

test("Session list and history view keep a crashed primary dormant until a write", async () => {
  for (const endpoint of ["/api/sessions", "view"] as const) {
    const path = "C:\\sessions\\primary.jsonl";
    const id = idForPath(path);
    const primary = new FakeRpc(path, "primary");
    const sessions = {
      list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
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
      assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
      primary.crash();
      const url = endpoint === "view" ? `/api/sessions/${id}/view` : endpoint;
      assert.equal((await fetch(`${origin}${url}`)).status, 200);
      assert.equal(primary.restartCount, 0, `${endpoint} must remain read-only`);
    } finally {
      server.close();
      await app.close();
    }
  }
});

test("a crashed secondary RPC clears stale running state and recovers once on the next prompt", async () => {
  const primaryPath = "C:\\sessions\\primary.jsonl";
  const secondaryPath = "C:\\sessions\\secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "primary");
  const secondary = new FakeRpc(secondaryPath, "secondary");
  const summaries = [
    { id: primaryId, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => secondary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/sessions/${secondaryId}/activate`, { method: "POST" })).status, 200);
    secondary.streaming = true;
    secondary.emit({ type: "agent_start" });
    secondary.crash();
    const afterCrash = await (await fetch(`${origin}/api/sessions`)).json() as { sessions: Array<{ id: string; running?: boolean }> };
    assert.equal(afterCrash.sessions.find((session) => session.id === secondaryId)?.running, false);
    const prompt = await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "recover", sessionId: secondaryId }) });
    assert.equal(prompt.status, 202);
    assert.equal(secondary.restartCount, 1);
    assert.equal(secondary.commands.filter((command) => command.type === "prompt").at(-1)?.message, "recover");
  } finally {
    server.close();
    await app.close();
  }
});

test("running Sessions stage model and thinking changes until their next prompt", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  primary.streaming = true;
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (url: string, body: object) => fetch(`${origin}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    assert.deepEqual(await (await post("/api/models/set", { provider: "test", modelId: "next", sessionId: id })).json(), { model: { provider: "test", id: "next", name: "Next", reasoning: true }, pending: true });
    assert.deepEqual(await (await post("/api/thinking/set", { level: "high", sessionId: id })).json(), { level: "high", pending: true });
    // Busy bootstrap/view calls intentionally do not queue get_state behind the
    // turn. They must therefore expose the accepted pending selections rather
    // than replay the cached model/thinking snapshot from the previous turn.
    const busyBootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as { state: { model: { id: string } | null; thinkingLevel?: string } };
    assert.equal(busyBootstrap.state.model?.id, "next");
    assert.equal(busyBootstrap.state.thinkingLevel, "high");
    const busyView = await (await fetch(`${origin}/api/sessions/${id}/view`)).json() as { state: { model: { id: string } | null; thinkingLevel?: string } };
    assert.equal(busyView.state.model?.id, "next");
    assert.equal(busyView.state.thinkingLevel, "high");
    assert.equal(primary.commands.some((command) => command.type === "set_model" || command.type === "set_thinking_level"), false);
    primary.streaming = false;
    primary.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const prompt = await post("/api/chat/prompt", { message: "next turn", sessionId: id });
    assert.equal(prompt.status, 202);
    const types = primary.commands.map((command) => command.type);
    assert.deepEqual(types.slice(-3), ["set_model", "set_thinking_level", "prompt"]);
  } finally {
    server.close();
    await app.close();
  }
});

test("a crash during a settlement barrier recovers and dispatches existing Secondary queue work", async () => {
  const primaryPath = "C:\\sessions\\barrier-primary.jsonl";
  const secondaryPath = "C:\\sessions\\barrier-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "primary");
  const secondary = new FakeRpc(secondaryPath, "secondary");
  const summaries = [
    { id: primaryId, sessionId: "barrier-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "barrier-secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => secondary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/sessions/${secondaryId}/activate`, { method: "POST" })).status, 200);
    // Simulate a settlement FIFO barrier holding the dispatch lock when the
    // live child dies mid-turn.
    const internals = app as unknown as {
      runtimePool: {
        get(id: string): {
          dispatching: boolean;
          queuePaused: boolean;
          promptQueue: Array<{
            id: string;
            message: string;
            images: [];
            imageCount: number;
            createdAt: number;
          }>;
        } | undefined;
      };
    };
    const runtime = internals.runtimePool.get(secondaryId);
    assert.ok(runtime, "activated Secondary exists");
    runtime.promptQueue.push({
      id: "00000000-0000-4000-8000-000000000701",
      message: "queued before crash",
      images: [],
      imageCount: 0,
      createdAt: 1,
    });
    runtime.dispatching = true;
    secondary.crash();
    assert.equal(
      runtime.dispatching,
      false,
      "process_error releases the stale dispatch lock",
    );
    assert.equal(runtime.queuePaused, false, "the crash does not pause the queue");
    // The next prompt must recover the worker and actually dispatch instead of
    // being silently swallowed behind the stale lock.
    const prompt = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "after crash", sessionId: secondaryId }),
    });
    assert.equal(prompt.status, 202);
    assert.equal(secondary.restartCount, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      secondary.commands
        .filter((command) => command.type === "prompt")
        .map((command) => command.message),
      ["queued before crash"],
      "recovery dispatches the pre-crash FIFO head exactly once",
    );
    assert.deepEqual(
      runtime.promptQueue.map((item) => item.message),
      ["after crash"],
      "the new request queues behind the recovered head rather than stranding both",
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("a Primary crash recovers and dispatches existing queue work", async () => {
  const path = "C:\\sessions\\barrier-primary-queued.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "barrier-primary-queued");
  const sessions = {
    list: async () => [{ id, sessionId: "barrier-primary-queued", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const internals = app as unknown as {
    promptQueue: Array<{
      id: string;
      message: string;
      images: [];
      imageCount: number;
      createdAt: number;
    }>;
    dispatching: boolean;
    queuePaused: boolean;
  };
  try {
    await fetch(`${origin}/api/bootstrap`);
    internals.promptQueue.push({
      id: "00000000-0000-4000-8000-000000000702",
      message: "primary queued before crash",
      images: [],
      imageCount: 0,
      createdAt: 1,
    });
    internals.dispatching = true;
    primary.crash();
    assert.equal(internals.dispatching, false);
    assert.equal(internals.queuePaused, false);

    const prompt = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "primary after crash" }),
    });
    assert.equal(prompt.status, 202);
    assert.equal(primary.restartCount, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      primary.commands
        .filter((command) => command.type === "prompt")
        .map((command) => command.message),
      ["primary queued before crash"],
      "Primary recovery dispatches the pre-crash FIFO head exactly once",
    );
    assert.deepEqual(
      internals.promptQueue.map((item) => item.message),
      ["primary after crash"],
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("model and thinking changes do not claim or transfer Session control", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  primary.streaming = true;
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const post = (url: string, client: string, body: object) => fetch(`${origin}${url}`, { method: "POST", headers: { "content-type": "application/json", "x-pi-chat-client": client }, body: JSON.stringify(body) });
  const controllers = (app as unknown as { sessionControllers: Map<string, string> }).sessionControllers;
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`, { headers: { "x-pi-chat-client": first } })).status, 200);
    assert.equal((await post("/api/models/set", first, { provider: "test", modelId: "next", sessionId: id })).status, 200);
    assert.equal((await post("/api/thinking/set", first, { level: "high", sessionId: id })).status, 200);
    assert.equal(controllers.has(id), false);
    assert.equal((await post("/api/thinking/set", second, { level: "low", sessionId: id })).status, 200);
    assert.equal(controllers.has(id), false);
    assert.equal((await post("/api/chat/prompt", second, { message: "claim by sending", sessionId: id })).status, 202);
    assert.equal(controllers.get(id), second);
    const foreignThinking = await post("/api/thinking/set", first, { level: "max", sessionId: id });
    assert.equal(foreignThinking.status, 409);
    assert.match((await foreignThinking.json() as { error: string }).error, /另一窗口/);
    assert.equal(controllers.get(id), second);
  } finally {
    server.close();
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
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/activate`, { method: "POST" })).status, 200);
    assert.equal(firstB.stopCount, 0);
    // Activating C exceeds one idle secondary worker, so the oldest idle B worker is reclaimed.
    assert.equal((await fetch(`${origin}/api/sessions/${idC}/activate`, { method: "POST" })).status, 200);
    assert.equal(firstB.stopCount, 1);
    assert.equal(workerC.stopCount, 0);

    // A running worker is never evicted to make capacity for another viewed Session.
    assert.equal((await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "keep C", sessionId: idC }) })).status, 202);
    assert.equal(workerC.streaming, true);
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/activate`, { method: "POST" })).status, 200);
    assert.equal(workerC.stopCount, 0);
    const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as { activeSessionIds: string[] };
    assert.deepEqual(new Set(bootstrap.activeSessionIds), new Set([idA, idB, idC]));
  } finally {
    server.close();
    await app.close();
  }
});

test("a reclaimed Runtime's late terminal, settlement, and error frames cannot contaminate another Session", async () => {
  const primaryPath = "C:\\sessions\\primary-stale-reclaim.jsonl";
  const pathA = "C:\\sessions\\stale-a.jsonl";
  const pathB = "C:\\sessions\\clean-b.jsonl";
  const primaryId = idForPath(primaryPath);
  const idA = idForPath(pathA);
  const idB = idForPath(pathB);
  const primary = new FakeRpc(primaryPath, "primary-stale-reclaim");
  const workerA = new FakeRpc(pathA, "stale-a");
  const workerB = new FakeRpc(pathB, "clean-b");
  const workers = [workerA, workerB];
  const summaries = [
    { id: primaryId, sessionId: "primary-stale-reclaim", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 3, messageCount: 1, active: true },
    { id: idA, sessionId: "stale-a", name: "A", preview: "A persisted", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: false },
    { id: idB, sessionId: "clean-b", name: "B", preview: "B persisted", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async (activePath?: string) => summaries.map((session) => ({ ...session, active: session.id === idForPath(activePath || primaryPath) })),
    pathForId: (id: string) => id === primaryId ? primaryPath : id === idA ? pathA : id === idB ? pathB : null,
    messagesForId: async (id: string) => [{ role: "user", content: id === idB ? "B persisted" : "A persisted" }],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => workers.shift() as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    secondaryRuntimeSweepMs: 60_000,
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const frames: string[] = [];
  const clients = (app as unknown as { sseClients: Map<{ write: (frame: string) => boolean }, string> }).sseClients;
  clients.set({ write: (frame) => { frames.push(frame); return true; } }, "observer");
  try {
    assert.equal((await fetch(`${origin}/api/sessions/${idA}/activate`, { method: "POST" })).status, 200);
    const pool = (app as unknown as {
      runtimePool: { get(id: string): { running: boolean; dispatching: boolean; failed?: boolean; promptQueue: unknown[]; pendingTerminalMessages: unknown[] } | undefined; reclaim(id: string, reason: "idle"): Promise<boolean> };
    }).runtimePool;
    assert.equal(await pool.reclaim(idA, "idle"), true);
    assert.equal(workerA.stopCount, 1);
    assert.equal(pool.get(idA), undefined);

    assert.equal((await fetch(`${origin}/api/sessions/${idB}/activate`, { method: "POST" })).status, 200);
    const runtimeB = pool.get(idB);
    assert.ok(runtimeB);
    const before = {
      frames: frames.length,
      running: runtimeB.running,
      dispatching: runtimeB.dispatching,
      failed: runtimeB.failed,
      queue: [...runtimeB.promptQueue],
      terminals: [...runtimeB.pendingTerminalMessages],
    };

    // Models stdout callbacks already queued by A's stopped child: the Runtime
    // object has been detached, so none may route through B or reach SSE.
    workerA.emitLate({ type: "message_end", message: { role: "assistant", content: "A_STALE_MARKER" } });
    workerA.emitLate({ type: "agent_settled" });
    workerA.emitLate({ type: "pi_chat_process_error", error: "A_STALE_MARKER" });
    await new Promise((resolve) => setTimeout(resolve, 15));

    assert.equal(frames.length, before.frames, "stale A events must not publish an SSE frame for B");
    assert.equal(runtimeB.running, before.running);
    assert.equal(runtimeB.dispatching, before.dispatching);
    assert.equal(runtimeB.failed, before.failed);
    assert.deepEqual(runtimeB.promptQueue, before.queue);
    assert.deepEqual(runtimeB.pendingTerminalMessages, before.terminals);
    const view = await (await fetch(`${origin}/api/sessions/${idB}/view`)).json() as { messages: Array<{ content?: unknown }>; liveMessage?: { content?: unknown }; activity?: unknown };
    assert.doesNotMatch(JSON.stringify(view), /A_STALE_MARKER/);
    assert.equal(view.liveMessage, undefined);
  } finally {
    clients.clear();
    server.close();
    await app.close();
  }
});

test("four viewed idle Sessions still obey a configured cap of three idle Secondary Runtimes", async () => {
  const paths = ["C:\\sessions\\primary.jsonl", "C:\\sessions\\one.jsonl", "C:\\sessions\\two.jsonl", "C:\\sessions\\three.jsonl", "C:\\sessions\\four.jsonl"];
  const ids = paths.map(idForPath);
  const primary = new FakeRpc(paths[0], "primary");
  const workers = paths.slice(1).map((path, index) => new FakeRpc(path, `secondary-${index}`));
  const pendingWorkers = [...workers];
  const summaries = paths.map((path, index) => ({ id: ids[index], sessionId: `s${index}`, name: `S${index}`, preview: "", cwd: process.cwd(), updatedAt: 10 - index, messageCount: 1, active: index === 0 }));
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => paths[ids.indexOf(id)] || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => pendingWorkers.shift() as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    maxIdleSecondaryRuntimes: 3,
    secondaryRuntimeIdleMs: 60_000,
    secondaryRuntimeSweepMs: 60_000,
  });
  const internals = app as unknown as { connectedClients: Map<string, number>; viewedSessionsByClient: Map<string, string>; runtimes: Map<string, unknown> };
  for (let index = 1; index <= 4; index += 1) {
    const client = `${index}`.repeat(8) + "-1111-4111-8111-111111111111";
    internals.connectedClients.set(client, 1);
    internals.viewedSessionsByClient.set(client, ids[index]);
  }
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const activations = await Promise.all(ids.slice(1).map((id) => fetch(`${origin}/api/sessions/${id}/activate`, { method: "POST" })));
    assert.ok(activations.every((response) => response.status === 200));
    assert.equal(internals.runtimes.size, 3);
    assert.equal(workers.reduce((count, worker) => count + worker.stopCount, 0), 1);
    const reclaimedIndex = workers.findIndex((worker) => worker.stopCount === 1);
    assert.ok(reclaimedIndex >= 0);
    const reclaimedId = ids[reclaimedIndex + 1];
    assert.equal(internals.runtimes.has(reclaimedId), false);
    const oldHistory = await fetch(`${origin}/api/sessions/${reclaimedId}/view`);
    assert.equal(oldHistory.status, 200);
    assert.equal((await oldHistory.json() as { runtimeStatus?: string }).runtimeStatus, "view-only");
  } finally {
    server.close();
    await app.close();
  }
});

test("concurrent activation never exceeds four Secondary workers or five hot conversations total", async () => {
  const paths = [
    "C:\\sessions\\primary-cap.jsonl",
    "C:\\sessions\\hot-one.jsonl",
    "C:\\sessions\\hot-two.jsonl",
    "C:\\sessions\\hot-three.jsonl",
    "C:\\sessions\\hot-four.jsonl",
    "C:\\sessions\\hot-five.jsonl",
  ];
  const ids = paths.map(idForPath);
  const primary = new FakeRpc(paths[0], "primary-cap");
  const workers = paths.slice(1).map((path, index) => {
    const worker = new FakeRpc(path, `hot-${index + 1}`);
    worker.streaming = true;
    return worker;
  });
  let created = 0;
  const summaries = paths.map((path, index) => ({ id: ids[index], sessionId: `cap-${index}`, name: `Cap ${index}`, preview: "", cwd: process.cwd(), updatedAt: 10 - index, messageCount: 1, active: index === 0 }));
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => paths[ids.indexOf(id)] || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => workers[created++] as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    secondaryRuntimeIdleMs: 60_000,
    secondaryRuntimeSweepMs: 60_000,
  });
  const internals = app as unknown as { runtimes: Map<string, { rpc: FakeRpc }> };
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const responses = await Promise.all(ids.slice(1).map((id) => fetch(`${origin}/api/sessions/${id}/activate`, { method: "POST" })));
    assert.equal(responses.filter((response) => response.status === 200).length, 4);
    assert.equal(responses.filter((response) => response.status === 409).length, 1);
    const rejectedIndex = responses.findIndex((response) => response.status === 409);
    const rejected = responses[rejectedIndex];
    assert.ok(rejected);
    assert.match((await rejected.json() as { error: string }).error, /5 个热对话上限/);
    assert.equal(internals.runtimes.size, 4);
    assert.equal(created, 4);
    assert.equal(workers.slice(0, 4).every((worker) => worker.stopCount === 0), true);

    const releasedIndex = responses.findIndex((response) => response.status === 200);
    const releasedWorker = internals.runtimes.get(ids[releasedIndex + 1])?.rpc;
    assert.ok(releasedWorker);
    releasedWorker.streaming = false;
    releasedWorker.emit({ type: "agent_settled" });
    const admitted = await fetch(`${origin}/api/sessions/${ids[rejectedIndex + 1]}/activate`, { method: "POST" });
    assert.equal(admitted.status, 200);
    assert.equal(releasedWorker.stopCount, 1);
    assert.equal(internals.runtimes.size, 4);
    assert.equal(created, 5);
  } finally {
    server.close();
    await app.close();
  }
});

test("a visible cold history remains readable after its idle Runtime is reclaimed", async () => {
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
    controllerReleaseMs: 10,
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const client = "11111111-1111-4111-8111-111111111111";
  const controller = new AbortController();
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`, { headers: { "x-pi-chat-client": client } })).status, 200);
    const events = fetch(`${origin}/api/events`, { headers: { "x-pi-chat-client": client }, signal: controller.signal }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/view`, { headers: { "x-pi-chat-client": client } })).status, 200);
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/activate`, { method: "POST", headers: { "x-pi-chat-client": client } })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(secondary.stopCount, 1);
    const history = await fetch(`${origin}/api/sessions/${idB}/view`, { headers: { "x-pi-chat-client": client } });
    assert.equal(history.status, 200);
    assert.equal((await history.json() as { runtimeStatus?: string }).runtimeStatus, "view-only");
    controller.abort();
    await events;
  } finally {
    controller.abort();
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
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/activate`, { method: "POST" })).status, 200);
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
