import assert from "node:assert/strict";
import test from "node:test";
import { reconcileSessionInventory } from "../../src/web/application/session-inventory-reconciliation";
import type { SessionSummary } from "../../src/shared/types";

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    sessionId: id,
    name: id,
    preview: "",
    cwd: "C:\\work",
    updatedAt: 1,
    messageCount: 1,
    turnCount: 1,
    active: false,
    ...overrides,
  };
}

test("session inventory reconciliation applies process facts without owning them", () => {
  const result = reconcileSessionInventory(
    [session("a", { running: false })],
    {
      runningOverrides: new Map([["a", true]]),
      queueProjections: new Map(),
      cachedQueues: new Map(),
      cancelledQueueIds: new Map(),
      sourceTurnTotals: new Map([["a", 3]]),
      localTurnTotal: () => 4,
      deletedSessionIds: new Set(),
      optimisticRenames: new Map([["a", { name: "Renamed" }]]),
    },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.running, true);
  assert.equal(result[0]?.turnCount, 4);
  assert.equal(result[0]?.name, "Renamed");
});

test("session inventory reconciliation filters deleted rows and cancelled queue entries", () => {
  const result = reconcileSessionInventory(
    [session("deleted"), session("kept")],
    {
      runningOverrides: new Map(),
      queueProjections: new Map([["kept", {
        paused: false,
        queue: [
          { id: "cancelled", message: "old", imageCount: 0, createdAt: 1 },
          { id: "kept", message: "new", imageCount: 0, createdAt: 2 },
        ],
      }]]),
      cachedQueues: new Map(),
      cancelledQueueIds: new Map([["kept", new Set(["cancelled"])]]) ,
      sourceTurnTotals: new Map(),
      localTurnTotal: () => 0,
      deletedSessionIds: new Set(["deleted"]),
      optimisticRenames: new Map(),
    },
  );
  assert.deepEqual(result.map((item) => item.id), ["kept"]);
  assert.equal(result[0]?.queued, true);
});
