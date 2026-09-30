import type { PaneAuthoritySnapshot } from "./pane-authority";
import type { LocalUserTurn } from "../lib/local-user-turn";
import type { PiMessage, QueuedPrompt } from "../../shared/types";
import type { ConversationPaneAction } from "../state/conversation-pane";

export interface QueuedAcknowledgementHost {
  patchSessionCache(sessionId: string, patch: { queue: QueuedPrompt[]; queuePaused?: boolean }, authority: PaneAuthoritySnapshot): void;
  commitPane(authority: PaneAuthoritySnapshot, action: ConversationPaneAction): boolean;
  updateSidebarQueue(sessionId: string, queue: QueuedPrompt[], paused: boolean): void;
  showNotice(message: string): void;
}

/** Apply the queued Prompt acknowledgement effects without owning Queue state. */
export function reconcileQueuedPromptAcknowledgement(input: {
  sessionId: string;
  authority: PaneAuthoritySnapshot;
  queuedTurn: LocalUserTurn | undefined;
  acknowledgedQueue: QueuedPrompt[] | undefined;
  acknowledgedPaused: boolean | undefined;
  promotedTurns: LocalUserTurn[];
  alreadyStreaming: boolean;
  previousToolStatus: string;
}, host: QueuedAcknowledgementHost): void {
  const removeQueuedTurn = input.queuedTurn?.queueState === "waiting"
    && input.queuedTurn.renderedInTranscript;
  if (removeQueuedTurn && input.queuedTurn) input.queuedTurn.renderedInTranscript = false;
  for (const promoted of input.promotedTurns) promoted.renderedInTranscript = true;
  const messages = removeQueuedTurn || input.promotedTurns.length
    ? (current: PiMessage[]) => {
        let next = removeQueuedTurn && input.queuedTurn
          ? current.filter((candidate) => candidate !== input.queuedTurn!.message)
          : current;
        for (const promoted of input.promotedTurns)
          if (!next.includes(promoted.message)) next = [...next, promoted.message];
        return next;
      }
    : undefined;
  host.commitPane(input.authority, {
    type: "PROMPT_ACKNOWLEDGED",
    sessionId: input.sessionId,
    ...(messages ? { messages } : null),
    ...(input.acknowledgedQueue && input.queuedTurn?.queueState !== "dispatched"
      ? { queue: input.acknowledgedQueue }
      : null),
    toolStatus: input.alreadyStreaming ? input.previousToolStatus : "",
  });
  if (input.acknowledgedQueue) {
    host.patchSessionCache(input.sessionId, {
      queue: input.acknowledgedQueue,
      queuePaused: input.acknowledgedPaused,
    }, input.authority);
    host.updateSidebarQueue(input.sessionId, input.acknowledgedQueue, input.acknowledgedPaused === true);
  }
  host.showNotice(
    input.queuedTurn?.queueState === "dispatched"
      ? "队列消息已开始执行"
      : "消息已加入队列",
  );
}
