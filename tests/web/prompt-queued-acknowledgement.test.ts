import assert from "node:assert/strict";
import test from "node:test";
import { reconcileQueuedPromptAcknowledgement } from "../../src/web/application/prompt-queued-acknowledgement";

test("queued acknowledgement reconciliation moves queue effects through explicit sinks", () => {
  const calls: string[] = [];
  const message = { role: "user", content: "queued" } as const;
  const authority = { sessionId: "session", navigationEpoch: 1, runEpochGeneration: 1, cacheGeneration: 1, revision: 1 } as never;
  const turn = {
    sessionId: "session", message, queueState: "waiting", renderedInTranscript: true, expectedTurnTotal: 1,
  } as never;
  reconcileQueuedPromptAcknowledgement({
    sessionId: "session",
    authority,
    queuedTurn: turn,
    acknowledgedQueue: [{ id: "queue", message: "queued", imageCount: 0, createdAt: 1 }],
    acknowledgedPaused: false,
    promotedTurns: [],
    alreadyStreaming: false,
    previousToolStatus: "",
  }, {
    patchSessionCache: () => calls.push("cache"),
    commitPane: () => { calls.push("pane"); return true; },
    updateSidebarQueue: () => calls.push("sidebar"),
    showNotice: (message) => calls.push(message),
  });
  assert.deepEqual(calls, ["pane", "cache", "sidebar", "消息已加入队列"]);
  assert.equal(turn.renderedInTranscript, false);
});
