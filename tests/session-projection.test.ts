import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionIndex } from "../src/server/session-index";
import {
  SessionProjection,
  type SessionProjectionReadEvent,
} from "../src/server/session-projection";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test("SessionProjection reads only the appended suffix after verifying its committed prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-incremental-projection-"));
  try {
    const path = join(root, "session.jsonl");
    const initial = line({ type: "session", id: "session", cwd: root })
      + line({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "one" } });
    await writeFile(path, initial);
    const reads: SessionProjectionReadEvent[] = [];
    const projection = new SessionProjection<Record<string, unknown>>(path, {
      retain: (value) => value,
      observeRead: (event) => reads.push(event),
    });
    const first = await projection.reconcile(await stat(path));
    assert.equal(first.kind, "rewrite");
    assert.equal(first.entries.length, 2);
    reads.length = 0;

    const appended = line({
      type: "message",
      id: "a1",
      parentId: "u1",
      message: { role: "assistant", content: "answer" },
    });
    await appendFile(path, appended);
    const second = await projection.reconcile(await stat(path));
    assert.equal(second.kind, "append");
    assert.equal(second.entries.length, 3);
    assert.equal(reads.reduce((total, event) => total + event.bytes, 0), Buffer.byteLength(appended));
    assert.ok(reads.every((event) => event.kind === "append" && event.offset >= Buffer.byteLength(initial)));
    assert.equal(second.committedBytes, second.observedBytes);
    assert.equal(second.uncommittedBytes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionProjection re-reads an incomplete EOF tail without duplicating its provisional entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-projection-tail-"));
  try {
    const path = join(root, "session.jsonl");
    const header = line({ type: "session", id: "session", cwd: root });
    const provisional = JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      message: { role: "user", content: "one" },
    });
    await writeFile(path, header + provisional);
    const projection = new SessionProjection<Record<string, unknown>>(path, {
      retain: (value) => value,
    });
    const first = await projection.reconcile(await stat(path));
    assert.equal(first.entries.length, 2);
    assert.equal(first.uncommittedBytes, Buffer.byteLength(provisional));

    await appendFile(path, `\n${line({
      type: "message",
      id: "a1",
      parentId: "u1",
      message: { role: "assistant", content: "answer" },
    })}`);
    const second = await projection.reconcile(await stat(path));
    assert.equal(second.kind, "append");
    assert.deepEqual(second.entries.map((entry) => entry.id), ["session", "u1", "a1"]);
    assert.equal(second.uncommittedBytes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionProjection frames a JSONL entry spanning multiple read chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-projection-large-entry-"));
  try {
    const path = join(root, "session.jsonl");
    const large = "x".repeat(700_000);
    await writeFile(path, line({ type: "session", id: "session", cwd: root })
      + line({ type: "message", id: "a1", message: { role: "assistant", content: large } }));
    const projection = new SessionProjection<Record<string, unknown>>(path, {
      retain: (value) => value,
    });
    const result = await projection.reconcile(await stat(path));
    assert.equal(result.entries.length, 2);
    assert.equal(
      ((result.entries[1].message as Record<string, unknown>).content as string).length,
      large.length,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionProjection falls back to a full rewrite after truncation or prefix replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-projection-rewrite-"));
  try {
    const path = join(root, "session.jsonl");
    await writeFile(path, line({ type: "session", id: "old", cwd: root })
      + line({ type: "message", id: "old-u", message: { role: "user", content: "old" } }));
    const reads: SessionProjectionReadEvent[] = [];
    const projection = new SessionProjection<Record<string, unknown>>(path, {
      retain: (value) => value,
      observeRead: (event) => reads.push(event),
    });
    await projection.reconcile(await stat(path));
    reads.length = 0;

    await writeFile(path, line({ type: "session", id: "new", cwd: root })
      + line({ type: "message", id: "new-u", message: { role: "user", content: "replacement with more bytes" } }));
    const replaced = await projection.reconcile(await stat(path));
    assert.equal(replaced.kind, "rewrite");
    assert.deepEqual(replaced.entries.map((entry) => entry.id), ["new", "new-u"]);
    assert.ok(reads.some((event) => event.kind === "rewrite" && event.offset === 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an append-only physical projection still follows a newly appended active branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-projection-branch-"));
  try {
    const path = join(root, "session.jsonl");
    await writeFile(path, line({ type: "session", id: "session", cwd: root })
      + line({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "root" } })
      + line({ type: "message", id: "old", parentId: "u1", message: { role: "assistant", content: "old branch" } }));
    const index = new SessionIndex(root, join(root, "cache.json"));
    const [session] = await index.list();
    assert.deepEqual((await index.snapshotForId(session.id))?.messages.map((message) => message.content), ["root", "old branch"]);

    await appendFile(path, line({ type: "message", id: "u2", parentId: "u1", message: { role: "user", content: "new branch" } })
      + line({ type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: "new answer" } }));
    const [summary] = await index.list();
    const snapshot = await index.snapshotForId(session.id);
    assert.equal(summary.messageCount, 3);
    assert.equal(summary.turnCount, 2);
    assert.deepEqual(snapshot?.messages.map((message) => message.content), ["root", "new branch", "new answer"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionIndex reuses incremental outline and transcript projections after an append", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-index-projection-"));
  try {
    const path = join(root, "session.jsonl");
    await writeFile(path, line({ type: "session", id: "session", cwd: root })
      + line({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "one" } }));
    const index = new SessionIndex(root, join(root, "cache.json"));
    const [session] = await index.list();
    const first = await index.snapshotForId(session.id);
    const internals = index as unknown as {
      outlineProjections: Map<string, unknown>;
      snapshotCache: Map<string, { projection: unknown }>;
    };
    const outlineProjection = internals.outlineProjections.get(path);
    const transcriptProjection = internals.snapshotCache.get(session.id)?.projection;
    assert.ok(outlineProjection);
    assert.ok(transcriptProjection);

    await appendFile(path, line({
      type: "message",
      id: "a1",
      parentId: "u1",
      message: { role: "assistant", content: "answer" },
    }));
    const [updated] = await index.list();
    const second = await index.snapshotForId(session.id);
    assert.equal(updated.messageCount, 2);
    assert.equal(second?.messages.length, 2);
    assert.notEqual(second, first);
    assert.equal(internals.outlineProjections.get(path), outlineProjection);
    assert.equal(internals.snapshotCache.get(session.id)?.projection, transcriptProjection);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
