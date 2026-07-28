import assert from "node:assert/strict";
import test from "node:test";
import { activeSessionIdsFromEvent, applyActiveSessionIds } from "../src/web/lib/active-sessions";

test("empty activeSessionIds event clears every stale writable Session", () => {
  const sessions = [
    { id: "a", name: "A", preview: "", cwd: "C:/", updatedAt: 1, messageCount: 1, writable: true, releasable: true },
    { id: "b", name: "B", preview: "", cwd: "C:/", updatedAt: 1, messageCount: 1, writable: true, releasable: true },
  ];
  const ids = activeSessionIdsFromEvent([]);
  assert.deepEqual(ids, []);
  const updated = applyActiveSessionIds(sessions, ids);
  assert.deepEqual(updated.map((session) => session.writable), [false, false]);
  assert.deepEqual(updated.map((session) => session.releasable), [false, false]);
});

test("active Session event filters invalid IDs and updates writable state", () => {
  const sessions = [
    { id: "a", name: "A", preview: "", cwd: "C:/", updatedAt: 1, messageCount: 1 },
    { id: "b", name: "B", preview: "", cwd: "C:/", updatedAt: 1, messageCount: 1 },
  ];
  const ids = activeSessionIdsFromEvent(["b", null, 3]);
  assert.deepEqual(ids, ["b"]);
  const updated = applyActiveSessionIds(sessions, ids);
  assert.deepEqual(updated.map((session) => session.writable), [false, true]);
  assert.equal(updated[0].releasable, false);
});
