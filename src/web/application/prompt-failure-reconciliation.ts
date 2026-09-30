import type { LocalUserTurn } from "../lib/local-user-turn";
import type { PiMessage } from "../../shared/types";

export interface PromptFailureLocalTurnPlan {
  retainAsDispatched: boolean;
  removeFromPending: boolean;
  renderedMessage?: PiMessage;
}

export function planPromptFailureLocalTurn(input: {
  localEntry: LocalUserTurn | undefined;
  pendingTurns: LocalUserTurn[];
  outcomeUnknown: boolean;
  steering: boolean;
}): PromptFailureLocalTurnPlan {
  if (!input.localEntry) return { retainAsDispatched: false, removeFromPending: false };
  if (input.outcomeUnknown && !input.steering)
    return { retainAsDispatched: true, removeFromPending: false };
  return {
    retainAsDispatched: false,
    removeFromPending: true,
    ...(input.localEntry.renderedInTranscript
      ? { renderedMessage: input.localEntry.message }
      : null),
  };
}

export function shouldClearModelSelectionOnFailure(
  error: unknown,
  modelUnavailable: (error: unknown) => boolean,
): boolean {
  return modelUnavailable(error);
}

export interface PromptFailureRecordHost {
  isTranscriptWorthyFailure(message: string, status?: number, code?: string): boolean;
  recordLocalFailure(scope: string, message: string, incidentId?: string): void;
}

/** Record only definite, transcript-worthy failures; uncertain delivery stays live. */
export function reconcilePromptFailureRecord(
  input: {
    scope: string;
    message: string;
    status?: number;
    code?: string;
    incidentId?: string;
    failureIsDefinite: boolean;
    steering: boolean;
  },
  host: PromptFailureRecordHost,
): boolean {
  if (
    !input.scope
    || !input.failureIsDefinite
    || input.steering
    || !host.isTranscriptWorthyFailure(input.message, input.status, input.code)
  ) return false;
  host.recordLocalFailure(input.scope, input.message, input.incidentId);
  return true;
}

export interface StoppedSteerFailureHost {
  setRunningOverride(sessionId: string, running: boolean): void;
  settleSidebar(sessionId: string): void;
  patchStoppedSession(sessionId: string, authority: unknown): void;
  releasePromptBusy(sessionId: string): void;
  clearStopping(sessionId: string): void;
}

export function reconcileStoppedSteerFailure(
  input: { sessionId: string; authority: unknown },
  host: StoppedSteerFailureHost,
): void {
  host.setRunningOverride(input.sessionId, false);
  host.settleSidebar(input.sessionId);
  host.patchStoppedSession(input.sessionId, input.authority);
  host.releasePromptBusy(input.sessionId);
  host.clearStopping(input.sessionId);
}
