import { useCallback, useEffect, useRef, useState } from "react";
import type { GateMode, PendingSteer, PiMessage, QueuedPrompt, SessionActivityState, SessionViewData } from "../../shared/types";
import { SessionViewCacheWriter, type SessionViewCacheWriteAuthority } from "./session-view-cache-writer";
import { ActiveSessionProjectionWriter } from "./active-session-projection-writer";
import { SessionViewCache, type SessionViewSnapshot } from "../lib/session-view-cache";

export function createSessionProjectionState(host: Record<string, any>) {
  const {
    advanceQueueProjectionRevision,
    applyActiveSessionIds,
    bindQueuedAdmission,
    filterCancelledQueue,
    latestQueueProjectionRef,
    localUserTurnsRef,
    queueProjectionSourceRef,
    runEpochGenerationRef,
    sessionRunningOverridesRef,
    sessions,
    sessionsRef,
    setActiveSessionIds,
    setSessions,
  } = host;
  const viewCacheRef = useRef(new SessionViewCache(32));
  /** A structural delete is terminal even if a response is lost in transit. */
  const confirmedDeletedSessionIdsRef = useRef(new Set<string>());
  const viewCacheWriterRef = useRef<SessionViewCacheWriter | null>(null);
  if (!viewCacheWriterRef.current)
    viewCacheWriterRef.current = new SessionViewCacheWriter(
      viewCacheRef.current,
      () => runEpochGenerationRef.current,
      (sessionId: any) => confirmedDeletedSessionIdsRef.current.has(sessionId),
    );
  const viewCacheWriter = viewCacheWriterRef.current;
  const activeSessionProjectionWriterRef =
    useRef<ActiveSessionProjectionWriter | null>(null);
  if (!activeSessionProjectionWriterRef.current)
    activeSessionProjectionWriterRef.current =
      new ActiveSessionProjectionWriter(
        (ids: any) => {
          setActiveSessionIds(ids);
          viewCacheWriter.setPinnedCurrent(ids);
          setSessions((current: any) => applyActiveSessionIds(current, ids));
        },
        () => runEpochGenerationRef.current,
      );
  const activeSessionProjectionWriter =
    activeSessionProjectionWriterRef.current;
  // Queue projections are event-owned and may be newer than an HTTP view. This
  // preparation callback runs only after the writer accepts process/deletion
  // authority, so a rejected async result cannot mutate queue projections.
  const prepareSessionViewCacheWrite = (view: SessionViewData): SessionViewData => {
    if (!Array.isArray(view.queue)) return view;
    const sessionId = view.session.id;
    const filteredQueue = filterCancelledQueue(sessionId, view.queue);
    const latest = latestQueueProjectionRef.current.get(sessionId);
    if (!latest) {
      latestQueueProjectionRef.current.set(sessionId, {
        queue: filteredQueue,
        paused: view.queuePaused === true,
      });
      queueProjectionSourceRef.current.set(sessionId, "view");
      advanceQueueProjectionRevision(sessionId);
    }
    const projection = latest || {
      queue: filteredQueue,
      paused: view.queuePaused === true,
    };
    return {
      ...view,
      queue: projection.queue,
      queuePaused: projection.paused,
    };
  };
  const commitSessionViewCache = (
    view: SessionViewData,
    authority: SessionViewCacheWriteAuthority,
  ) => viewCacheWriter.remember(view, authority, prepareSessionViewCacheWrite);
  const refreshSessionCache = (id: string, patch: Partial<SessionViewData>) =>
    viewCacheWriter.refreshCurrent(id, patch);
  const refreshSessionCacheForAuthority = (
    id: string,
    patch: Partial<SessionViewData>,
    authority: SessionViewCacheWriteAuthority,
  ) => viewCacheWriter.refresh(id, patch, authority);
  /**
   * Queue projections are event-owned and can be newer than a cached Session
   * view. Never let a stale cached view resurrect an item already removed by a
   * queue_update/dispatch event.
   */
  function withLatestQueueProjection(view: SessionViewSnapshot): SessionViewSnapshot;
  function withLatestQueueProjection(view: undefined): undefined;
  function withLatestQueueProjection(view: SessionViewSnapshot | undefined): SessionViewSnapshot | undefined;
  function withLatestQueueProjection(view: SessionViewSnapshot | undefined): SessionViewSnapshot | undefined {
    if (!view) return undefined;
    const latest = latestQueueProjectionRef.current.get(view.session.id);
    if (!latest) return view;
    return {
      ...view,
      queue: latest.queue,
      queuePaused: latest.paused,
    };
  };
  const patchSessionCache = (
    id: string,
    patch: Parameters<SessionViewCacheWriter["patchCurrent"]>[1],
  ) => viewCacheWriter.patchCurrent(id, patch);
  const patchSessionCacheForAuthority = (
    id: string,
    patch: Parameters<SessionViewCacheWriter["patch"]>[1],
    authority: SessionViewCacheWriteAuthority,
  ) => viewCacheWriter.patch(id, patch, authority);
  const updateLiveSessionCache = (id: string, message: PiMessage) =>
    viewCacheWriter.updateLiveCurrent(id, message);
  /**
   * HTTP acknowledgements and SSE can both be lost during a reconnect. A later
   * authoritative Session view still contains the scheduler's queue, so bind
   * its stable queue IDs to matching local admissions before transcript
   * protection decides whether those rows should remain hidden.
   */
  const reconcileQueuedAdmissions = (
    sessionId: string,
    queue: QueuedPrompt[] | undefined,
  ) => {
    if (!sessionId || !queue?.length) return;
    const turns = localUserTurnsRef.current.get(sessionId);
    if (!turns?.length) return;
    for (const queued of queue)
      bindQueuedAdmission(
        turns,
        queued.id,
        queued.message,
        queued.imageCount,
      );
  };
  const appendTerminalSessionCache = (id: string, message: PiMessage) =>
    viewCacheWriter.appendTerminalCurrent(id, message);
  const [pendingSteersBySession, setPendingSteersBySession] = useState<
    Record<string, PendingSteer[]>
  >({});
  const pendingSteersRef = useRef(new Map<string, PendingSteer[]>());
  /** Latest server authority prevents an older refresh from reviving a consumed Steer. */
  const pendingSteerProjectionRef = useRef(new Map<string, { revision: number; items: PendingSteer[] }>());
  const syncPendingSteers = (sessionId: string, items: PendingSteer[]) => {
    if (items.length) pendingSteersRef.current.set(sessionId, items);
    else pendingSteersRef.current.delete(sessionId);
    setPendingSteersBySession(Object.fromEntries(pendingSteersRef.current));
  };
  const [gateModes, setGateModes] = useState<Record<string, GateMode>>({});
  const gateModesRef = useRef<Record<string, GateMode>>({});
  const updateGateMode = useCallback(
    (
      sessionId: string,
      mode: GateMode | undefined,
      authority?: SessionViewCacheWriteAuthority,
    ) => {
      const next = { ...gateModesRef.current };
      if (mode) next[sessionId] = mode;
      else delete next[sessionId];
      gateModesRef.current = next;
      if (authority)
        patchSessionCacheForAuthority(sessionId, { gateMode: mode }, authority);
      else patchSessionCache(sessionId, { gateMode: mode });
      setGateModes(next);
    },
    [],
  );
  const [failedSessionIds, setFailedSessionIds] = useState<string[]>([]);
  /** Apply only server-authored Sidebar activity; cache overlay protects it from late HTTP views. */
  const applySessionActivity = useCallback(
    (sessionId: string, activity: SessionActivityState) => {
      const terminalActivity =
        activity.execution === "idle" ||
        activity.execution === "queued" ||
        activity.execution === "failed";
      if (activity.execution === "running" || activity.execution === "dispatching")
        sessionRunningOverridesRef.current.set(sessionId, true);
      else if (terminalActivity)
        sessionRunningOverridesRef.current.set(sessionId, false);
      // `paused` belongs to the follow-up queue and may coexist with an active
      // turn. Preserve the preceding running/terminal authority instead of
      // manufacturing either conclusion from paused alone.
      setFailedSessionIds((current: any) =>
        activity.execution === "failed"
          ? [...new Set([...current, sessionId])]
          : current.filter((id: any) => id !== sessionId),
      );
      setSessions((current: any) =>
        current.map((session: any) => {
          if (session.id !== sessionId) return session;
          const running =
            activity.execution === "running" ||
            activity.execution === "dispatching"
              ? true
              : terminalActivity
                ? false
                : session.running === true;
          return {
            ...session,
            activity,
            running,
            queued:
              activity.execution === "queued" ||
              activity.execution === "paused",
            pendingConfirmation: activity.awaitingConfirmation,
          };
        }),
      );
      patchSessionCache(sessionId, { sessionActivity: activity });
    },
    [],
  );
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  return {
    viewCacheRef,
    confirmedDeletedSessionIdsRef,
    viewCacheWriterRef,
    viewCacheWriter,
    activeSessionProjectionWriterRef,
    activeSessionProjectionWriter,
    prepareSessionViewCacheWrite,
    commitSessionViewCache,
    refreshSessionCache,
    refreshSessionCacheForAuthority,
    patchSessionCache,
    patchSessionCacheForAuthority,
    updateLiveSessionCache,
    reconcileQueuedAdmissions,
    appendTerminalSessionCache,
    withLatestQueueProjection,
    pendingSteersBySession,
    setPendingSteersBySession,
    pendingSteersRef,
    pendingSteerProjectionRef,
    syncPendingSteers,
    gateModes,
    setGateModes,
    gateModesRef,
    updateGateMode,
    failedSessionIds,
    setFailedSessionIds,
    applySessionActivity,
  };
}
