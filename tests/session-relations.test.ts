import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionRelationStore } from "../src/server/session-relations";

const source = "aaaaaaaaaaaaaaaaaaaa";
const firstDestination = "bbbbbbbbbbbbbbbbbbbb";
const secondDestination = "cccccccccccccccccccc";

function relation(messageId: string, createdAt: number) {
  return {
    sourceSessionId: source,
    sourceName: "Source conversation",
    sourcePersistedMessageId: messageId,
    createdAt,
  };
}

test("Session Fork provenance persists atomically and serializes concurrent mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-session-relations-"));
  const path = join(root, "relations.json");
  try {
    const store = new SessionRelationStore(path);
    await Promise.all([
      store.recordFork(firstDestination, relation("user-1:0", 10)),
      store.recordFork(secondDestination, relation("user-2:0", 20)),
    ]);
    const restored = new SessionRelationStore(path);
    assert.deepEqual(await restored.getForkOrigin(firstDestination), relation("user-1:0", 10));
    assert.deepEqual(await restored.getForkOrigin(secondDestination), relation("user-2:0", 20));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).version, 1);

    await restored.removeDestination(firstDestination);
    const afterRemoval = new SessionRelationStore(path);
    assert.equal(await afterRemoval.getForkOrigin(firstDestination), null);
    assert.deepEqual(await afterRemoval.getForkOrigin(secondDestination), relation("user-2:0", 20));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Session Fork provenance fails closed on malformed files and rejects invalid relations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-session-relations-invalid-"));
  const path = join(root, "relations.json");
  try {
    await writeFile(path, "{not-json\n");
    const store = new SessionRelationStore(path);
    await assert.rejects(() => store.getForkOrigin(firstDestination));
    await assert.rejects(() => store.recordFork(firstDestination, relation("user-1:0", 10)));
    assert.equal(await readFile(path, "utf8"), "{not-json\n");
    await assert.rejects(() => store.recordFork(source, relation("user-1:0", 10)), /无效/);
    await assert.rejects(() => store.recordFork(firstDestination, { ...relation("user-1:0", 10), sourceName: "bad\nname" }), /无效/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed atomic relation write never mutates the live cache or durable file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-session-relations-write-failure-"));
  const path = join(root, "relations.json");
  try {
    await new SessionRelationStore(path).recordFork(firstDestination, relation("user-1:0", 10));
    const failing = new SessionRelationStore(path, {
      writeAtomic: async () => { throw new Error("simulated write failure"); },
    });
    assert.deepEqual(await failing.getForkOrigin(firstDestination), relation("user-1:0", 10));
    await assert.rejects(() => failing.recordFork(secondDestination, relation("user-2:0", 20)), /simulated write failure/);
    assert.equal(await failing.getForkOrigin(secondDestination), null);
    await assert.rejects(() => failing.removeDestination(firstDestination), /simulated write failure/);
    assert.deepEqual(await failing.getForkOrigin(firstDestination), relation("user-1:0", 10));
    const restarted = new SessionRelationStore(path);
    assert.deepEqual(await restarted.getForkOrigin(firstDestination), relation("user-1:0", 10));
    assert.equal(await restarted.getForkOrigin(secondDestination), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
