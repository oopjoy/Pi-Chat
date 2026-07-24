import assert from "node:assert/strict";
import test from "node:test";
import { SessionScrollMemory, sessionTurnWindow } from "../src/web/lib/session-scroll-memory";

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
  assert.equal(sessionTurnWindow(4), 20);
  assert.equal(sessionTurnWindow(10), 20);
  assert.equal(sessionTurnWindow(20), 20);
  assert.equal(sessionTurnWindow(21), 30);
  assert.equal(sessionTurnWindow(25), 30);
  assert.equal(sessionTurnWindow(46), 50);
  assert.equal(sessionTurnWindow(10_001), 10_000);
  assert.equal(sessionTurnWindow(Number.POSITIVE_INFINITY), undefined);

  const memory = new SessionScrollMemory();
  memory.remember("short-hot-session", 0, 800, 800, 4);
  assert.equal(memory.turns("short-hot-session"), 20);
});

test("restoration clamps positions after content shrinks and unknown sessions start at the bottom", () => {
  const memory = new SessionScrollMemory();
  memory.remember("session-a", 3_500, 5_000, 800, 30);

  assert.deepEqual(memory.target("session-a", 2_400, 800), { top: 1_600, stickToBottom: false });
  assert.deepEqual(memory.target("session-new", 4_000, 800), { top: 4_000, stickToBottom: true });
  memory.forget("session-a");
  assert.equal(memory.turns("session-a"), undefined);
});
