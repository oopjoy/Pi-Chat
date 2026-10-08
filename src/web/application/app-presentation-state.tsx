import { useMemo } from "react";
import { createSessionManagementActions } from "./session-management-actions";

export function useAppPresentationState(host: Record<string, any>) {
  const {
    ApiRequestError,
    api,
    ComposerControls,
    PiMarkIcon,
    activeSessionProjectionWriter,
    anySessionPendingConfirmation,
    anySessionQueued,
    anySessionRunning,
    appliedDraftRestorationSequencesRef,
    appliedQueueMutationSequenceRef,
    applyBootstrapMetadata,
    browserStateDiagnosticSnapshot,
    buildIdentityMismatch,
    busy,
    busySessionCountsRef,
    cancelPendingNavigation,
    cancelledQueueIdsRef,
    cancellingQueueIdsRef,
    changeGate,
    changeModel,
    changeThinking,
    clearPendingLiveMessage,
    closeComplete,
    commitPane,
    commitSidebarSessions,
    composerDraftKeyId,
    composerDraftRevisionsRef,
    composerModels,
    composerQueueMode,
    composerState,
    confirmedDeletedSessionIdsRef,
    confirmedQueueDispatchIdsRef,
    copyingSessionIds,
    createSession,
    createSessionManagementActions,
    currentSessionBusyBeforeStreaming,
    currentSessionRuntimePreparing,
    desiredSessionIdRef,
    diagnoseVisibleUserTurnDuplicates,
    diagnosticCheckpointRef,
    diagnosticSidebarRowsRef,
    diagnosticSseRejectionAtRef,
    diagnosticUiSignatureRef,
    diagnosticsBusy,
    downloadStateDiagnosticBundle,
    draftRestorationIntentSequenceRef,
    effectiveControl,
    error,
    forgetComposerKey,
    forgetLocalFailuresForSession,
    gateAvailable,
    gateMode,
    gateModesRef,
    lastSessionEventTypeRef,
    latestQueueProjectionRef,
    lifecycleBlocked,
    liveMessage,
    loading,
    localUserTurnsRef,
    messages,
    modelInventoryConfirmed,
    mutationBlocked,
    navigationEpochRef,
    notice,
    observing,
    optimisticDeletesRef,
    optimisticRenamesRef,
    optimisticSessionMutationTokenRef,
    optimisticSessionsTotal,
    pane,
    paneCommitRevisionRef,
    pendingGateModesRef,
    pendingScrollRestoreRef,
    pendingSessionPrefsRef,
    pendingSteersRef,
    primaryRuntime,
    primaryRuntimeMessage,
    openRuntimeSetup,
    primaryRuntimeUnavailable,
    promptBusyReleasesRef,
    promptStarting,
    queue,
    queueMutationSequenceRef,
    queuePaused,
    queueProjectionRevisionRef,
    queueProjectionSourceRef,
    recordBrowserStateDiagnostic,
    refresh,
    refreshOperationTokenRef,
    refreshSessionCache,
    refreshSidebarSessions,
    reportBackgroundRefreshError,
    resultPendingError,
    runEpochGenerationRef,
    runtimeStatus,
    saveSessionComposerSelections,
    scrollMemoryRef,
    sessionDialog,
    sessionEventVersionRef,
    sessionRunGenerationsRef,
    sessionRunningOverridesRef,
    sessions,
    sessionsRef,
    sessionsTotal,
    setBusy,
    setBusySessionIds,
    setCloseComplete,
    setComposerPendingByScope,
    setComposerSelectionRevision,
    setCopyingSessionIds,
    setDiagnosticsBusy,
    setError,
    setFailedSessionIds,
    setGateModes,
    setLocalFailures,
    setManagementSection,
    setNotice,
    setPendingGateModes,
    setPendingSteersBySession,
    setRefreshing,
    setRestoredComposerDrafts,
    setSessionDialog,
    setSessionDirectories,
    setSessionNavigation,
    setSessions,
    setSessionsTotal,
    setSteerDequeueingBySession,
    setStoppingSessionIds,
    setUnseenReplySessionIds,
    setWarmingSessionIds,
    settledRunGenerationsRef,
    sidebarCommittedFullSequenceRef,
    sidebarFullRequestSequenceRef,
    sourceTurnTotalsRef,
    state,
    stats,
    steerDequeueExpectedDraftRevisionRef,
    stoppingCurrentSession,
    stoppingOperationTokensRef,
    streamDiagnosticsRef,
    streamGapRecoveriesRef,
    streamingWireProjectionsRef,
    subagentAddressesRef,
    syncMutatingSessionIds,
    terminalAssistantSessionIdsRef,
    terminalAssistantStreamGenerationsRef,
    toolStatus,
    turnTotal,
    unreadSteeringDropMessagesRef,
    useEffect,
    useMemo,
    useRef,
    viewCacheWriter,
    viewSession,
    viewSwitching,
    viewedSession,
    viewedSessionId,
    viewedSessionIdRef,
    viewingSubagentSession,
    warmingSessionIdsRef,
  } = host;
  const diagnosticSidebarRows = useMemo(
    () => sessions.flatMap((session: any) => {
      const execution = session.activity?.execution ||
        (session.running ? "running" : session.queued ? "queued" : "idle");
      const interesting =
        session.id === viewedSessionId ||
        execution !== "idle" ||
        session.pendingConfirmation === true ||
        Boolean(session.controlOwner);
      if (!interesting) return [];
      const controlledByThisWindow = session.controlledByThisWindow === true;
      const foreignOwnerPresent = Boolean(
        session.controlOwner && !controlledByThisWindow,
      );
      return [{
        sessionId: session.id,
        execution,
        running: session.running === true,
        queued: session.queued === true,
        pendingConfirmation: session.pendingConfirmation === true,
        controlledByThisWindow,
        foreignOwnerPresent,
        viewed: session.id === viewedSessionId,
        signature: [
          execution,
          session.running === true,
          session.queued === true,
          session.pendingConfirmation === true,
          controlledByThisWindow,
          foreignOwnerPresent,
          session.id === viewedSessionId,
        ].join(":"),
      }];
    }),
    [sessions, viewedSessionId],
  );
  const diagnosticSidebarSignature = diagnosticSidebarRows
    .map((row: any) => `${row.sessionId}:${row.signature}`)
    .join("|");
  const diagnosticHasLive = Boolean(liveMessage);
  const diagnosticControlledByThisWindow =
    effectiveControl.controlledByThisWindow === true;
  const diagnosticForeignOwnerPresent = Boolean(
    effectiveControl.controlOwner && !diagnosticControlledByThisWindow,
  );
  const diagnosticUiDetails = {
    paneKind: pane.identity.kind,
    stateStreaming: state.isStreaming,
    compacting: state.isCompacting === true,
    hasLive: diagnosticHasLive,
    toolActive: Boolean(toolStatus),
    promptStarting,
    runtimeStatus,
    queuePaused,
    queueLength: queue.length,
    transcriptCount: messages.length,
    sidebarRows: sessions.length,
    sidebarRunning: viewedSession?.running === true,
    sidebarQueued: viewedSession?.queued === true,
    sidebarExecution: viewedSession?.activity?.execution || "none",
    sidebarRunningCount: sessions.filter((session: any) => session.running).length,
    sidebarQueuedCount: sessions.filter((session: any) => session.queued).length,
    sidebarFailedCount: sessions.filter((session: any) => session.activity?.execution === "failed").length,
    sidebarPausedCount: sessions.filter((session: any) => session.activity?.execution === "paused").length,
    sidebarConfirmationCount: sessions.filter((session: any) => session.pendingConfirmation).length,
    sidebarForeignOwnerCount: sessions.filter((session: any) =>
      Boolean(session.controlOwner && session.controlledByThisWindow !== true),
    ).length,
    observing,
    controlledByThisWindow: diagnosticControlledByThisWindow,
    foreignOwnerPresent: diagnosticForeignOwnerPresent,
    authorityPresent: Boolean(effectiveControl.controlOwner),
    composerQueueVisible: composerQueueMode,
    composerSteerEligible: state.isStreaming,
    composerStopVisible: state.isStreaming,
    composerSendVisible: !composerQueueMode,
    composerDisabled: mutationBlocked,
    stopping: stoppingCurrentSession,
  };
  const recordDiagnosticProjection = (force: boolean): void => {
    const uiSignature = JSON.stringify([viewedSessionId, diagnosticUiDetails]);
    if (force || diagnosticUiSignatureRef.current !== uiSignature) {
      diagnosticUiSignatureRef.current = uiSignature;
      recordBrowserStateDiagnostic("projection", "ui-state", {
        sessionId: viewedSessionId,
        details: diagnosticUiDetails,
      });
    }

    const previousRows = diagnosticSidebarRowsRef.current;
    const nextRows = new Map<string, string>();
    const allSessionIds = new Set(sessions.map((session: any) => session.id));
    for (const row of diagnosticSidebarRows) {
      nextRows.set(row.sessionId, row.signature);
      if (!force && previousRows.get(row.sessionId) === row.signature) continue;
      recordBrowserStateDiagnostic("projection", "sidebar-session", {
        sessionId: row.sessionId,
        details: {
          found: true,
          sidebarExecution: row.execution,
          sidebarRunning: row.running,
          sidebarQueued: row.queued,
          pendingConfirmation: row.pendingConfirmation,
          controlledByThisWindow: row.controlledByThisWindow,
          foreignOwnerPresent: row.foreignOwnerPresent,
          viewed: row.viewed,
        },
      });
    }
    if (!force) {
      for (const sessionId of previousRows.keys()) {
        if (nextRows.has(sessionId)) continue;
        recordBrowserStateDiagnostic("projection", "sidebar-session", {
          sessionId,
          details: {
            found: allSessionIds.has(sessionId),
            sidebarExecution: "idle",
            sidebarRunning: false,
            sidebarQueued: false,
            pendingConfirmation: false,
            controlledByThisWindow: false,
            foreignOwnerPresent: false,
            viewed: false,
          },
        });
      }
    }
    diagnosticSidebarRowsRef.current = nextRows;
  };
  diagnosticCheckpointRef.current = () => recordDiagnosticProjection(true);

  const diagnosedUserTurnProjectionRef = useRef("");
  useEffect(() => {
    const duplicates = diagnoseVisibleUserTurnDuplicates(
      messages,
      viewedSessionId ? (localUserTurnsRef.current.get(viewedSessionId) || []) : [],
      turnTotal,
    );
    for (const duplicate of duplicates) {
      const signature = [
        viewedSessionId,
        duplicate.kind,
        duplicate.contentHash,
        duplicate.pairCount,
        pane.identity.sessionId,
        paneCommitRevisionRef.current,
      ].join(":");
      if (diagnosedUserTurnProjectionRef.current === signature) continue;
      diagnosedUserTurnProjectionRef.current = signature;
      recordBrowserStateDiagnostic("projection", "user-turn-duplicate", {
        sessionId: viewedSessionId,
        details: {
          duplicateKind: duplicate.kind,
          duplicateCount: duplicate.messageCount,
          duplicatePairCount: duplicate.pairCount,
          localTurnCount: duplicate.localTurnCount,
          localRowCount: duplicate.localRowCount,
          persistedCount: duplicate.persistedCount,
          identityCount: duplicate.identityCount,
          persistedAfterBaselineCount: duplicate.persistedAfterBaselineCount,
          adjacent: duplicate.adjacent,
          sourceGeneration: paneCommitRevisionRef.current,
          projectionSource: "pane-commit",
        },
      });
    }
  }, [messages, pane.identity.sessionId, viewedSessionId]);

  useEffect(() => {
    recordDiagnosticProjection(false);
  }, [
    composerQueueMode,
    currentSessionBusyBeforeStreaming,
    currentSessionRuntimePreparing,
    diagnosticSidebarSignature,
    effectiveControl.controlOwner,
    effectiveControl.controlledByThisWindow,
    diagnosticHasLive,
    loading,
    messages.length,
    mutationBlocked,
    observing,
    viewingSubagentSession,
    pane.identity.kind,
    primaryRuntimeUnavailable,
    promptStarting,
    queue.length,
    queuePaused,
    runtimeStatus,
    sessions.length,
    state.isCompacting,
    state.isStreaming,
    stoppingCurrentSession,
    toolStatus,
    viewedSession?.activity?.execution,
    viewedSession?.queued,
    viewedSession?.running,
    viewedSessionId,
    viewSwitching,
  ]);

  const composerControls = (
    <ComposerControls
      state={composerState}
      models={composerModels}
      modelInventoryPending={!modelInventoryConfirmed}
      stats={stats}
      disabled={mutationBlocked || viewingSubagentSession}
      gateAvailable={gateAvailable}
      gateMode={gateMode}
      primaryUnavailable={false}
      onGate={(mode: any) => void changeGate(mode)}
      onModel={(provider: any, id: any, api: any) => void changeModel(provider, id, api)}
      onThinking={(level: any) => void changeThinking(level)}
    />
  );

  const composerNotices = (
    <>
      {buildIdentityMismatch && (
        <div className="primary-runtime-status is-failed" role="status">
          网页与服务版本不一致，普通操作已暂停。请刷新页面；若仍存在，可在左侧使用“完整重启”，或在设置中关闭
          Pi Chat 后重新打开。
        </div>
      )}
      {primaryRuntimeMessage && (
        <div
          className={`primary-runtime-status is-${primaryRuntime.status}`}
          role="status"
        >
          {primaryRuntimeMessage}
          {primaryRuntime.status === "failed" && <button type="button" className="runtime-setup-link" onClick={openRuntimeSetup}>连接设置 / 重试</button>}
        </div>
      )}
      {(error || notice) && (
        <div className={`app-toast ${error ? "error" : ""}`} role="status">
          {error || notice}
        </div>
      )}
    </>
  );

  const sessionDialogSource = sessionDialog
    ? sessions.find((session: any) => session.id === sessionDialog.session.id) || sessionDialog.session
    : null;
  const sessionDialogCopyBlocked = Boolean(
    sessionDialog &&
    (sessionDialog.mode === "clone" || sessionDialog.mode === "fork") &&
    (mutationBlocked ||
      copyingSessionIds.includes(sessionDialog.session.id) ||
      sessionDialogSource?.running ||
      sessionDialogSource?.queued ||
      sessionDialogSource?.pendingConfirmation ||
      sessionDialogSource?.messageCount === 0),
  );

  const {
    reconcileSessionMutation,
    applySessionListSnapshot,
    clearDeletedSessionProjection,
    finalizeDeletedSession,
    selectDeletionFallback,
    reconcilePendingSessionMutations,
    refreshManually,
    restartPi,
    shutdownPiChat,
    exportStateDiagnostics,
    copySessionToNew,
    confirmCloneSession,
    confirmForkSession,
    renameSession,
    deleteSession,
  } = createSessionManagementActions({
    ApiRequestError,
    activeSessionProjectionWriter,
    anySessionPendingConfirmation,
    anySessionQueued,
    anySessionRunning,
    api,
    appliedDraftRestorationSequencesRef,
    appliedQueueMutationSequenceRef,
    applyBootstrapMetadata,
    browserStateDiagnosticSnapshot,
    buildIdentityMismatch,
    busy,
    busySessionCountsRef,
    cancelPendingNavigation,
    cancelledQueueIdsRef,
    cancellingQueueIdsRef,
    clearPendingLiveMessage,
    commitPane,
    commitSidebarSessions,
    composerDraftKeyId,
    composerDraftRevisionsRef,
    confirmedDeletedSessionIdsRef,
    confirmedQueueDispatchIdsRef,
    copyingSessionIds,
    createSession,
    desiredSessionIdRef,
    diagnosticCheckpointRef,
    diagnosticSidebarRowsRef,
    diagnosticSseRejectionAtRef,
    diagnosticsBusy,
    downloadStateDiagnosticBundle,
    draftRestorationIntentSequenceRef,
    forgetComposerKey,
    forgetLocalFailuresForSession,
    gateModesRef,
    lastSessionEventTypeRef,
    latestQueueProjectionRef,
    lifecycleBlocked,
    localUserTurnsRef,
    mutationBlocked,
    navigationEpochRef,
    optimisticDeletesRef,
    optimisticRenamesRef,
    optimisticSessionMutationTokenRef,
    optimisticSessionsTotal,
    pendingGateModesRef,
    pendingScrollRestoreRef,
    pendingSessionPrefsRef,
    pendingSteersRef,
    promptBusyReleasesRef,
    queueMutationSequenceRef,
    queueProjectionRevisionRef,
    queueProjectionSourceRef,
    recordBrowserStateDiagnostic,
    refresh,
    refreshOperationTokenRef,
    refreshSessionCache,
    refreshSidebarSessions,
    reportBackgroundRefreshError,
    resultPendingError,
    runEpochGenerationRef,
    saveSessionComposerSelections,
    scrollMemoryRef,
    sessionDialog,
    sessionEventVersionRef,
    sessionRunGenerationsRef,
    sessionRunningOverridesRef,
    sessions,
    sessionsRef,
    sessionsTotal,
    setBusy,
    setBusySessionIds,
    setCloseComplete,
    setComposerPendingByScope,
    setComposerSelectionRevision,
    setCopyingSessionIds,
    setDiagnosticsBusy,
    setError,
    setFailedSessionIds,
    setGateModes,
    setLocalFailures,
    setManagementSection,
    setNotice,
    setPendingGateModes,
    setPendingSteersBySession,
    setRefreshing,
    setRestoredComposerDrafts,
    setSessionDialog,
    setSessionDirectories,
    setSessionNavigation,
    setSessions,
    setSessionsTotal,
    setSteerDequeueingBySession,
    setStoppingSessionIds,
    setUnseenReplySessionIds,
    setWarmingSessionIds,
    settledRunGenerationsRef,
    sidebarCommittedFullSequenceRef,
    sidebarFullRequestSequenceRef,
    sourceTurnTotalsRef,
    steerDequeueExpectedDraftRevisionRef,
    stoppingOperationTokensRef,
    streamDiagnosticsRef,
    streamGapRecoveriesRef,
    streamingWireProjectionsRef,
    subagentAddressesRef,
    syncMutatingSessionIds,
    terminalAssistantSessionIdsRef,
    terminalAssistantStreamGenerationsRef,
    unreadSteeringDropMessagesRef,
    viewCacheWriter,
    viewSession,
    viewedSessionIdRef,
    warmingSessionIdsRef,
  });


  return {
    diagnosticSidebarRows,
    diagnosticSidebarSignature,
    diagnosticHasLive,
    diagnosticControlledByThisWindow,
    diagnosticForeignOwnerPresent,
    diagnosticUiDetails,
    recordDiagnosticProjection,
    diagnosedUserTurnProjectionRef,
    composerControls,
    composerNotices,
    sessionDialogSource,
    sessionDialogCopyBlocked,
    reconcileSessionMutation,
    applySessionListSnapshot,
    clearDeletedSessionProjection,
    finalizeDeletedSession,
    selectDeletionFallback,
    reconcilePendingSessionMutations,
    refreshManually,
    restartPi,
    shutdownPiChat,
    exportStateDiagnostics,
    copySessionToNew,
    confirmCloneSession,
    confirmForkSession,
    renameSession,
    deleteSession,
  };
}
