import type { SessionDirectorySummary, SessionSummary, SessionViewData } from "../../shared/types";
import type { PaneAuthority, PaneAuthoritySnapshot, DraftPaneAuthority } from "./pane-authority";
import type { RuntimeProjectionWriteAuthority } from "./runtime-projection-writer";
import type { ActiveSessionProjectionAuthority, ActiveSessionViewAuthority, ActiveSessionDraftAuthority } from "./active-session-projection-writer";
import type { ModelCatalogueAuthority } from "./model-catalogue-revision-gate";

type SessionViewCommitAuthority = PaneAuthoritySnapshot & ActiveSessionViewAuthority;
type DraftSessionViewCommitAuthority = DraftPaneAuthority & ActiveSessionDraftAuthority;
type RefreshAuthority = Pick<PaneAuthority, "runEpochGeneration" | "cacheGeneration" | "navigationEpoch">
  & Pick<RuntimeProjectionWriteAuthority, "runtimeProjectionGeneration">
  & Pick<ActiveSessionProjectionAuthority, "activeSessionProjectionGeneration" | "activeSessionFullRevision">
  & ModelCatalogueAuthority
  & { refreshEpoch: number };

export function createSessionProjectionFlows(host: Record<string, any>) {
  const {
    EARLY_HISTORY_VIEW_DELAY_MS,
    EARLY_SIDEBAR_INVENTORY_DELAY_MS,
    MAX_DIRECTORY_PREFIX_SIZE,
    acceptQueueProjectionIfCurrent,
    activeSessionIds,
    activeSessionProjectionWriter,
    api,
    appearance,
    applyAppearance,
    applyBootstrap,
    applyBootstrapMetadata,
    applySidebarInventory,
    applySidebarQueueProjection,
    bootstrapCompletedRef,
    bootstrapInFlightRef,
    buildIdentityMatches,
    cancelPendingNavigation,
    cancellingQueueIdsRef,
    capturePaneAuthority,
    clearStoppingForSession,
    commitPane,
    commitSessionViewCache,
    commitSidebarSessions,
    committedPaneCommandsRef,
    committedPaneIdentityRef,
    completedCompactionSessionIdsRef,
    confirmPrimaryCapabilitySnapshot,
    confirmedDeletedSessionIdsRef,
    createSessionBootstrapFlow,
    createSessionViewApplicator,
    desiredSessionIdRef,
    directoryLoadGenerationsRef,
    directorySessionCoverageRef,
    draftAuthorityCanCommit,
    fetchSessionView,
    handshakeInFlightRef,
    initialHistoryRef,
    initialReadyRecoveryRequestedRef,
    loadAllSessionsGenerationRef,
    loadingEarlierRequestsRef,
    localDraftRef,
    localTurnBelongsInTranscript,
    localUserTurnsRef,
    modelCatalogueRevisionGate,
    navigationEpochRef,
    optimisticSessionsTotal,
    paneAuthorityCanCommit,
    paneModelRef,
    pinnedInventoryAttemptRef,
    promoteTurnsAbsentFromQueue,
    protectTranscriptWithLocalTurns,
    queueProjectionForView,
    queueProjectionRevisionRef,
    reconcileQueuedAdmissions,
    reconcileServerPendingPrompt,
    reconcileServerPendingSteers,
    reconcileSessionInventoryCurrent,
    recordBrowserStateDiagnostic,
    recordPaneCommit,
    recordSourceTurnTotal,
    recoverableRefreshError,
    refreshAuthorityIsCurrent,
    refreshEpochRef,
    rehydrateSubagentAddressChain,
    rememberConfirmedQueueDispatchIds,
    rememberedSessionId,
    replacementBootstrapPendingRef,
    reportBackgroundRefreshError,
    requestPromptReconcileRef,
    runEpochGenerationRef,
    runtimeProjectionWriter,
    saveAppearance,
    saveSessionNavigationPreferences,
    saveSidebarOpen,
    saveSidebarWidth,
    schedulePromptReconcileRef,
    sessionEventVersionRef,
    sessionNavigation,
    sessionNavigationRef,
    sessionRefreshGenerationRef,
    sessionRefreshInFlightRef,
    sessionRefreshRequestedFullRef,
    sessionRefreshRequestedRef,
    sessionRefreshTimerRef,
    sessions,
    setBuildIdentityMismatch,
    setError,
    setLoading,
    setLoadingAllSessions,
    setLoadingDirectoryKeys,
    setNotice,
    setPaneLoading,
    setRuntimeWarming,
    setServerBuildIdentity,
    setSessionDirectories,
    setSessions,
    setSessionsTotal,
    setUnseenReplySessionIds,
    showAllSessionsRef,
    sidebarCommittedFullSequenceRef,
    sidebarDirectoryKey,
    sidebarFullRequestSequenceRef,
    sidebarInventoryReady,
    sidebarInventoryReadyRef,
    sidebarOpen,
    sidebarWidth,
    subagentAddressesRef,
    terminalAssistantSessionIdsRef,
    tryAutoAllowGate,
    uniqueSessionSummaries,
    updateGateMode,
    useCallback,
    useEffect,
    viewCacheWriter,
    viewedSessionIdRef,
  } = host;
  const applySessionView = useCallback((
    view: SessionViewData,
    authority: SessionViewCommitAuthority | DraftSessionViewCommitAuthority,
    queueRequestRevision?: number,
  ) => createSessionViewApplicator({
    recordBrowserStateDiagnostic,
    confirmedDeleted: () => confirmedDeletedSessionIdsRef.current,
    paneAuthorityCanCommit: (authority: any) => "sessionId" in authority ? paneAuthorityCanCommit(authority) : draftAuthorityCanCommit(authority),
    projectActiveSession: (id: string) => activeSessionProjectionWriter.projectSessionView(id),
    reconcileActiveSession: (id: string, active: boolean, authority: any) => activeSessionProjectionWriter.reconcileSessionView(id, active, authority),
    completedCompaction: () => completedCompactionSessionIdsRef.current,
    queueProjectionForView,
    applySidebarQueueProjection,
    commitSessionViewCache,
    recordRejectedView: (sessionId: string, reason: string, authority: any) => {
      const decisionReason = reason === "session-deleted" ? reason : reason === "stale-authority"
        ? authority && "sessionId" in authority ? "stale-pane-authority" : "stale-draft-authority" : reason;
      recordBrowserStateDiagnostic("projection", "session-view-rejected", {
        sessionId,
        details: { authorityPresent: Boolean(authority), decisionReason },
      });
    },
    recordAcceptedView: (sessionId: string, authority: any) => recordBrowserStateDiagnostic("projection", "session-view-accepted", {
      sessionId,
      details: { authorityPresent: Boolean(authority), decisionReason: "accepted" },
    }),
    reconcileServerPendingPrompt,
    reconcileServerPendingSteers,
    clearStoppingForSession,
    viewedSessionId: () => viewedSessionIdRef.current,
    clearTerminalAssistantMarker: (id: string) => terminalAssistantSessionIdsRef.current.delete(id),
    clearUnseenReply: (id: string) => setUnseenReplySessionIds((current: any) => current.filter((candidate: any) => candidate !== id)),
    recordSourceTurnTotal,
    reconcileQueuedAdmissions,
    localTurns: (id: string) => localUserTurnsRef.current.get(id) || [],
    promoteTurnsAbsentFromQueue,
    cancellingQueueIds: (id: string) => cancellingQueueIdsRef.current.get(id),
    protectTranscriptWithLocalTurns,
    rememberConfirmedQueueDispatchIds,
    localTurnBelongsInTranscript,
    storeLocalTurns: (id: string, turns: any[]) => localUserTurnsRef.current.set(id, turns),
    deleteLocalTurns: (id: string) => localUserTurnsRef.current.delete(id),
    updateGateMode,
    extensionAuthority: (id: string, authority: any) => authority && "sessionId" in authority ? authority : capturePaneAuthority(id),
    tryAutoAllowGate,
    commitPane,
    committedPaneCommandsFor: (id: string) => committedPaneIdentityRef.current.kind === "session" && committedPaneIdentityRef.current.sessionId === id ? committedPaneCommandsRef.current : [],
    setRuntimeWarming,
    clearPaneLoading: (id: string) => setPaneLoading((current: any) => current?.sessionId === id ? null : current),
    recordPaneCommit,
    recordCommittedView: (resolvedView: SessionViewData, queuePaused: boolean) => recordBrowserStateDiagnostic("projection", "session-view-committed", {
      sessionId: resolvedView.session.id,
      details: {
        decisionReason: "committed",
        stateStreaming: resolvedView.state.isStreaming,
        viewStreaming: resolvedView.isStreaming,
        sessionRunning: resolvedView.session.running === true,
        hasLive: Boolean(resolvedView.liveMessage),
        toolActive: Boolean(resolvedView.toolStatus),
        queuePaused,
        queueLength: resolvedView.queue?.length || 0,
        runtimeStatus: resolvedView.runtimeStatus || "view-only",
      },
    }),
    isSubagentView: (id: string) => subagentAddressesRef.current.has(id),
    reconcileSessionInventoryCurrent,
    updateSessionSummary: (summary: SessionSummary) => setSessions((current: any) => {
      const known = current.some((session: any) => session.id === summary.id);
      if (!known && !sidebarInventoryReadyRef.current) return current;
      return uniqueSessionSummaries(known ? current.map((session: any) => session.id === summary.id ? { ...session, ...summary } : session) : [...current, summary]);
    }),
  })(view, authority, queueRequestRevision), [
    capturePaneAuthority, commitPane, tryAutoAllowGate, draftAuthorityCanCommit,
    paneAuthorityCanCommit, recordPaneCommit, reconcileServerPendingPrompt,
    reconcileServerPendingSteers, setRuntimeWarming, updateGateMode,
    clearStoppingForSession,
  ]);

  const ensureHandshake = useCallback(
    (refreshEpoch: number, runEpochGeneration: number) => {
      const current = handshakeInFlightRef.current;
      if (
        current &&
        current.refreshEpoch === refreshEpoch &&
        current.runEpochGeneration === runEpochGeneration
      )
        return current.request;
      if (current) {
        // Keep the same service token generation, but prevent this refresh from
        // joining a promise whose authority closure belongs to an older refresh.
        api.detachHandshake();
        handshakeInFlightRef.current = null;
      }
      const request = api
        .handshake()
        .then((handshake: any) => {
          if (
            refreshEpochRef.current !== refreshEpoch ||
            runEpochGenerationRef.current !== runEpochGeneration
          )
            return false;
          api.acceptHandshake(handshake);
          setServerBuildIdentity(handshake.buildIdentity);
          setBuildIdentityMismatch(
            !buildIdentityMatches(handshake.buildIdentity),
          );
          return true;
        })
        .finally(() => {
          if (handshakeInFlightRef.current?.request === request)
            handshakeInFlightRef.current = null;
        });
      handshakeInFlightRef.current = {
        refreshEpoch,
        runEpochGeneration,
        request,
      };
      return request;
    },
    [],
  );

  const loadBootstrap = useCallback((authority: RefreshAuthority) => {
    const current = bootstrapInFlightRef.current;
    if (
      current
      && current.runEpochGeneration === authority.runEpochGeneration
      && current.cacheGeneration === authority.cacheGeneration
      && current.runtimeProjectionGeneration ===
        authority.runtimeProjectionGeneration
      && current.activeSessionProjectionGeneration ===
        authority.activeSessionProjectionGeneration
      && current.activeSessionFullRevision ===
        authority.activeSessionFullRevision
      && current.modelCatalogueGeneration ===
        authority.modelCatalogueGeneration
    ) return current.request;
    // Never let a refresh authorized by a newer Runtime/cache observation join
    // a request that began before that projection existed. The old request is
    // uncancellable; identity-guarded cleanup prevents it detaching the new one.
    if (current) bootstrapInFlightRef.current = null;
    // api.bootstrap() performs the lightweight handshake only for the real
    // transport. Keeping this seam direct preserves test/local adapters that
    // supply a complete authenticated bootstrap projection themselves.
    const request = api.bootstrap().finally(() => {
      if (bootstrapInFlightRef.current?.request === request)
        bootstrapInFlightRef.current = null;
    });
    bootstrapInFlightRef.current = {
      request,
      runEpochGeneration: authority.runEpochGeneration,
      cacheGeneration: authority.cacheGeneration,
      runtimeProjectionGeneration: authority.runtimeProjectionGeneration,
      activeSessionProjectionGeneration:
        authority.activeSessionProjectionGeneration,
      activeSessionFullRevision: authority.activeSessionFullRevision,
      modelCatalogueGeneration: authority.modelCatalogueGeneration,
    };
    return request;
  }, []);

  const refresh = useCallback(
    () => createSessionBootstrapFlow({
      captureRefreshAuthority: () => ({
        refreshEpoch: ++refreshEpochRef.current,
        ...viewCacheWriter.captureAuthority(runEpochGenerationRef.current),
        ...runtimeProjectionWriter.captureAuthority(runEpochGenerationRef.current),
        ...activeSessionProjectionWriter.captureAuthority(runEpochGenerationRef.current),
        ...modelCatalogueRevisionGate.captureAuthority(),
        navigationEpoch: navigationEpochRef.current,
      }),
      desiredSessionId: () => desiredSessionIdRef.current,
      viewedSessionId: () => viewedSessionIdRef.current,
      rememberedSessionId,
      setDesiredSessionId: (id: string) => { desiredSessionIdRef.current = id; },
      sessionEventVersion: (id: string) => sessionEventVersionRef.current.get(id) || 0,
      queueProjectionRevision: (id: string) => queueProjectionRevisionRef.current.get(id) || 0,
      queueRevisionSnapshot: () => new Map(queueProjectionRevisionRef.current),
      capturePaneAuthority,
      initialHistory: () => initialHistoryRef.current,
      clearInitialHistory: () => { initialHistoryRef.current = null; },
      refreshAuthorityIsCurrent,
      confirmedDeleted: () => confirmedDeletedSessionIdsRef.current,
      hasLocalDraft: () => Boolean(localDraftRef.current),
      ensureHandshake,
      fetchSessionView,
      setInitialHistory: (value: any) => { initialHistoryRef.current = value; },
      applySessionView,
      earlyHistoryDelayMs: () => EARLY_HISTORY_VIEW_DELAY_MS,
      earlySidebarDelayMs: () => EARLY_SIDEBAR_INVENTORY_DELAY_MS,
      sidebarInventoryReady: () => sidebarInventoryReadyRef.current,
      showAllSessions: () => showAllSessionsRef.current,
      applySidebarInventory,
      refreshEpoch: () => refreshEpochRef.current,
      runEpochGeneration: () => runEpochGenerationRef.current,
      recordBootstrapRejected: (reason: string) => recordBrowserStateDiagnostic("projection", "bootstrap-rejected", {
        details: { authorityPresent: true, decisionReason: reason },
      }),
      markBootstrapCompleted: () => {
        bootstrapCompletedRef.current = true;
        if (typeof window !== "undefined") replacementBootstrapPendingRef.current = false;
      },
      applyBootstrapMetadata,
      acceptQueueProjectionIfCurrent,
      paneModel: () => paneModelRef.current,
      confirmPrimaryCapabilitySnapshot,
      clearRecoverableError: () => setError((current: any) => recoverableRefreshError(current) ? "" : current),
      activeSessionIds: () => activeSessionIds,
      applyBootstrap,
      paneAuthorityCanCommit,
      schedulePromptReconcile: (id: string, version?: number, failedAttempts?: number) =>
        schedulePromptReconcileRef.current(id, version, failedAttempts),
      requestPromptReconcile: (id: string) => requestPromptReconcileRef.current(id),
      requestPromptReconcileRef,
      loadBootstrap,
    })(),
    [
      applyBootstrap,
      applyBootstrapMetadata,
      applySessionView,
      applySidebarInventory,
      confirmPrimaryCapabilitySnapshot,
      capturePaneAuthority,
      ensureHandshake,
      fetchSessionView,
      loadBootstrap,
      paneAuthorityCanCommit,
      refreshAuthorityIsCurrent,
    ],
  );

  const startIdleRecovery = useCallback(
    (serverEpochChanged: any = false, refreshOnOrdinaryIdle: any = false) => {
      // Idle is authoritative lifecycle state even when the following bootstrap
      // is slow or rejected. Do not leave navigation and mutations locked on
      // stale maintenance state while JSONL fallback remains available.
      runtimeProjectionWriter.observeLifecycle("idle");
      setNotice("");
      const replacementBootstrapPending =
        replacementBootstrapPendingRef.current;
      const retryFailedInitialBootstrap =
        !bootstrapCompletedRef.current &&
        !initialReadyRecoveryRequestedRef.current;
      const needsRecovery =
        serverEpochChanged ||
        replacementBootstrapPending ||
        retryFailedInitialBootstrap;
      if (!needsRecovery && !refreshOnOrdinaryIdle) return;
      // A same-epoch ready can arrive while B's first bootstrap is pending. It
      // joins that request, so it must not consume the one retry reserved for a
      // later failed attempt.
      if (
        retryFailedInitialBootstrap &&
        !serverEpochChanged &&
        !replacementBootstrapPending &&
        bootstrapInFlightRef.current
      )
        return;
      // A replacement may first announce maintenance, so its later first idle
      // bootstrap remains distinct from this epoch's one failed-bootstrap retry.
      replacementBootstrapPendingRef.current = false;
      if (
        retryFailedInitialBootstrap &&
        !serverEpochChanged &&
        !replacementBootstrapPending
      )
        initialReadyRecoveryRequestedRef.current = true;
      void refresh()
        .then(async () => {
          const id = viewedSessionIdRef.current;
          if (!id) return;
          if (subagentAddressesRef.current.has(id)) {
            await rehydrateSubagentAddressChain(id).catch(() => undefined);
            return;
          }
          void api.markSessionViewed(id).catch(() => undefined);
        })
        .catch(reportBackgroundRefreshError);
    },
    [refresh, rehydrateSubagentAddressChain, reportBackgroundRefreshError],
  );

  const refreshSidebarSessions = useCallback(async (forceFull: any = false) => {
    const runEpochGeneration = runEpochGenerationRef.current;
    if (sessionRefreshInFlightRef.current) {
      if (sessionRefreshGenerationRef.current === runEpochGeneration) {
        sessionRefreshRequestedRef.current = true;
        sessionRefreshRequestedFullRef.current ||= forceFull;
        return;
      }
      // A replacement does not cancel browser requests. Detach A's coalescer so
      // B can read its own Session Index immediately; A's finally is ownership-guarded.
      sessionRefreshInFlightRef.current = false;
      sessionRefreshGenerationRef.current = null;
      sessionRefreshRequestedRef.current = false;
      sessionRefreshRequestedFullRef.current = false;
    }
    sessionRefreshInFlightRef.current = true;
    sessionRefreshGenerationRef.current = runEpochGeneration;
    try {
      const full = forceFull || showAllSessionsRef.current;
      const fullBarrier = sidebarCommittedFullSequenceRef.current;
      const fullRequestSequence = full
        ? ++sidebarFullRequestSequenceRef.current
        : 0;
      const result = await api.sessions(
        full,
        full ? [] : sessionNavigationRef.current.pinnedSessionIds,
        forceFull,
      );
      if (runEpochGenerationRef.current !== runEpochGeneration) return;
      for (const session of result.sessions) {
        if (
          typeof session.turnCount === "number" &&
          Number.isFinite(session.turnCount)
        )
          recordSourceTurnTotal(session.id, session.turnCount);
      }
      const committed = full
        ? commitSidebarSessions(result.sessions, {
            kind: "full",
            requestSequence: fullRequestSequence,
          })
        : commitSidebarSessions(result.sessions, {
            kind: "base",
            fullBarrier,
          });
      if (!committed) return;
      setSessionsTotal(
        optimisticSessionsTotal(
          result.sessions,
          result.total ?? result.sessions.length,
        ),
      );
      setSessionDirectories(result.directories || []);
    } catch (cause) {
      if (runEpochGenerationRef.current === runEpochGeneration) throw cause;
    } finally {
      if (sessionRefreshGenerationRef.current !== runEpochGeneration) return;
      sessionRefreshInFlightRef.current = false;
      sessionRefreshGenerationRef.current = null;
      if (sessionRefreshRequestedRef.current) {
        sessionRefreshRequestedRef.current = false;
        const requestedFull = sessionRefreshRequestedFullRef.current;
        sessionRefreshRequestedFullRef.current = false;
        void refreshSidebarSessions(requestedFull).catch(reportBackgroundRefreshError);
      }
    }
  }, [reportBackgroundRefreshError]);

  const loadAllSessions = useCallback(async () => {
    const runEpochGeneration = runEpochGenerationRef.current;
    if (
      showAllSessionsRef.current ||
      loadAllSessionsGenerationRef.current === runEpochGeneration
    )
      return;
    loadAllSessionsGenerationRef.current = runEpochGeneration;
    const fullRequestSequence = ++sidebarFullRequestSequenceRef.current;
    setLoadingAllSessions(true);
    setError("");
    try {
      const result = await api.sessions(true);
      if (runEpochGenerationRef.current !== runEpochGeneration) return;
      for (const session of result.sessions) {
        if (
          typeof session.turnCount === "number" &&
          Number.isFinite(session.turnCount)
        )
          recordSourceTurnTotal(session.id, session.turnCount);
      }
      if (
        !commitSidebarSessions(result.sessions, {
          kind: "full",
          requestSequence: fullRequestSequence,
        })
      )
        return;
      setSessionsTotal(
        optimisticSessionsTotal(
          result.sessions,
          result.total ?? result.sessions.length,
        ),
      );
      setSessionDirectories(result.directories || []);
    } catch (cause) {
      if (runEpochGenerationRef.current === runEpochGeneration)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (loadAllSessionsGenerationRef.current !== runEpochGeneration) return;
      loadAllSessionsGenerationRef.current = null;
      setLoadingAllSessions(false);
    }
  }, []);

  const loadDirectorySessions = useCallback(
    async (cwd: string, renderedCount: number) => {
      const runEpochGeneration = runEpochGenerationRef.current;
      const fullBarrier = sidebarCommittedFullSequenceRef.current;
      const key = sidebarDirectoryKey(cwd);
      if (directoryLoadGenerationsRef.current.get(key) === runEpochGeneration)
        return;
      directoryLoadGenerationsRef.current.set(key, runEpochGeneration);
      setLoadingDirectoryKeys((current: any) => [...new Set([...current, key])]);
      try {
        const covered =
          directorySessionCoverageRef.current.get(key) ?? renderedCount;
        if (covered >= MAX_DIRECTORY_PREFIX_SIZE) {
          const fullRequestSequence = ++sidebarFullRequestSequenceRef.current;
          const result = await api.sessions(true);
          if (runEpochGenerationRef.current !== runEpochGeneration) return;
          if (
            !commitSidebarSessions(result.sessions, {
              kind: "full",
              requestSequence: fullRequestSequence,
            })
          )
            return;
          setSessionsTotal(
            optimisticSessionsTotal(
              result.sessions,
              result.total ?? result.sessions.length,
            ),
          );
          setSessionDirectories(result.directories || []);
          return;
        }
        const result = await api.directorySessions(cwd, covered + 15);
        if (runEpochGenerationRef.current !== runEpochGeneration) return;
        if (
          !commitSidebarSessions(result.sessions, {
            kind: "directory",
            cwd,
            fullBarrier,
          })
        )
          return;
        setSessionDirectories(result.directories || []);
      } catch (cause) {
        if (runEpochGenerationRef.current === runEpochGeneration)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (directoryLoadGenerationsRef.current.get(key) !== runEpochGeneration)
          return;
        directoryLoadGenerationsRef.current.delete(key);
        setLoadingDirectoryKeys((current: any) =>
          current.filter((candidate: any) => candidate !== key),
        );
      }
    },
    [],
  );

  const scheduleSidebarRefresh = useCallback((forceFull: any = false) => {
    const runEpochGeneration = runEpochGenerationRef.current;
    if (forceFull) sessionRefreshRequestedFullRef.current = true;
    if (sessionRefreshTimerRef.current !== null)
      window.clearTimeout(sessionRefreshTimerRef.current);
    sessionRefreshTimerRef.current = window.setTimeout(() => {
      sessionRefreshTimerRef.current = null;
      if (runEpochGenerationRef.current !== runEpochGeneration) return;
      const requestedFull = sessionRefreshRequestedFullRef.current;
      sessionRefreshRequestedFullRef.current = false;
      void refreshSidebarSessions(requestedFull).catch(reportBackgroundRefreshError);
    }, 180);
  }, [refreshSidebarSessions, reportBackgroundRefreshError]);

  useEffect(() => {
    refresh()
      .catch(reportBackgroundRefreshError)
      .finally(() => setLoading(false));
    return () => {
      if (sessionRefreshTimerRef.current !== null)
        window.clearTimeout(sessionRefreshTimerRef.current);
      for (const request of loadingEarlierRequestsRef.current.values())
        request.controller.abort();
      cancelPendingNavigation();
    };
  }, [cancelPendingNavigation, refresh, reportBackgroundRefreshError]);

  useEffect(() => {
    applyAppearance(appearance);
    saveAppearance(appearance);
  }, [appearance]);

  useEffect(() => saveSidebarOpen(sidebarOpen), [sidebarOpen]);
  useEffect(() => saveSidebarWidth(sidebarWidth), [sidebarWidth]);
  useEffect(
    () => saveSessionNavigationPreferences(sessionNavigation),
    [sessionNavigation],
  );
  useEffect(() => {
    if (!sidebarInventoryReady || showAllSessionsRef.current) return;
    const pinned = sessionNavigation.pinnedSessionIds.filter((id: any) =>
      /^[a-f0-9]{20}$/i.test(id),
    );
    if (!pinned.length) return;
    const loaded = new Set(sessions.map((session: any) => session.id));
    if (pinned.every((id: any) => loaded.has(id))) return;
    const attempt = `${runEpochGenerationRef.current}:${pinned.join(",")}`;
    if (pinnedInventoryAttemptRef.current === attempt) return;
    pinnedInventoryAttemptRef.current = attempt;
    void refreshSidebarSessions().catch(reportBackgroundRefreshError);
  }, [
    refreshSidebarSessions,
    reportBackgroundRefreshError,
    sessionNavigation.pinnedSessionIds,
    sessions,
    sidebarInventoryReady,
  ]);

  // EventSource reconnects after a server restart, but it cannot replay events
  // missed while disconnected. Keep transport ownership in usePiEventSource;
  // this component remains responsible only for translating events into UI state.

  return {
    applySessionView,
    ensureHandshake,
    loadBootstrap,
    refresh,
    startIdleRecovery,
    refreshSidebarSessions,
    loadAllSessions,
    loadDirectorySessions,
    scheduleSidebarRefresh,
  };
}
