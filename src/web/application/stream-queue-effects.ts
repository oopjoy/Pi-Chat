import type { PiMessage, QueuedPrompt } from "../../shared/types";
import type { LocalUserTurn } from "../lib/local-user-turn";
import type { ConversationPaneAction } from "../state/conversation-pane";
import { userMessage } from "../lib/pi-events";
import { nextLocalTurnTotal } from "../lib/local-user-turn";

export interface QueueProjection {
  queue: QueuedPrompt[];
  paused: boolean;
}

export interface StreamQueueEffectHost {
  acceptQueue(sessionId: string, queue: QueuedPrompt[], paused: boolean): QueueProjection;
  localTurns(sessionId: string): LocalUserTurn[];
  bindQueuedAdmission(turns: LocalUserTurn[], id: string, message: string, imageCount: number): LocalUserTurn | undefined;
  promoteAbsentTurns(turns: LocalUserTurn[], queuedIds: Set<string>): LocalUserTurn[];
  dispatchPane(action: ConversationPaneAction): void;
  requestPromptReconcile(sessionId: string): void;
  updateSidebar(sessionId: string, queue: QueuedPrompt[], paused: boolean): void;
  patchSessionCache(sessionId: string, queue: QueuedPrompt[], paused: boolean): void;
}

/** Apply a complete Queue snapshot (including status-embedded Queue data). */
export function applyQueueSnapshotEffect(input: {
  sessionId: string;
  queue: QueuedPrompt[];
  paused: boolean;
  viewing: boolean;
}, host: StreamQueueEffectHost): QueueProjection {
  const projection = host.acceptQueue(input.sessionId, input.queue, input.paused);
  const turns = host.localTurns(input.sessionId);
  for (const item of projection.queue)
    host.bindQueuedAdmission(turns, item.id, item.message, item.imageCount);
  const promotedTurns = host.promoteAbsentTurns(
    turns,
    new Set(projection.queue.map((item) => item.id)),
  );
  const promotedForPane = input.viewing
    ? promotedTurns.filter((turn) => !turn.renderedInTranscript)
    : [];
  for (const turn of promotedForPane) turn.renderedInTranscript = true;
  if (promotedForPane.length) {
    if (input.viewing)
      host.dispatchPane({
        type: "QUEUE_UPDATED",
        sessionId: input.sessionId,
        queue: projection.queue,
        paused: projection.paused,
        messages: (current: PiMessage[]) => {
          let next = current;
          for (const promoted of promotedForPane)
            if (!next.includes(promoted.message)) next = [...next, promoted.message];
          return next;
        },
      });
    host.requestPromptReconcile(input.sessionId);
  } else if (input.viewing) {
    host.dispatchPane({
      type: "QUEUE_UPDATED",
      sessionId: input.sessionId,
      queue: projection.queue,
      paused: projection.paused,
    });
  }
  host.updateSidebar(input.sessionId, projection.queue, projection.paused);
  host.patchSessionCache(input.sessionId, projection.queue, projection.paused);
  return projection;
}

/** Queue update adds authoritative admitted-item and pending-editor reconciliation. */
export function applyKnownQueueDispatchEffect(input: {
  sessionId: string;
  queue: QueuedPrompt[];
  knownTurn: LocalUserTurn;
  viewing: boolean;
}, host: Pick<StreamQueueEffectHost, "dispatchPane">): void {
  input.knownTurn.queueState = "dispatched";
  if (!input.viewing) return;
  const shouldAppend = !input.knownTurn.renderedInTranscript;
  if (shouldAppend) input.knownTurn.renderedInTranscript = true;
  host.dispatchPane({
    type: "QUEUE_DISPATCHED",
    sessionId: input.sessionId,
    queue: input.queue,
    pendingUserMessage: (current) => current === input.knownTurn.message ? null : current,
    ...(shouldAppend
      ? { messages: (current) => current.includes(input.knownTurn.message) ? current : [...current, input.knownTurn.message] }
      : null),
  });
}

export function applySyntheticQueueDispatchEffect(input: {
  sessionId: string;
  queue: QueuedPrompt[];
  dispatchedId: string;
  dispatchedMessage: string;
  imageCount: number;
  sourceMessages: PiMessage[];
  sourceTurnTotal?: number;
  baselineTurnTotal?: number;
  viewing: boolean;
}, host: {
  localTurns(sessionId: string): LocalUserTurn[];
  storeLocalTurns(sessionId: string, turns: LocalUserTurn[]): void;
  dispatchPane(action: ConversationPaneAction): void;
}): LocalUserTurn {
  const turns = host.localTurns(input.sessionId);
  const text = input.dispatchedMessage || (
    input.imageCount > 0 ? `请查看附加的 ${input.imageCount} 张图片` : "队列消息"
  );
  const message = userMessage(text, []);
  const turn: LocalUserTurn = {
    sessionId: input.sessionId,
    message,
    expectedTurnTotal: nextLocalTurnTotal(input.sourceMessages, input.sourceTurnTotal, turns),
    baselineTurnTotal: input.baselineTurnTotal,
    queueId: input.dispatchedId || undefined,
    queueState: "dispatched",
    confirmByPosition: input.imageCount > 0,
    renderedInTranscript: input.viewing,
  };
  host.storeLocalTurns(input.sessionId, [...turns, turn]);
  if (input.viewing)
    host.dispatchPane({
      type: "QUEUE_DISPATCHED",
      sessionId: input.sessionId,
      queue: input.queue,
      messages: (current) => [...current, message],
    });
  return turn;
}

export function applyQueueErrorEffect(input: {
  sessionId: string;
  queue: QueuedPrompt[];
  paused: boolean;
  failedId: string;
  viewing: boolean;
  errorMessage: string;
}, host: StreamQueueEffectHost & { showError(message: string): void }): QueueProjection {
  const projection = host.acceptQueue(input.sessionId, input.queue, input.paused);
  const turns = host.localTurns(input.sessionId);
  const queuedIds = new Set(projection.queue.map((item) => item.id));
  if (input.failedId) queuedIds.add(input.failedId);
  const rendered = new Set<PiMessage>();
  for (const turn of turns) {
    if (!turn.queueId || !queuedIds.has(turn.queueId)) continue;
    turn.queueState = "waiting";
    if (turn.queueId === input.failedId) turn.queueRetryPending = true;
    if (turn.renderedInTranscript) rendered.add(turn.message);
    turn.renderedInTranscript = false;
  }
  host.updateSidebar(input.sessionId, projection.queue, projection.paused);
  host.patchSessionCache(input.sessionId, projection.queue, projection.paused);
  if (input.viewing) {
    host.dispatchPane({
      type: "QUEUE_FAILED",
      sessionId: input.sessionId,
      queue: projection.queue,
      paused: projection.paused,
      messages: (current) => current.filter((message) => !rendered.has(message)),
      pendingUserMessage: null,
    });
    host.showError(input.errorMessage);
  }
  return projection;
}

export function applyQueueUpdateEffect(input: {
  sessionId: string;
  queue: QueuedPrompt[];
  paused: boolean;
  admittedId?: string;
  viewing: boolean;
}, host: StreamQueueEffectHost): QueueProjection {
  const projection = host.acceptQueue(input.sessionId, input.queue, input.paused);
  const turns = host.localTurns(input.sessionId);
  const admitted = input.admittedId
    ? projection.queue.find((item) => item.id === input.admittedId)
    : undefined;
  const admittedTurn = admitted
    ? host.bindQueuedAdmission(turns, admitted.id, admitted.message, admitted.imageCount)
    : undefined;
  const removeAdmittedTurn = Boolean(admittedTurn?.renderedInTranscript);
  if (admittedTurn) admittedTurn.renderedInTranscript = false;
  const promotedTurns = host.promoteAbsentTurns(turns, new Set(projection.queue.map((item) => item.id)));
  const promotedForPane = input.viewing
    ? promotedTurns.filter((turn) => !turn.renderedInTranscript)
    : [];
  for (const turn of promotedForPane) turn.renderedInTranscript = true;
  const messages = removeAdmittedTurn || promotedForPane.length
    ? (current: PiMessage[]) => {
        let next = removeAdmittedTurn && admittedTurn
          ? current.filter((message) => message !== admittedTurn.message)
          : current;
        for (const promoted of promotedForPane)
          if (!next.includes(promoted.message)) next = [...next, promoted.message];
        return next;
      }
    : undefined;
  host.updateSidebar(input.sessionId, projection.queue, projection.paused);
  host.patchSessionCache(input.sessionId, projection.queue, projection.paused);
  if (input.viewing) {
    host.dispatchPane({
      type: "QUEUE_UPDATED",
      sessionId: input.sessionId,
      queue: projection.queue,
      paused: projection.paused,
      ...(messages ? { messages } : null),
      pendingUserMessage: admittedTurn
        ? (current) => current === admittedTurn.message ? null : current
        : undefined,
    });
  }
  if (input.viewing && promotedTurns.length) host.requestPromptReconcile(input.sessionId);
  return projection;
}
