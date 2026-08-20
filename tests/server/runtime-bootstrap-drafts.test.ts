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
import { FakeRpc, GateFakeRpc } from "../helpers/server-app-fixture";

test("warm starts a dedicated Runtime without full-view probes and same-mode Gate is a no-op", async () => {
  const primaryPath = "C:\\sessions\\warm-primary.jsonl";
  const secondaryPath = "C:\\sessions\\warm-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "warm-primary");
  const secondary = new FakeRpc(secondaryPath, "warm-secondary");
  const summaries = [
    { id: primaryId, sessionId: "warm-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "warm-secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    summaryForId: (id: string) => summaries.find((summary) => summary.id === id) || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => secondary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    const warm = await fetch(`${origin}/api/sessions/${secondaryId}/warm`, { method: "POST" });
    assert.equal(warm.status, 200);
    assert.deepEqual(secondary.commands.map((command) => command.type), ["get_state"], "warm must not request history, commands, or stats");

    const prompted = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello", sessionId: secondaryId, gateMode: "strict" }),
    });
    assert.equal(prompted.status, 202);
    assert.equal(secondary.commands.filter((command) => command.type === "prompt" && command.message === "/gate strict").length, 0);
  } finally {
    server.close();
    await app.close();
  }
});

test("an idle known Runtime view never waits for a global Session inventory", async () => {
  const primaryPath = "C:\\sessions\\idle-view-primary.jsonl";
  const secondaryPath = "C:\\sessions\\idle-view-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "idle-view-primary");
  const secondary = new FakeRpc(secondaryPath, "idle-view-secondary");
  const summaries = [
    { id: primaryId, sessionId: "idle-view-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "idle-view-secondary", name: "Secondary", preview: "saved", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  let listCalls = 0;
  let blockInventory = false;
  const sessions = {
    list: async () => {
      listCalls += 1;
      if (blockInventory) return new Promise<SessionSummary[]>(() => undefined);
      return summaries;
    },
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    summaryForId: (id: string) => summaries.find((summary) => summary.id === id) || null,
    messagesForId: async () => [{ role: "user", content: "saved" }],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => secondary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    assert.equal((await fetch(`${origin}/api/sessions/${secondaryId}/warm`, { method: "POST" })).status, 200);
    const callsBeforeView = listCalls;
    blockInventory = true;
    const response = await fetch(`${origin}/api/sessions/${secondaryId}/view`, { signal: AbortSignal.timeout(500) });
    assert.equal(response.status, 200);
    const view = await response.json() as { session: { id: string; active: boolean }; runtimeStatus: string };
    assert.equal(view.session.id, secondaryId);
    assert.equal(view.session.active, true);
    assert.equal(view.runtimeStatus, "active");
    assert.equal(listCalls, callsBeforeView);
  } finally {
    server.close();
    await app.close();
  }
});

test("a running persisted Session retains its indexed sidebar summary while a refresh omits it", async () => {
  const primaryPath = "C:\\sessions\\summary-primary.jsonl";
  const secondaryPath = "C:\\sessions\\summary-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "summary-primary");
  const secondary = new FakeRpc(secondaryPath, "summary-secondary");
  const primarySummary = { id: primaryId, sessionId: "summary-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true };
  const secondarySummary = { id: secondaryId, sessionId: "summary-secondary", name: "Persisted title", preview: "persisted preview", cwd: process.cwd(), updatedAt: 8, messageCount: 24, turnCount: 8, active: false };
  const sessions = {
    // Model the short SessionIndex refresh gap: Runtime activation knows the
    // secondary summary, but the following sidebar list has not republished it.
    list: async () => [primarySummary],
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    summaryForId: (id: string) => id === secondaryId ? secondarySummary : id === primaryId ? primarySummary : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => secondary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    assert.equal((await fetch(`${origin}/api/sessions/${secondaryId}/warm`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "continue", sessionId: secondaryId }),
    })).status, 202);

    const sidebar = await (await fetch(`${origin}/api/sessions`)).json() as { sessions: SessionSummary[] };
    const row = sidebar.sessions.find((session) => session.id === secondaryId);
    assert.ok(row);
    assert.equal(row.name, "Persisted title");
    assert.equal(row.preview, "persisted preview");
    assert.equal(row.messageCount, 24);
    assert.equal(row.turnCount, 8);
  } finally {
    server.close();
    await app.close();
  }
});

test("known cold history returns without waiting for global inventory, usage fallback, or Gate discovery", async () => {
  const primaryPath = "C:\\sessions\\cold-fast-primary.jsonl";
  const coldPath = "C:\\sessions\\cold-fast-target.jsonl";
  const primaryId = idForPath(primaryPath);
  const coldId = idForPath(coldPath);
  const primary = new FakeRpc(primaryPath, "cold-fast-primary");
  const coldSummary = { id: coldId, sessionId: "cold-fast", name: "Cold fast", preview: "saved", cwd: process.cwd(), updatedAt: 1, messageCount: 2, active: false };
  const sessions = {
    summaryForId: (id: string) => id === coldId ? coldSummary : id === primaryId ? { ...coldSummary, id: primaryId, sessionId: "cold-fast-primary", active: true } : null,
    snapshotForId: async (id: string) => id === coldId ? {
      messages: [{ role: "user", content: "saved question" }, { role: "assistant", content: "saved answer" }],
      usage: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, context: null },
      settings: {},
    } : null,
    messagesForId: async () => { throw new Error("target snapshot should satisfy history"); },
    usageForId: async () => new Promise<never>(() => undefined),
    list: async () => new Promise<SessionSummary[]>(() => undefined),
  } as unknown as SessionIndex;
  const resources = {
    systemGateEnabled: async () => new Promise<boolean>(() => undefined),
  } as unknown as ResourceManager;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${coldId}/view`, { signal: AbortSignal.timeout(500) });
    assert.equal(response.status, 200);
    const view = await response.json() as { viewSource: string; runtimeStatus: string; messages: Array<{ content: string }>; gateAvailable: boolean };
    assert.equal(view.viewSource, "cold-jsonl");
    assert.equal(view.runtimeStatus, "view-only");
    assert.deepEqual(view.messages.map((message) => message.content), ["saved question", "saved answer"]);
    assert.equal(view.gateAvailable, true);
  } finally {
    server.close();
    await app.close();
  }
});

test("new-session initial submit accepts a >1 MB image body and performs model, thinking, Gate, and user prompt", async () => {
  const primaryPath = "C:\\sessions\\initial-primary.jsonl";
  const draftPath = "C:\\sessions\\initial-draft.jsonl";
  const primaryId = idForPath(primaryPath);
  const primary = new FakeRpc(primaryPath, "initial-primary");
  const draft = new FakeRpc(draftPath, "initial-draft");
  const sessions = {
    list: async () => [{ id: primaryId, sessionId: "initial-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => primaryPath,
    summaryForId: () => null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => draft as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const imageData = "A".repeat(1_100_000);
  try {
    await fetch(`${origin}/api/bootstrap`);
    const response = await fetch(`${origin}/api/sessions/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initial: {
        message: "first",
        images: [{ type: "image", data: imageData, mimeType: "image/png" }],
        model: { provider: "test", modelId: "next" },
        thinkingLevel: "high",
        gateMode: "open",
      } }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(
      draft.commands.filter((command) => ["set_model", "set_thinking_level", "prompt"].includes(String(command.type))).map((command) => [command.type, command.message]),
      [["set_model", undefined], ["set_thinking_level", undefined], ["prompt", "/gate open"], ["prompt", "first"]],
    );
    const prompt = draft.commands.find((command) => command.type === "prompt" && command.message === "first") as { images?: Array<{ data: string }> } | undefined;
    assert.equal(prompt?.images?.[0]?.data.length, imageData.length);
  } finally {
    server.close();
    await app.close();
  }
});

test("an initial draft prompt timeout stays uncertain and protects the following prompt", async () => {
  const primaryPath = "C:\\sessions\\initial-timeout-primary.jsonl";
  const draftPath = "C:\\sessions\\initial-timeout-draft.jsonl";
  const primaryId = idForPath(primaryPath);
  class InitialPromptTimeoutRpc extends FakeRpc {
    override async send(command: Record<string, unknown>, timeoutMs?: number) {
      if (command.type === "prompt" && command.message === "possibly initial") {
        this.commands.push(command);
        this.streaming = true;
        this.emit({ type: "agent_start" });
        throw new RpcRequestTimeoutError("prompt");
      }
      return super.send(command, timeoutMs);
    }
  }
  const primary = new FakeRpc(primaryPath, "initial-timeout-primary");
  const draft = new InitialPromptTimeoutRpc(draftPath, "initial-timeout-draft");
  const sessions = {
    list: async () => [{ id: primaryId, sessionId: "initial-timeout-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => primaryPath,
    summaryForId: () => null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => draft as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    const initial = await fetch(`${origin}/api/sessions/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initial: { message: "possibly initial" } }),
    });
    assert.equal(initial.status, 202);
    const initialBody = await initial.json() as {
      accepted: boolean;
      queued: boolean;
      deliveryUncertain?: boolean;
      session: { id: string };
    };
    assert.equal(initialBody.deliveryUncertain, true);

    const following = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: initialBody.session.id, message: "must wait" }),
    });
    assert.equal(following.status, 202);
    const followingBody = await following.json() as {
      queued: boolean;
      queue: Array<{ message: string }>;
    };
    assert.equal(followingBody.queued, true);
    assert.deepEqual(followingBody.queue.map((item) => item.message), ["must wait"]);
    assert.deepEqual(
      draft.commands
        .filter((command) => command.type === "prompt")
        .map((command) => command.message),
      ["possibly initial"],
      "the following prompt must not race an initial write Pi may have accepted",
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("a settled first draft retries JSONL visibility before replacing its provisional title", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-draft-title-"));
  const primaryPath = join(root, "primary.jsonl");
  const draftPath = join(root, "draft.jsonl");
  const primaryId = idForPath(primaryPath);
  const draftId = idForPath(draftPath);
  const primary = new FakeRpc(primaryPath, "title-primary");
  const draft = new FakeRpc(draftPath, "title-draft");
  let persisted = false;
  const durableSummary: SessionSummary = {
    id: draftId,
    sessionId: "title-draft",
    name: "durable first prompt",
    preview: "durable first prompt",
    cwd: root,
    updatedAt: 2,
    lastUserPromptAt: 2,
    messageCount: 1,
    turnCount: 1,
    active: false,
  };
  const sessions = {
    list: async () => [
      { id: primaryId, sessionId: "title-primary", name: "Primary", preview: "", cwd: root, updatedAt: 1, messageCount: 1, active: true },
      ...(persisted ? [durableSummary] : []),
    ],
    pathForId: (id: string) => id === primaryId ? primaryPath : persisted && id === draftId ? draftPath : null,
    summaryForId: (id: string) => persisted && id === draftId ? durableSummary : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => draft as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: root, webRoot: root });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/api/sessions/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initial: { message: "durable first prompt" } }),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json() as { session: { name: string } }).session.name, "新对话");

    draft.streaming = false;
    draft.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    persisted = true;
    await writeFile(draftPath, `${JSON.stringify({ type: "message", message: { role: "user", content: "durable first prompt" } })}\n`, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 180));

    const sidebar = await (await fetch(`${origin}/api/sessions`)).json() as { sessions: SessionSummary[] };
    assert.equal(sidebar.sessions.find((session) => session.id === draftId)?.name, "durable first prompt");
    assert.equal((app as unknown as { runtimes: Map<string, { draftSession?: unknown }> }).runtimes.get(draftId)?.draftSession, undefined);
  } finally {
    server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gate modes stay isolated per Runtime and survive Secondary recovery", async () => {
  const primaryPath = "C:\\sessions\\gate-primary.jsonl";
  const secondaryPath = "C:\\sessions\\gate-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new GateFakeRpc(primaryPath, "gate-primary");
  const secondary = new GateFakeRpc(secondaryPath, "gate-secondary");
  const summaries = [
    { id: primaryId, sessionId: "gate-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "gate-secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
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
  const post = (path: string, body: object) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    assert.equal((await post(`/api/sessions/${secondaryId}/activate`, {})).status, 200);
    assert.equal((await post("/api/chat/prompt", { message: "/gate open", sessionId: secondaryId })).status, 202);

    const primaryView = await (await fetch(`${origin}/api/sessions/${primaryId}/view`)).json() as { gateMode?: string };
    const secondaryView = await (await fetch(`${origin}/api/sessions/${secondaryId}/view`)).json() as { gateMode?: string };
    assert.equal(primaryView.gateMode, "strict");
    assert.equal(secondaryView.gateMode, "open");

    secondary.crash();
    assert.equal((await post("/api/chat/prompt", { message: "recover", sessionId: secondaryId })).status, 202);
    const gatePrompts = secondary.commands.filter((command) => command.type === "prompt" && typeof command.message === "string" && command.message.startsWith("/gate "));
    assert.equal(gatePrompts.at(-1)?.message, "/gate open");
    const recoveredView = await (await fetch(`${origin}/api/sessions/${secondaryId}/view`)).json() as { gateMode?: string };
    assert.equal(recoveredView.gateMode, "open");
  } finally {
    server.close();
    await app.close();
  }
});
