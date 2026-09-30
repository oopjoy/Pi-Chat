import assert from "node:assert/strict";
import test from "node:test";
import { readColdSessionView } from "../../src/server/services/cold-session-view";

const summary = { id: "s", sessionId: "pi-s", name: "S", preview: "", cwd: "C:\\work", updatedAt: 1, messageCount: 1, active: false };

test("cold Session view uses target-only recent projection before global inventory fallback", async () => {
  const calls: string[] = [];
  const view = await readColdSessionView({
    index: {
      recentSnapshotAndSummaryForId: async () => {
        calls.push("recent");
        return { summary, snapshot: { messages: [], settings: {} } };
      },
      summaryForId: () => null,
    } as never,
    activeSessionPath: () => undefined,
    currentCwd: () => "C:\\work",
    projectSnapshot: () => ({ session: summary } as never),
    projectMessages: async () => null,
    forkOrigin: async () => undefined,
  }, "s", 10, "client");
  assert.equal(view?.session.id, "s");
  assert.deepEqual(calls, ["recent"]);
});

test("cold Session view adds Fork provenance only after a successful view projection", async () => {
  const view = await readColdSessionView({
    index: {
      recentSnapshotAndSummaryForId: async () => null,
      snapshotAndSummaryForId: async () => ({ summary, snapshot: { messages: [], settings: {} } }),
      summaryForId: () => null,
    } as never,
    activeSessionPath: () => undefined,
    currentCwd: () => "C:\\work",
    projectSnapshot: () => ({ session: summary } as never),
    projectMessages: async () => null,
    forkOrigin: async () => ({ sourceSessionId: "source", sourceName: "Source", sourcePersistedMessageId: "u:0", createdAt: 1, sourceAvailable: true }),
  }, "s", 10, "client", true);
  assert.equal(view?.forkOrigin?.sourceSessionId, "source");
});
