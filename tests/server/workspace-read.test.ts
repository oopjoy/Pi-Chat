import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
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

function sessionContent(id: string, cwd: string, withTurn: boolean, paths = ["README.md"], linkedPaths: string[] = []) {
  const entries: Record<string, unknown>[] = [{ type: "session", id, cwd }];
  if (withTurn) {
    entries.push({ type: "message", id: `${id}-user`, parentId: null, message: { role: "user", content: "hello" } });
    for (const [index, path] of paths.entries()) {
      const callId = `${id}-edit-${index}`;
      const messageId = `${id}-call-${index}`;
      entries.push(
        { type: "message", id: messageId, parentId: index ? `${id}-result-${index - 1}` : `${id}-user`, message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "edit", arguments: { path, edits: [{ oldText: "old", newText: "new" }] } }] } },
        { type: "message", id: `${id}-result-${index}`, parentId: messageId, message: { role: "toolResult", toolCallId: callId, toolName: "edit", content: "ok" } },
      );
    }
    if (linkedPaths.length) entries.push({
      type: "message",
      id: `${id}-links`,
      parentId: paths.length ? `${id}-result-${paths.length - 1}` : `${id}-user`,
      message: { role: "assistant", content: linkedPaths.map((path) => `[${path}](${path})`).join("\n") },
    });
  }
  return `${entries.map(JSON.stringify).join("\n")}\n`;
}

test("cold persisted Workspace reads and explicit opens never start or query a Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-route-"));
  try {
    const workspace = join(root, "workspace");
    const sessionsRoot = join(root, "sessions");
    await mkdir(workspace, { recursive: true });
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(join(workspace, "README.md"), "# Cold workspace\n");
    await writeFile(join(workspace, "notes.txt"), "not modified by this Session\n");
    const unsafeFiles = ["run.cmd", "script.js", "script.vbs", "page.hta", "shortcut.url", "settings.reg"];
    await Promise.all(unsafeFiles.map((name) => writeFile(join(workspace, name), "safe text preview\n")));
    await mkdir(join(workspace, "swap"));
    await writeFile(join(workspace, "swap", "file.txt"), "inside workspace\n");
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "file.txt"), "outside workspace\n");
    await writeFile(join(workspace, "hold.txt"), "held open\n");
    const activePath = join(sessionsRoot, "active.jsonl");
    const coldPath = join(sessionsRoot, "cold.jsonl");
    const unsafePath = join(sessionsRoot, "unsafe.jsonl");
    await writeFile(activePath, sessionContent("active", workspace, true));
    await writeFile(coldPath, sessionContent("cold", workspace, true, ["README.md"], ["notes.txt"]));
    await writeFile(unsafePath, sessionContent("unsafe", workspace, true, [...unsafeFiles, "hold.txt", "swap/file.txt"], unsafeFiles));
    const rpc = new FakeRpc(activePath, "active");
    const opened: string[] = [];
    let replaceBeforeFinalVerification = false;
    let holdNextOpen = false;
    let markOpenHeld!: () => void;
    let releaseOpen!: () => void;
    const openHeld = new Promise<void>((resolve) => { markOpenHeld = resolve; });
    const openRelease = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const app = new PiChatApp({
      rpc: rpc as unknown as PiRpcClient,
      sessions: new SessionIndex(sessionsRoot, join(root, "cache.json")),
      resources: {} as ResourceManager,
      openLocalFile: async (path, verifyTarget) => {
        if (replaceBeforeFinalVerification) {
          replaceBeforeFinalVerification = false;
          await rename(join(workspace, "swap"), join(root, "original-swap"));
          await symlink(join(root, "outside"), join(workspace, "swap"), process.platform === "win32" ? "junction" : "dir");
        }
        assert.equal(await verifyTarget(), path);
        if (holdNextOpen) {
          holdNextOpen = false;
          markOpenHeld();
          await openRelease;
        }
        opened.push(path);
      },
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
      assert.deepEqual((await listing.json() as { files: unknown[] }).files, [{ path: "README.md", name: "README.md", operation: "edit" }]);
      const preview = await fetch(`${base}/api/sessions/${coldId}/workspace/file?path=README.md`);
      assert.equal(preview.status, 200);
      assert.match((await preview.json() as { text: string }).text, /Cold workspace/);
      const openedResponse = await fetch(`${base}/api/sessions/${coldId}/workspace/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "README.md" }),
      });
      assert.equal(openedResponse.status, 200);
      assert.deepEqual(await openedResponse.json(), { ok: true, path: "README.md" });
      assert.deepEqual(opened, [await realpath(join(workspace, "README.md"))]);
      assert.equal((await fetch(`${base}/api/sessions/${coldId}/workspace/file?path=notes.txt`)).status, 404);
      assert.equal((await fetch(`${base}/api/sessions/${coldId}/workspace/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "notes.txt" }),
      })).status, 404, "ordinary Workspace Open remains limited to successful Edit/Write projection");
      const linkedOpen = await fetch(`${base}/api/sessions/${coldId}/workspace/open-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "notes.txt" }),
      });
      assert.equal(linkedOpen.status, 200);
      assert.deepEqual(await linkedOpen.json(), { ok: true, path: "notes.txt" });
      assert.equal((await fetch(`${base}/api/sessions/${coldId}/workspace/open-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "README.md" }),
      })).status, 404, "a browser path must be backed by a persisted assistant link");
      assert.equal(opened.length, 2);
      const unsafeId = idForPath(unsafePath);
      for (const path of unsafeFiles) {
        const response = await fetch(`${base}/api/sessions/${unsafeId}/workspace/open`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        });
        assert.equal(response.status, 409, `${path} must not reach the Windows shell`);
        const linkedResponse = await fetch(`${base}/api/sessions/${unsafeId}/workspace/open-link`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        });
        assert.equal(linkedResponse.status, 409, `${path} linked in a reply must still not reach the Windows shell`);
      }
      assert.equal(opened.length, 2, "shell-active file extensions must never call the opener");

      holdNextOpen = true;
      const heldRequest = fetch(`${base}/api/sessions/${unsafeId}/workspace/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "hold.txt" }),
      });
      await openHeld;
      const lifecycle = (app as unknown as { lifecycleCoordinator: {
        activeMutations: number;
        begin(value: "restarting"): void;
        end(value: "restarting"): void;
      } }).lifecycleCoordinator;
      assert.equal(lifecycle.activeMutations, 1);
      assert.throws(() => lifecycle.begin("restarting"), /写操作正在完成/);
      releaseOpen();
      assert.equal((await heldRequest).status, 200);
      assert.equal(lifecycle.activeMutations, 0);
      lifecycle.begin("restarting");
      assert.equal((await fetch(`${base}/api/sessions/${unsafeId}/workspace/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "hold.txt" }),
      })).status, 503);
      lifecycle.end("restarting");
      assert.equal(opened.length, 3, "maintenance must reject a new Open before it reaches the shell");

      replaceBeforeFinalVerification = true;
      const replaced = await fetch(`${base}/api/sessions/${unsafeId}/workspace/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "swap/file.txt" }),
      });
      assert.equal(replaced.status, 400);
      assert.equal(opened.length, 3, "a path replaced before the shell handoff must fail final verification");
      assert.equal(rpc.commands.length, before, "cold Workspace reads and opens must not send Pi RPC commands");
      assert.equal((await fetch(`${base}/api/sessions/ffffffffffffffffffff/workspace/files`)).status, 404);
      assert.equal((await fetch(`${base}/api/sessions/${coldId}/workspace/files`, { method: "POST" })).status, 405);
      assert.equal((await fetch(`${base}/api/sessions/${coldId}/workspace/open`)).status, 405);
      assert.equal((await fetch(`${base}/api/sessions/${coldId}/workspace/open-link`)).status, 405);
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
