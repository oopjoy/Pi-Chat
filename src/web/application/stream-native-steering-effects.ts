import type { PendingSteer, PiMessage } from "../../shared/types";
import {
  removeLocalTurnAndRebase,
  removePendingSteeringTurns,
  type LocalUserTurn,
} from "../lib/local-user-turn";

export interface PendingSteerProjection {
  revision: number;
  items: PendingSteer[];
}

export interface NativeSteeringDequeueHost {
  projection(sessionId: string): PendingSteerProjection | undefined;
  commitProjection(sessionId: string, projection: PendingSteerProjection): void;
  localTurns(sessionId: string): LocalUserTurn[];
  storeLocalTurns(sessionId: string, turns: LocalUserTurn[]): void;
  pendingSteers(sessionId: string): PendingSteer[];
  syncPendingSteers(sessionId: string, items: PendingSteer[]): void;
  clearDequeueing(sessionId: string): void;
  sourceTurnTotal(sessionId: string): number;
  updateTurnTotal(sessionId: string, turnTotal: number): void;
  removeVisibleTurns(sessionId: string, messages: Set<PiMessage>): void;
  restoreComposerDrafts(
    sessionId: string,
    withdrawn: LocalUserTurn[],
    pendingById: ReadonlyMap<string, PendingSteer>,
  ): void;
}

/**
 * Apply a server-confirmed native Steer dequeue. The service owns the whole
 * browser-local turn transaction, while App supplies the authoritative refs,
 * pane writer, and Composer draft writer through narrow ports.
 */
export function applyNativeSteeringDequeueEffect(input: {
  sessionId: string;
  ids: string[];
  revision?: number;
}, host: NativeSteeringDequeueHost): boolean {
  if (!input.sessionId || !input.ids.length) return false;
  const previous = host.projection(input.sessionId);
  const revision = input.revision ?? previous?.revision ?? 0;
  if (previous && revision < previous.revision) return false;
  const withdrawnIds = new Set(input.ids);
  host.commitProjection(input.sessionId, {
    revision,
    items: previous
      ? previous.items.filter((item) => !withdrawnIds.has(item.id))
      : [],
  });

  const pending = host.localTurns(input.sessionId);
  const withdrawn = input.ids.flatMap((id) => {
    const turn = pending.find((candidate) => candidate.queueId === id);
    return turn ? [turn] : [];
  });
  let remaining = pending;
  for (const turn of withdrawn)
    remaining = removeLocalTurnAndRebase(remaining, turn);
  host.storeLocalTurns(input.sessionId, remaining);

  const pendingSteers = host.pendingSteers(input.sessionId);
  const pendingById = new Map(pendingSteers.map((item) => [item.id, item]));
  host.syncPendingSteers(
    input.sessionId,
    pendingSteers.filter((item) => !withdrawnIds.has(item.id)),
  );
  host.clearDequeueing(input.sessionId);
  if (!withdrawn.length) return true;

  host.updateTurnTotal(
    input.sessionId,
    Math.max(
      host.sourceTurnTotal(input.sessionId),
      ...remaining.map((turn) => turn.expectedTurnTotal),
    ),
  );
  host.removeVisibleTurns(
    input.sessionId,
    new Set(withdrawn.map((turn) => turn.message)),
  );
  host.restoreComposerDrafts(input.sessionId, withdrawn, pendingById);
  return true;
}

export interface NativeSteeringClearHost {
  projection(sessionId: string): PendingSteerProjection | undefined;
  commitProjection(sessionId: string, projection: PendingSteerProjection): void;
  localTurns(sessionId: string): LocalUserTurn[];
  storeLocalTurns(sessionId: string, turns: LocalUserTurn[]): void;
  syncPendingSteers(sessionId: string, items: PendingSteer[]): void;
  removeVisibleTurns(sessionId: string, messages: Set<PiMessage>): void;
  reportDropped(sessionId: string): void;
}

/** Clear waiting native Steers after a server lifecycle reset, revision-fenced. */
export function applyNativeSteeringClearEffect(input: {
  sessionId: string;
  revision: number;
  droppedCount: number;
}, host: NativeSteeringClearHost): boolean {
  const previous = host.projection(input.sessionId);
  if (previous && input.revision < previous.revision) return false;
  host.commitProjection(input.sessionId, { revision: input.revision, items: [] });
  const pending = host.localTurns(input.sessionId);
  const remaining = removePendingSteeringTurns(pending);
  host.syncPendingSteers(input.sessionId, []);
  host.storeLocalTurns(input.sessionId, remaining);
  host.removeVisibleTurns(
    input.sessionId,
    new Set(
      pending
        .filter((turn) => turn.revealOnMessageStart && turn.queueState === "waiting")
        .map((turn) => turn.message),
    ),
  );
  if (input.droppedCount > 0) host.reportDropped(input.sessionId);
  return true;
}
