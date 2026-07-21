import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiChatApp } from "../src/server/app";
import type { PiRpcClient } from "../src/server/rpc-client";
import type { ResourceManager } from "../src/server/resource-manager";
import { SessionIndex, idForPath } from "../src/server/session-index";

class SessionWorker {
  commands: Record<string, unknown>[] = [];
  stopped = false;
  constructor(private readonly path: string) {}
  onEvent() { return () => {}; }
  async start() {}
  async stop() { this.stopped = true; }
  async send(command: Record<string, unknown>) {
    this.commands.push(command);
    if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: this.path, sessionId: "history", isStreaming: false } };
    if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [] } };
    if (command.type === "get_available_models") return { type: "response", success: true, data: { models: [] } };
    if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [] } };
    if (command.type === "get_session_stats") return { type: "response", success: true, data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    if (command.type === "set_session_name") {
      await appendFile(this.path, `${JSON.stringify({ type: "session_info", id: "rename", parentId: "m1", name: command.name })}\n`);
      return { type: "response", success: true };
    }
    throw new Error(`Unexpected command: ${String(command.type)}`);
  }
}

test("empty draft stays out of the sidebar and is reclaimed when another New replaces it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-empty-draft-delete-"));
  try {
    const primaryPath = join(root, "primary.jsonl");
    const draftPath = join(root, "draft.jsonl");
    const primaryId = idForPath(primaryPath);
    const draftId = idForPath(draftPath);
    const primary = new SessionWorker(primaryPath) as unknown as PiRpcClient;
    const draft = new SessionWorker(draftPath);
    const sessions = {
      list: async () => [{ id: primaryId, sessionId: "primary", name: "Saved", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
      pathForId: (id: string) => id === primaryId ? primaryPath : null,
      messagesForId: async () => [],
    } as unknown as SessionIndex;
    const app = new PiChatApp({ rpc: primary, createRpc: () => draft as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
    const server = createServer((request, response) => void app.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const created = await (await fetch(`${origin}/api/sessions/new`, { method: "POST" })).json() as { session: { id: string } };
      assert.equal(created.session.id, draftId);
      const sidebar = await (await fetch(`${origin}/api/sessions`)).json() as { sessions: Array<{ id: string; messageCount: number }> };
      assert.equal(sidebar.sessions.some((session) => session.id === draftId), false);
      const renamed = await fetch(`${origin}/api/sessions/${draftId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Should not save" }) });
      assert.equal(renamed.status, 500);
      const after = await (await fetch(`${origin}/api/sessions`)).json() as { sessions: Array<{ id: string }> };
      assert.equal(after.sessions.some((session) => session.id === draftId), false);
    } finally {
      server.close();
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session rename uses Pi RPC and delete stops the worker before removing JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-session-management-"));
  try {
    const historyPath = join(root, "history.jsonl");
    await writeFile(historyPath, [
      { type: "session", id: "history", cwd: process.cwd() },
      { type: "message", id: "m1", parentId: null, message: { role: "user", content: "question" } },
    ].map(JSON.stringify).join("\n") + "\n");
    const historyId = idForPath(historyPath);
    const primary = {
      onEvent: () => () => {},
      send: async (command: Record<string, unknown>) => {
        if (command.type === "get_state") return { type: "response", success: true, data: { model: null, sessionFile: join(root, "primary.jsonl"), sessionId: "primary", isStreaming: false } };
        if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [] } };
        if (command.type === "get_available_models") return { type: "response", success: true, data: { models: [] } };
        if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [] } };
        if (command.type === "get_session_stats") return { type: "response", success: true, data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        throw new Error(`Unexpected primary command: ${String(command.type)}`);
      },
    } as unknown as PiRpcClient;
    const worker = new SessionWorker(historyPath);
    const app = new PiChatApp({
      rpc: primary,
      createRpc: () => worker as unknown as PiRpcClient,
      sessions: new SessionIndex(root, join(root, "cache.json")),
      resources: {} as ResourceManager,
      cwd: process.cwd(),
      webRoot: process.cwd(),
    });
    const server = createServer((request, response) => void app.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const invalid = await fetch(`${origin}/api/sessions/${historyId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "   " }) });
      assert.equal(invalid.status, 400);
      const renamed = await fetch(`${origin}/api/sessions/${historyId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Renamed session" }) });
      assert.equal(renamed.status, 200);
      assert.equal(worker.commands.some((command) => command.type === "set_session_name" && command.name === "Renamed session"), true);
      const deleted = await fetch(`${origin}/api/sessions/${historyId}`, { method: "DELETE" });
      assert.equal(deleted.status, 200);
      assert.equal(worker.stopped, true);
      assert.equal(existsSync(historyPath), false);
    } finally {
      server.close();
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
