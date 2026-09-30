import type { PendingPromptProjection, SessionViewData, PendingSteer } from "../../shared/types";
import type { LocalUserTurn } from "../lib/local-user-turn";
import { bindLocalTurnPromptIdentity, hasLocalTurnForPendingPayload, localTurnForPendingPrompt, nextLocalTurnTotal, removeLocalTurnAndRebase, sameUserInstructionForDiagnostic } from "../lib/local-user-turn";

export interface ServerPendingProjectionHost {
  turns(id: string): LocalUserTurn[];
  storeTurns(id: string, turns: LocalUserTurn[]): void;
  deleteTurns(id: string): void;
  recordLifecycle(phase: string, id: string, turn: LocalUserTurn | undefined, promptId?: string, count?: number): void;
  pendingSteerProjection(id: string): { revision: number; items: PendingSteer[] } | undefined;
  commitSteerProjection(id: string, projection: { revision: number; items: PendingSteer[] }): void;
  syncSteers(id: string, items: PendingSteer[]): void;
}

export function reconcileServerPendingPrompt(host: ServerPendingProjectionHost, view: SessionViewData): void {
  const pending = view.pendingPrompt;
  if (!pending) return;
  const turns = host.turns(view.session.id);
  const existing = localTurnForPendingPrompt(turns, pending);
  const serverPromptId = pending.promptId || pending.message.piChatPromptId;
  const pendingPromptId = pending.id || pending.message.piChatPendingMessageId;
  if (existing) {
    bindLocalTurnPromptIdentity(existing, { serverPromptId, pendingPromptId });
    existing.queueState = "dispatched";
    existing.queueRetryPending = false;
    host.recordLifecycle("server-reconciled", view.session.id, existing, serverPromptId);
    return;
  }
  if (hasLocalTurnForPendingPayload(turns, pending)) {
    host.recordLifecycle("ambiguous-suppressed", view.session.id, undefined, serverPromptId, turns.filter((turn) => sameUserInstructionForDiagnostic(turn.message, pending.message)).length);
    return;
  }
  const message = { ...pending.message };
  const turn: LocalUserTurn = {
    sessionId: view.session.id,
    message,
    ...(serverPromptId ? { serverPromptId } : null),
    ...(pendingPromptId ? { pendingPromptId } : null),
    expectedTurnTotal: pending.expectedTurnTotal,
    baselineTurnTotal: typeof view.turnTotal === "number" && Number.isFinite(view.turnTotal) ? view.turnTotal : undefined,
    queueState: "dispatched",
    confirmByPosition: Array.isArray(message.content),
    renderedInTranscript: false,
  };
  bindLocalTurnPromptIdentity(turn, { serverPromptId, pendingPromptId });
  host.storeTurns(view.session.id, [...turns, turn]);
  host.recordLifecycle("server-rehydrated", view.session.id, turn, serverPromptId);
}

export function reconcileServerPendingSteers(host: ServerPendingProjectionHost, view: SessionViewData): void {
  if (!Array.isArray(view.pendingSteers)) return;
  const sessionId = view.session.id;
  const incomingRevision = typeof view.pendingSteerRevision === "number" ? view.pendingSteerRevision : 0;
  const previous = host.pendingSteerProjection(sessionId);
  if (previous && incomingRevision < previous.revision) return;
  const items = view.pendingSteers.map((item) => ({ ...item }));
  host.commitSteerProjection(sessionId, { revision: incomingRevision, items });
  const ids = new Set(items.map((item) => item.id));
  let turns = host.turns(sessionId);
  for (const turn of [...turns]) {
    if (turn.revealOnMessageStart && turn.queueState === "waiting" && turn.queueId && !ids.has(turn.queueId))
      turns = removeLocalTurnAndRebase(turns, turn);
  }
  let expectedTurnTotal = nextLocalTurnTotal(view.messages, view.turnTotal, turns);
  const baseline = typeof view.turnTotal === "number" && Number.isFinite(view.turnTotal) ? view.turnTotal : undefined;
  for (const item of items) {
    const existing = turns.find((turn) => turn.queueId === item.id);
    if (existing) {
      existing.queueState = "waiting";
      existing.revealOnMessageStart = true;
      continue;
    }
    turns.push({
      sessionId,
      message: { role: "user", content: item.message, timestamp: item.createdAt },
      expectedTurnTotal: expectedTurnTotal++,
      baselineTurnTotal: baseline,
      queueId: item.id,
      queueState: "waiting",
      revealOnMessageStart: true,
      renderedInTranscript: false,
    });
  }
  if (turns.length) host.storeTurns(sessionId, turns);
  else host.deleteTurns(sessionId);
  host.syncSteers(sessionId, items);
}
