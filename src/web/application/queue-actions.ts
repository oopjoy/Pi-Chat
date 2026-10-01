import type { QueuedPrompt } from "../../shared/types";
import type { ComposerDraftKey } from "../state/composer";

export function createQueueActions(host: Record<string, any>) {
  const {
    acceptQueueProjection,
    advanceQueueProjectionRevision,
    api,
    appliedDraftRestorationSequencesRef,
    appliedQueueMutationSequenceRef,
    applyDequeuedSteers,
    applySidebarQueueProjection,
    cancelledQueueIdsRef,
    cancellingQueueIdsRef,
    captureViewOperation,
    commitPaneIfCurrent,
    composerDraftKeyId,
    composerDraftRevisionsRef,
    confirmedDeletedSessionIdsRef,
    draftRestorationIntentSequenceRef,
    filterCancelledQueue,
    latestQueueProjectionRef,
    localUserTurnsRef,
    patchSessionCacheForAuthority,
    pendingSteersRef,
    promptDraftFromMessage,
    queueMutationSequenceRef,
    queueProjectionRevisionRef,
    queueProjectionSourceRef,
    removeLocalTurnAndRebase,
    setError,
    setRestoredComposerDrafts,
    setSessions,
    setSteerDequeueingBySession,
    sourceTurnTotalsRef,
    steerDequeueExpectedDraftRevisionRef,
    viewCacheRef,
    viewOperationIsCurrent,
    viewOperationIsInCurrentRun,
  } = host;
  const dequeuePendingSteers = () => {
    const operation = captureViewOperation();
    const draftKey: ComposerDraftKey = {
      kind: "session",
      sessionId: operation.sessionId,
    };
    steerDequeueExpectedDraftRevisionRef.current.set(
      operation.sessionId,
      composerDraftRevisionsRef.current.get(composerDraftKeyId(draftKey)) || 0,
    );
    setSteerDequeueingBySession((current: any) => ({
      ...current,
      [operation.sessionId]: true,
    }));
    void api.dequeueSteers(operation.sessionId).then((result: any) => {
      if (!viewOperationIsInCurrentRun(operation)) return;
      applyDequeuedSteers(
        operation.sessionId,
        result.items.map((item: any) => item.id),
      );
      if (
        result.count === 0 &&
        (pendingSteersRef.current.get(operation.sessionId)?.length || 0) > 0 &&
        viewOperationIsCurrent(operation)
      )
        setError("这些 Steer 已不在 Pi 的原生等待队列中，未伪装为撤回成功");
    }).catch((cause: any) => {
      if (viewOperationIsCurrent(operation))
        setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      setSteerDequeueingBySession((current: any) => {
        if (!current[operation.sessionId]) return current;
        const next = { ...current };
        delete next[operation.sessionId];
        return next;
      });
    });
  };

  const cancelQueuedPrompt = (item: QueuedPrompt) => {
    const operation = captureViewOperation();
    draftRestorationIntentSequenceRef.current += 1;
    const cancellationSequence = draftRestorationIntentSequenceRef.current;
    const cancellationDraftKey: ComposerDraftKey = {
      kind: "session",
      sessionId: operation.sessionId,
    };
    const expectedDraftRevision =
      composerDraftRevisionsRef.current.get(composerDraftKeyId(cancellationDraftKey)) || 0;
    const queueProjectionRevision =
      queueProjectionRevisionRef.current.get(operation.sessionId) || 0;
    const mutationSequence =
      (queueMutationSequenceRef.current.get(operation.sessionId) || 0) + 1;
    queueMutationSequenceRef.current.set(operation.sessionId, mutationSequence);
    const pendingAtCancellation =
      localUserTurnsRef.current.get(operation.sessionId) || [];
    const localCancelledAtCancellation = pendingAtCancellation.find(
      (turn: any) => turn.queueId === item.id,
    );
    const cancellingIds =
      cancellingQueueIdsRef.current.get(operation.sessionId) || new Set<string>();
    cancellingIds.add(item.id);
    cancellingQueueIdsRef.current.set(operation.sessionId, cancellingIds);
    void api
      .cancelQueued(item.id, operation.sessionId)
      .then((result: any) => {
        if (!viewOperationIsInCurrentRun(operation)) return;
        if (confirmedDeletedSessionIdsRef.current.has(operation.sessionId))
          return;
        const pending =
          localUserTurnsRef.current.get(operation.sessionId) || [];
        const cancelling = cancellingQueueIdsRef.current.get(operation.sessionId);
        if (cancelling) {
          cancelling.delete(item.id);
          if (!cancelling.size)
            cancellingQueueIdsRef.current.delete(operation.sessionId);
        }
        const cancelled =
          pending.find((turn: any) => turn.queueId === item.id) ||
          localCancelledAtCancellation;
        const remaining = cancelled
          ? removeLocalTurnAndRebase(pending, cancelled)
          : pending;
        if (remaining.length)
          localUserTurnsRef.current.set(operation.sessionId, remaining);
        else localUserTurnsRef.current.delete(operation.sessionId);
        const cancelledIds =
          cancelledQueueIdsRef.current.get(operation.sessionId) || new Set<string>();
        cancelledIds.add(item.id);
        cancelledQueueIdsRef.current.set(operation.sessionId, cancelledIds);
        const queueProjectionChanged =
          (queueProjectionRevisionRef.current.get(operation.sessionId) || 0) !==
          queueProjectionRevision;
        const appliedMutationSequence =
          appliedQueueMutationSequenceRef.current.get(operation.sessionId) || 0;
        const mutationIsNewestSuccess =
          mutationSequence > appliedMutationSequence;
        if (mutationIsNewestSuccess)
          appliedQueueMutationSequenceRef.current.set(
            operation.sessionId,
            mutationSequence,
          );
        const currentProjection =
          latestQueueProjectionRef.current.get(operation.sessionId) || {
            queue: viewCacheRef.current.get(operation.sessionId)?.queue || [],
            paused:
              viewCacheRef.current.get(operation.sessionId)?.queuePaused === true,
          };
        const latestProjection =
          queueProjectionChanged || !mutationIsNewestSuccess
            ? currentProjection
            : { queue: result.queue, paused: result.paused };
        const authoritativeProjection = {
          queue: filterCancelledQueue(
            operation.sessionId,
            latestProjection.queue,
          ),
          paused: latestProjection.paused,
        };

        latestQueueProjectionRef.current.set(
          operation.sessionId,
          authoritativeProjection,
        );
        queueProjectionSourceRef.current.set(operation.sessionId, "mutation");
        if (!queueProjectionChanged)
          advanceQueueProjectionRevision(operation.sessionId);
        const authoritativeQueue = authoritativeProjection.queue;
        setSessions((current: any) =>
          current.map((session: any) =>
            session.id === operation.sessionId
              ? applySidebarQueueProjection(session, authoritativeQueue)
              : session,
          ),
        );
        if (cancelled) {
          const restoredTurnTotal = Math.max(
            sourceTurnTotalsRef.current.get(operation.sessionId) || 0,
            cancelled.expectedTurnTotal - 1,
            ...remaining.map((turn: any) => turn.expectedTurnTotal),
          );
          setSessions((current: any) =>
            current.map((session: any) =>
              session.id === operation.sessionId
                ? { ...session, turnCount: restoredTurnTotal }
                : session,
            ),
          );
        }
        patchSessionCacheForAuthority(
          operation.sessionId,
          {
            queue: authoritativeQueue,
            queuePaused: authoritativeProjection.paused,
          },
          operation,
        );
        const restored = cancelled
          ? promptDraftFromMessage(cancelled.message, item.message)
          : { message: item.message, images: [] };
        commitPaneIfCurrent(operation, {
          type: "QUEUE_UPDATED",
          sessionId: operation.sessionId,
          queue: authoritativeQueue,
          paused: authoritativeProjection.paused,
          messages: cancelled?.renderedInTranscript
            ? (current: any) =>
                current.filter((message: any) => message !== cancelled.message)
            : undefined,
        });
        // Composer restoration is Session-keyed state. The server normally
        // broadcasts the post-cancel queue before the DELETE response arrives,
        // which advances the Pane revision and makes the click's old authority
        // stale. Do not lose the user's message merely because that truthful
        // queue frame won the race; a newer editor revision still wins in the
        // Composer reducer below.
        // HTTP completions may arrive out of click order. The latest successful
        // cancellation wins the Composer, never whichever response finishes last.
        const restorationKeyId = composerDraftKeyId(cancellationDraftKey);
        if (
          cancellationSequence >
          (appliedDraftRestorationSequencesRef.current.get(restorationKeyId) || 0)
        ) {
          appliedDraftRestorationSequencesRef.current.set(
            restorationKeyId,
            cancellationSequence,
          );
          setRestoredComposerDrafts((current: any) => ({
            ...current,
            [restorationKeyId]: {
              key: cancellationDraftKey,
              revision: cancellationSequence,
              expectedDraftRevision,
              ...restored,
            },
          }));
        }
      })
      .catch((cause: any) => {
        if (viewOperationIsCurrent(operation))
          setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  const resumeQueuedPrompt = () => {
    const operation = captureViewOperation();
    const queueProjectionRevision =
      queueProjectionRevisionRef.current.get(operation.sessionId) || 0;
    const mutationSequence =
      (queueMutationSequenceRef.current.get(operation.sessionId) || 0) + 1;
    queueMutationSequenceRef.current.set(operation.sessionId, mutationSequence);
    void api
      .resumeQueue(operation.sessionId)
      .then((result: any) => {
        if (!viewOperationIsInCurrentRun(operation)) return;
        const appliedMutationSequence =
          appliedQueueMutationSequenceRef.current.get(operation.sessionId) || 0;
        if (mutationSequence < appliedMutationSequence) return;
        appliedQueueMutationSequenceRef.current.set(
          operation.sessionId,
          mutationSequence,
        );
        const currentProjection = latestQueueProjectionRef.current.get(
          operation.sessionId,
        );
        const projectionChanged =
          (queueProjectionRevisionRef.current.get(operation.sessionId) || 0) !==
          queueProjectionRevision;
        const resumedProjection = projectionChanged && currentProjection
          ? acceptQueueProjection(
              operation.sessionId,
              currentProjection.queue,
              result.paused,
              "mutation",
            )
          : acceptQueueProjection(
              operation.sessionId,
              result.queue,
              result.paused,
              "mutation",
            );
        patchSessionCacheForAuthority(
          operation.sessionId,
          {
            queue: resumedProjection.queue,
            queuePaused: resumedProjection.paused,
          },
          operation,
        );
        setSessions((current: any) =>
          current.map((session: any) =>
            session.id === operation.sessionId
              ? applySidebarQueueProjection(
                  session,
                  resumedProjection.queue,
                  resumedProjection.paused,
                )
              : session,
          ),
        );
        commitPaneIfCurrent(operation, {
          type: "QUEUE_UPDATED",
          sessionId: operation.sessionId,
          queue: resumedProjection.queue,
          paused: resumedProjection.paused,
        });
      })
      .catch((cause: any) => {
        if (viewOperationIsCurrent(operation))
          setError(cause instanceof Error ? cause.message : String(cause));
      });
  };


  return {
    dequeuePendingSteers,
    cancelQueuedPrompt,
    resumeQueuedPrompt,
  };
}
