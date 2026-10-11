import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { truncateSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionProjection } from "../src/server/session-projection";
import { SessionIndex } from "../src/server/session-index";

const line = (value: unknown) => JSON.stringify(value) + "\n";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function holdFirstSuffix(t: TestContext, path: string, offset: number) {
  const entered = deferred();
  const release = deferred();
  const originalOpen = fs.open;
  let opens = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const ordinal = String(args[0]) === path ? ++opens : 0;
    const handle = await originalOpen(...args);
    if (!ordinal) return handle;
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", (async (buffer: Buffer, start: number, length: number, position: number) => {
      const result = await read(buffer, start, length, position);
      if (ordinal === 1 && position === offset) { entered.resolve(); await release.promise; }
      return result;
    }) as typeof handle.read);
    return handle;
  });
  syncBuiltinESMExports();
  return { entered: entered.promise, release: release.resolve, opens: () => opens };
}

test("two reconciliations of one appended file cannot decode and commit the same suffix concurrently", async t => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-chat-projection-race-"));
  const path = join(root, "session.jsonl");
  const original = line({ id: "one" });
  await fs.writeFile(path, original);
  const projection = new SessionProjection(path, { retain: value => value });
  const initial = await projection.reconcile();
  await fs.appendFile(path, line({ id: "two" }));
  const gate = holdFirstSuffix(t, path, Buffer.byteLength(original));
  const first = projection.reconcile();
  await gate.entered;
  const second = projection.reconcile();
  try {
    assert.equal(gate.opens(), 1, "a second reconciliation must wait before opening the file");
    gate.release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a.entries.map(entry => entry.id), ["one", "two"]);
    assert.deepEqual(b.entries.map(entry => entry.id), ["one", "two"]);
    assert.deepEqual(initial.entries.map(entry => entry.id), ["one"], "a previous result must not borrow a subsequently pushed array");
    assert.equal(b.kind, "none", "the queued reader starts from the committed new offset");
  } finally {
    gate.release(); await Promise.allSettled([first, second]);
    t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true });
  }
});

test("list refresh and body read serialize through the same projection and see appends while queued", async t => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-chat-index-cross-read-"));
  const path = join(root, "session.jsonl");
  const initial = line({ type: "session", id: "session", cwd: root }) + line({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "one" } });
  await fs.writeFile(path, initial);
  const index = new SessionIndex(root, join(root, "cache.json"));
  const [session] = await index.list();
  await index.snapshotForId(session.id);
  const projection = (index as unknown as { snapshotCache: Map<string, { projection: SessionProjection<Record<string, unknown>> }> }).snapshotCache.get(session.id)!.projection;
  await fs.appendFile(path, line({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "answer" } }));
  const gate = holdFirstSuffix(t, path, Buffer.byteLength(initial));
  const bothEntered = deferred();
  let calls = 0;
  const reconcile = projection.reconcile.bind(projection);
  t.mock.method(projection, "reconcile", (...args: Parameters<typeof reconcile>) => {
    const promise = reconcile(...args);
    if (++calls === 2) bothEntered.resolve();
    return promise;
  });
  const body = index.snapshotForId(session.id);
  await gate.entered;
  const list = index.list();
  try {
    await bothEntered.promise;
    assert.equal(gate.opens(), 1, "the list must not open another reader into the same mutable projection");
    await fs.appendFile(path, line({ type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "two" } }));
    gate.release();
    const [snapshot, summaries] = await Promise.all([body, list]);
    assert.equal(snapshot?.messages.length, 2);
    assert.equal(summaries[0].messageCount, 3);
    assert.deepEqual(projection.entries.map(entry => entry.id), ["session", "u1", "a1", "u2"]);
    assert.equal((await index.snapshotForId(session.id))?.messages.length, 3);
  } finally {
    gate.release(); await Promise.allSettled([body, list]);
    t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed post-decode verification leaves the last committed snapshot intact and does not poison the queue", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-chat-projection-rollback-"));
  const path = join(root, "session.jsonl");
  const initial = line({ id: "one" });
  let truncate = false;
  const projection = new SessionProjection(path, { retain: value => value, observeRead: () => { if (truncate) { truncate = false; truncateSync(path, 0); } } });
  try {
    await fs.writeFile(path, initial);
    await projection.reconcile();
    await fs.appendFile(path, line({ id: "two" }));
    truncate = true;
    await assert.rejects(projection.reconcile(), /changed/);
    assert.deepEqual(projection.entries.map(entry => entry.id), ["one"]);
    assert.equal(projection.sourceBytes, Buffer.byteLength(initial));
    await fs.writeFile(path, line({ id: "replacement" }));
    assert.deepEqual((await projection.reconcile()).entries.map(entry => entry.id), ["replacement"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
