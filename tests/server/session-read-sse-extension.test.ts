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
    const pinned = await (
      await fetch(`${origin}/api/sessions?include=bad,${activeId},${activeId}`)
    ).json() as { sessions: Array<{ id: string }>; total: number };
    assert.equal(pinned.total, 25);
    assert.equal(pinned.sessions.length, 16);
    assert.equal(
      pinned.sessions.filter((session) => session.id === activeId).length,
      1,
      "a bounded pin request unions an older Session into the base page exactly once",
    );
    const prefixQuery = new URLSearchParams({
      cwd: process.cwd(),
      offset: "0",
      limit: "30",
    });
    const prefix = await (
      await fetch(`${origin}/api/sessions?${prefixQuery}`)
    ).json() as { sessions: Array<{ id: string }>; total: number };
    assert.equal(prefix.total, 25);
    assert.equal(
      prefix.sessions.length,
      25,
      "directory reads may return a cumulative prefix larger than one 15-row page",
    );
    const all = await (await fetch(`${origin}/api/sessions?all=1`)).json() as { sessions: Array<{ id: string }>; total: number };
    assert.equal(all.total, 25);
    assert.equal(all.sessions.length, 25);
    assert.equal(all.sessions.some((session) => session.id === activeId), true);
  } finally {
    server.close();
    await app.close();
  }
});

test("missing-cwd directory pagination uses the empty persisted key instead of the UI sentinel", async () => {
  const path = "C:\\sessions\\unknown-cwd-primary.jsonl";
  const primary = new FakeRpc(path, "unknown-cwd-primary");
  const summaries = Array.from({ length: 25 }, (_, index) => ({
    id: (index + 300).toString(16).padStart(20, "0"),
    sessionId: `unknown-cwd-${index}`,
    name: `Unknown cwd ${index}`,
    preview: "",
    cwd: "",
    updatedAt: 100 - index,
    messageCount: 1,
    active: false,
  }));
  const sessions = {
    list: async () => summaries,
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) =>
    void app.handle(request, response),
  );
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const base = await (await fetch(`${origin}/api/sessions`)).json() as {
      sessions: unknown[];
      directories: Array<{ cwd: string; count: number }>;
    };
    assert.equal(base.sessions.length, 15);
    assert.deepEqual(base.directories, [
      { cwd: "", count: 25, lastUserPromptAt: 100 },
    ]);
    const prefix = await (
      await fetch(`${origin}/api/sessions?cwd=&offset=0&limit=30`)
    ).json() as { sessions: unknown[]; total: number };
    assert.equal(prefix.total, 25);
    assert.equal(prefix.sessions.length, 25);
  } finally {
    server.close();
    await app.close();
  }
});

test("an explicit fresh Session inventory awaits the current JSONL index on the first click", async () => {
  const path = "C:\\sessions\\fresh-primary.jsonl";
  const primary = new FakeRpc(path, "fresh-primary");
  const stale = {
    id: "11111111111111111111",
    sessionId: "stale",
    name: "Stale cached Session",
    preview: "",
    cwd: process.cwd(),
    updatedAt: 1,
    messageCount: 1,
    active: false,
  };
  const fresh = {
    ...stale,
    id: "22222222222222222222",
    sessionId: "fresh",
    name: "Fresh indexed Session",
  };
  let cachedCalls = 0;
  let freshCalls = 0;
  const sessions = {
    listCached: async () => {
      cachedCalls += 1;
      return [stale];
    },
    list: async () => {
      freshCalls += 1;
      return [fresh];
    },
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) =>
    void app.handle(request, response),
  );
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const cached = await (await fetch(`${origin}/api/sessions`)).json() as {
      sessions: Array<{ name: string }>;
    };
    assert.deepEqual(cached.sessions.map((session) => session.name), [
      "Stale cached Session",
    ]);
    assert.equal(cachedCalls, 1);
    assert.equal(freshCalls, 0);

    const current = await (
      await fetch(`${origin}/api/sessions?all=1&fresh=1`)
    ).json() as { sessions: Array<{ name: string }> };
    assert.deepEqual(current.sessions.map((session) => session.name), [
      "Fresh indexed Session",
    ]);
    assert.equal(freshCalls, 1);
    assert.equal(
      primary.commands.length,
      0,
      "fresh inventory remains a JSONL-only read and never probes the Runtime",
    );
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
    assert.deepEqual(result.messages, [{ ...persisted[0], piChatPersistedMessageId: "1:0" }]);
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
    primary.emit({
      type: "message_end",
      message: { role: "assistant", content: [], timestamp: 2, secret: "drop me" },
      requestToken: "drop me",
    });
    primary.emit({ type: "agent_settled" });
    primary.emit({ type: "agent_start" });
    primary.emit({ type: "message_end", message: { role: "assistant", content: "second answer", timestamp: 3 } });
    const ownerBeforeMalformed = app as unknown as {
      primaryPendingTerminalMessages: unknown[];
      liveMessage?: unknown;
      runGenerationsBySession: Map<string, number>;
    };
    const pendingBeforeMalformed = ownerBeforeMalformed.primaryPendingTerminalMessages;
    const liveBeforeMalformed = ownerBeforeMalformed.liveMessage;
    const generationBeforeMalformed = ownerBeforeMalformed.runGenerationsBySession.values().next().value;
    primary.emit({ type: "message_end", message: { content: "malformed" } });
    primary.emit({ type: "message_end", message: { role: "evil", content: "unknown role" } });
    assert.strictEqual(ownerBeforeMalformed.primaryPendingTerminalMessages, pendingBeforeMalformed);
    assert.strictEqual(ownerBeforeMalformed.liveMessage, liveBeforeMalformed);
    assert.equal(ownerBeforeMalformed.runGenerationsBySession.values().next().value, generationBeforeMalformed);
    const updates = frames.filter((frame) => frame.includes('"type":"message_update"'));
    const terminals = frames.filter((frame) => frame.includes('"type":"message_end"'));
    assert.match(terminals[0] || "", /"content":"cumulative answer"/);
    assert.match(terminals[0] || "", /"piChatSessionId"/);
    assert.match(terminals[0] || "", /"piChatRunEpoch":"[A-Za-z0-9_-]+"/);
    assert.match(terminals[0] || "", /"piChatRunGeneration":1/);
    assert.match(terminals[1] || "", /"piChatRunGeneration":2/);
    assert.equal(terminals.length, 2, "malformed known terminal events fail closed");
    const firstPayload = JSON.parse((terminals[0].split("data: ")[1] || "{}").trim()) as Record<string, unknown>;
    const secondPayload = JSON.parse((terminals[1].split("data: ")[1] || "{}").trim()) as Record<string, unknown>;
    assert.equal(firstPayload.piChatEventSchema, 1);
    assert.equal(firstPayload.terminalKind, "assistant");
    const updatePayload = JSON.parse((updates[0]?.split("data: ")[1] || "{}").trim()) as Record<string, unknown>;
    const firstLiveId = (firstPayload.message as { piChatLiveMessageId?: unknown }).piChatLiveMessageId;
    const updateLiveId = (updatePayload.message as { piChatLiveMessageId?: unknown } | undefined)?.piChatLiveMessageId;
    const secondLiveId = (secondPayload.message as { piChatLiveMessageId?: unknown }).piChatLiveMessageId;
    assert.equal(typeof firstLiveId, "string");
    assert.equal(typeof secondLiveId, "string");
    assert.equal(updateLiveId, firstLiveId, "cumulative update and terminal share one live identity");
    assert.notEqual(firstLiveId, secondLiveId, "each assistant lifecycle receives a new server identity");
    assert.equal(JSON.stringify(firstPayload).includes("drop me"), false);
    assert.ok((app as unknown as {
      stateDiagnostics: { snapshot(): { entries: Array<{ category: string; name: string; details: Record<string, unknown> }> } };
    }).stateDiagnostics.snapshot().entries.some((entry) =>
      entry.category === "rpc-event"
      && entry.name === "rejected"
      && entry.details.decisionReason === "malformed-critical-event"
    ));
  } finally {
    clients.clear();
    await app.close();
  }
});

test("delta-only assistant RPC events reach SSE as cumulative live snapshots", async () => {
  const path = "C:\\sessions\\primary-delta-stream.jsonl";
  const primary = new FakeRpc(path, "primary-delta-stream");
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const frames: string[] = [];
  const clients = (app as unknown as { sseClients: Map<{ write: (frame: string) => boolean }, string> }).sseClients;
  clients.set({ write: (frame) => { frames.push(frame); return true; } }, "11111111-1111-4111-8111-111111111111");
  try {
    await (app as unknown as { ensurePrimaryIdentity(): Promise<void> }).ensurePrimaryIdentity();
    primary.emit({ type: "agent_start" });
    primary.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    primary.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    primary.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "连续" },
    });
    primary.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "吐字" },
    });
    primary.emit({ type: "message_end", message: { role: "assistant", content: [] } });

    const payloads = frames
      .filter((frame) => frame.includes('"type":"message_update"'))
      .map((frame) => JSON.parse((frame.split("data: ")[1] || "{}").trim()) as {
        message?: { role?: string; content?: unknown; piChatLiveMessageId?: string };
      });
    assert.ok(payloads.length >= 1);
    const latest = payloads.at(-1)?.message;
    assert.equal(latest?.role, "assistant");
    assert.deepEqual(latest?.content, [{ type: "text", text: "连续吐字" }]);
    assert.equal(typeof latest?.piChatLiveMessageId, "string");
    const terminal = frames
      .filter((frame) => frame.includes('"type":"message_end"'))
      .map((frame) => JSON.parse((frame.split("data: ")[1] || "{}").trim()) as {
        message?: { content?: unknown; piChatLiveMessageId?: string };
      })
      .at(-1)?.message;
    assert.deepEqual(terminal?.content, [{ type: "text", text: "连续吐字" }]);
    assert.equal(terminal?.piChatLiveMessageId, latest?.piChatLiveMessageId);
  } finally {
    clients.clear();
    await app.close();
  }
});

test("malformed Secondary terminals do not mutate owner state or LRU recency", async () => {
  const primaryPath = "C:\\sessions\\primary-terminal-owner.jsonl";
  const secondaryPath = "C:\\sessions\\secondary-terminal-owner.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "primary-terminal-owner");
  const secondary = new FakeRpc(secondaryPath, "secondary-terminal-owner");
  let now = 1_000;
  const summaries = [
    { id: primaryId, sessionId: "primary-terminal-owner", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "secondary-terminal-owner", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === primaryId ? primaryPath : candidate === secondaryId ? secondaryPath : null,
    summaryForId: (candidate: string) => summaries.find((summary) => summary.id === candidate) || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => secondary as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    now: () => now,
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/sessions/${secondaryId}/warm`, { method: "POST" })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const internals = app as unknown as {
      runtimePool: { get(id: string): {
        lastUsedAt: number;
        liveMessage?: unknown;
        pendingTerminalMessages: unknown[];
      } | undefined };
      runGenerationsBySession: Map<string, number>;
    };
    const runtime = internals.runtimePool.get(secondaryId)!;
    runtime.liveMessage = { role: "assistant", content: "pending" };
    runtime.pendingTerminalMessages = [{ role: "assistant", content: "existing" }];
    internals.runGenerationsBySession.set(secondaryId, 4);
    const pendingBefore = runtime.pendingTerminalMessages;
    const liveBefore = runtime.liveMessage;
    const lastUsedBefore = runtime.lastUsedAt;
    now = 2_000;
    secondary.emit({ type: "message_end", message: { content: "missing role" } });
    assert.strictEqual(runtime.pendingTerminalMessages, pendingBefore);
    assert.strictEqual(runtime.liveMessage, liveBefore);
    assert.equal(runtime.lastUsedAt, lastUsedBefore);
    assert.equal(internals.runGenerationsBySession.get(secondaryId), 4);
  } finally {
    server.close();
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
    assert.equal((app as unknown as {
      stateDiagnostics: { snapshot(): { promptEvidence: { records: unknown[] } } };
    }).stateDiagnostics.snapshot().promptEvidence.records.length, 0);
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
