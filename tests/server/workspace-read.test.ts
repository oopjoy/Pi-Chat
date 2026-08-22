import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import type { PiRpcClient } from "../../src/server/rpc-client";
import type { ResourceManager } from "../../src/server/resource-manager";
import { idForPath, SessionIndex } from "../../src/server/session-index";
import { FakeRpc } from "../helpers/server-app-fixture";

async function listen(app: PiChatApp) {
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

function sessionContent(id: string, cwd: string, withTurn: boolean) {
  const entries: Record<string, unknown>[] = [{ type: "session", id, cwd }];
  if (withTurn) entries.push({ type: "message", id: `${id}-user`, parentId: null, message: { role: "user", content: "hello" } });
  return `${entries.map(JSON.stringify).join("\n")}\n`;
}

test("cold persisted Workspace reads never start or query a Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-route-"));
  try {
    const workspace = join(root, "workspace");
    const sessionsRoot = join(root, "sessions");
    await mkdir(workspace, { recursive: true });
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(join(workspace, "README.md"), "# Cold workspace\n");
    const activePath = join(sessionsRoot, "active.jsonl");
    const coldPath = join(sessionsRoot, "cold.jsonl");
    await writeFile(activePath, sessionContent("active", workspace, true));
    await writeFile(coldPath, sessionContent("cold", workspace, true));
    const rpc = new FakeRpc(activePath, "active");
    const app = new PiChatApp({
      rpc: rpc as unknown as PiRpcClient,
      sessions: new SessionIndex(sessionsRoot, join(root, "cache.json")),
      resources: {} as ResourceManager,
      cwd: workspace,
      webRoot: workspace,
    });
    const { server, base } = await listen(app);
    try {
      await fetch(`${base}/api/bootstrap`);
      const before = rpc.commands.length;
      const coldId = idForPath(coldPath);
      const listing = await fetch(`${base}/api/sessions/${coldId}/workspace/files?dir=`);
      assert.equal(listing.status, 200);
      assert.deepEqual((await listing.json() as { entries: unknown[] }).entries, [{ name: "README.md", type: "file" }]);
      const preview = await fetch(`${base}/api/sessions/${coldId}/workspace/file?path=README.md`);
      assert.equal(preview.status, 200);
      assert.match((await preview.json() as { text: string }).text, /Cold workspace/);
      assert.equal(rpc.commands.length, before, "cold Workspace reads must not send Pi RPC commands");
      assert.equal((await fetch(`${base}/api/sessions/ffffffffffffffffffff/workspace/files`)).status, 404);
      assert.equal((await fetch(`${base}/api/sessions/${coldId}/workspace/files`, { method: "POST" })).status, 405);
    } finally {
      server.close();
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an active but empty Primary draft has no persisted Workspace authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-draft-route-"));
  try {
    const workspace = join(root, "workspace");
    const sessionsRoot = join(root, "sessions");
    await mkdir(workspace, { recursive: true });
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(join(workspace, "README.md"), "private draft workspace\n");
    const draftPath = join(sessionsRoot, "draft.jsonl");
    await writeFile(draftPath, sessionContent("draft", workspace, false));
    const rpc = new FakeRpc(draftPath, "draft");
    const app = new PiChatApp({
      rpc: rpc as unknown as PiRpcClient,
      sessions: new SessionIndex(sessionsRoot, join(root, "cache.json")),
      resources: {} as ResourceManager,
      cwd: workspace,
      webRoot: workspace,
    });
    const { server, base } = await listen(app);
    try {
      await fetch(`${base}/api/bootstrap`);
      const before = rpc.commands.length;
      const response = await fetch(`${base}/api/sessions/${idForPath(draftPath)}/workspace/files`);
      assert.equal(response.status, 404);
      assert.equal(rpc.commands.length, before);
    } finally {
      server.close();
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
