import type { QueuedPrompt, SessionSummary } from "../../shared/types";
import { uniqueSessionSummaries } from "../lib/session-summary";
import {
  applySidebarQueueProjection,
  applySidebarRunningOverride,
} from "./session-summary-reconciliation";

export interface SessionInventoryReconciliationContext {
  runningOverrides: ReadonlyMap<string, boolean>;
  queueProjections: ReadonlyMap<string, { queue: QueuedPrompt[]; paused: boolean }>;
  cachedQueues: ReadonlyMap<string, { queue: QueuedPrompt[]; paused: boolean }>;
  cancelledQueueIds: ReadonlyMap<string, ReadonlySet<string>>;
  sourceTurnTotals: ReadonlyMap<string, number>;
  localTurnTotal: (sessionId: string) => number;
  deletedSessionIds: ReadonlySet<string>;
  optimisticRenames: ReadonlyMap<string, { name: string }>;
}

function filterCancelledQueue(
  sessionId: string,
  queue: QueuedPrompt[],
  cancelledQueueIds: ReadonlyMap<string, ReadonlySet<string>>,
): QueuedPrompt[] {
  const cancelled = cancelledQueueIds.get(sessionId);
  return cancelled?.size
    ? queue.filter((item) => !cancelled.has(item.id))
    : queue;
}

function reconcileTurnCount(
  session: SessionSummary,
  sourceTurnTotals: ReadonlyMap<string, number>,
  localTurnTotal: (sessionId: string) => number,
): SessionSummary {
  const summaryTurnTotal = typeof session.turnCount === "number" && Number.isFinite(session.turnCount)
    ? session.turnCount
    : 0;
  const resolvedTurnTotal = Math.max(
    summaryTurnTotal,
    sourceTurnTotals.get(session.id) || 0,
    localTurnTotal(session.id),
  );
  return resolvedTurnTotal > summaryTurnTotal
    ? { ...session, turnCount: resolvedTurnTotal }
    : session;
}

/**
 * Reconcile one server Session inventory into the browser Sidebar projection.
 * This module owns no refs, cache, React state, or mutation authority; callers
 * provide the current process-local observations explicitly.
 */
export function reconcileSessionInventory(
  incoming: SessionSummary[],
  context: SessionInventoryReconciliationContext,
): SessionSummary[] {
  return uniqueSessionSummaries(incoming)
    .map((session) => {
      const running = context.runningOverrides.get(session.id);
      return running === undefined
        ? session
        : applySidebarRunningOverride(session, running);
    })
    .map((session) => {
      const projection = context.queueProjections.get(session.id)
        || context.cachedQueues.get(session.id);
      const cancelled = context.cancelledQueueIds.has(session.id);
      if (!projection && !cancelled) return session;
      const queue = projection
        ? filterCancelledQueue(session.id, projection.queue, context.cancelledQueueIds)
        : [];
      return applySidebarQueueProjection(session, queue, projection?.paused ?? false);
    })
    .map((session) => reconcileTurnCount(session, context.sourceTurnTotals, context.localTurnTotal))
    .filter((session) => !context.deletedSessionIds.has(session.id))
    .map((session) => {
      const rename = context.optimisticRenames.get(session.id);
      return rename ? { ...session, name: rename.name } : session;
    });
}
