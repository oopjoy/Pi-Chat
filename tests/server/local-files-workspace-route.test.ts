import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { handleLocalFilesWorkspaceRoute } from "../../src/server/routes/local-files-and-workspace";

async function fixture(selectFolder: () => Promise<string | null> = async () => process.cwd()) {
  let folderPicks = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    void handleLocalFilesWorkspaceRoute({
      pickLocalFiles: async () => ["C:\\file.txt"],
      readClipboardFiles: async (files) => files.map((file) => file.name),
      pickWorkspaceFolder: async () => { folderPicks += 1; return selectFolder(); },
      currentCwd: () => "C:\\work",
    }, request, response, url).then((handled) => {
      if (!handled) { response.statusCode = 404; response.end(); }
    });
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
