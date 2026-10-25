import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import type { PiRpcClient } from "../../src/server/rpc-client";
import type { ResourceManager } from "../../src/server/resource-manager";
import { idForPath, SessionIndex } from "../../src/server/session-index";
import { FakeRpc } from "../helpers/server-app-fixture";

function transcript(id: string, cwd: string) {
  return [
    { type: "session", id, cwd },
    { type: "message", id: `${id}-user`, parentId: null, message: { role: "user", content: "hello" } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

test("the real App serves a verified Session JSONL reference", async () => {
  // Canonicalize first: GitHub Windows runners often give an 8.3 TMP path,
  // and idForPath(realpath(file)) would not match SessionIndex's resolve().
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-chat-session-reference-")));
  const workspace = join(root, "workspace");
  const sessionsRoot = join(root, "sessions");
  const sessionPath = join(sessionsRoot, "history.jsonl");
  try {
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(sessionsRoot, { recursive: true })]);
    await writeFile(sessionPath, transcript("history", workspace));
    const canonicalPath = await realpath(sessionPath);
    const sessionId = idForPath(canonicalPath);
    const rpc = new FakeRpc(sessionPath, "active");
    const app = new PiChatApp({
      rpc: rpc as unknown as PiRpcClient,
      sessions: new SessionIndex(sessionsRoot, join(root, "cache.json")),
      resources: {} as ResourceManager,
      cwd: workspace,
      webRoot: workspace,
    });
    const server = createServer((request, response) => void app.handle(request, response));
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const bootstrap = await fetch(`${origin}/api/bootstrap`);
      const bootstrapText = await bootstrap.text();
      assert.equal(bootstrap.status, 200, bootstrapText);
      const listed = (JSON.parse(bootstrapText) as { sessions?: Array<{ id: string; sessionId: string }> }).sessions || [];
      const target = listed.find((session) => session.id === sessionId)
        || listed.find((session) => session.sessionId === "history");
      assert.ok(target, `indexed Session missing: computed=${sessionId} listed=${JSON.stringify(listed)}`);
      const response = await fetch(`${origin}/api/sessions/${target.id}/session-file`);
      const bodyText = await response.text();
      assert.equal(response.status, 200, bodyText);
      assert.deepEqual(JSON.parse(bodyText), { sessionId: target.id, sessionFile: resolve(canonicalPath) });
    } finally {
      server.close();
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
