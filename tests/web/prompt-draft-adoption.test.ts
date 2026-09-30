import assert from "node:assert/strict";
import test from "node:test";
import { adoptDraftSessionView } from "../../src/web/application/prompt-draft-adoption";

test("draft adoption commits the new Session view through explicit pane/cache ports", () => {
  const calls: string[] = [];
  const result = adoptDraftSessionView({
    initial: {
      sessionId: "session",
      session: { id: "session" },
      state: { isStreaming: false },
      gateMode: "strict",
      accepted: true,
      queued: false,
    } as never,
    targetSessionId: "session",
    draftAuthority: {} as never,
    host: {
      draftAuthorityCanCommit: () => true,
      applySessionView: () => calls.push("view"),
      capturePaneAuthority: () => "pane" as never,
      commitPane: () => { calls.push("pane"); return true; },
      commitSessionViewCache: () => calls.push("cache"),
    },
  });
  assert.equal(result.paneAuthority, "pane");
  assert.deepEqual(calls, ["view", "pane"]);
});

test("draft adoption caches a stale completion without committing the new Pane", () => {
  const calls: string[] = [];
  const result = adoptDraftSessionView({
    initial: { sessionId: "session", session: { id: "session" }, state: {}, gateMode: "strict", accepted: true, queued: false } as never,
    targetSessionId: "session",
    draftAuthority: {} as never,
    host: {
      draftAuthorityCanCommit: () => false,
      applySessionView: () => calls.push("view"),
      capturePaneAuthority: () => "pane" as never,
      commitPane: () => { calls.push("pane"); return true; },
      commitSessionViewCache: () => calls.push("cache"),
    },
  });
  assert.equal(result.paneAuthority, undefined);
  assert.deepEqual(calls, ["cache"]);
});
