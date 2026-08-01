import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../src/shared/types";
import { uniqueSessionSummaries } from "../src/web/lib/session-summary";

const summary = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  id, sessionId: id, name: id, preview: "", cwd: "C:/work", updatedAt: 1, messageCount: 1, ...patch,
});

test("sidebar session reconciliation keeps exactly one row for each stable Session ID", () => {
  const merged = uniqueSessionSummaries([
    summary("a", { name: "old", preview: "old snapshot" }),
    summary("b"),
    summary("a", { name: "new", preview: "authoritative snapshot", updatedAt: 2 }),
  ]);
  assert.deepEqual(merged.map((session) => session.id), ["a", "b"]);
  assert.deepEqual(merged[0], summary("a", { name: "new", preview: "authoritative snapshot", updatedAt: 2 }));
});
