import assert from "node:assert/strict";
import test from "node:test";
import { SessionScrollMemory } from "../src/web/lib/session-scroll-memory";

test("a conversation restores its previous reading position inside one window", () => {
  const memory = new SessionScrollMemory();
  memory.remember("session-a", 1_240, 6_000, 800, 40);
  memory.remember("session-b", 4_195, 5_000, 800, 20);

  assert.deepEqual(memory.target("session-a", 6_500, 800), { top: 1_240, stickToBottom: false });
  assert.equal(memory.turns("session-a"), 40);
  assert.deepEqual(memory.target("session-b", 5_500, 800), { top: 5_500, stickToBottom: true });
});

test("restoration clamps positions after content shrinks and unknown sessions start at the bottom", () => {
  const memory = new SessionScrollMemory();
  memory.remember("session-a", 3_500, 5_000, 800, 30);

  assert.deepEqual(memory.target("session-a", 2_400, 800), { top: 1_600, stickToBottom: false });
  assert.deepEqual(memory.target("session-new", 4_000, 800), { top: 4_000, stickToBottom: true });
  memory.forget("session-a");
  assert.equal(memory.turns("session-a"), undefined);
});
