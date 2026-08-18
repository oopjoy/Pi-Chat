import assert from "node:assert/strict";
import test from "node:test";
import {
  composerDraftKeyId,
  composerPartition,
  composerReducer,
  emptyComposerState,
  type ComposerDraftKey,
  type ComposerSnapshot,
} from "../src/web/state/composer";

const session = (sessionId: string): ComposerDraftKey => ({ kind: "session", sessionId });
const fresh = (generation: number): ComposerDraftKey => ({ kind: "new", generation });

function snapshot(key: ComposerDraftKey, message: string): ComposerSnapshot {
  return { key, message, images: [], revision: 1, delivery: "queue" };
}

test("Composer reducer partitions existing Sessions and New generations", () => {
  let state = emptyComposerState();
  state = composerReducer(state, { type: "edit", key: session("A"), message: "A draft" });
  state = composerReducer(state, { type: "edit", key: session("B"), message: "B draft" });
  state = composerReducer(state, { type: "edit", key: fresh(1), message: "first New" });
  state = composerReducer(state, { type: "edit", key: fresh(2), message: "second New" });

  assert.equal(composerPartition(state, session("A")).draft.message, "A draft");
  assert.equal(composerPartition(state, session("B")).draft.message, "B draft");
  assert.equal(composerPartition(state, fresh(1)).draft.message, "first New");
  assert.equal(composerPartition(state, fresh(2)).draft.message, "second New");
  assert.notEqual(composerDraftKeyId(fresh(1)), composerDraftKeyId(fresh(2)));
});

test("Composer reducer retains an immutable accepted snapshot across later edits", () => {
  const key = session("A");
  let state = composerReducer(emptyComposerState(), { type: "edit", key, message: "first" });
  const accepted = snapshot(key, "first");
  state = composerReducer(state, { type: "accept", snapshot: accepted, retry: false });
  accepted.images.push({ type: "image", data: "mutated", mimeType: "image/png" });
  state = composerReducer(state, { type: "edit", key, message: "later draft" });

  const partition = composerPartition(state, key);
  assert.equal(partition.pending[0]?.message, "first");
  assert.equal(partition.pending[0]?.images.length, 0);
  assert.equal(partition.draft.message, "later draft");
});

test("Composer reducer restores a definite failure without losing a newer draft", () => {
  const key = session("A");
  let state = composerReducer(emptyComposerState(), { type: "edit", key, message: "send me" });
  state = composerReducer(state, { type: "accept", snapshot: snapshot(key, "send me"), retry: false });
  state = composerReducer(state, { type: "start-delivery", key });
  state = composerReducer(state, { type: "edit", key, message: "newer text" });
  state = composerReducer(state, { type: "delivery-rejected", key });

  let partition = composerPartition(state, key);
  assert.equal(partition.draft.message, "send me");
  assert.equal(partition.suspended?.message, "newer text");
  assert.equal(partition.blocked?.message, "send me");

  state = composerReducer(state, { type: "accept", snapshot: snapshot(key, "send me"), retry: true });
  state = composerReducer(state, { type: "start-delivery", key });
  state = composerReducer(state, { type: "delivery-accepted", key });
  partition = composerPartition(state, key);
  assert.equal(partition.draft.message, "newer text");
  assert.equal(partition.blocked, undefined);
});

test("Composer reducer never restores an outcome-unknown snapshot", () => {
  const key = session("A");
  let state = composerReducer(emptyComposerState(), { type: "edit", key, message: "do not retry" });
  state = composerReducer(state, { type: "accept", snapshot: snapshot(key, "do not retry"), retry: false });
  state = composerReducer(state, { type: "start-delivery", key });
  state = composerReducer(state, { type: "delivery-unknown", key });

  const partition = composerPartition(state, key);
  assert.equal(partition.draft.message, "");
  assert.equal(partition.blocked, undefined);
  assert.equal(partition.pending.length, 0);
  assert.equal(partition.inFlight, undefined);
});

test("Composer reducer fences cancelled-queue restoration by partition revision", () => {
  const key = session("A");
  let state = composerReducer(emptyComposerState(), { type: "edit", key, message: "new work" });
  const revision = composerPartition(state, key).draft.revision;
  state = composerReducer(state, { type: "edit", key, message: "newer work" });
  state = composerReducer(state, {
    type: "restore-cancelled",
    key,
    expectedRevision: revision,
    message: "cancelled queue item",
    images: [],
  });
  assert.equal(composerPartition(state, key).draft.message, "newer work");

  state = composerReducer(state, {
    type: "restore-cancelled",
    key: session("B"),
    expectedRevision: 0,
    message: "B cancellation",
    images: [],
  });
  assert.equal(composerPartition(state, key).draft.message, "newer work");
  assert.equal(composerPartition(state, session("B")).draft.message, "B cancellation");
});
