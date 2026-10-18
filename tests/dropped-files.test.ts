import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DroppedFileStore, DRAFT_ATTACHMENT_LEASE_MS, STAGING_GRACE_MS, safeDroppedFileName } from "../src/server/dropped-files";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-attachment-store-"));
  let now = Date.now();
  const store = new DroppedFileStore(join(root, "cache"), () => now);
  return { root, store, advance(ms: number) { now += ms; }, async close() { await rm(root, { recursive: true, force: true }); } };
}

test("managed payloads are bounded UUID entries and never arbitrary user paths", async () => {
  const f = await fixture();
  try {
    const path = await f.store.stage("note.log", Buffer.from("hello"), "windowA");
    assert.equal(f.store.manages(path), true);
    assert.equal(f.store.manages(f.store.root), false);
    assert.equal(f.store.manages(join(f.store.root, "..", "outside.txt")), false);
    assert.equal(f.store.manages(join(f.store.root, "not-a-uuid", "payload", "x")), false);
    assert.equal(await readFile(path, "utf8"), "hello");
    assert.equal(safeDroppedFileName("../secret.exe"), "secret.exe");
    assert.equal(safeDroppedFileName("CON.txt"), "_CON.txt");
    assert.ok(safeDroppedFileName("a".repeat(200) + ".pdf").endsWith(".pdf"));
    await assert.rejects(f.store.discard(join(f.root, "outside"), "windowA", 1), /路径无效/);
  } finally { await f.close(); }
});

test("one window cannot delete another window's leased attachment", async () => {
  const f = await fixture();
  try {
    const path = await f.store.stage("paper.pdf", Buffer.from("pdf"), "windowA");
    assert.deepEqual(await f.store.lease([path], "windowB", 1, true), []);
    await f.store.discard(path, "windowA", 2);
    await access(path);
    await f.store.discard(path, "windowB", 2);
    await assert.rejects(access(path));
  } finally { await f.close(); }
});

test("an out-of-order lease release cannot revoke a newer claim", async () => {
  const f = await fixture();
  try {
    const path = await f.store.stage("data.log", Buffer.from("data"), "windowA");
    await f.store.lease([path], "windowA", 5, true);
    await f.store.discard(path, "windowA", 4);
    await access(path);
    f.advance(STAGING_GRACE_MS + 1);
    assert.equal((await f.store.maintain()).removed, 0);
  } finally { await f.close(); }
});

test("sent-or-possibly-sent attachments survive card deletion, expiry and service replacement", async () => {
  const f = await fixture();
  try {
    const path = await f.store.stage("experiment.tex", Buffer.from("paper"), "windowA");
    await f.store.retain([path]);
    await f.store.discard(path, "windowA", 1);
    f.advance(3 * DRAFT_ATTACHMENT_LEASE_MS);
    const stats = await f.store.maintain();
    assert.equal(stats.retained, 1);
    assert.equal(stats.removed, 0);
    const restarted = new DroppedFileStore(f.store.root);
    await restarted.retain([path]);
    assert.equal(await readFile(path, "utf8"), "paper");
  } finally { await f.close(); }
});

test("abandoned staging expires after the grace period; an adopted draft has a 30-day lease", async () => {
  const f = await fixture();
  try {
    const orphan = await f.store.stage("orphan.txt", Buffer.from("o"), "windowA");
    const draft = await f.store.stage("draft.txt", Buffer.from("d"), "windowB");
    await f.store.lease([draft], "windowB", 1, true);
    f.advance(STAGING_GRACE_MS + 1);
    assert.equal((await f.store.maintain()).removed, 1);
    await assert.rejects(access(orphan));
    await access(draft);
    f.advance(DRAFT_ATTACHMENT_LEASE_MS);
    assert.equal((await f.store.maintain()).removed, 1);
    await assert.rejects(access(draft));
  } finally { await f.close(); }
});

test("cleanup and retention serialize across separate store instances", async () => {
  const f = await fixture();
  try {
    const path = await f.store.stage("result.csv", Buffer.from("result"), "windowA");
    const otherProcess = new DroppedFileStore(f.store.root);
    await otherProcess.retain([path]);
    f.advance(DRAFT_ATTACHMENT_LEASE_MS * 2);
    await Promise.all([f.store.maintain(), otherProcess.retain([path])]);
    await access(path);
  } finally { await f.close(); }
});

test("collection removes only its payload and bookkeeping, never unknown user files", async () => {
  const f = await fixture();
  try {
    const path = await f.store.stage("temporary.txt", Buffer.from("owned"), "windowA");
    const extra = join(dirname(dirname(path)), "user-note.txt");
    await writeFile(extra, "do not delete");
    f.advance(DRAFT_ATTACHMENT_LEASE_MS * 2);
    assert.equal((await f.store.maintain()).removed, 1);
    await assert.rejects(access(path));
    assert.equal(await readFile(extra, "utf8"), "do not delete");
  } finally { await f.close(); }
});

test("an acknowledgement from retain always wins against a simultaneous collector", async () => {
  const f = await fixture();
  try {
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const path = await f.store.stage(`race-${iteration}.txt`, Buffer.from("data"), "windowA");
      f.advance(DRAFT_ATTACHMENT_LEASE_MS * 2);
      const peer = new DroppedFileStore(f.store.root);
      const [, retained] = await Promise.allSettled([f.store.maintain(), peer.retain([path])]);
      if (retained.status === "fulfilled") await access(path);
      // A collector may win before retain, but then retain must reject and the
      // caller's preflight cannot forward the nonexistent path to Pi.
    }
  } finally { await f.close(); }
});

test("interrupted payload writes can be collected but cannot be retained or sent", async () => {
  const f = await fixture();
  try {
    const path = await f.store.stage("partial.bin", Buffer.from("complete payload"), "windowA");
    await writeFile(path, "part");
    await assert.rejects(f.store.retain([path]), /不存在或已被修改/);
    f.advance(DRAFT_ATTACHMENT_LEASE_MS + 1);
    assert.equal((await f.store.maintain()).removed, 1);
    await assert.rejects(access(path));
  } finally { await f.close(); }
});

test("a symlink payload never grants deletion of an outside file", async (t) => {
  const f = await fixture();
  try {
    const path = await f.store.stage("link.txt", Buffer.from("inside"), "windowA");
    const outside = join(f.root, "outside.txt");
    await writeFile(outside, "keep");
    await rm(path);
    try { await symlink(outside, path); }
    catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")) { t.skip("symlink privilege unavailable"); return; }
      throw error;
    }
    f.advance(DRAFT_ATTACHMENT_LEASE_MS * 2);
    await f.store.maintain();
    assert.equal(await readFile(outside, "utf8"), "keep");
    await assert.rejects(f.store.discard(path, "windowA", 1));
  } finally { await f.close(); }
});
