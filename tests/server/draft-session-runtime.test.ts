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
import { FakeRpc, PersistedDraftRpc } from "../helpers/server-app-fixture";

test("New creates an independent draft while the primary Session is running", async () => {
  const primaryPath = "C:\\sessions\\primary.jsonl";
  const draftPath = "C:\\sessions\\draft.jsonl";
  const primaryId = idForPath(primaryPath);
  const draftId = idForPath(draftPath);
  const primary = new FakeRpc(primaryPath, "primary");
  primary.streaming = true;
  const draft = new FakeRpc(draftPath, "draft");
  const sessions = {
    list: async (activePath?: string) => [{ id: primaryId, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: primaryId === idForPath(activePath || primaryPath) }],
    pathForId: (id: string) => id === primaryId ? primaryPath : id === draftId ? draftPath : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => draft as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/api/sessions/new`, { method: "POST" });
    assert.equal(response.status, 200);
    const view = await response.json() as { session: { id: string; name: string }; isStreaming: boolean };
    assert.equal(view.session.id, draftId);
    assert.equal(view.session.name, "新对话");
    assert.equal(view.isStreaming, false);
    assert.equal(primary.commands.some((command) => command.type === "new_session"), false);
    assert.equal(draft.commands.some((command) => command.type === "new_session"), false);
    assert.equal((await fetch(`${origin}/api/sessions`)).status, 200);
  } finally {
    server.close();
    await app.close();
  }
});

test("a prompted draft stays in its selected cwd group before SessionIndex catches up", async () => {
  const selectedCwd = await mkdtemp(join(tmpdir(), "pi-chat-draft-cwd-"));
  const primaryPath = "C:\\sessions\\primary.jsonl";
  const draftPath = join(selectedCwd, "draft.jsonl");
  const primaryId = idForPath(primaryPath);
  const draftId = idForPath(draftPath);
  const primary = new FakeRpc(primaryPath, "primary");
  const draft = new PersistedDraftRpc(draftPath, "draft");
  const sessions = {
    // Deliberately omit the new draft to reproduce the scan-lag window.
    list: async (activePath?: string) => [{ id: primaryId, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: primaryId === idForPath(activePath || primaryPath) }],
    pathForId: (id: string) => id === primaryId ? primaryPath : null,
    summaryForId: () => null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  let createdCwd = "";
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: (cwd) => { createdCwd = cwd; return draft as unknown as PiRpcClient; },
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
  const client = "11111111-1111-4111-8111-111111111111";
  const headers = { "content-type": "application/json", "x-pi-chat-client": client };
  try {
    const created = await fetch(`${origin}/api/sessions/new`, { method: "POST", headers, body: JSON.stringify({ cwd: selectedCwd }) });
    assert.equal(created.status, 200);
    assert.equal((await created.json() as { session: { id: string } }).session.id, draftId);
    assert.equal(createdCwd, selectedCwd);
    const prompted = await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers, body: JSON.stringify({ message: "hello", sessionId: draftId }) });
    assert.equal(prompted.status, 202);
    draft.streaming = false;
    draft.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sidebar = await (await fetch(`${origin}/api/sessions`, { headers })).json() as { sessions: SessionSummary[]; directories: Array<{ cwd: string }> };
    assert.equal(sidebar.sessions.find((session) => session.id === draftId)?.cwd, selectedCwd);
    assert.equal(sidebar.directories.some((directory) => directory.cwd === selectedCwd), true);
  } finally {
    server.close();
    await app.close();
    await rm(selectedCwd, { recursive: true, force: true });
  }
});
