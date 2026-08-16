import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BackgroundSubagentSnapshot } from "../src/shared/types";
import { handleSubagentsReadRoute } from "../src/server/routes/subagents-read";
import { PiChatApp } from "../src/server/app";
import { SubagentStatusUnavailableError } from "../src/server/subagent-status-provider";
import type { PiRpcClient } from "../src/server/rpc-client";
import type { ResourceManager } from "../src/server/resource-manager";
import { idForPath, type SessionIndex } from "../src/server/session-index";
import { FakeRpc } from "./helpers/server-app-fixture";

const ID = "0123456789abcdefabcd";
const CHILD_ID = "fedcba9876543210abcd";
const SNAPSHOT: BackgroundSubagentSnapshot = {
  total: 1,
  activeCount: 1,
  attentionCount: 0,
  truncated: false,
  steps: [{ key: "subagent-1", label: "实施子代理 1", status: "running", elapsedMs: 1, updateAgeMs: 2 }],
};

async function fixture(found: boolean | "unavailable" = true) {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    void handleSubagentsReadRoute({
      backgroundSubagents: async (sessionId) => {
        calls.push(sessionId);
        if (found === "unavailable") throw new SubagentStatusUnavailableError();
        return found ? SNAPSHOT : null;
      },
      backgroundSubagentView: async (input) => found === true ? { child: input.childSessionId, turns: input.turns } : null,
    }, request, response, url, "client-a", {
      recentTurns: 10,
      maxTurns: 100,
      turnIncrement: 10,
    }).then((handled) => {
      if (!handled) {
        response.statusCode = 404;
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("background Subagent route is GET-only and returns the safe projection", async () => {
  const target = await fixture();
  try {
    const response = await fetch(`${target.origin}/api/sessions/${ID}/background-subagents`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), SNAPSHOT);
    assert.deepEqual(target.calls, [ID]);
    assert.equal((await fetch(`${target.origin}/api/sessions/${ID}/background-subagents`, { method: "POST" })).status, 405);
  } finally {
    await target.close();
  }
});

test("background Subagent route exposes transient catalog failure as unavailable", async () => {
  const target = await fixture("unavailable");
  try {
    const response = await fetch(`${target.origin}/api/sessions/${ID}/background-subagents`);
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { code?: string }).code, "SUBAGENT_STATUS_UNAVAILABLE");
  } finally {
    await target.close();
  }
});

test("verified background Subagent child history is GET-only and paginated", async () => {
  const target = await fixture();
  try {
    const url = `${target.origin}/api/sessions/${ID}/background-subagents/${CHILD_ID}/view?turns=20`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { child: CHILD_ID, turns: 20 });
    assert.equal((await fetch(url, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${target.origin}/api/sessions/${ID}/background-subagents/${CHILD_ID}/view?turns=11`)).status, 400);
  } finally {
    await target.close();
  }
});

test("background Subagent route fails closed for an unknown Session", async () => {
  const target = await fixture(false);
  try {
    const response = await fetch(`${target.origin}/api/sessions/${ID}/background-subagents`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "会话不存在" });
  } finally {
    await target.close();
  }
});

test("PiChatApp reads an addressed child JSONL without Runtime, control, or sidebar authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-subagent-view-"));
  const parentPath = join(root, "parent.jsonl");
  const childDirectory = join(root, "parent", "abc12345", "run-0");
  const childPath = join(childDirectory, "session.jsonl");
  await mkdir(childDirectory, { recursive: true });
  await writeFile(parentPath, `${JSON.stringify({ type: "session", id: "parent", cwd: root })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "parent" } })}\n`);
  const childContent = [
    { type: "session", id: "child", cwd: root },
    { type: "session_info", name: "subagent-reviewer-child-1" },
    { type: "message", message: { role: "user", content: "inspect" } },
    { type: "message", message: { role: "assistant", content: "child answer" } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(childPath, childContent);
  const parentId = idForPath(parentPath);
  const childId = idForPath(childPath);
  const primary = new FakeRpc(parentPath, "parent");
  let creations = 0;
  const sessions = {
    pathForId: (id: string) => id === parentId ? parentPath : null,
    list: async () => [],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => { creations += 1; throw new Error("child read must not create Runtime"); },
    sessions,
    resources: {} as ResourceManager,
    cwd: root,
    webRoot: process.cwd(),
  });
  (app as unknown as { subagentStatuses: {
    listForParentSession(path: string): Promise<BackgroundSubagentSnapshot>;
    knownChildSessionPath(id: string): string | null;
    navigationTargetForParentSession(parent: string, child: string): Promise<{ path: string; label: string; modifiedAt: number; content: string } | null>;
  } }).subagentStatuses = {
    listForParentSession: async () => SNAPSHOT,
    knownChildSessionPath: () => null,
    navigationTargetForParentSession: async (parent, child) =>
      parent === parentPath && child === childId
        ? { path: childPath, label: "review child", modifiedAt: Date.now(), content: childContent }
        : null,
  };
  const control = (app as unknown as { sessionControl: { connectedClients: Map<string, unknown>; viewedSessionsByClient: Map<string, unknown> } }).sessionControl;
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${parentId}/background-subagents/${childId}/view`);
    assert.equal(response.status, 200);
    const view = await response.json() as {
      session: { id: string; name: string; writable: boolean };
      messages: Array<{ role: string; content: string }>;
      runtimeStatus: string;
    };
    assert.equal(view.session.id, childId);
    assert.equal(view.session.name, "review child");
    assert.equal(view.session.writable, false);
    assert.equal(view.runtimeStatus, "view-only");
    assert.equal(view.messages.at(-1)?.content, "child answer");
    assert.equal(creations, 0);
    assert.deepEqual(primary.commands, []);
    assert.equal(control.connectedClients.size, 0);
    assert.equal(control.viewedSessionsByClient.size, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("PiChatApp background Subagents read cold index and owned hot paths without warming authority", async () => {
  const coldId = "aaaaaaaaaaaaaaaaaaaa";
  const hotId = "bbbbbbbbbbbbbbbbbbbb";
  const unknownId = "cccccccccccccccccccc";
  const primaryPath = "C:\sessions\primary.jsonl";
  const coldPath = "C:\sessions\cold.jsonl";
  const hotPath = "D:\owned\hot.jsonl";
  const primary = new FakeRpc(primaryPath, "primary");
  let creations = 0;
  const indexCalls: string[] = [];
  const sessions = {
    pathForId: (id: string) => {
      indexCalls.push(id);
      return id === coldId ? coldPath : null;
    },
    list: async () => [],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => { creations += 1; throw new Error("read route must not create Runtime"); },
    sessions,
    resources: {} as ResourceManager,
    cwd: "C:\same-cwd-is-not-ownership-proof",
    webRoot: process.cwd(),
  });
  const paths: string[] = [];
  (app as unknown as { subagentStatuses: {
    listForParentSession(path: string): Promise<BackgroundSubagentSnapshot>;
    knownChildSessionPath(id: string): string | null;
  } }).subagentStatuses = {
    listForParentSession: async (path) => { paths.push(path); return SNAPSHOT; },
    knownChildSessionPath: () => null,
  };
  const pool = (app as unknown as { runtimePool: { get(id: string): unknown } }).runtimePool;
  const originalGet = pool.get.bind(pool);
  pool.get = (id: string) => id === hotId
    ? { sessionPath: hotPath, cwd: "C:\same-cwd-is-not-ownership-proof", promptQueue: [], operationLeases: 0 }
    : originalGet(id);
  const control = (app as unknown as { sessionControl: { connectedClients: Map<string, unknown>; viewedSessionsByClient: Map<string, unknown> } }).sessionControl;
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/sessions/${coldId}/background-subagents`)).status, 200);
    assert.equal((await fetch(`${origin}/api/sessions/${hotId}/background-subagents`)).status, 200);
    assert.equal((await fetch(`${origin}/api/sessions/${unknownId}/background-subagents`)).status, 404);
    assert.deepEqual(paths, [coldPath, hotPath]);
    assert.deepEqual(indexCalls, [coldId, unknownId], "owned hot Runtime path bypasses cwd and SessionIndex fallback");
    assert.equal(creations, 0);
    assert.deepEqual(primary.commands, []);
    assert.equal(control.connectedClients.size, 0);
    assert.equal(control.viewedSessionsByClient.size, 0);
    assert.equal((app as unknown as { applicationLifecycle: string }).applicationLifecycle, "idle");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
  }
});
