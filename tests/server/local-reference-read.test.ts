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

function transcript(id: string, cwd: string, answer: string) {
  return [
    { type: "session", id, cwd },
    { type: "message", id: `${id}-user`, parentId: null, message: { role: "user", content: "Show the results" } },
    { type: "message", id: `${id}-answer`, parentId: `${id}-user`, message: { role: "assistant", content: answer } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

// Tests the real server gate: browser-supplied absolute paths alone never grant access.
test("persisted assistant references allow outside files and images but not arbitrary disk reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-referenced-local-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const sessionsRoot = join(root, "sessions");
  const ref = (name: string) => join(outside, name).replace(/\\/g, "/");
  try {
    await Promise.all([workspace, outside, sessionsRoot, join(outside, "swap")].map((p) => mkdir(p, { recursive: true })));
    await writeFile(ref("report.md"), "outside report\n");
    await writeFile(ref("unlisted.md"), "not granted\n");
    await writeFile(ref("private-key.txt"), "must stay protected\n");
    await writeFile(ref("run.cmd"), "echo should never execute\n");
    await writeFile(ref("vector.svg"), "<svg />");
    await writeFile(ref("swap/report.md"), "before swap\n");
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(ref("plot.png"), png);
    await writeFile(ref("unlisted.png"), png);
    await writeFile(ref("large.png"), Buffer.alloc(33 * 1024 * 1024));
    const activePath = join(sessionsRoot, "active.jsonl");
    const coldPath = join(sessionsRoot, "cold.jsonl");
    const otherPath = join(sessionsRoot, "other.jsonl");
    const answer = [
      `[Report](<${ref("report.md")}>)`, `[script](<${ref("run.cmd")}>)`,
      `[private](<${ref("private-key.txt")}>)`, `[swap](<${ref("swap/report.md")}>)`,
      `![plot](<${ref("plot.png")}>)`, `![svg](<${ref("vector.svg")}>)`,
      `![large](<${ref("large.png")}>)`,
      `[unlisted](<${ref("unlisted.md")}>)`,
    ];
    // A code block containing a path is not a rendered link or permission.
    answer[answer.length - 1] = `\x60\x60\x60text\n${answer[answer.length - 1]}\n\x60\x60\x60`;
    await writeFile(activePath, transcript("active", workspace, "Ready"));
    await writeFile(coldPath, transcript("cold", workspace, answer.join("\n\n")));
    await writeFile(otherPath, transcript("other", workspace, "No local references"));
    const rpc = new FakeRpc(activePath, "active");
    const opened: string[] = [];
    let swapBeforeVerify = false;
    const app = new PiChatApp({
      rpc: rpc as unknown as PiRpcClient,
      sessions: new SessionIndex(sessionsRoot, join(root, "cache.json")),
      resources: {} as ResourceManager, cwd: workspace, webRoot: workspace,
      openLocalFile: async (path, verifyTarget) => {
        if (swapBeforeVerify) {
          await rename(join(outside, "swap"), join(outside, "old-swap"));
          await symlink(workspace, join(outside, "swap"), process.platform === "win32" ? "junction" : "dir");
        }
        assert.equal(await verifyTarget(), path);
        opened.push(path);
      },
    });
    const server = createServer((request, response) => void app.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const coldId = idForPath(coldPath);
    const post = (id: string, path: string, route = "open-link") => fetch(`${base}/api/sessions/${id}/workspace/${route}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }),
    });
    const image = (id: string, path: string) => fetch(`${base}/api/sessions/${id}/workspace/image?${new URLSearchParams({ path })}`);
    try {
      await fetch(`${base}/api/bootstrap`);
      const before = rpc.commands.length;
      const response = await post(coldId, ref("report.md"));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, path: ref("report.md") });
      assert.deepEqual(opened, [await realpath(ref("report.md"))]);
      const picture = await image(coldId, ref("plot.png"));
      assert.equal(picture.status, 200);
      assert.equal(picture.headers.get("content-type"), "image/png");
      assert.equal(picture.headers.get("x-content-type-options"), "nosniff");
      assert.match(picture.headers.get("content-security-policy") || "", /sandbox/);
      assert.deepEqual(Buffer.from(await picture.arrayBuffer()), png);
      assert.equal((await post(coldId, ref("unlisted.md"))).status, 404);
      assert.equal((await image(coldId, ref("unlisted.png"))).status, 404);
      assert.equal((await post(idForPath(otherPath), ref("report.md"))).status, 404);
      assert.equal((await image(idForPath(otherPath), ref("plot.png"))).status, 404);
      assert.equal((await post(coldId, ref("plot.png"))).status, 404, "an image reference does not grant shell-open authority");
      assert.equal((await image(coldId, ref("report.md"))).status, 404, "a file link does not grant inline-image authority");
      assert.equal((await post(coldId, ref("report.md"), "open")).status, 400, "Files inspector remains Workspace-contained");
      assert.equal((await post(coldId, "../outside/report.md")).status, 400);
      assert.equal((await post(coldId, "//host/share/report.md")).status, 400);
      assert.equal((await post(coldId, ref("private-key.txt"))).status, 400);
      assert.equal((await post(coldId, ref("run.cmd"))).status, 409);
      assert.equal((await image(coldId, ref("vector.svg"))).status, 409);
      assert.equal((await image(coldId, ref("large.png"))).status, 413);
      swapBeforeVerify = true;
      assert.equal((await post(coldId, ref("swap/report.md"))).status, 400);
      assert.equal(opened.length, 1);
      assert.equal(rpc.commands.length, before, "references must not start or query a Runtime");
    } finally {
      server.close();
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
