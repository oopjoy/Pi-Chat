import type { PaneAuthoritySnapshot } from "./pane-authority";
import type { SessionViewData } from "../../shared/types";
import type { LocalUserTurn } from "../lib/local-user-turn";
import { appendLocalTurnOnce } from "../lib/local-user-turn";
import { promptSettledBeforeAcknowledgement } from "./prompt-submit-flow";
import type { ConversationPaneAction } from "../state/conversation-pane";

export interface OrdinaryPromptAcknowledgementHost<TAuthority extends PaneAuthoritySnapshot> {
  protectLocalTurn(): void;
  localTurnEntry(): LocalUserTurn | undefined;
  commitPane(authority: TAuthority, action: ConversationPaneAction): boolean;
  fetchSessionView(sessionId: string): Promise<SessionViewData>;
  currentEventVersion(sessionId: string): number;
  currentPaneAuthority(authority: TAuthority): boolean;
  applySessionView(view: SessionViewData, authority: TAuthority, queueRevision: number): void;
  queueRevision(sessionId: string): number;
  schedulePromptReconcile(sessionId: string): void;
}

/** Reconcile the ordinary Prompt acknowledgement against terminal/SSE races. */
export async function reconcileOrdinaryPromptAcknowledgement<TAuthority extends PaneAuthoritySnapshot>(
  input: {
    sessionId: string;
    authority: TAuthority;
    eventVersionBefore: number;
    eventVersionAfter: number;
    lastEventType?: string;
    promptTerminalByEvent: boolean;
  },
  host: OrdinaryPromptAcknowledgementHost<TAuthority>,
): Promise<void> {
  const settledBeforeAcknowledgement = promptSettledBeforeAcknowledgement({
    promptTerminalByEvent: input.promptTerminalByEvent,
    eventVersionAfter: input.eventVersionAfter,
    eventVersionBefore: input.eventVersionBefore,
    lastEventType: input.lastEventType,
  });
  host.protectLocalTurn();
  // Browser state can conservatively classify a submission as locally queued
  // while the Server, after its authoritative busy check, accepts it directly.
  // A direct acknowledgement must promote the local turn out of the hidden
  // waiting Queue state; otherwise the next hot SessionView filters it from
  // the transcript until a later F5/reconcile.
  const acknowledgedTurn = host.localTurnEntry();
  if (acknowledgedTurn) {
    acknowledgedTurn.queueState = "dispatched";
    acknowledgedTurn.queueRetryPending = false;
  }
  host.commitPane(input.authority, {
    type: "PROMPT_ACKNOWLEDGED",
    sessionId: input.sessionId,
    messages: (current) => appendLocalTurnOnce(current, host.localTurnEntry()),
    ...(settledBeforeAcknowledgement
      ? null
      : { isStreaming: true, toolStatus: "正在等待 Pi 处理…" }),
  });
  if (!settledBeforeAcknowledgement) {
    host.schedulePromptReconcile(input.sessionId);
    return;
  }
  try {
    const requestVersion = host.currentEventVersion(input.sessionId);
    const view = await host.fetchSessionView(input.sessionId);
    if (
      host.currentPaneAuthority(input.authority)
      && host.currentEventVersion(input.sessionId) === requestVersion
    ) host.applySessionView(view, input.authority, host.queueRevision(input.sessionId));
  } catch {
    // Persisted history already owns the user turn; a busy view read must not
    // turn a settled Prompt into a false timeout error.
  }
}
