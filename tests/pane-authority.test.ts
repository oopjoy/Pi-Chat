import assert from "node:assert/strict";
import test from "node:test";
import {
  canCommitDraftPaneAuthority,
  canCommitPaneAuthority,
  canRememberPaneView,
  type DraftPaneAuthority,
  type DraftPaneAuthorityState,
  type PaneAuthoritySnapshot,
  type PaneAuthorityState,
} from "../src/web/application/pane-authority";

const sessionIdentity = (sessionId = "session-a") => ({ kind: "session" as const, sessionId });
const draftIdentity = () => ({ kind: "draft" as const, sessionId: "" });

function sessionAuthority(overrides: Partial<PaneAuthoritySnapshot> = {}): PaneAuthoritySnapshot {
  return {
    sessionId: "session-a",
    desiredSessionId: "session-a",
    runEpochGeneration: 4,
    navigationEpoch: 7,
    committedRevision: 12,
    draftGeneration: 3,
    committedIdentity: sessionIdentity(),
    ...overrides,
  };
}

function currentSession(overrides: Partial<PaneAuthorityState> = {}): PaneAuthorityState {
  return { ...sessionAuthority(), ...overrides };
}

function draftAuthority(overrides: Partial<DraftPaneAuthority> = {}): DraftPaneAuthority {
  return {
    runEpochGeneration: 4,
    navigationEpoch: 7,
    committedRevision: 12,
    draftGeneration: 3,
    ...overrides,
  };
}

function currentDraft(overrides: Partial<DraftPaneAuthorityState> = {}): DraftPaneAuthorityState {
  return {
    runEpochGeneration: 4,
    navigationEpoch: 7,
    committedRevision: 12,
    draftGeneration: 3,
    committedIdentity: draftIdentity(),
    ...overrides,
  };
}

test("pane authority accepts the exact captured Session identity", () => {
  assert.equal(canCommitPaneAuthority(sessionAuthority(), currentSession()), true);
});

test("pane authority rejects stale A to B to A continuations", () => {
  const authority = sessionAuthority();
  for (const current of [
    currentSession({ desiredSessionId: "session-b" }),
    currentSession({ navigationEpoch: 8, committedRevision: 13 }),
    currentSession({ committedIdentity: sessionIdentity("session-b") }),
    currentSession({ runEpochGeneration: 5 }),
    currentSession({ draftGeneration: 4 }),
  ]) {
    assert.equal(canCommitPaneAuthority(authority, current), false);
  }
});

test("pane authority rejects an authority that was captured before its own desired target", () => {
  assert.equal(canCommitPaneAuthority(sessionAuthority({ desiredSessionId: "session-b" }), currentSession()), false);
  assert.equal(canCommitPaneAuthority(sessionAuthority({ sessionId: "" }), currentSession()), false);
});

test("a same-process stale navigation may update cache but a replacement result may not", () => {
  const authority = sessionAuthority();
  assert.equal(canRememberPaneView(authority, authority.runEpochGeneration), true);
  assert.equal(canRememberPaneView(authority, authority.runEpochGeneration + 1), false);
});

test("draft authority accepts only the current draft generation and revision", () => {
  assert.equal(canCommitDraftPaneAuthority(draftAuthority(), currentDraft()), true);
  assert.equal(canCommitDraftPaneAuthority(draftAuthority(), currentDraft({ committedIdentity: { kind: "none", sessionId: "" } })), false);
  assert.equal(canCommitDraftPaneAuthority(draftAuthority({ navigationEpoch: 8 }), currentDraft()), false);
  assert.equal(canCommitDraftPaneAuthority(draftAuthority(), currentDraft({ committedRevision: 13 })), false);
  assert.equal(canCommitDraftPaneAuthority(draftAuthority(), currentDraft({ draftGeneration: 4 })), false);
});
