import assert from "node:assert/strict";
import test from "node:test";
import { isAtBottom, SessionScrollMemory, sessionTurnWindow } from "../src/web/lib/session-scroll-memory";

test("a conversation restores its previous reading position inside one window", () => {
  const memory = new SessionScrollMemory();
  memory.remember("session-a", 1_240, 6_000, 800, 40);
  memory.remember("session-b", 4_195, 5_000, 800, 20);

  assert.deepEqual(memory.target("session-a", 6_500, 800), { top: 1_240, stickToBottom: false });
  assert.equal(memory.turns("session-a"), 40);
  assert.deepEqual(memory.target("session-b", 5_500, 800), { top: 5_500, stickToBottom: true });
});

test("remembered turn counts always use a Session view API window", () => {
  assert.equal(sessionTurnWindow(0), undefined);
  assert.equal(sessionTurnWindow(Number.NaN), undefined);
  assert.equal(sessionTurnWindow(4), 10);
  assert.equal(sessionTurnWindow(10), 10);
  assert.equal(sessionTurnWindow(11), 20);
  assert.equal(sessionTurnWindow(20), 20);
  assert.equal(sessionTurnWindow(21), 30);
  assert.equal(sessionTurnWindow(25), 30);
  assert.equal(sessionTurnWindow(46), 50);
  assert.equal(sessionTurnWindow(10_001), 10_000);
  assert.equal(sessionTurnWindow(Number.POSITIVE_INFINITY), undefined);

  const memory = new SessionScrollMemory();
  memory.remember("short-hot-session", 0, 800, 800, 4);
  assert.equal(memory.turns("short-hot-session"), 10);
});

test("bottom detection uses the same tight tolerance as restoration", () => {
  assert.equal(isAtBottom(975, 2_000, 1_000), false);
  assert.equal(isAtBottom(999, 2_000, 1_000), true);
});

test("a nearby reading position is not mistaken for the bottom", () => {
  const memory = new SessionScrollMemory();
  // scrollHeight - top - clientHeight = 25px: this is visibly above the
  // newest reply and must be restored as an exact reading position.
  memory.remember("near-bottom", 975, 2_000, 1_000, 10);
  assert.deepEqual(memory.target("near-bottom", 2_000, 1_000), { top: 975, stickToBottom: false });

  memory.remember("at-bottom", 999, 2_000, 1_000, 10);
  assert.deepEqual(memory.target("at-bottom", 2_000, 1_000), { top: 2_000, stickToBottom: true });
});

test("restoration clamps positions after content shrinks and unknown sessions start at the bottom", () => {
  const memory = new SessionScrollMemory();
  memory.remember("session-a", 3_500, 5_000, 800, 30);

  assert.deepEqual(memory.target("session-a", 2_400, 800), { top: 1_600, stickToBottom: false });
  assert.deepEqual(memory.target("session-new", 4_000, 800), { top: 4_000, stickToBottom: true });
  memory.forget("session-a");
  assert.equal(memory.turns("session-a"), undefined);
});
