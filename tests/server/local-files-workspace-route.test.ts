import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { handleLocalFilesWorkspaceRoute } from "../../src/server/routes/local-files-and-workspace";
import { DroppedFileStore } from "../../src/server/dropped-files";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fixture(selectFolder: () => Promise<string | null> = async () => process.cwd(), attachmentStore?: DroppedFileStore) {
  let folderPicks = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    void handleLocalFilesWorkspaceRoute({
      attachmentStore,
      pickLocalFiles: async () => ["C:\\file.txt"],
      readClipboardFiles: async (files) => files.map((file) => file.name),
      pickWorkspaceFolder: async () => { folderPicks += 1; return selectFolder(); },
      currentCwd: () => "C:\\work",
    }, request, response, url).then((handled) => {
      if (!handled) { response.statusCode = 404; response.end(); }
    }).catch((error: Error) => { response.statusCode = 400; response.end(JSON.stringify({ error: error.message })); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    folderPicks: () => folderPicks,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("local file route adapter keeps picker operations behind narrow ports", async () => {
  const target = await fixture();
  try {
    assert.deepEqual(await (await fetch(`${target.origin}/api/local-files/pick`, { method: "POST" })).json(), { paths: ["C:\\file.txt"] });
    assert.deepEqual(await (await fetch(`${target.origin}/api/local-files/clipboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ name: "clip.txt", size: 1 }] }),
    })).json(), { paths: ["clip.txt"] });
  } finally {
    await target.close();
  }
});

test("Explorer basename lookup is removed and cannot consult unrelated windows", async () => {
  const target = await fixture();
  try {
    const response = await fetch(`${target.origin}/api/local-files/explorer-selection`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ names: ["results"] }),
    });
    assert.equal(response.status, 404);
    assert.equal(target.folderPicks(), 0);
  } finally { await target.close(); }
});

test("explicit attachment folder selection returns the chosen path without a workspace change", { skip: process.platform !== "win32" }, async () => {
  const target = await fixture();
  try {
    const response = await fetch(`${target.origin}/api/local-files/pick-folder`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { paths: [process.cwd()] });
    assert.equal(target.folderPicks(), 1);
  } finally { await target.close(); }
});

test("cancelled folder selection adds nothing and GET cannot open a native dialog", async () => {
  const target = await fixture(async () => null);
  try {
    assert.equal((await fetch(`${target.origin}/api/local-files/pick-folder`)).status, 405);
    assert.equal(target.folderPicks(), 0);
    const response = await fetch(`${target.origin}/api/local-files/pick-folder`, { method: "POST" });
    assert.deepEqual(await response.json(), { paths: [] });
    assert.equal(target.folderPicks(), 1);
  } finally { await target.close(); }
});

test("staged file API uses durable storage and retention survives subsequent card release", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-store-route-"));
  const store = new DroppedFileStore(join(root, "user-data", "attachments"));
  const target = await fixture(undefined, store);
  const post = (path: string, body: unknown) => fetch(`${target.origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const response = await post("/api/local-files/stage", { owner: "pageA", name: "result.log", data: "cmVzdWx0", size: 6 });
    assert.equal(response.status, 200);
    const { path } = await response.json() as { path: string };
    assert.equal(store.manages(path), true);
    assert.equal(path.startsWith(join(root, "user-data")), true);
    const lease = await post("/api/local-files/lease", { paths: [path], owner: "pageA", revision: 1, active: true });
    assert.deepEqual(await lease.json(), { missing: [] });
    assert.equal((await post("/api/local-files/prepare", { paths: [path] })).status, 200);
    assert.equal((await post("/api/local-files/lease", { paths: [path], owner: "pageA", revision: 2, active: false })).status, 200);
    await access(path);
    const cleanup = await store.maintain();
    assert.equal(cleanup.retained, 1);
    assert.equal(cleanup.drafts, 0);
    assert.equal(cleanup.removed, 0);
    // Removing the draft-storage panel must not leave hidden management APIs.
    for (const [path, method] of [
      ["/api/local-files/storage", "GET"], ["/api/local-files/storage", "POST"],
      ["/api/local-files/storage/open", "POST"],
    ]) assert.equal((await fetch(`${target.origin}${path}`, { method })).status, 404);
  } finally { await target.close(); await rm(root, { recursive: true, force: true }); }
});

test("draft workspace route returns the selected directory", async () => {
  const target = await fixture();
  try {
    const response = await fetch(`${target.origin}/api/workspace/draft-pick`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).cancelled, false);
  } finally {
    await target.close();
  }
});
