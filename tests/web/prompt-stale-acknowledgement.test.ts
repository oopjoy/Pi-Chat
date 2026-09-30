import assert from "node:assert/strict";
import test from "node:test";
import { reconcileStalePromptAcknowledgement } from "../../src/web/application/prompt-stale-acknowledgement";

test("stale acknowledgement restores same-session Queue without painting another Pane", () => {
  const calls: string[] = [];
  reconcileStalePromptAcknowledgement({
    sessionId: "s",
    queued: true,
    queue: [{ id: "q", message: "queued", imageCount: 0, createdAt: 1 }],
    queuePaused: false,
    navigationEpochMatches: true,
    viewingSameSession: true,
    desiredSameSession: true,
    authority: {} as never,
    previousToolStatus: "busy",
  }, {
    patchSessionCache: () => calls.push("cache"),
    capturePaneAuthority: () => ({}) as never,
    commitPane: () => { calls.push("pane"); return true; },
    updateSidebarQueue: () => calls.push("sidebar"),
    scheduleSidebarRefresh: () => calls.push("refresh"),
  });
  assert.deepEqual(calls, ["cache", "pane", "sidebar", "refresh"]);
});
