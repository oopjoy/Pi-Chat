import type { PiMessage, PiState, QueuedPrompt } from "../../shared/types";
import type { LocalUserTurn } from "../lib/local-user-turn";
import type { ConversationPaneAction } from "../state/conversation-pane";
import {
  applyKnownQueueDispatchEffect,
  applySyntheticQueueDispatchEffect,
  type QueueProjection,
} from "./stream-queue-effects";

export interface QueueDispatchEffectHost {
  acceptQueue(sessionId: string, queue: QueuedPrompt[], paused: boolean): QueueProjection;
  sourceQueue(sessionId: string): QueueProjection;
  patchQueue(sessionId: string, queue: QueuedPrompt[], paused: boolean): void;
  updateSidebar(sessionId: string, queue: QueuedPrompt[], paused: boolean): void;
  patchSettings(sessionId: string, state: Partial<PiState>): void;
  dispatchPane(action: ConversationPaneAction): void;
  clearCancelling(sessionId: string, queueId: string): void;
  localTurns(sessionId: string): LocalUserTurn[];
  bindQueuedDispatch(turns: LocalUserTurn[], queueId: string, message: string, imageCount: number, clientPromptOperationId?: string): LocalUserTurn | undefined;
  confirmedIds(sessionId: string): Set<string> | undefined;
  consumeConfirmedIds(sessionId: string, queueId: string, clientPromptOperationId: string): void;
  sourceMessages(sessionId: string): PiMessage[];
  sourceTurnTotal(sessionId: string): number | undefined;
  baselineTurnTotal(sessionId: string): number | undefined;
  storeLocalTurns(sessionId: string, turns: LocalUserTurn[]): void;
  patchRunning(sessionId: string): void;
}

export function applyQueueDispatchEffect(input: {
  sessionId: string;
  queueId: string;
  message: string;
  clientPromptOperationId: string;
  imageCount: number;
  displaySettings: Partial<Pick<PiState, "model" | "thinkingLevel">>;
  viewing: boolean;
}, host: QueueDispatchEffectHost): QueueProjection {
  const source = host.sourceQueue(input.sessionId);
  const projection = host.acceptQueue(
    input.sessionId,
    source.queue.filter((item) => item.id !== input.queueId),
    source.paused,
  );
  host.patchQueue(input.sessionId, projection.queue, projection.paused);
  host.updateSidebar(input.sessionId, projection.queue, projection.paused);
  if (Object.keys(input.displaySettings).length) {
    host.patchSettings(input.sessionId, input.displaySettings);
    if (input.viewing)
      host.dispatchPane({
        type: "RUNTIME_SETTINGS_ADOPTED",
        target: { kind: "session", sessionId: input.sessionId },
        state: input.displaySettings,
      });
  }
  if (input.queueId) host.clearCancelling(input.sessionId, input.queueId);
  const localTurns = host.localTurns(input.sessionId);
  const known = host.bindQueuedDispatch(
    localTurns,
    input.queueId,
    input.message,
    input.imageCount,
    input.clientPromptOperationId || undefined,
  );
  if (known) {
    applyKnownQueueDispatchEffect({
      sessionId: input.sessionId,
      queue: projection.queue,
      knownTurn: known,
      viewing: input.viewing,
    }, { dispatchPane: host.dispatchPane });
  } else {
    const confirmed = host.confirmedIds(input.sessionId);
    const wasConfirmed = Boolean(
      (input.queueId && confirmed?.has(input.queueId))
      || (input.clientPromptOperationId && confirmed?.has(input.clientPromptOperationId)),
    );
    if (wasConfirmed) {
      host.consumeConfirmedIds(input.sessionId, input.queueId, input.clientPromptOperationId);
      if (input.viewing)
        host.dispatchPane({
          type: "QUEUE_DISPATCHED",
          sessionId: input.sessionId,
          queue: projection.queue,
        });
    } else {
      applySyntheticQueueDispatchEffect({
        sessionId: input.sessionId,
        queue: projection.queue,
        dispatchedId: input.queueId,
        dispatchedMessage: input.message,
        imageCount: input.imageCount,
        sourceMessages: host.sourceMessages(input.sessionId),
        sourceTurnTotal: host.sourceTurnTotal(input.sessionId),
        baselineTurnTotal: host.baselineTurnTotal(input.sessionId),
        viewing: input.viewing,
      }, {
        localTurns: host.localTurns,
        storeLocalTurns: host.storeLocalTurns,
        dispatchPane: host.dispatchPane,
      });
    }
  }
  host.patchRunning(input.sessionId);
  return projection;
}
