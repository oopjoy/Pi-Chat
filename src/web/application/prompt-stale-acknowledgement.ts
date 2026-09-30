import type { PaneAuthoritySnapshot } from "./pane-authority";
import type { QueuedPrompt } from "../../shared/types";
import type { ConversationPaneAction } from "../state/conversation-pane";
import { applySidebarQueueProjection } from "./session-summary-reconciliation";

export interface StaleAcknowledgementHost {
  patchSessionCache(sessionId: string, patch: { queue: QueuedPrompt[]; queuePaused?: boolean }, authority: PaneAuthoritySnapshot): void;
  capturePaneAuthority(sessionId: string): PaneAuthoritySnapshot;
  commitPane(authority: PaneAuthoritySnapshot, action: ConversationPaneAction): boolean;
  updateSidebarQueue(sessionId: string, queue: QueuedPrompt[]): void;
  scheduleSidebarRefresh(): void;
}

/** Preserve same-session Queue authority without painting a stale Pane. */
export function reconcileStalePromptAcknowledgement(input: {
  sessionId: string;
  queued: boolean;
  queue: QueuedPrompt[] | undefined;
  queuePaused: boolean | undefined;
  navigationEpochMatches: boolean;
  viewingSameSession: boolean;
  desiredSameSession: boolean;
  authority: PaneAuthoritySnapshot | null;
  previousToolStatus: string;
}, host: StaleAcknowledgementHost): boolean {
  if (input.authority && input.queued && input.queue?.length && input.navigationEpochMatches
    && input.viewingSameSession && input.desiredSameSession) {
    host.patchSessionCache(input.sessionId, {
      queue: input.queue,
      queuePaused: input.queuePaused,
    }, input.authority);
    const currentAuthority = host.capturePaneAuthority(input.sessionId);
    host.commitPane(currentAuthority, {
      type: "PROMPT_ACKNOWLEDGED",
      sessionId: input.sessionId,
      queue: input.queue,
      toolStatus: input.previousToolStatus,
    });
    host.updateSidebarQueue(input.sessionId, input.queue);
  }
  host.scheduleSidebarRefresh();
  return true;
}
