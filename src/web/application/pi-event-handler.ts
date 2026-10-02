import { dispatchPiEventBranch } from "./pi-event-branch-dispatch";
import type { ExtensionUiRequest, ModelInfo, PiMessage, PrimaryRuntimeReadiness, QueuedPrompt, SessionActivityState, SessionSummary, SessionViewData, SlashCommand } from "../../shared/types";
import type { StreamingMessageAppend } from "../../shared/streaming-wire";

export function createPiEventHandler(host: Record<string, any>) {
  const {
    type,
    MESSAGE_CHECKPOINT_EVENT,
    MESSAGE_DELTA_EVENT,
    WAITING_FOR_PI_STATUS,
    acceptQueueProjection,
    activeSessionProjectionWriter,
    admitStreamEvent,
    appendTerminalSessionCache,
    applyDequeuedSteers,
    applyExtensionUiRequestEffect,
    applyNativeSteeringClearEffect,
    applyQueueDispatchEffect,
    applyQueueErrorEffect,
    applyQueueSnapshotEffect,
    applyQueueUpdateEffect,
    applySessionActivity,
    applySessionView,
    applySidebarQueueProjection,
    applySidebarRunningOverride,
    applyStreamingDelta,
    assistantMessage,
    assistantMessageRequestsTool,
    authoritativeTurnTotal,
    bindQueuedAdmission,
    bindQueuedDispatch,
    block,
    cancelPendingNavigation,
    cancellingQueueIdsRef,
    capturePaneAuthority,
    clearEmptyQueuePause,
    clearPendingLiveMessage,
    clearPromptReconcileTimer,
    clearStoppingForSession,
    clientPromptOperationId,
    commitSessionViewCache,
    completedCompactionSessionIdsRef,
    confirmedQueueDispatchIdsRef,
    consumeLocalSteeringTurn,
    currentQueue,
    decodeStreamingCheckpoint,
    deriveActiveSessionChangedEffect,
    deriveApplicationLifecycleEffect,
    deriveExtensionRequestResolvedEffect,
    deriveFastModeChangedEffect,
    deriveGateModeChangedEffect,
    derivePromptDeliveryUncertainEffect,
    derivePromptRetryEffect,
    deriveQueueDispatchEffect,
    deriveQueueErrorEffect,
    deriveQueueSnapshotEffect,
    deriveSessionControlChangedEffect,
    deriveSessionMutationEffect,
    deriveWorkspaceChangedEffect,
    desiredSessionIdRef,
    dispatchAskQuestionnaire,
    dispatchPane,
    displaySettingsFromEvent,
    fetchSessionView,
    finalizeDeletedSession,
    finiteRunMetric,
    gateModeFromNotice,
    generation,
    incomingPaused,
    invalidatesSessionViewVersion,
    isSessionScopedEvent,
    item,
    lastEventFrameAtRef,
    lastSessionEventTypeRef,
    latestQueueProjectionRef,
    localDraftRef,
    localUserTurnsRef,
    mergeModelCatalog,
    messages,
    modelCatalogueRevisionGate,
    navigationEpochRef,
    pane,
    paneAuthorityCanCommit,
    paneStateRef,
    parseAskQuestionnaire,
    patchSessionCache,
    paused,
    pending,
    pendingGateModesRef,
    pendingSteerProjectionRef,
    pendingSteersRef,
    projectionPaused,
    promoteTurnsAbsentFromQueue,
    promptControllerRef,
    queue,
    queueId,
    queueProjectionRevisionRef,
    queuedIds,
    recordBrowserStateDiagnostic,
    recordLocalFailure,
    recordSseRejectionDiagnostic,
    refresh,
    releasePromptBusy,
    rememberObservedModel,
    reportBackgroundRefreshError,
    requestPromptReconcileRef,
    resetResourceReloadTransientState,
    resourceReloadActiveRef,
    runEpoch,
    runEpochRef,
    runGeneration,
    runtimeProjectionWriter,
    saveModelCatalog,
    scheduleLiveMessage,
    scheduleSidebarRefresh,
    selectDeletionFallback,
    session,
    sessionEventVersionRef,
    sessionId,
    sessionRunGenerationsRef,
    sessionRunningOverridesRef,
    sessionsRef,
    setCloseComplete,
    setError,
    setEventSourceGeneration,
    setFailedSessionIds,
    setManagementSection,
    setModelRuntimeSyncPending,
    setModels,
    setNotice,
    setRuntimeWarming,
    setSessions,
    setUnseenReplySessionIds,
    setWorkspaceCwd,
    settleSidebarActivity,
    settledPaneActivity,
    settledRunGenerationsRef,
    sourceTurnTotalsRef,
    sseFloodCountRef,
    sseReconnectTimerRef,
    stageGateMode,
    startIdleRecovery,
    state,
    steeringClearedMessage,
    streamDiagnosticsRef,
    streamGapRecoveriesRef,
    streamingWireProjectionsRef,
    syncPendingSteers,
    terminalAssistantSessionIdsRef,
    terminalAssistantStreamGenerationsRef,
    tryAutoAllowGate,
    turns,
    unreadSteeringDropMessagesRef,
    updateGateMode,
    updateLiveSessionCache,
    view,
    viewCacheRef,
    viewCacheWriter,
    viewedSessionIdRef,
    withStreamingAppendHints,
    workspaceEpochRef,
    workspaceRevisionRef
  } = host;
    return (rawEvent: Event, source: EventSource): void => {
      lastEventFrameAtRef.current = Date.now();
      const admission = admitStreamEvent(rawEvent, runEpochRef.current);
      if (!admission.accepted) {
        recordSseRejectionDiagnostic({
          sessionId: admission.sessionId,
          runGeneration: admission.runGeneration,
          eventType: admission.eventType,
          decisionReason: admission.reason,
        });
        return;
      }
      const { event, type, sessionId: eventSessionId, runEpoch: eventRunEpoch, runGeneration: eventRunGeneration, terminalEvent } = admission.value;
      sseFloodCountRef.current = 0;
      if (type === "pi_chat_heartbeat") return;
      if (type === "pi_chat_sse_resync" || type === "pi_chat_oversized_event") {
        void refresh().catch(reportBackgroundRefreshError);
        return;
      }
      const eventRunStartedAt = finiteRunMetric(event.piChatRunStartedAt);
      const eventRunDurationMs = finiteRunMetric(event.piChatRunDurationMs);
      if (eventSessionId && typeof eventRunGeneration === "number") {
        const latest = sessionRunGenerationsRef.current.get(eventSessionId);
        const settled = settledRunGenerationsRef.current.get(eventSessionId);
        // A Pi turn is a monotonic lifecycle. Once a generation settles, every
        // non-terminal frame from it is stale, even if SSE/backpressure makes
        // it arrive after settlement. Explicit generation zero is valid before
        // the first agent_start; undefined means that no authority is known yet.
        if (latest !== undefined && eventRunGeneration < latest) {
          recordSseRejectionDiagnostic({
            sessionId: eventSessionId,
            runGeneration: eventRunGeneration,
            eventType: type || "unknown",
            decisionReason: "stale-run-generation",
          });
          return;
        }
        if (
          settled !== undefined
          && eventRunGeneration <= settled
          && type !== "agent_settled"
        ) {
          recordSseRejectionDiagnostic({
            sessionId: eventSessionId,
            runGeneration: eventRunGeneration,
            eventType: type || "unknown",
            decisionReason: "settled-run-generation",
          });
          return;
        }
        sessionRunGenerationsRef.current.set(
          eventSessionId,
          Math.max(latest ?? -1, eventRunGeneration),
        );
        if (type === "agent_settled")
          settledRunGenerationsRef.current.set(
            eventSessionId,
            Math.max(settled ?? -1, eventRunGeneration),
          );
      }
      // Only explicitly global frames may omit a Session ID. A malformed
      // session-scoped frame must never be interpreted as belonging to whatever
      // pane happens to be visible at that instant.
      if (isSessionScopedEvent(type) && !eventSessionId) {
        recordSseRejectionDiagnostic({
          eventType: type || "unknown",
          decisionReason: "missing-session",
        });
        return;
      }
      // A destination is no longer allowed to paint updates from the source
      // pane while navigation is in flight. Its events still update that pane's
      // cache, ready for an immediate return.
      const viewingEventSession =
        Boolean(eventSessionId) &&
        eventSessionId === viewedSessionIdRef.current &&
        viewedSessionIdRef.current === desiredSessionIdRef.current;
      /**
       * Session-status carries the same cumulative queue snapshot as the
       * dedicated queue event. Keep one projection path for both so a
       * coalesced/missed queue_dispatch cannot strand a local turn in FIFO.
       */
      const projectStatusQueue = (queue: QueuedPrompt[], paused: boolean): void => {
        if (!eventSessionId) return;
        applyQueueSnapshotEffect({
          sessionId: eventSessionId,
          queue,
          paused,
          viewing: viewingEventSession,
        }, {
          acceptQueue: (sessionId: any, incoming: any, incomingPaused: any) =>
            acceptQueueProjection(sessionId, incoming, incomingPaused, "event"),
          localTurns: (sessionId: any) => localUserTurnsRef.current.get(sessionId) || [],
          bindQueuedAdmission,
          promoteAbsentTurns: (turns: any, queuedIds: any) => promoteTurnsAbsentFromQueue(
            turns,
            queuedIds,
            false,
            true,
            cancellingQueueIdsRef.current.get(eventSessionId),
          ),
          dispatchPane,
          requestPromptReconcile: requestPromptReconcileRef.current,
          updateSidebar: (sessionId: any, currentQueue: any, projectionPaused: any) => setSessions((current: any) => current.map((session: any) =>
            session.id === sessionId
              ? applySidebarQueueProjection(session, currentQueue, projectionPaused)
              : session,
          )),
          patchSessionCache: (sessionId: any, currentQueue: any, projectionPaused: any) => patchSessionCache(sessionId, {
            queue: currentQueue,
            queuePaused: projectionPaused,
          }),
        });
      };
      if (
        event.piChatPromptId &&
        eventSessionId &&
        (type === "agent_start" ||
          type === "agent_settled" ||
          type === "pi_chat_process_error")
      ) {
        const observed = promptControllerRef.current.observeServerLifecycle(
          String(event.piChatPromptId),
          eventRunGeneration,
          eventSessionId,
          runEpochRef.current,
        );
        if (observed?.phase === "settled" ||
          observed?.phase === "failed" ||
          observed?.phase === "aborted")
          promptControllerRef.current.clearTerminal();
      }
      recordBrowserStateDiagnostic("sse", "admitted", {
        sessionId: eventSessionId,
        runGeneration: eventRunGeneration,
        details: {
          eventType: type || "unknown",
          viewing: viewingEventSession,
          navigationEpoch: navigationEpochRef.current,
        },
      });
      if (type === "pi_chat_prompt_retry_scheduled"
        || type === "pi_chat_prompt_retry_started"
        || type === "pi_chat_prompt_retry_exhausted"
        || type === "pi_chat_prompt_failed") {
        const retry = derivePromptRetryEffect(type, event);
        const {
          retryAttempt,
          retryAttempts,
          maxAttempts,
          delayMs,
          isRetryLifecycle,
          serverPromptId,
          retryPhase,
          status,
        } = retry;
        const observedRetry = isRetryLifecycle && serverPromptId && eventSessionId
          ? promptControllerRef.current.observeRetry(
              serverPromptId,
              retryPhase,
              eventRunGeneration,
              eventSessionId,
              eventRunEpoch,
              retryAttempt,
              maxAttempts,
              delayMs,
            )
          : undefined;
        // Once a Server Prompt has a terminal lifecycle fact, a late retry frame
        // must not repaint the Pane. Identity-less legacy frames keep the old
        // projection path; identity-bearing frames require an active operation.
        const retryIdentityMatchesEvent = Boolean(
          observedRetry
          && eventSessionId
          && observedRetry.sessionId === eventSessionId
          && (!eventRunEpoch
            || !observedRetry.runEpoch
            || observedRetry.runEpoch === eventRunEpoch),
        );
        const projectRetry = !isRetryLifecycle
          || !serverPromptId
          || Boolean(
            observedRetry
            && retryIdentityMatchesEvent
            && !["settled", "failed", "aborted"].includes(observedRetry.phase),
          );
        if (projectRetry && eventSessionId) {
          patchSessionCache(eventSessionId, { toolStatus: status, isStreaming: type !== "pi_chat_prompt_failed" });
          if (viewingEventSession)
            dispatchPane({ type: "TOOL_STATUS_UPDATED", sessionId: eventSessionId, status });
        }
        recordBrowserStateDiagnostic("retry", type, {
          sessionId: eventSessionId,
          runGeneration: eventRunGeneration,
          details: {
            retryAttempt,
            retryAttempts,
            maxAttempts,
            delayMs,
            provider: retry.provider,
            model: retry.model,
            api: retry.api,
          },
        });
      }
      if (type === "pi_chat_native_steering_dequeued") {
        const ids = Array.isArray(event.ids)
          ? event.ids.filter((id: any): id is string =>
              typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id),
            )
          : [];
        if (eventSessionId && ids.length) {
          const incomingRevision = typeof event.pendingSteerRevision === "number"
            ? event.pendingSteerRevision
            : 0;
          applyDequeuedSteers(eventSessionId, ids, incomingRevision);
        }
        return;
      }
      if (eventSessionId && invalidatesSessionViewVersion(type)) {
        sessionEventVersionRef.current.set(
          eventSessionId,
          (sessionEventVersionRef.current.get(eventSessionId) || 0) + 1,
        );
        lastSessionEventTypeRef.current.set(eventSessionId, type);
      }
      // View snapshots use stale-while-revalidate: retain them through streaming
      // and terminal events for instant navigation, then refresh in the background.
      // Only structural session mutations explicitly discard a snapshot below.
            const branchScope = Object.assign(Object.create(host), {
        event,
        type,
        eventSessionId,
        eventRunEpoch,
        eventRunGeneration,
        terminalEvent,
        eventRunStartedAt,
        eventRunDurationMs,
        viewingEventSession,
        projectStatusQueue,
        source,
      });
      if (dispatchPiEventBranch(branchScope)) return;

  };
}
