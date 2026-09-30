import assert from "node:assert/strict";
import test from "node:test";
import {
  applyNativeSteeringClearEffect,
  applyNativeSteeringDequeueEffect,
  type PendingSteerProjection,
} from "../../src/web/application/stream-native-steering-effects";
import type { PendingSteer } from "../../src/shared/types";
import type { LocalUserTurn } from "../../src/web/lib/local-user-turn";

function steer(id: string, expectedTurnTotal: number): LocalUserTurn {
  return {
    sessionId: "session",
    queueId: id,
    queueState: "waiting",
    revealOnMessageStart: true,
    expectedTurnTotal,
    message: { role: "user", content: id },
    renderedInTranscript: false,
  };
}

function pending(id: string): PendingSteer {
  return { id, message: id, createdAt: 1 };
}

test("native dequeue removes only confirmed turns and restores their Composer draft", () => {
  const a = steer("a", 2);
  const b = steer("b", 3);
  let turns = [a, b];
  let projection: PendingSteerProjection | undefined = {
    revision: 4,
    items: [pending("a"), pending("b")],
  };
  let pendingItems = [pending("a"), pending("b")];
  const calls: string[] = [];
  const applied = applyNativeSteeringDequeueEffect({
    sessionId: "session",
    ids: ["a"],
    revision: 5,
  }, {
    projection: () => projection,
    commitProjection: (_, next) => { projection = next; },
    localTurns: () => turns,
    storeLocalTurns: (_, next) => { turns = next; },
    pendingSteers: () => pendingItems,
    syncPendingSteers: (_, next) => { pendingItems = next; },
    clearDequeueing: () => calls.push("clear-dequeueing"),
    sourceTurnTotal: () => 1,
    updateTurnTotal: (_, total) => calls.push(`turn-total:${total}`),
    removeVisibleTurns: (_, messages) => calls.push(`remove-visible:${messages.size}`),
    restoreComposerDrafts: (_, withdrawn, byId) => {
      calls.push(`restore:${withdrawn.map((turn) => turn.queueId).join(",")}:${byId.size}`);
    },
  });

  assert.equal(applied, true);
  assert.deepEqual(projection, { revision: 5, items: [pending("b")] });
  assert.deepEqual(pendingItems, [pending("b")]);
  assert.deepEqual(turns, [{ ...b, expectedTurnTotal: 2 }]);
  assert.deepEqual(calls, [
    "clear-dequeueing",
    "turn-total:2",
    "remove-visible:1",
    "restore:a:2",
  ]);
});

test("stale native dequeue cannot mutate a newer pending-Steer projection", () => {
  const initial: PendingSteerProjection = { revision: 7, items: [pending("a")] };
  const applied = applyNativeSteeringDequeueEffect({
    sessionId: "session",
    ids: ["a"],
    revision: 6,
  }, {
    projection: () => initial,
    commitProjection: () => assert.fail("stale dequeue must not commit"),
    localTurns: () => [steer("a", 1)],
    storeLocalTurns: () => assert.fail("stale dequeue must not edit turns"),
    pendingSteers: () => [pending("a")],
    syncPendingSteers: () => assert.fail("stale dequeue must not edit pending list"),
    clearDequeueing: () => assert.fail("stale dequeue must not clear current operation"),
    sourceTurnTotal: () => 0,
    updateTurnTotal: () => assert.fail("stale dequeue must not update sidebar"),
    removeVisibleTurns: () => assert.fail("stale dequeue must not edit pane"),
    restoreComposerDrafts: () => assert.fail("stale dequeue must not restore a draft"),
  });
  assert.equal(applied, false);
});

test("native clear drops waiting Steers and reports only an accepted reset", () => {
  const waiting = steer("a", 1);
  const dispatched = { ...steer("b", 2), queueState: "dispatched" as const };
  let turns = [waiting, dispatched];
  const calls: string[] = [];
  const applied = applyNativeSteeringClearEffect({
    sessionId: "session",
    revision: 3,
    droppedCount: 1,
  }, {
    projection: () => ({ revision: 2, items: [pending("a")] }),
    commitProjection: (_, next) => calls.push(`projection:${next.revision}:${next.items.length}`),
    localTurns: () => turns,
    storeLocalTurns: (_, next) => { turns = next; },
    syncPendingSteers: (_, next) => calls.push(`pending:${next.length}`),
    removeVisibleTurns: (_, messages) => calls.push(`visible:${messages.size}`),
    reportDropped: () => calls.push("dropped"),
  });

  assert.equal(applied, true);
  assert.deepEqual(turns, [dispatched]);
  assert.deepEqual(calls, ["projection:3:0", "pending:0", "visible:1", "dropped"]);
});
