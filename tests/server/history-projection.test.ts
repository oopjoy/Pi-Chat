import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import { sessionViewFromCurrentProjection, type SessionHotViewPorts } from "../../src/server/services/session-hot-view";
import { projectHotMemoryView, type HotMemoryViewProjectionHost } from "../../src/server/services/session-view-projection";
import { SessionIndex, idForPath } from "../../src/server/session-index";
import type { PiRpcClient } from "../../src/server/rpc-client";
import type { ResourceManager } from "../../src/server/resource-manager";
import { FakeRpc } from "../helpers/server-app-fixture";

const host: HotMemoryViewProjectionHost = {
  modelFromSettings: () => null, sessionActivity: () => ({ execution: "idle", awaitingConfirmation: false }),
  offlineStats: () => undefined, currentGateMode: () => "strict", pendingRequest: () => undefined,
  controlState: () => ({}), touch: () => {}, reconcilePendingPrompts: () => {}, pendingPrompt: () => undefined,
  pendingSteers: () => ({ items: [], revision: 0 }), stateWithPendingPromptSettings: (_id, state) => state,
  stateWithFastMode: (_id, state) => state,
};

test("a hot one-turn suffix cannot claim that an 88-turn Session has no older history", () => {
  const view = projectHotMemoryView(host, {
    id: "session", turnLimit: 10, clientId: "", primary: false,
    source: {
      summary: { id: "session", sessionId: "native", name: "Large history", cwd: "", preview: "", updatedAt: 1, active: true, messageCount: 1539, turnCount: 88 },
      persisted: [{ role: "user", content: "latest", piChatPersistedMessageId: "last-user:0" }],
      terminalTail: [{ role: "assistant", content: "answer", piChatLiveMessageId: "live" }],
      state: { model: null, isStreaming: false }, streaming: false, queue: [], queuePaused: false,
      gateMode: "strict", historyPending: false, reconcilePending: false,
    },
  });
  assert.equal(view.messagesTruncated, true);
  assert.equal(view.visibleTurnCount, 1);
  assert.equal(view.turnTotal, 88);
  assert.equal(view.messageTotal, 1539);
  assert.equal(view.historyPending, true);
});

test("idle hot views use bounded snapshots and preserve their full-history metadata", async () => {
  const id = "session";
  const summary = { id, sessionId: "native", name: "Large", cwd: "", preview: "", updatedAt: 1, active: true, messageCount: 1539, turnCount: 88 };
  const messages = [{ role: "user", content: "latest", piChatPersistedMessageId: "last:0" }];
  let recentReads = 0;
  const ports: SessionHotViewPorts = {
    index: {
      summaryForId: () => summary,
      recentSnapshotForId: async () => { recentReads++; return { messages, settings: {}, usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, context: null }, usageComplete: false, sourceMessagesTruncated: true, sourceMessageTotal: 6302, sourceTurnTotal: 333 }; },
      snapshotForId: async () => { throw new Error("unbounded snapshot must not be read"); },
      messagesForId: async () => { throw new Error("unbounded messages must not be read"); },
    } as unknown as SessionIndex,
    primaryRpc: { currentGeneration: () => 1, send: async () => ({ data: { commands: [] } }) } as unknown as PiRpcClient,
    activeSessionId: id, activeSessionPath: "C:/fixture/large.jsonl", primaryRpcGeneration: 1, applicationLifecycle: "idle", currentCwd: "",
    secondaryForId: () => undefined, touchSecondary: () => {}, now: () => 1,
    lastPrimaryState: { model: null, isStreaming: false }, lastPrimaryMessages: [], lastPrimaryMessagesSessionId: id,
    primarySummarySnapshot: summary, primaryPendingTerminalSessionId: id, primaryPendingTerminalMessages: [],
    builtinCommands: [], lastPrimaryCommands: [], primaryGateMode: "strict", running: false, toolStatus: "", queuePaused: false,
    primaryTurnActive: () => false, runtimeTurnActive: () => false, primaryReadReady: () => true, bindPrimaryIdentity: () => {},
    coldSessionViewForId: async () => null, coldSessionView: async () => null,
    sessionSummaries: sessions => sessions, reconcilePendingAcceptedPrompts: () => {}, pendingPromptForSession: () => undefined,
    pendingSteerProjection: () => ({ items: [], revision: 0 }), statsForSession: async () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }), offlineStatsForId: async () => undefined,
    stateWithFastMode: (_id, state) => state, stateWithPendingPromptSettings: (_id, state) => state,
    sessionActivity: host.sessionActivity, controlState: () => ({}), publicQueue: () => [], pendingRequestForSession: () => undefined,
  };
  const view = await sessionViewFromCurrentProjection(ports, id, 10);
  assert.equal(recentReads, 1);
  assert.equal(view?.turnTotal, 333);
  assert.equal(view?.messageTotal, 6302);
  assert.equal(view?.messagesTruncated, true);
  assert.equal(view?.visibleTurnCount, 1);
});

test("older history GET stays guarded and reads disk without any Runtime command", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-history-route-"));
  const path = join(root, "history.jsonl");
  const id = idForPath(path);
  await writeFile(path, [
    { type: "session", id: "native", version: 3, cwd: root },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "older", timestamp: 10 } },
    { type: "session_info", id: "info", parentId: "u1", name: "History" },
    { type: "message", id: "u2", parentId: "info", message: { role: "user", content: "newer" } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const index = new SessionIndex(root);
  await index.list();
  const rpc = new FakeRpc("C:/different-primary.jsonl", "primary");
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions: index, resources: {} as ResourceManager, cwd: root, webRoot: root });
  const server = createServer((request, response) => { void app.handle(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  app.setAllowedHosts([new URL(origin).host]);
  try {
    const projection = app as unknown as {
      recordAcceptedPrompt(id: string, promptId: string, at: number, text: string, images: []): void;
      pendingPromptForSession(id: string): unknown;
    };
    projection.recordAcceptedPrompt(id, "previous-prompt", 1, "older", []);
    const endpoint = `${origin}/api/sessions/${id}/history?before=u2%3A0`;
    assert.equal((await fetch(endpoint)).status, 403);
    const handshake = await fetch(origin + "/api/bootstrap/handshake").then(response => response.json());
    const headers = { origin, "x-pi-chat-token": handshake.requestToken };
    assert.equal((await fetch(endpoint, { headers: { ...headers, origin: "https://evil.invalid" } })).status, 403);
    const response = await fetch(endpoint, { headers });
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.deepEqual(page.messages.map((message: { piChatPersistedMessageId: string }) => message.piChatPersistedMessageId), ["u1:0"]);
    assert.equal(page.messagesTruncated, false);
    assert.equal(page.messages[0].piChatPromptId, "previous-prompt");
    assert.equal(projection.pendingPromptForSession(id), undefined);
    assert.equal((await fetch(endpoint, { headers, method: "POST" })).status, 405);
    assert.equal((await fetch(`${origin}/api/sessions/${id}/history?before=../escape`, { headers })).status, 400);
    assert.equal(rpc.commands.length, 0);
  } finally { server.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});
