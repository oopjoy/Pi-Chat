import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { BackgroundSubagentSnapshot } from "../src/shared/types";
import { handleSubagentsReadRoute } from "../src/server/routes/subagents-read";
import { PiChatApp } from "../src/server/app";
import type { PiRpcClient } from "../src/server/rpc-client";
import type { ResourceManager } from "../src/server/resource-manager";
import type { SessionIndex } from "../src/server/session-index";
import { FakeRpc } from "./helpers/server-app-fixture";

const ID = "0123456789abcdefabcd";
const SNAPSHOT: BackgroundSubagentSnapshot = {
  total: 1,
  activeCount: 1,
  attentionCount: 0,
  truncated: false,
  steps: [{ key: "subagent-1", label: "实施子代理 1", status: "running", elapsedMs: 1, updateAgeMs: 2 }],
};

async function fixture(found = true) {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    void handleSubagentsReadRoute({
      backgroundSubagents: async (sessionId) => {
        calls.push(sessionId);
        return found ? SNAPSHOT : null;
      },
    }, request, response, url).then((handled) => {
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
  (app as unknown as { subagentStatuses: { listForParentSession(path: string): Promise<BackgroundSubagentSnapshot> } }).subagentStatuses = {
    listForParentSession: async (path) => { paths.push(path); return SNAPSHOT; },
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
