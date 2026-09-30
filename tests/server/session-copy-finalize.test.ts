import assert from "node:assert/strict";
import test from "node:test";
import { finalizeSessionCopy } from "../../src/server/services/session-copy-finalize";

test("session copy finalize verifies projection before releasing the outcome fence", async () => {
  const calls: string[] = [];
  const result = await finalizeSessionCopy({
    host: {
      now: () => 1,
      recordFork: async () => { calls.push("fork"); },
      reportRelationFailure: () => {},
      listSessions: async () => { calls.push("list"); },
      summaryForId: () => ({ id: "new", sessionId: "pi-new", name: "New", preview: "", cwd: "C:\\work", updatedAt: 1, messageCount: 1, active: false }),
      pathForId: () => "C:\\work\\new.jsonl",
      markProjectionPending: () => { calls.push("pending"); },
      clearOutcome: () => { calls.push("clear"); },
      broadcastCopied: () => { calls.push("broadcast"); },
    },
    sourceSessionId: "source",
    sourceName: "Source",
    mode: "fork",
    copied: { sessionId: "new", piSessionId: "pi-new", sessionPath: "C:\\work\\new.jsonl" },
    forkTarget: { text: "fork", images: [] },
    persistedMessageId: "entry:0",
  });
  assert.equal(result.session.id, "new");
  assert.equal(result.forkOrigin?.sourceSessionId, "source");
  assert.deepEqual(calls, ["fork", "list", "clear", "broadcast"]);
});
