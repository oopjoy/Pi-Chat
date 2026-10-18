import assert from "node:assert/strict";
import test from "node:test";
import {
  composerAcceptError,
  composerPartition,
  composerPendingUsage,
  composerReducer,
  emptyComposerState,
  type ComposerState,
} from "../src/web/state/composer";

const key = { kind: "session" as const, sessionId: "repeated-failure" };
const image = { type: "image" as const, data: "YQ==", mimeType: "image/png", fileName: "B.png" };
const fileB = "C:/notes/B.log";
const fileC = "C:/notes/C.pdf";

function send(state: ComposerState, retry: boolean): ComposerState {
  const draft = composerPartition(state, key).draft;
  assert.equal(composerAcceptError(state, { ...draft, key, delivery: "queue" }, retry), null);
  state = composerReducer(state, { type: "accept", snapshot: { ...draft, key, delivery: "queue" }, retry });
  return composerReducer(state, { type: "start-delivery", key });
}

function rejectedTwice(): ComposerState {
  let state = composerReducer(emptyComposerState(), { type: "edit", key, message: "A" });
  state = send(state, false);
  state = composerReducer(state, { type: "replace", key, message: "B", images: [image], files: [fileB] });
  state = composerReducer(state, { type: "delivery-rejected", key, error: "first rejection" });
  state = send(state, true);
  state = composerReducer(state, { type: "replace", key, message: "C", images: [], files: [fileC] });
  return composerReducer(state, { type: "delivery-rejected", key, error: "second rejection" });
}

test("consecutive definite failures preserve B and C with their images and files", () => {
  const state = rejectedTwice();
  const partition = composerPartition(state, key);
  assert.equal(partition.draft.message, "A");
  assert.deepEqual(partition.suspended?.map((draft) => draft.message), ["B", "C"]);
  assert.deepEqual(partition.suspended?.[0].images, [image]);
  assert.deepEqual(partition.suspended?.[0].files, [fileB]);
  assert.deepEqual(partition.suspended?.[1].files, [fileC]);
  assert.equal(partition.pending.length, 0, "retained editor drafts are not send-queue entries");
  assert.equal(partition.inFlight, undefined);
});

test("successful retry restores B first, and C remains manually recoverable without sending", () => {
  let state = send(rejectedTwice(), true);
  state = composerReducer(state, { type: "delivery-accepted", key });
  const before = composerPartition(state, key);
  assert.equal(before.draft.message, "B");
  assert.deepEqual(before.draft.images, [image]);
  assert.deepEqual(before.suspended?.map((draft) => draft.message), ["C"]);
  state = composerReducer(state, { type: "recover-suspended", key });
  const after = composerPartition(state, key);
  assert.equal(after.draft.message, "C");
  assert.deepEqual(after.draft.files, [fileC]);
  assert.deepEqual(after.suspended?.map((draft) => draft.message), ["B"], "switching drafts does not overwrite the editor");
  assert.ok(after.draft.revision > before.draft.revision);
  assert.equal(after.pending.length, 0);
  assert.equal(after.inFlight, undefined);
  state = composerReducer(state, { type: "recover-suspended", key });
  assert.equal(composerPartition(state, key).draft.message, "B");
  assert.deepEqual(composerPartition(state, key).draft.images, [image]);
});

test("retained drafts stay Session-local and cannot replace an in-flight draft", () => {
  let state = rejectedTwice();
  const other = { kind: "session" as const, sessionId: "other" };
  const unchanged = composerReducer(state, { type: "recover-suspended", key: other });
  assert.equal(unchanged, state);
  state = send(state, true);
  assert.equal(composerReducer(state, { type: "recover-suspended", key }), state);
});

test("every retained draft counts toward local memory and snapshot budgets, then forget releases them", () => {
  let state = rejectedTwice();
  const usage = composerPendingUsage(state);
  assert.equal(usage.snapshots, 3, "two retained drafts plus the failed send");
  assert.ok(usage.imageBytes > 0);
  assert.ok(usage.payloadBytes > 0);
  state = composerReducer(state, { type: "forget", key });
  assert.deepEqual(composerPendingUsage(state), { snapshots: 0, imageBytes: 0, payloadBytes: 0 });
});
