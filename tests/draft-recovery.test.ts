import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { installAppDom } from "./helpers/app-dom";
import { DraftRecoveryStore, DRAFT_RETENTION_MS } from "../src/web/lib/draft-recovery";
import { composerPartition, composerReducer, emptyComposerState } from "../src/web/state/composer";

const key = { kind: "session" as const, sessionId: "saved-session" };
const image = { type: "image" as const, data: "YQ==", mimeType: "image/png", fileName: "plot.png", size: 1 };
function partition(message: string, withImage = false) {
  return composerPartition(composerReducer(emptyComposerState(), {
    type: "replace", key, message, images: withImage ? [image] : [], files: ["C:/work/paper.pdf"],
  }), key);
}
function dbFixture() {
  const f = installAppDom();
  Object.defineProperty(f.dom.window, "indexedDB", { configurable: true, value: new IDBFactory() });
  return f;
}

test("text, images and local paths survive a store replacement without restoring a send queue", async () => {
  const f = dbFixture();
  try {
    const first = new DraftRecoveryStore();
    first.persist(key, partition("long scientific question", true));
    await first.flush();
    const replacement = new DraftRecoveryStore();
    const records = await replacement.discover(key);
    assert.equal(records.length, 1);
    const restored = await replacement.load(records[0]);
    assert.equal(restored.drafts[0].message, "long scientific question");
    assert.deepEqual(restored.drafts[0].images, [image]);
    assert.deepEqual(restored.drafts[0].files, ["C:/work/paper.pdf"]);
    assert.deepEqual(restored.missingImages, []);
    assert.equal("pending" in restored, false);
    assert.equal("inFlight" in restored, false);
    assert.deepEqual(await replacement.discover({ kind: "session", sessionId: "unrelated" }), []);
  } finally { f.dispose(); }
});

test("remounting an editor in the same page cannot let a late old acknowledgement erase the new draft", async () => {
  const f = dbFixture();
  try {
    const oldEditor = new DraftRecoveryStore();
    const newEditor = new DraftRecoveryStore();
    assert.notEqual(oldEditor.owner, newEditor.owner);
    oldEditor.persist(key, partition("old pending send"));
    newEditor.persist(key, partition("new editor text"));
    await Promise.all([oldEditor.flush(), newEditor.flush()]);
    oldEditor.persist(key, composerPartition(emptyComposerState(), key));
    await oldEditor.flush();
    const records = await newEditor.discover(key);
    assert.equal(records.length, 1);
    assert.equal(records[0].frames[0].message, "new editor text");
  } finally { f.dispose(); }
});

test("a backup that was acknowledged or changed in another window is rechecked before recovery", async () => {
  const f = dbFixture();
  try {
    const writer = new DraftRecoveryStore();
    writer.persist(key, partition("old version"));
    await writer.flush();
    const reader = new DraftRecoveryStore();
    const source = (await reader.discover(key))[0];
    writer.persist(key, composerPartition(emptyComposerState(), key));
    await assert.rejects(reader.load(source), /已更新、已发送或已失效/);
    await writer.flush();
  } finally { f.dispose(); }
});

test("the synchronous text journal is newer than an unfinished async image save", async () => {
  const f = dbFixture();
  try {
    const store = new DraftRecoveryStore();
    store.persist(key, partition("older"));
    await store.flush();
    store.persist(key, partition("latest keystroke before close"));
    // Deliberately do not flush this update: this is the close/crash window.
    const records = await new DraftRecoveryStore().discover(key);
    assert.equal(records[0].frames[0].message, "latest keystroke before close");
    await store.flush();
  } finally { f.dispose(); }
});

test("scientific text and Windows path backslashes round-trip byte-for-byte", async () => {
  const f = dbFixture();
  try {
    const message = ["中文科研说明", "$$", "@@begin{aligned}", "@@nabla u + @@frac{1}{2} &= 0", "@@end{aligned}", "$$", "C:@@work@@experiment.log"].join("\n").replaceAll("@@", String.fromCharCode(92));
    const store = new DraftRecoveryStore();
    store.persist(key, partition(message));
    await store.flush();
    const recovered = await store.load((await store.discover(key))[0]);
    assert.equal(recovered.drafts[0].message, message);
  } finally { f.dispose(); }
});

test("an acknowledged empty draft cannot resurrect an older database record", async () => {
  const f = dbFixture();
  try {
    const store = new DraftRecoveryStore();
    store.persist(key, partition("already sent"));
    await store.flush();
    store.persist(key, composerPartition(emptyComposerState(), key));
    assert.deepEqual(await new DraftRecoveryStore().discover(key), []);
    await store.flush();
  } finally { f.dispose(); }
});

test("pending and in-flight input recovers only as ordinary drafts with an uncertainty warning", async () => {
  const f = dbFixture();
  try {
    let state = composerReducer(emptyComposerState(), { type: "edit", key, message: "A" });
    state = composerReducer(state, { type: "accept", retry: false, snapshot: { ...composerPartition(state, key).draft, key, delivery: "queue" } });
    state = composerReducer(state, { type: "start-delivery", key });
    const store = new DraftRecoveryStore();
    store.persist(key, composerPartition(state, key));
    await store.flush();
    const record = (await store.discover(key))[0];
    const recovered = await store.load(record);
    assert.equal(recovered.drafts[0].recoveryWarning, "delivery-uncertain");
    const restored = composerReducer(emptyComposerState(), { type: "recover-persisted", key, drafts: recovered.drafts });
    assert.equal(composerPartition(restored, key).draft.message, "A");
    assert.equal(composerPartition(restored, key).pending.length, 0);
    assert.equal(composerPartition(restored, key).inFlight, undefined);
  } finally { f.dispose(); }
});

test("storage denial preserves the text fallback and reports missing images instead of ghost thumbnails", async () => {
  const f = installAppDom();
  const warnings: string[] = [];
  try {
    const store = new DraftRecoveryStore((message) => warnings.push(message));
    store.persist(key, partition("keep my text", true));
    await store.flush();
    const record = (await store.discover(key))[0];
    const restored = await store.load(record);
    assert.equal(restored.drafts[0].message, "keep my text");
    assert.deepEqual(restored.drafts[0].images, []);
    assert.deepEqual(restored.missingImages, ["plot.png"]);
    assert.ok(warnings.some((message) => message.includes("图片草稿未能保存")));
  } finally { f.dispose(); }
});

test("two pages keep separate records and consuming one exact revision does not overwrite the other", async () => {
  const f = dbFixture();
  const first = new DraftRecoveryStore();
  first.persist(key, partition("window A"));
  await first.flush();
  const other = installAppDom();
  Object.defineProperty(other.dom.window, "localStorage", { value: f.dom.window.localStorage });
  Object.defineProperty(other.dom.window, "indexedDB", { value: f.dom.window.indexedDB });
  try {
    const second = new DraftRecoveryStore();
    second.persist(key, partition("window B"));
    await second.flush();
    const records = await second.discover(key);
    assert.equal(records.length, 2);
    assert.notEqual(records[0].owner, records[1].owner);
    const source = records.find((record) => record.owner === first.owner)!;
    second.consume(source);
    assert.equal((await second.discover(key)).length, 1);
    first.persist(key, partition("window A newer edit"));
    await first.flush();
    assert.equal((await second.discover(key)).length, 2, "a receipt never hides a later edit");
  } finally { other.dispose(); f.dispose(); }
});

test("clearing backups invalidates queued writes and keeps current editor data out of storage until edited again", async () => {
  const f = dbFixture();
  try {
    const writer = new DraftRecoveryStore();
    writer.persist(key, partition("must disappear", true));
    // A second instance is how the settings panel clears storage while the
    // Composer's asynchronous write may still be queued.
    const settings = new DraftRecoveryStore();
    await settings.clear();
    await writer.flush();
    writer.persist(key, partition("heartbeat must not resurrect this"), true);
    await writer.flush();
    assert.deepEqual(await settings.discover(key), []);
    writer.persist(key, partition("a later deliberate edit"));
    await writer.flush();
    assert.equal((await settings.discover(key))[0].frames[0].message, "a later deliberate edit");
  } finally { f.dispose(); }
});

test("an edit made after a clear starts is not erased by that clear transaction", async () => {
  const f = dbFixture();
  try {
    const writer = new DraftRecoveryStore();
    writer.persist(key, partition("old", true));
    await writer.flush();
    const clearing = writer.clear();
    writer.persist(key, partition("new deliberate edit during cleanup", true));
    await Promise.all([clearing, writer.flush()]);
    const source = (await writer.discover(key))[0];
    assert.equal(source.frames[0].message, "new deliberate edit during cleanup");
    assert.deepEqual((await writer.load(source)).drafts[0].images, [image]);
    assert.equal(writer.needsCloseWarning(), false);
  } finally { f.dispose(); }
});

test("a full synchronous journal falls back to IndexedDB without losing the current text", async () => {
  const f = dbFixture();
  const warnings: string[] = [];
  const original = Object.getOwnPropertyDescriptor(f.dom.window.Storage.prototype, "setItem")!;
  Object.defineProperty(f.dom.window.Storage.prototype, "setItem", { configurable: true, value: () => { throw new Error("quota"); } });
  try {
    const store = new DraftRecoveryStore((message) => warnings.push(message));
    store.persist(key, partition("long text survives journal quota"));
    await store.flush();
    assert.equal((await store.discover(key))[0].frames[0].message, "long text survives journal quota");
    assert.ok(warnings.some((warning) => warning.includes("空间不足")));
  } finally {
    Object.defineProperty(f.dom.window.Storage.prototype, "setItem", original);
    f.dispose();
  }
});

test("expired backups and their unused image bodies are collected after 30 days", async () => {
  const f = dbFixture();
  const now = Date.now;
  let clock = now();
  Date.now = () => clock;
  try {
    const store = new DraftRecoveryStore();
    store.persist(key, partition("expired", true));
    await store.flush();
    clock += DRAFT_RETENTION_MS + 1;
    await store.cleanup();
    assert.deepEqual(await store.discover(key), []);
    assert.equal(f.dom.window.localStorage.length, 0);
  } finally { Date.now = now; f.dispose(); }
});
