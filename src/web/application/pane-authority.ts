import type { ConversationPaneIdentity } from "../state/conversation-pane";

export type PaneAuthority = {
  sessionId: string;
  desiredSessionId: string;
  runEpochGeneration: number;
  navigationEpoch: number;
  committedRevision: number;
  draftGeneration: number;
};

export type PaneAuthoritySnapshot = PaneAuthority & {
  committedIdentity: ConversationPaneIdentity;
};

export type DraftPaneAuthority = Omit<PaneAuthority, "sessionId" | "desiredSessionId">;

export type PaneAuthorityState = Omit<PaneAuthoritySnapshot, "sessionId"> & {
  sessionId: string;
};

export type DraftPaneAuthorityState = Omit<PaneAuthority, "sessionId" | "desiredSessionId"> & {
  committedIdentity: ConversationPaneIdentity;
};

/**
 * A pane commit is browser-local projection, not Session authority. Every
 * async continuation must match the complete captured pane identity before it
 * can dispatch a visible update. A matching Session ID alone is insufficient
 * after A → B → A navigation.
 */
export function canCommitPaneAuthority(
  authority: PaneAuthoritySnapshot,
  current: PaneAuthorityState,
): boolean {
  return Boolean(authority.sessionId)
    && authority.desiredSessionId === authority.sessionId
    && current.desiredSessionId === authority.sessionId
    && current.runEpochGeneration === authority.runEpochGeneration
    && current.navigationEpoch === authority.navigationEpoch
    && current.committedRevision === authority.committedRevision
    && current.committedIdentity.kind === authority.committedIdentity.kind
    && current.committedIdentity.sessionId === authority.committedIdentity.sessionId
    && current.draftGeneration === authority.draftGeneration;
}

/** Draft commits use the same lifecycle fences but intentionally have no Session ID. */
export function canCommitDraftPaneAuthority(
  authority: DraftPaneAuthority,
  current: DraftPaneAuthorityState,
): boolean {
  return current.runEpochGeneration === authority.runEpochGeneration
    && current.navigationEpoch === authority.navigationEpoch
    && current.draftGeneration === authority.draftGeneration
    && current.committedIdentity.kind === "draft"
    && current.committedRevision === authority.committedRevision;
}
