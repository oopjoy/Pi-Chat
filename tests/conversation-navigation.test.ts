import assert from "node:assert/strict";
import test from "node:test";
import { adjacentUserMessageOffset } from "../src/web/lib/conversation-navigation";

test("previous and next conversation navigation selects only user-message offsets", () => {
  // Actual DOM order would be user 0, agent 160, user 400, agent 560, user 800.
  // The Agent offsets deliberately do not enter this input.
  const userOffsets = [0, 400, 800];
  assert.equal(adjacentUserMessageOffset(userOffsets, 20, "next"), 400);
  assert.equal(adjacentUserMessageOffset(userOffsets, 420, "next"), 800);
  assert.equal(adjacentUserMessageOffset(userOffsets, 780, "previous"), 400);
  // A navigation target is placed at offset - 14px, so after landing on 400,
  // the following previous action starts around 386px and selects the prior user turn.
  assert.equal(adjacentUserMessageOffset(userOffsets, 386, "previous"), 0);
});

test("conversation navigation stops cleanly at first and last user messages", () => {
  assert.equal(adjacentUserMessageOffset([0, 400], 450, "next"), null);
  assert.equal(adjacentUserMessageOffset([0, 400], 0, "previous"), null);
});
