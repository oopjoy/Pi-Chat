import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiChatApp } from "../src/server/app";
import { ModelManager } from "../src/server/model-manager";
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

test("cold history shows its own last model and thinking without starting a Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-cold-settings-"));
  try {
    const primaryPath = join(root, "primary.jsonl");
    const coldPath = join(root, "cold.jsonl");
    const primary = new SessionWorker(primaryPath) as unknown as PiRpcClient;
    await writeFile(primaryPath, [
      { type: "session", id: "primary", cwd: process.cwd() },
      { type: "message", id: "p1", message: { role: "user", content: "primary" } },
    ].map(JSON.stringify).join("\n"));
    await writeFile(coldPath, [
      { type: "session", id: "cold", cwd: process.cwd() },
      { type: "model_change", id: "m1", parentId: null, provider: "saved", modelId: "history-model" },
      { type: "thinking_level_change", id: "t1", parentId: "m1", thinkingLevel: "high" },
      { type: "message", id: "u1", parentId: "t1", message: { role: "user", content: "cold history" } },
    ].map(JSON.stringify).join("\n"));
    const sessions = new SessionIndex(root, join(root, "cache.json"));
    const app = new PiChatApp({ rpc: primary, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
    const server = createServer((request, response) => void app.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      await fetch(`${origin}/api/bootstrap`);
      const coldId = idForPath(coldPath);
      const response = await fetch(`${origin}/api/sessions/${coldId}/view`);
      assert.equal(response.status, 200);
      const view = await response.json() as { runtimeStatus: string; state: { model: { provider: string; id: string; name: string } | null; thinkingLevel?: string } };
      assert.equal(view.runtimeStatus, "view-only");
      assert.deepEqual(view.state.model, { provider: "saved", id: "history-model", name: "history-model" });
      assert.equal(view.state.thinkingLevel, "high");
      assert.equal((app as unknown as { runtimes: Map<string, unknown> }).runtimes.has(coldId), false);
    } finally {
      server.close();
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty draft stays out of the sidebar and is reclaimed when another New replaces it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-empty-draft-delete-"));
  try {
    const primaryPath = join(root, "primary.jsonl");
    const draftPath = join(root, "draft.jsonl");
    const primaryId = idForPath(primaryPath);
    const draftId = idForPath(draftPath);
    const primary = new SessionWorker(primaryPath) as unknown as PiRpcClient;
    const draft = new SessionWorker(draftPath);
    let createCount = 0;
    const sessions = {
      list: async () => [{ id: primaryId, sessionId: "primary", name: "Saved", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
      pathForId: (id: string) => id === primaryId ? primaryPath : null,
      messagesForId: async () => [],
    } as unknown as SessionIndex;
    const app = new PiChatApp({
      rpc: primary,
      createRpc: () => {
        createCount += 1;
        return draft as unknown as PiRpcClient;
      },
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
    try {
      const created = await (await fetch(`${origin}/api/sessions/new`, { method: "POST" })).json() as { session: { id: string }; messages: unknown[] };
      assert.equal(created.session.id, draftId);
      assert.deepEqual(created.messages, []);
      // Second New reuses the same idle empty draft worker (no second spawn).
      const again = await (await fetch(`${origin}/api/sessions/new`, { method: "POST" })).json() as { session: { id: string } };
      assert.equal(again.session.id, draftId);
      assert.equal(createCount, 1);
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

test("a prompted New draft appears in the sidebar before agent_settled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-prompted-sidebar-immediate-"));
  try {
    class StreamingOnlyWorker extends SessionWorker {
      private readonly filePath: string;
      constructor(path: string) {
        super(path);
        this.filePath = path;
      }
      override async send(command: Record<string, unknown>) {
        // Intentionally keep the JSONL empty and get_messages empty until settle.
        // The sidebar must still inject the prompted draft immediately.
        if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [] } };
        if (command.type === "prompt") {
          await writeFile(this.filePath, `${JSON.stringify({ type: "session", id: "streaming", cwd: process.cwd() })}\n`);
          return { type: "response", success: true };
        }
        if (command.type === "get_state") {
          return { type: "response", success: true, data: { model: null, sessionFile: this.filePath, sessionId: "streaming", isStreaming: true } };
        }
        return super.send(command);
      }
    }
    const primaryPath = join(root, "primary.jsonl");
    const draftPath = join(root, "draft.jsonl");
    const primary = new SessionWorker(primaryPath) as unknown as PiRpcClient;
    const app = new PiChatApp({
      rpc: primary,
      createRpc: () => new StreamingOnlyWorker(draftPath) as unknown as PiRpcClient,
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
    const client = "11111111-1111-4111-8111-111111111111";
    try {
      const created = await (await fetch(`${origin}/api/sessions/new`, { method: "POST", headers: { "x-pi-chat-client": client } })).json() as { session: { id: string } };
      const draftId = created.session.id;
      assert.equal(draftId, idForPath(draftPath));
      const before = await (await fetch(`${origin}/api/sessions`)).json() as { sessions: Array<{ id: string }> };
      assert.equal(before.sessions.some((session) => session.id === draftId), false);
      const prompted = await fetch(`${origin}/api/chat/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-chat-client": client },
        body: JSON.stringify({ message: "hello while streaming", sessionId: draftId }),
      });
      assert.equal(prompted.status, 202);
      const after = await (await fetch(`${origin}/api/sessions`)).json() as { sessions: Array<{ id: string; running?: boolean }> };
      const row = after.sessions.find((session) => session.id === draftId);
      assert.ok(row, "prompted draft should appear in sidebar before JSONL has messages");
      assert.equal(row.running, true);
    } finally {
      server.close();
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a prompted New draft survives the next New and remains deletable by worker path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-prompted-draft-survives-"));
  try {
    class PromptDraftWorker extends SessionWorker {
      private hasMessage = false;
      private readonly listeners = new Set<(event: Record<string, unknown>) => void>();
      private readonly filePath: string;
      constructor(path: string) {
        super(path);
        this.filePath = path;
      }
      override onEvent(listener: (event: Record<string, unknown>) => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }
      private emit(event: Record<string, unknown>) {
        for (const listener of this.listeners) listener(event);
      }
      override async send(command: Record<string, unknown>) {
        if (command.type === "get_messages") {
          return {
            type: "response",
            success: true,
            data: { messages: this.hasMessage ? [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }] : [] },
          };
        }
        if (command.type === "prompt") {
          this.hasMessage = true;
          await writeFile(this.filePath, [
            { type: "session", id: "prompted", cwd: process.cwd() },
            { type: "message", id: "m1", parentId: null, message: { role: "user", content: "hello" } },
          ].map(JSON.stringify).join("\n") + "\n");
          queueMicrotask(() => {
            this.emit({ type: "agent_start" });
            this.emit({ type: "message_start", message: { role: "assistant", content: "hi" } });
            this.emit({ type: "agent_settled" });
          });
          return { type: "response", success: true };
        }
        return super.send(command);
      }
    }
    const primaryPath = join(root, "primary.jsonl");
    const firstPath = join(root, "first.jsonl");
    const secondPath = join(root, "second.jsonl");
    const workers = [new PromptDraftWorker(firstPath), new PromptDraftWorker(secondPath)];
    const primary = new SessionWorker(primaryPath) as unknown as PiRpcClient;
    const sessions = new SessionIndex(root, join(root, "cache.json"));
    const app = new PiChatApp({
      rpc: primary,
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
    const client = "11111111-1111-4111-8111-111111111111";
    try {
      const firstView = await (await fetch(`${origin}/api/sessions/new`, { method: "POST", headers: { "x-pi-chat-client": client } })).json() as { session: { id: string } };
      assert.equal(firstView.session.id, idForPath(firstPath));
      const prompted = await fetch(`${origin}/api/chat/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-chat-client": client },
        body: JSON.stringify({ message: "hello", sessionId: firstView.session.id }),
      });
      assert.equal(prompted.status, 202);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const secondView = await (await fetch(`${origin}/api/sessions/new`, { method: "POST", headers: { "x-pi-chat-client": client } })).json() as { session: { id: string } };
      assert.equal(secondView.session.id, idForPath(secondPath));
      assert.notEqual(secondView.session.id, firstView.session.id);
      assert.equal(existsSync(firstPath), true);
      let listed = false;
      for (let attempt = 0; attempt < 20 && !listed; attempt += 1) {
        const sidebar = await (await fetch(`${origin}/api/sessions`)).json() as { sessions: Array<{ id: string }> };
        listed = sidebar.sessions.some((session) => session.id === firstView.session.id);
        if (!listed) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(listed, true);
      const deleted = await fetch(`${origin}/api/sessions/${firstView.session.id}`, { method: "DELETE", headers: { "x-pi-chat-client": client } });
      assert.equal(deleted.status, 200);
      assert.equal(existsSync(firstPath), false);
    } finally {
      server.close();
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an Extension command commits a draft before the next New", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-extension-draft-"));
  try {
    class ExtensionDraftWorker extends SessionWorker {
      private hasMessage = false;
      override async send(command: Record<string, unknown>) {
        if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [{ name: "gate", source: "extension" }] } };
        if (command.type === "get_messages") return { type: "response", success: true, data: { messages: this.hasMessage ? [{ role: "user", content: "/gate open" }] : [] } };
        if (command.type === "prompt") { this.hasMessage = true; return { type: "response", success: true }; }
        return super.send(command);
      }
    }
    const primaryPath = join(root, "primary.jsonl");
    const firstPath = join(root, "first.jsonl");
    const secondPath = join(root, "second.jsonl");
    const workers = [new ExtensionDraftWorker(firstPath), new ExtensionDraftWorker(secondPath)];
    const primary = new SessionWorker(primaryPath) as unknown as PiRpcClient;
    const sessions = {
      list: async () => [{ id: idForPath(primaryPath), sessionId: "primary", name: "Saved", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
      pathForId: () => null,
      messagesForId: async () => [],
    } as unknown as SessionIndex;
    const app = new PiChatApp({ rpc: primary, createRpc: () => workers.shift() as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
    const server = createServer((request, response) => void app.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const client = "11111111-1111-4111-8111-111111111111";
    try {
      const first = await (await fetch(`${origin}/api/sessions/new`, { method: "POST", headers: { "x-pi-chat-client": client } })).json() as { session: { id: string } };
      const command = await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json", "x-pi-chat-client": client }, body: JSON.stringify({ message: "/gate open", sessionId: first.session.id }) });
      assert.equal(command.status, 202);
      assert.equal((await command.json() as { extension?: boolean }).extension, true);
      const next = await (await fetch(`${origin}/api/sessions/new`, { method: "POST", headers: { "x-pi-chat-client": client } })).json() as { session: { id: string } };
      assert.equal(first.session.id, idForPath(firstPath));
      assert.equal(next.session.id, idForPath(secondPath));
    } finally {
      server.close();
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("different browser windows never share the same empty New draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-window-drafts-"));
  try {
    const primaryPath = join(root, "primary.jsonl");
    const draftAPath = join(root, "draft-a.jsonl");
    const draftBPath = join(root, "draft-b.jsonl");
    const workers = [new SessionWorker(draftAPath), new SessionWorker(draftBPath)];
    const primary = new SessionWorker(primaryPath) as unknown as PiRpcClient;
    const sessions = {
      list: async () => [{ id: idForPath(primaryPath), sessionId: "primary", name: "Saved", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
      pathForId: () => null,
      messagesForId: async () => [],
    } as unknown as SessionIndex;
    const app = new PiChatApp({ rpc: primary, createRpc: () => workers.shift() as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
    const server = createServer((request, response) => void app.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const first = await (await fetch(`${origin}/api/sessions/new`, { method: "POST", headers: { "x-pi-chat-client": "11111111-1111-4111-8111-111111111111" } })).json() as { session: { id: string } };
      const second = await (await fetch(`${origin}/api/sessions/new`, { method: "POST", headers: { "x-pi-chat-client": "22222222-2222-4222-8222-222222222222" } })).json() as { session: { id: string } };
      assert.equal(first.session.id, idForPath(draftAPath));
      assert.equal(second.session.id, idForPath(draftBPath));
      assert.notEqual(first.session.id, second.session.id);
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

test("cold view keeps reasoning/input for a configured catalogue model", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-cold-catalog-"));
  try {
    const primaryPath = join(root, "primary.jsonl");
    const coldPath = join(root, "cold.jsonl");
    const primary = new SessionWorker(primaryPath) as unknown as PiRpcClient;
    await writeFile(join(root, "models.json"), JSON.stringify({
      providers: {
        "cpa-proxy": {
          models: [
            { id: "gpt-5.6-sol", name: "gpt-5.6-sol", reasoning: true, input: ["text", "image"] },
          ],
        },
      },
    }));
    await writeFile(primaryPath, [
      { type: "session", id: "primary", cwd: process.cwd() },
      { type: "message", id: "p1", message: { role: "user", content: "primary" } },
    ].map(JSON.stringify).join("\n"));
    await writeFile(coldPath, [
      { type: "session", id: "cold", cwd: process.cwd() },
      { type: "model_change", id: "m1", parentId: null, provider: "cpa-proxy", modelId: "gpt-5.6-sol" },
      { type: "message", id: "u1", parentId: "m1", message: { role: "user", content: "cold" } },
    ].map(JSON.stringify).join("\n"));
    const sessions = new SessionIndex(root, join(root, "cache.json"));
    const modelManager = new ModelManager(root);
    const app = new PiChatApp({ rpc: primary, sessions, resources: {} as ResourceManager, modelManager, cwd: process.cwd(), webRoot: process.cwd() });
    const server = createServer((request, response) => void app.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      await fetch(`${origin}/api/bootstrap`);
      const coldId = idForPath(coldPath);
      const response = await fetch(`${origin}/api/sessions/${coldId}/view`);
      assert.equal(response.status, 200);
      const view = await response.json() as { runtimeStatus: string; state: { model: { provider: string; id: string; reasoning?: boolean; input?: string[] } | null } };
      assert.equal(view.runtimeStatus, "view-only");
      assert.equal(view.state.model?.provider, "cpa-proxy");
      assert.equal(view.state.model?.id, "gpt-5.6-sol");
      assert.equal(view.state.model?.reasoning, true, "catalogue model keeps its reasoning capability in the cold view");
      assert.deepEqual(view.state.model?.input, ["text", "image"]);
    } finally {
      server.close();
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
