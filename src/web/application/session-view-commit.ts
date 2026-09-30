import type { QueuedPrompt, SessionViewData } from "../../shared/types";
import type { ActiveSessionViewDecision } from "./active-session-projection-writer";

export type SessionViewCommitDecision =
  | { kind: "rejected"; reason: string }
  | {
      kind: "accepted";
      view: SessionViewData;
      sourceView: SessionViewData;
      queue: QueuedPrompt[];
      queuePaused: boolean;
      queueKnown: boolean;
      active: ActiveSessionViewDecision;
    };

export interface SessionViewCommitPorts {
  isDeleted(sessionId: string): boolean;
  canCommit(authority: unknown): boolean;
  projectActive(
    sessionId: string,
    viewSource: SessionViewData["viewSource"],
    reportedActive: boolean,
    authority: unknown,
  ): ActiveSessionViewDecision;
  completedCompaction(sessionId: string): boolean;
  queueProjection(
    sessionId: string,
    incoming: QueuedPrompt[] | undefined,
    paused: boolean,
    requestRevision?: number,
  ): { queue: QueuedPrompt[]; paused: boolean; known: boolean };
  applyQueueToSession(
    session: SessionViewData["session"],
    queue: QueuedPrompt[],
    paused: boolean,
  ): SessionViewData["session"];
  commitCache(
    view: SessionViewData,
    authority: unknown,
  ): SessionViewData | null;
  recordRejected(sessionId: string, reason: string): void;
  recordAccepted(sessionId: string): void;
}

/**
 * Admission and normalization boundary for one SessionView response.
 *
 * This function deliberately stops before transcript/local-turn reconciliation
 * and Pane reduction. Those remain App-owned browser authorities. It owns only
 * the freshness/deletion gate, active-runtime projection, compaction fence,
 * Queue normalization, and cache commit ordering.
 */
export function prepareSessionViewCommit(
  view: SessionViewData,
  authority: unknown,
  queueRequestRevision: number | undefined,
  ports: SessionViewCommitPorts,
): SessionViewCommitDecision {
  const sessionId = view.session.id;
  if (ports.isDeleted(sessionId)) {
    ports.recordRejected(sessionId, "session-deleted");
    return { kind: "rejected", reason: "session-deleted" };
  }
  if (authority !== null && authority !== undefined && !ports.canCommit(authority)) {
    ports.recordRejected(sessionId, "stale-authority");
    return { kind: "rejected", reason: "stale-authority" };
  }
  ports.recordAccepted(sessionId);

  const active = ports.projectActive(
    sessionId,
    view.viewSource,
    view.isActive,
    authority,
  );
  const activeNormalizedView: SessionViewData = {
    ...view,
    session: {
      ...view.session,
      writable: active.active,
    },
    isActive: active.active,
    runtimeStatus: active.active
      ? view.runtimeStatus === "view-only" ? "active" : view.runtimeStatus
      : "view-only",
  };
  const normalizedView = ports.completedCompaction(sessionId)
    ? {
        ...activeNormalizedView,
        toolStatus: "",
        state: { ...activeNormalizedView.state, isCompacting: false },
      }
    : activeNormalizedView;
  const queueProjection = ports.queueProjection(
    sessionId,
    normalizedView.queue,
    normalizedView.queuePaused === true,
    queueRequestRevision,
  );
  const queueFilteredView = queueProjection.known
    ? {
        ...normalizedView,
        session: ports.applyQueueToSession(
          normalizedView.session,
          queueProjection.queue,
          queueProjection.paused,
        ),
        queue: queueProjection.queue,
        queuePaused: queueProjection.paused,
      }
    : queueProjection.queue.length || queueProjection.paused
      ? {
          ...normalizedView,
          session: ports.applyQueueToSession(
            normalizedView.session,
            queueProjection.queue,
            queueProjection.paused,
          ),
          queue: queueProjection.queue,
          queuePaused: queueProjection.paused,
        }
      : normalizedView;
  const sourceView = ports.commitCache(queueFilteredView, authority);
  if (!sourceView) {
    ports.recordRejected(sessionId, "cache-authority");
    return { kind: "rejected", reason: "cache-authority" };
  }
  return {
    kind: "accepted",
    view: queueFilteredView,
    sourceView,
    queue: queueProjection.queue,
    queuePaused: queueProjection.paused,
    queueKnown: queueProjection.known,
    active,
  };
}
