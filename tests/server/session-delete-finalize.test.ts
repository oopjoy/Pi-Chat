import assert from "node:assert/strict";
import test from "node:test";
import { finalizeSessionDelete } from "../../src/server/services/session-delete-finalize";

test("session delete finalize removes relation, cleans state, refreshes and bootstraps", async () => {
  const calls: string[] = [];
  const result = await finalizeSessionDelete({
    getForkOrigin: async () => undefined,
    removeForkDestination: async () => { calls.push("remove-relation"); },
    restoreForkOrigin: async () => { calls.push("restore"); },
    reportRelationFailure: () => {},
    validateDeletePath: async () => { calls.push("validate"); return "C:\\missing.jsonl"; },
    clearDeletedSessionState: () => { calls.push("clear"); },
    refreshSessions: async () => { calls.push("refresh"); },
    broadcastDeleted: () => { calls.push("broadcast"); },
    bootstrap: async () => { calls.push("bootstrap"); return { ok: true }; },
  }, "0123456789abcdef0123", undefined);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ["remove-relation", "clear", "refresh", "broadcast", "bootstrap"]);
});
