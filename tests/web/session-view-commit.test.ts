import assert from "node:assert/strict";
import test from "node:test";
import { prepareSessionViewCommit } from "../../src/web/application/session-view-commit";
import type { SessionViewData } from "../../src/shared/types";

function view(overrides: Partial<SessionViewData> = {}): SessionViewData {
  return {
    session: {
      id: "session",
      sessionId: "session",
      name: "Session",
      preview: "",
      cwd: "C:\\workspace",
      updatedAt: 1,
      messageCount: 1,
      active: true,
      running: true,
    },
    state: { model: null, isStreaming: true },
    messages: [],
    messageTotal: 0,
    turnTotal: 0,
    messagesTruncated: false,
    isActive: true,
    isStreaming: true,
    queue: [],
    queuePaused: false,
    viewSource: "hot-memory",
    ...overrides,
  };
}

function ports(calls: string[], options: {
  deleted?: boolean;
  current?: boolean;
  compaction?: boolean;
  known?: boolean;
} = {}) {
  return {
    isDeleted: () => options.deleted === true,
    canCommit: () => options.current !== false,
    projectActive: () => ({ active: true, accepted: true }),
    completedCompaction: () => options.compaction === true,
    queueProjection: (_id: string, incoming: SessionViewData["queue"], paused: boolean) => ({
      queue: incoming || [],
      paused,
      known: options.known !== false,
    }),
    applyQueueToSession: (session: SessionViewData["session"]) => ({ ...session, queued: true }),
    commitCache: (candidate: SessionViewData) => {
      calls.push("cache");
      return candidate;
    },
    recordRejected: (_id: string, reason: string) => calls.push(`reject:${reason}`),
    recordAccepted: () => calls.push("accepted"),
  };
}

test("session view commit rejects deleted and stale authorities before active projection", () => {
  const deletedCalls: string[] = [];
  const deleted = prepareSessionViewCommit(view(), {}, undefined, ports(deletedCalls, { deleted: true }));
  assert.deepEqual(deleted, { kind: "rejected", reason: "session-deleted" });
  assert.deepEqual(deletedCalls, ["reject:session-deleted"]);

  const staleCalls: string[] = [];
  const stale = prepareSessionViewCommit(view(), {}, undefined, ports(staleCalls, { current: false }));
  assert.deepEqual(stale, { kind: "rejected", reason: "stale-authority" });
  assert.deepEqual(staleCalls, ["reject:stale-authority"]);
});

test("session view commit fences completed compaction before cache write", () => {
  const calls: string[] = [];
  const result = prepareSessionViewCommit(
    view({
      state: { model: null, isStreaming: true, isCompacting: true },
      toolStatus: "bash 已完成，Pi 正在继续…",
    }),
    {},
    3,
    ports(calls, { compaction: true }),
  );
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.equal(result.sourceView.toolStatus, "");
  assert.equal(result.sourceView.state.isCompacting, false);
  assert.equal(result.queueKnown, true);
  assert.deepEqual(calls, ["accepted", "cache"]);
});

test("unknown Queue does not manufacture an empty authoritative queue", () => {
  const result = prepareSessionViewCommit(
    view({ queue: undefined, queuePaused: false }),
    {},
    undefined,
    ports([], { known: false }),
  );
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(result.sourceView.queue, undefined);
  assert.equal(result.queueKnown, false);
});
