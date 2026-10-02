import type { PromptImage, PromptSettingsSnapshot, QueuedPrompt, SlashCommand } from "../../shared/types";
import type { LocalUserTurn } from "../lib/local-user-turn";

type Callback = (...args: any[]) => any;
type Ref<T> = { current: T };

export interface PromptAcknowledgementStageHost {
  acceptQueueProjection: Callback;
  applySessionView: Callback;
  applySidebarQueueProjection: Callback;
  bindLocalTurnPromptIdentity: Callback;
  cancellingQueueIdsRef: Ref<any>;
  capturePaneAuthority: Callback;
  commitPaneIfCurrent: Callback;
  composerCommands: SlashCommand[];
  desiredSessionIdRef: Ref<any>;
  fetchSessionView: Callback;
  gateModeFromCommand: Callback;
  lastSessionEventTypeRef: Ref<any>;
  latestQueueProjectionRef: Ref<any>;
  localUserTurnsRef: Ref<any>;
  markLocalTurnQueued: Callback;
  navigationEpochRef: Ref<any>;
  paneAuthorityCanCommit: Callback;
  patchSessionCacheForAuthority: Callback;
  pendingSteerFromAcknowledgement: Callback;
  pendingSteersRef: Ref<any>;
  planAcknowledgedQueueProjection: Callback;
  planAcknowledgedTurn: Callback;
  promoteTurnsAbsentFromQueue: Callback;
  promptAcknowledgementKind: Callback;
  promptSubmitControllerRef: Ref<any>;
  queueProjectionRevisionRef: Ref<any>;
  queueProjectionSourceRef: Ref<any>;
  reconcileOrdinaryPromptAcknowledgement: Callback;
  reconcileQueuedPromptAcknowledgement: Callback;
  reconcileSpecialPromptAcknowledgement: Callback;
  reconcileStalePromptAcknowledgement: Callback;
  recordUserTurnLifecycle: Callback;
  removeLocalTurnAndRebase: Callback;
  requestPromptReconcileRef: Ref<any>;
  scheduleSidebarRefresh: Callback;
  sessionEventVersionRef: Ref<any>;
  setNotice: Callback;
  setSessions: Callback;
  syncPendingSteers: Callback;
  updateGateMode: Callback;
  viewedSessionIdRef: Ref<any>;
}

export interface PromptAcknowledgementStageState {
  alreadyStreaming: boolean;
  capturedSelection: any;
  eventVersionBeforePrompt: number;
  images: PromptImage[];
  localTurn: any;
  localTurnEntry: Callback;
  message: string;
  previousToolStatus: string;
  promptAuthority: any;
  promptOperationId: string;
  promptPaneIsCurrent: Callback;
  promptQueueProjectionRevision: number;
  promptTerminalByEvent: boolean;
  protectLocalPrompt: Callback;
  protectedLocalTurn: LocalUserTurn | null;
  serverPromptId: string | null;
  queuePaused: boolean;
  result: {
    extension?: boolean;
    id?: string;
    promptId?: string;
    queued?: boolean;
    queue?: QueuedPrompt[];
    steered?: boolean;
    deliveryUncertain?: boolean;
  };
  steering: boolean;
  targetSessionId: string;
}

export interface PromptAcknowledgementStageResult {
  protectedLocalTurn: LocalUserTurn | null;
  serverPromptId: string | null;
}

/** Applies the HTTP Prompt acknowledgement after transport admission. */
export async function reconcilePromptAcknowledgement(
  host: PromptAcknowledgementStageHost,
  input: PromptAcknowledgementStageState,
): Promise<PromptAcknowledgementStageResult> {
  const {
    acceptQueueProjection,
    applySessionView,
    applySidebarQueueProjection,
    bindLocalTurnPromptIdentity,
    cancellingQueueIdsRef,
    capturePaneAuthority,
    commitPaneIfCurrent,
    composerCommands,
    desiredSessionIdRef,
    fetchSessionView,
    gateModeFromCommand,
    lastSessionEventTypeRef,
    latestQueueProjectionRef,
    localUserTurnsRef,
    markLocalTurnQueued,
    navigationEpochRef,
    paneAuthorityCanCommit,
    patchSessionCacheForAuthority,
    pendingSteerFromAcknowledgement,
    pendingSteersRef,
    planAcknowledgedQueueProjection,
    planAcknowledgedTurn,
    promoteTurnsAbsentFromQueue,
    promptAcknowledgementKind,
    promptSubmitControllerRef,
    queueProjectionRevisionRef,
    queueProjectionSourceRef,
    reconcileOrdinaryPromptAcknowledgement,
    reconcileQueuedPromptAcknowledgement,
    reconcileSpecialPromptAcknowledgement,
    reconcileStalePromptAcknowledgement,
    recordUserTurnLifecycle,
    removeLocalTurnAndRebase,
    requestPromptReconcileRef,
    scheduleSidebarRefresh,
    sessionEventVersionRef,
    setNotice,
    setSessions,
    syncPendingSteers,
    updateGateMode,
    viewedSessionIdRef,
    alreadyStreaming,
    capturedSelection,
    eventVersionBeforePrompt,
    images,
    localTurn,
    localTurnEntry,
    message,
    previousToolStatus,
    promptAuthority,
    promptOperationId,
    promptPaneIsCurrent,
    promptQueueProjectionRevision,
    promptTerminalByEvent,
    protectLocalPrompt,
    queuePaused,
    result,
    steering,
    targetSessionId,
  } = { ...host, ...input };
  let { protectedLocalTurn, serverPromptId } = input;
    if (promptOperationId && result.promptId && serverPromptId !== result.promptId) {
      serverPromptId = result.promptId;
      const boundOperation = promptSubmitControllerRef.current.bindServerPromptId(
        promptOperationId,
        result.promptId,
      );
      if (["settled", "failed", "aborted"].includes(boundOperation.phase))
        promptSubmitControllerRef.current.clearTerminal();
    }
    if (
      targetSessionId &&
      !result.queued &&
      !result.steered &&
      capturedSelection &&
      promptPaneIsCurrent()
    ) {
      const displaySettings = {
        ...(capturedSelection.model ? { model: capturedSelection.model } : null),
        ...(capturedSelection.thinkingLevel
          ? { thinkingLevel: capturedSelection.thinkingLevel }
          : null),
      };
      patchSessionCacheForAuthority(
        targetSessionId,
        { state: displaySettings },
        promptAuthority!,
      );
      commitPaneIfCurrent(promptAuthority!, {
        type: "RUNTIME_SETTINGS_ADOPTED",
        target: { kind: "session", sessionId: targetSessionId },
        state: displaySettings,
      });
    }
    // This Session-scoped selection remains the Composer's next-normal-turn
    // default after admission, matching a persistent Model chooser. The
    // immutable captured object above still prevents a later click from
    // rewriting this already-admitted prompt.
    // HTTP acceptance can mean the prompt was queued, before Gate reaches its
    // dispatch boundary. First reconcile its Session-local admission even if
    // a refresh/navigation committed a newer pane while this response was in
    // flight. In particular, losing the old pane authority must never drop a
    // queue ID and strand a waiting local turn outside both Queue and history.
    // Only the later DOM/notice writes are pane-authority guarded.
    if (result.extension && protectedLocalTurn) {
      const pending = localUserTurnsRef.current.get(targetSessionId) || [];
      const remaining = removeLocalTurnAndRebase(pending, protectedLocalTurn);
      if (remaining.length)
        localUserTurnsRef.current.set(targetSessionId, remaining);
      else localUserTurnsRef.current.delete(targetSessionId);
      protectedLocalTurn = null;
    }
    const acceptedLocalTurn = localTurnEntry();
    if (acceptedLocalTurn && !result.steered) {
      const serverPromptId =
        typeof result.promptId === "string"
          ? result.promptId
          : result.queued && typeof result.id === "string"
            ? result.id
            : undefined;
      if (serverPromptId) {
        bindLocalTurnPromptIdentity(acceptedLocalTurn, { serverPromptId });
        recordUserTurnLifecycle("identity-bound", targetSessionId, acceptedLocalTurn, serverPromptId);
      }
    }
    const promptNavigationIsCurrent = Boolean(
      promptAuthority &&
      promptAuthority.navigationEpoch === navigationEpochRef.current &&
      viewedSessionIdRef.current === targetSessionId &&
      desiredSessionIdRef.current === targetSessionId,
    );
    // Bind the server queue ID as Session-scoped bookkeeping even when the
    // acknowledgement crossed navigation. Pane authority still fences the
    // visible projection below, but dropping this binding would strand an
    // accepted waiting turn without a recoverable queue identity.
    if (
      result.queued &&
      acceptedLocalTurn &&
      typeof result.id === "string"
    )
      markLocalTurnQueued(acceptedLocalTurn, result.id);
    const currentQueueProjection = latestQueueProjectionRef.current.get(
      targetSessionId,
    ) || { queue: [], paused: queuePaused };
    const acknowledgedTurn = localTurnEntry();
    const queuePlan = promptNavigationIsCurrent
      ? planAcknowledgedQueueProjection({
          incoming: result.queue,
          incomingPaused: queuePaused,
          currentRevision: queueProjectionRevisionRef.current.get(targetSessionId) || 0,
          requestRevision: promptQueueProjectionRevision,
          current: currentQueueProjection,
          source: queueProjectionSourceRef.current.get(targetSessionId),
          resultQueued: result.queued,
          resultId: typeof result.id === "string" ? result.id : undefined,
          acknowledgedTurnQueueId: acknowledgedTurn?.queueId,
          acknowledgedTurnQueueState: acknowledgedTurn?.queueState,
        })
      : undefined;
    const acknowledgedProjection = queuePlan
      ? queuePlan.accepted
        ? {
            ...acceptQueueProjection(
              targetSessionId,
              queuePlan.queue,
              queuePlan.paused,
              "ack",
            ),
            accepted: true,
          }
        : queuePlan
      : undefined;
    const acknowledgedQueue = acknowledgedProjection?.accepted
      ? acknowledgedProjection.queue
      : undefined;
    let promotedAcknowledgedTurns: LocalUserTurn[] = [];
    const acknowledgementKind = promptAcknowledgementKind(result);
    const acknowledgementTurnPlan = planAcknowledgedTurn({
      kind: acknowledgementKind,
      acceptedTurnPresent: Boolean(acceptedLocalTurn),
      resultId: typeof result.id === "string" ? result.id : undefined,
      currentQueue: latestQueueProjectionRef.current.get(targetSessionId)?.queue,
    });
    const acknowledgedSteer = pendingSteerFromAcknowledgement({
      steered: result.steered === true,
      queueState: acceptedLocalTurn?.queueState,
      queueId: acceptedLocalTurn?.queueId,
      message,
      imageCount: images.length,
      createdAt: Date.now(),
    });
    if (acknowledgedSteer) {
      syncPendingSteers(targetSessionId, [
        ...(pendingSteersRef.current.get(targetSessionId) || []),
        acknowledgedSteer,
      ]);
    } else if (acknowledgementTurnPlan.promoteFromQueue) {
      // Dispatch SSE may beat this acknowledgement. Never demote a turn that
      // the scheduler has already started into the waiting-only queue UI.
      // A newer complete queue projection can prove that this acknowledged
      // item has already left the FIFO even when queue_dispatch was lost.
      const currentProjection = latestQueueProjectionRef.current.get(targetSessionId);
      if (
        currentProjection &&
        !currentProjection.queue.some((item: any) => item.id === result.id)
      )
        promotedAcknowledgedTurns = promoteTurnsAbsentFromQueue(
          localUserTurnsRef.current.get(targetSessionId) || [],
          new Set(currentProjection.queue.map((item: any) => item.id)),
          false,
          true,
          cancellingQueueIdsRef.current.get(targetSessionId),
        );
    } else if (acknowledgementTurnPlan.markDispatched && acceptedLocalTurn) {
      acceptedLocalTurn.queueState = "dispatched";
    }
    if (acknowledgementKind !== "extension" && acknowledgementKind !== "steer" && acceptedLocalTurn) {
      const acceptedTurnTotal = acceptedLocalTurn.expectedTurnTotal;
      setSessions((current: any) =>
        current.map((session: any) =>
          session.id === targetSessionId &&
          acceptedTurnTotal > (session.turnCount || 0)
            ? { ...session, turnCount: acceptedTurnTotal }
            : session,
        ),
      );
    }
    const promotedAcknowledgedForPane = promptPaneIsCurrent()
      ? promotedAcknowledgedTurns.filter(
          (candidate: any) => !candidate.renderedInTranscript,
        )
      : [];
    for (const promoted of promotedAcknowledgedForPane)
      promoted.renderedInTranscript = true;
    // A prompt acknowledgement that crossed a real navigation boundary must
    // not schedule a background reconcile against the later pane. The later
    // A view owns its own authority and will reconcile the Session on entry;
    // allowing the stale chain to schedule here can retain a deferred React
    // update after unmount (and can repeatedly poll a stale test/consumer).
    if (targetSessionId && promotedAcknowledgedTurns.length && promptNavigationIsCurrent)
      requestPromptReconcileRef.current(targetSessionId);
    // A late acknowledgement is useful for Session reconciliation, but it
    // must not write into a later A pane after A → B → A. Queue state is
    // Session-owned: after a same-Session view commit (e.g. an SSE-driven
    // refresh snapshot taken before the acknowledgement) the ack is the only
    // authority and must restore the queue. After a real navigation the
    // newer view is authoritative, so the stale ack must stay inert.
    if (!promptPaneIsCurrent()) {
      reconcileStalePromptAcknowledgement({
        sessionId: targetSessionId,
        queued: result.queued === true,
        queue: acknowledgedQueue,
        queuePaused: acknowledgedProjection?.paused,
        navigationEpochMatches: promptAuthority?.navigationEpoch === navigationEpochRef.current,
        viewingSameSession: viewedSessionIdRef.current === targetSessionId,
        desiredSameSession: desiredSessionIdRef.current === targetSessionId,
        authority: promptAuthority,
        previousToolStatus,
      }, {
        patchSessionCache: patchSessionCacheForAuthority,
        capturePaneAuthority,
        commitPane: commitPaneIfCurrent,
        updateSidebarQueue: (sessionId: any, queue: any) => setSessions((current: any) => current.map((session: any) =>
          session.id === sessionId ? applySidebarQueueProjection(session, queue) : session,
        )),
        scheduleSidebarRefresh,
      });
      return { protectedLocalTurn, serverPromptId };
    }
    if (reconcileSpecialPromptAcknowledgement({
      result,
      message,
      sessionId: targetSessionId,
      authority: promptAuthority!,
      gateModeFromCommand,
    }, {
      commitPane: commitPaneIfCurrent,
      protectLocalTurn: () => { protectLocalPrompt(localTurn); },
      updateGateMode,
      showNotice: setNotice,
      composerCommands,
      previousToolStatus,
      alreadyStreaming,
    })) {
      // Extension/Steer acknowledgement effects are host-driven; queue and
      // ordinary Prompt paths continue below.
    } else if (result.queued) {
      const queuedTurn = localTurnEntry();
      reconcileQueuedPromptAcknowledgement({
        sessionId: targetSessionId,
        authority: promptAuthority!,
        queuedTurn,
        acknowledgedQueue,
        acknowledgedPaused: acknowledgedProjection?.paused,
        promotedTurns: promotedAcknowledgedForPane,
        alreadyStreaming,
        previousToolStatus,
      }, {
        patchSessionCache: (sessionId: any, patch: any, authority: any) =>
          patchSessionCacheForAuthority(sessionId, patch, authority),
        commitPane: commitPaneIfCurrent,
        updateSidebarQueue: (sessionId: any, queue: any, paused: any) => {
          setSessions((current: any) => current.map((session: any) =>
            session.id === sessionId
              ? applySidebarQueueProjection(session, queue, paused)
              : session,
          ));
        },
        showNotice: setNotice,
      });
    } else {
      await reconcileOrdinaryPromptAcknowledgement({
        sessionId: targetSessionId,
        authority: promptAuthority!,
        eventVersionBefore: eventVersionBeforePrompt,
        eventVersionAfter: sessionEventVersionRef.current.get(targetSessionId) || 0,
        lastEventType: lastSessionEventTypeRef.current.get(targetSessionId),
        promptTerminalByEvent,
      }, {
        protectLocalTurn: () => { protectLocalPrompt(localTurn); },
        localTurnEntry,
        commitPane: commitPaneIfCurrent,
        fetchSessionView,
        currentEventVersion: (sessionId: any) => sessionEventVersionRef.current.get(sessionId) || 0,
        currentPaneAuthority: paneAuthorityCanCommit,
        applySessionView,
        queueRevision: (sessionId: any) => queueProjectionRevisionRef.current.get(sessionId) || 0,
        schedulePromptReconcile: requestPromptReconcileRef.current,
      });
      if (result.deliveryUncertain)
        setNotice("消息已交给 Pi，正在确认执行状态；请勿重复发送");
    }
  return { protectedLocalTurn, serverPromptId };
}
