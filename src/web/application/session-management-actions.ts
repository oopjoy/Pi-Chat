import type { GateMode, SessionDirectorySummary, SessionSummary, SessionViewData } from "../../shared/types";
import type { ComposerDraftKey } from "../state/composer";
import type { StateDiagnosticExportBundle } from "../../shared/state-diagnostics";

export function createSessionManagementActions(host: Record<string, any>) {
  const {
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
  } = host;
  const reconcileSessionMutation = async (
    sessionId: string,
    kind: "rename" | "delete",
    expectedName?: string,
  ) => {
    const fullRequestSequence = ++sidebarFullRequestSequenceRef.current;
    const result = await api.sessions(true, [], true);
    const session = result.sessions.find((item: any) => item.id === sessionId);
    const outcome =
      kind === "rename"
        ? session?.name === expectedName
          ? "committed"
          : session
            ? "not-committed"
            : "absent"
        : session
          ? "not-committed"
          : "committed";
    return { outcome, result, fullRequestSequence } as const;
  };

  const applySessionListSnapshot = (result: {
    sessions: SessionSummary[];
    total: number;
    directories?: SessionDirectorySummary[];
  }, fullRequestSequence: number) => {
    if (
      !commitSidebarSessions(result.sessions, {
        kind: "full",
        requestSequence: fullRequestSequence,
      })
    )
      return false;
    setSessionsTotal(optimisticSessionsTotal(result.sessions, result.total));
    if (result.directories) setSessionDirectories(result.directories);
    return true;
  };

  /**
   * Delete terminal state is stronger than an ordinary list refresh: once an
   * authoritative source says a Session is gone, no older request may restore
   * its row or cached pane. Keep every Session-keyed projection cleanup here;
   * otherwise a long-lived tab retains image payloads, promises, generations,
   * and stale recovery markers forever after repeated deletes.
   */
  const clearDeletedSessionProjection = (sessionId: string): void => {
    if (!sessionId) return;
    const keyId = composerDraftKeyId({ kind: "session", sessionId });
    localUserTurnsRef.current.delete(sessionId);
    pendingSteersRef.current.delete(sessionId);
    gateModesRef.current = Object.fromEntries(
      Object.entries(gateModesRef.current).filter(([id]: any) => id !== sessionId),
    );
    pendingGateModesRef.current.delete(sessionId);
    pendingSessionPrefsRef.current.delete(sessionId);
    saveSessionComposerSelections(pendingSessionPrefsRef.current);
    setComposerSelectionRevision((revision: any) => revision + 1);
    composerDraftRevisionsRef.current.delete(keyId);
    appliedDraftRestorationSequencesRef.current.delete(keyId);
    steerDequeueExpectedDraftRevisionRef.current.delete(sessionId);
    cancelledQueueIdsRef.current.delete(sessionId);
    cancellingQueueIdsRef.current.delete(sessionId);
    queueProjectionRevisionRef.current.delete(sessionId);
    queueProjectionSourceRef.current.delete(sessionId);
    confirmedQueueDispatchIdsRef.current.delete(sessionId);
    latestQueueProjectionRef.current.delete(sessionId);
    queueMutationSequenceRef.current.delete(sessionId);
    appliedQueueMutationSequenceRef.current.delete(sessionId);
    sessionEventVersionRef.current.delete(sessionId);
    sessionRunGenerationsRef.current.delete(sessionId);
    settledRunGenerationsRef.current.delete(sessionId);
    lastSessionEventTypeRef.current.delete(sessionId);
    sourceTurnTotalsRef.current.delete(sessionId);
    sessionRunningOverridesRef.current.delete(sessionId);
    terminalAssistantSessionIdsRef.current.delete(sessionId);
    terminalAssistantStreamGenerationsRef.current.delete(sessionId);
    streamingWireProjectionsRef.current.delete(sessionId);
    streamGapRecoveriesRef.current.delete(sessionId);
    unreadSteeringDropMessagesRef.current.delete(sessionId);
    diagnosticSidebarRowsRef.current.delete(sessionId);
    for (const key of diagnosticSseRejectionAtRef.current.keys())
      if (key.startsWith(`${sessionId}:`)) diagnosticSseRejectionAtRef.current.delete(key);
    warmingSessionIdsRef.current.delete(sessionId);
    const promptBusyLease = promptBusyReleasesRef.current.get(sessionId);
    if (promptBusyLease) {
      promptBusyLease.markTerminal();
      promptBusyLease.release();
      promptBusyReleasesRef.current.delete(sessionId);
    }
    busySessionCountsRef.current.delete(sessionId);
    stoppingOperationTokensRef.current.delete(sessionId);
    for (const childId of [...subagentAddressesRef.current.keys()]) {
      if (childId === sessionId || subagentAddressesRef.current.get(childId)?.parentSessionId === sessionId)
        subagentAddressesRef.current.delete(childId);
    }
    viewCacheWriter.forgetCurrent(sessionId);
    scrollMemoryRef.current.forget(sessionId);
    streamDiagnosticsRef.current?.deleteSession(sessionId);
    setPendingSteersBySession(Object.fromEntries(pendingSteersRef.current));
    setGateModes({ ...gateModesRef.current });
    setPendingGateModes(Object.fromEntries(pendingGateModesRef.current));
    setSteerDequeueingBySession((current: any) => {
      if (!current[sessionId]) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setComposerPendingByScope((current: any) => {
      if (!(keyId in current)) return current;
      const next = { ...current };
      delete next[keyId];
      return next;
    });
    setWarmingSessionIds([...warmingSessionIdsRef.current]);
    setBusySessionIds([...busySessionCountsRef.current.keys()]);
    setStoppingSessionIds((current: any) => current.filter((id: any) => id !== sessionId));
    setFailedSessionIds((current: any) => current.filter((id: any) => id !== sessionId));
    setUnseenReplySessionIds((current: any) => current.filter((id: any) => id !== sessionId));
    activeSessionProjectionWriter.forgetCurrent(sessionId);
    setCopyingSessionIds((current: any) => current.filter((id: any) => id !== sessionId));
    setRestoredComposerDrafts((current: any) => {
      if (!(keyId in current)) return current;
      const next = { ...current };
      delete next[keyId];
      return next;
    });
  };

  const finalizeDeletedSession = (sessionId: string) => {
    const wasVisible = sessionId === viewedSessionIdRef.current;
    const desiredSessionId = desiredSessionIdRef.current;
    const wasViewed = wasVisible || sessionId === desiredSessionId;
    // A delete may settle after the user has already selected a live replacement.
    // Cancel only navigation to the deleted ID; preserve that newer destination.
    if (sessionId === desiredSessionId) cancelPendingNavigation();
    if (wasVisible) {
      clearPendingLiveMessage();
      pendingScrollRestoreRef.current = "";
      viewedSessionIdRef.current = "";
      if (desiredSessionIdRef.current === sessionId)
        desiredSessionIdRef.current = "";
      commitPane({ type: "CLEAR_PANE" });
    }
    optimisticRenamesRef.current.delete(sessionId);
    optimisticDeletesRef.current.delete(sessionId);
    confirmedDeletedSessionIdsRef.current.add(sessionId);
    // Keep a bounded tombstone set for already-resolved late continuations;
    // process-epoch invalidation remains the stronger long-term fence.
    while (confirmedDeletedSessionIdsRef.current.size > 512) {
      const oldest = confirmedDeletedSessionIdsRef.current.values().next().value;
      if (typeof oldest !== "string") break;
      confirmedDeletedSessionIdsRef.current.delete(oldest);
    }
    clearDeletedSessionProjection(sessionId);
    forgetComposerKey(composerDraftKeyId({ kind: "session", sessionId }));
    setSessionNavigation((current: any) => ({
      ...current,
      pinnedSessionIds: current.pinnedSessionIds.filter(
        (id: any) => id !== sessionId,
      ),
    }));
    setSessions((current: any) =>
      current.filter((session: any) => session.id !== sessionId),
    );
    syncMutatingSessionIds();
    return wasViewed;
  };

  const selectDeletionFallback = (
    deletedId: string,
    sessionsAfterDeletion: SessionSummary[],
    wasViewed: boolean,
  ) => {
    // Only replace a pane that was still selected when terminal deletion was
    // established; never override a newer user selection or local draft.
    if (!wasViewed) return;
    // A completed user navigation must win over deletion fallback. A deleted
    // visible pane has already been cleared to empty refs by finalization.
    if (
      (viewedSessionIdRef.current &&
        viewedSessionIdRef.current !== deletedId) ||
      (desiredSessionIdRef.current && desiredSessionIdRef.current !== deletedId)
    )
      return;
    // Deleting the conversation currently being read is an explicit end of
    // that reading context. Do not silently move the user into another recent
    // Session; create the New presentation instead. Other Sessions remain in
    // the sidebar and can be selected explicitly.
    void sessionsAfterDeletion;
    createSession();
  };

  /** Resolve only operations proven by a full authoritative Session inventory. */
  const reconcilePendingSessionMutations = async () => {
    const runEpochGeneration = runEpochGenerationRef.current;
    const fullRequestSequence = ++sidebarFullRequestSequenceRef.current;
    const result = await api.sessions(true, [], true);
    if (
      runEpochGenerationRef.current !== runEpochGeneration ||
      fullRequestSequence < sidebarCommittedFullSequenceRef.current
    )
      return false;
    let confirmed = false;
    const absentRenames: Array<{ id: string; wasViewed: boolean }> = [];
    for (const [id, pending] of optimisticRenamesRef.current) {
      const session = result.sessions.find((item: any) => item.id === id);
      if (session?.name === pending.name) {
        optimisticRenamesRef.current.delete(id);
        confirmed = true;
      } else if (!session) {
        absentRenames.push({ id, wasViewed: finalizeDeletedSession(id) });
        confirmed = true;
      }
    }
    for (const id of optimisticDeletesRef.current.keys()) {
      if (!result.sessions.some((session: any) => session.id === id)) {
        finalizeDeletedSession(id);
        confirmed = true;
      }
    }
    if (confirmed) syncMutatingSessionIds();
    applySessionListSnapshot(result, fullRequestSequence);
    for (const absent of absentRenames)
      selectDeletionFallback(absent.id, result.sessions, absent.wasViewed);
    return true;
  };

  const refreshManually = async () => {
    const runEpochGeneration = runEpochGenerationRef.current;
    const operationToken = Symbol("manual-refresh");
    refreshOperationTokenRef.current = operationToken;
    setRefreshing(true);
    setError("");
    try {
      const [metadataResult, inventoryResult] = await Promise.allSettled([
        refresh(),
        reconcilePendingSessionMutations(),
      ]);
      if (runEpochGenerationRef.current !== runEpochGeneration) return;
      if (inventoryResult.status === "rejected") throw inventoryResult.reason;
      if (
        inventoryResult.value &&
        refreshOperationTokenRef.current === operationToken
      )
        setNotice("会话已刷新");
      if (metadataResult.status === "rejected") {
        const cause = metadataResult.reason;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } catch (cause) {
      if (
        refreshOperationTokenRef.current === operationToken &&
        runEpochGenerationRef.current === runEpochGeneration
      )
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (refreshOperationTokenRef.current === operationToken) {
        refreshOperationTokenRef.current = null;
        setRefreshing(false);
      }
    }
  };

  const restartPi = async () => {
    // A mismatched bundle has stale browser state by definition. Let the server
    // make the final quiescence decision rather than trapping recovery behind a
    // possibly stale sidebar activity projection.
    if (
      busy ||
      lifecycleBlocked ||
      (!buildIdentityMismatch &&
        (anySessionRunning ||
          anySessionQueued ||
          anySessionPendingConfirmation))
    )
      return;
    if (
      !window.confirm(
        "完整重启 Pi Chat 并应用本地更新？\n\n将结束 Pi Chat 服务及其所有 Pi RPC 会话进程，重新构建当前工作目录，然后启动全新的 Pi Chat。已保存的前端、服务端、内置组件与本地配置更新都会生效；聊天记录不会删除。\n\n会重新加载当前电脑上已经保存的 Pi Chat、扩展和配置改动。正在生成、排队或等待确认时无法执行。",
      )
    )
      return;
    cancelPendingNavigation();
    setBusy(true);
    setError("");
    setNotice("正在结束 Pi Chat 进程、构建本地更新并启动全新服务…");
    try {
      await api.restart();
      // Wait for a different startup token so this and every observing window
      // reload only after the replacement listener is actually ready.
      await api.waitForApplicationHandoff();
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const shutdownPiChat = async () => {
    // See restartPi: only the server's live quiescence check is authoritative
    // when this Web bundle no longer agrees with that server.
    if (
      busy ||
      lifecycleBlocked ||
      (!buildIdentityMismatch &&
        (anySessionRunning ||
          anySessionQueued ||
          anySessionPendingConfirmation))
    )
      return;
    if (
      !window.confirm(
        "关闭全部 Pi Chat？\n\n将先检查所有窗口中的对话。只要任一对话仍在执行、排队或等待确认，就不会关闭。\n\n确认空闲后，将关闭所有浏览器/PWA 窗口、本地服务和全部 Pi RPC。聊天记录和设置会保留。",
      )
    )
      return;
    setBusy(true);
    setError("");
    setNotice("正在检查全部对话并关闭 Pi Chat…");
    try {
      await api.shutdown();
      setManagementSection(null);
      setCloseComplete("application");
      window.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const exportStateDiagnostics = async () => {
    if (diagnosticsBusy) return;
    setDiagnosticsBusy(true);
    setError("");
    try {
      recordBrowserStateDiagnostic("diagnostic", "export-requested", {
        sessionId: viewedSessionIdRef.current,
      });
      streamDiagnosticsRef.current?.checkpoint();
      diagnosticCheckpointRef.current();
      const server = await api.stateDiagnosticSnapshot();
      const bundle: StateDiagnosticExportBundle = {
        schemaVersion: 4,
        generatedAt: new Date().toISOString(),
        warning:
          "仅含最近五分钟的脱敏结构状态；服务端与当前浏览器页面各自保持本地顺序，时间戳不代表跨进程绝对顺序。",
        server,
        browser: browserStateDiagnosticSnapshot(),
      };
      const filename = downloadStateDiagnosticBundle(bundle);
      setNotice(`诊断已导出：${filename}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const copySessionToNew = (
    source: SessionSummary,
    persistedMessageId?: string,
  ) => {
    if (
      buildIdentityMismatch ||
      mutationBlocked ||
      copyingSessionIds.includes(source.id) ||
      optimisticRenamesRef.current.has(source.id) ||
      optimisticDeletesRef.current.has(source.id)
    )
      return;
    const runEpochGeneration = runEpochGenerationRef.current;
    const navigationEpoch = navigationEpochRef.current;
    const restorationSequence = persistedMessageId
      ? ++draftRestorationIntentSequenceRef.current
      : 0;
    setCopyingSessionIds((current: any) => [...new Set([...current, source.id])]);
    setError("");
    setNotice(
      persistedMessageId
        ? "正在从该消息创建新对话…"
        : "正在复制对话…",
    );
    const request = persistedMessageId
      ? api.forkSession(source.id, persistedMessageId)
      : api.cloneSession(source.id);
    let retainCopyGuard = false;
    void request
      .then((result: any) => {
        if (runEpochGenerationRef.current !== runEpochGeneration) return;
        setSessions((current: any) => [
          result.session,
          ...current.filter((session: any) => session.id !== result.session.id),
        ]);
        setSessionsTotal((current: any) =>
          sessionsRef.current.some((session: any) => session.id === result.session.id)
            ? current
            : current + 1,
        );
        if (result.editorText !== undefined || result.editorImages?.length) {
          const key: ComposerDraftKey = {
            kind: "session",
            sessionId: result.session.id,
          };
          const keyId = composerDraftKeyId(key);
          if (
            restorationSequence >
            (appliedDraftRestorationSequencesRef.current.get(keyId) || 0)
          ) {
            appliedDraftRestorationSequencesRef.current.set(
              keyId,
              restorationSequence,
            );
            setRestoredComposerDrafts((current: any) => ({
              ...current,
              [keyId]: {
                key,
                revision: restorationSequence,
                expectedDraftRevision:
                  composerDraftRevisionsRef.current.get(keyId) || 0,
                message: result.editorText || "",
                images: result.editorImages || [],
              },
            }));
          }
        }
        setNotice(result.warning || (
          persistedMessageId
            ? "已在新对话中分叉，可修改原消息后发送"
            : "已复制为新对话"
        ));
        void refreshSidebarSessions().catch(reportBackgroundRefreshError);
        if (navigationEpochRef.current === navigationEpoch)
          void viewSession(result.session.id, result.session.name);
      })
      .catch((cause: any) => {
        if (runEpochGenerationRef.current !== runEpochGeneration) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        const committedOrUncertain = /结果尚未确认|新对话已创建|请勿重复|不要重复/.test(message);
        retainCopyGuard = committedOrUncertain;
        setError(committedOrUncertain
          ? message
          : `${persistedMessageId ? "分叉" : "复制"}新对话失败：${message}`);
        if (committedOrUncertain) void refreshSidebarSessions().catch(reportBackgroundRefreshError);
      })
      .finally(() => {
        if (runEpochGenerationRef.current !== runEpochGeneration) return;
        if (!retainCopyGuard) setCopyingSessionIds((current: any) =>
          current.filter((sessionId: any) => sessionId !== source.id),
        );
      });
  };

  const confirmCloneSession = () => {
    const dialog = sessionDialog;
    if (!dialog || dialog.mode !== "clone") return;
    setSessionDialog(null);
    copySessionToNew(dialog.session);
  };

  const confirmForkSession = () => {
    const dialog = sessionDialog;
    if (!dialog || dialog.mode !== "fork") return;
    setSessionDialog(null);
    copySessionToNew(dialog.session, dialog.persistedMessageId);
  };

  const renameSession = (name: string) => {
    if (buildIdentityMismatch) return;
    const dialog = sessionDialog;
    if (!dialog || dialog.mode !== "rename") return;
    const sessionId = dialog.session.id;
    if (
      optimisticRenamesRef.current.has(sessionId) ||
      optimisticDeletesRef.current.has(sessionId)
    )
      return;
    const previousName = dialog.session.name;
    const runEpochGeneration = runEpochGenerationRef.current;
    const token = ++optimisticSessionMutationTokenRef.current;
    optimisticRenamesRef.current.set(sessionId, { token, previousName, name });
    syncMutatingSessionIds();
    setSessionDialog(null);
    setError("");
    setSessions((current: any) =>
      current.map((session: any) =>
        session.id === sessionId ? { ...session, name } : session,
      ),
    );
    refreshSessionCache(sessionId, {
      session: { ...dialog.session, name },
    });
    void api
      .renameSession(sessionId, name)
      .then(() => {
        if (optimisticRenamesRef.current.get(sessionId)?.token !== token)
          return;
        if (runEpochGenerationRef.current !== runEpochGeneration) {
          void reconcilePendingSessionMutations().catch(() => undefined);
          return;
        }
        optimisticRenamesRef.current.delete(sessionId);
        syncMutatingSessionIds();
        // `set_session_name` is the mutation authority. Sidebar/session views
        // refresh asynchronously through the renamed SSE event, so never make
        // a running rename wait for a full Bootstrap projection.
        setNotice("对话已重命名");
      })
      .catch(async (cause: any) => {
        const pending = optimisticRenamesRef.current.get(sessionId);
        if (!pending || pending.token !== token) return;
        if (runEpochGenerationRef.current !== runEpochGeneration) {
          void reconcilePendingSessionMutations().catch(() => undefined);
          return;
        }
        try {
          const { outcome, result, fullRequestSequence } =
            await reconcileSessionMutation(sessionId, "rename", name);
          if (
            optimisticRenamesRef.current.get(sessionId)?.token !== token ||
            runEpochGenerationRef.current !== runEpochGeneration ||
            fullRequestSequence < sidebarCommittedFullSequenceRef.current
          ) {
            if (runEpochGenerationRef.current !== runEpochGeneration)
              void reconcilePendingSessionMutations().catch(() => undefined);
            return;
          }
          if (outcome === "committed") {
            optimisticRenamesRef.current.delete(sessionId);
            syncMutatingSessionIds();
            applySessionListSnapshot(result, fullRequestSequence);
            setNotice("对话已重命名");
            return;
          }
          if (outcome === "absent") {
            const wasViewed = finalizeDeletedSession(sessionId);
            applySessionListSnapshot(result, fullRequestSequence);
            selectDeletionFallback(sessionId, result.sessions, wasViewed);
            setError("重命名未完成：对话已不存在或已被删除");
            return;
          }
          if (outcome === "not-committed") {
            const definiteRejection =
              cause instanceof ApiRequestError &&
              cause.status >= 400 &&
              cause.status < 500 &&
              !resultPendingError(cause);
            if (definiteRejection) {
              optimisticRenamesRef.current.delete(sessionId);
              syncMutatingSessionIds();
              applySessionListSnapshot(result, fullRequestSequence);
              setError(`重命名失败，已恢复原名称：${cause.message}`);
              return;
            }
            // A fresh JSONL snapshot is not a completion barrier for the
            // original request: the server may still be finishing its RPC and
            // index refresh after the HTTP response was lost. Keep the local
            // name and mutation guard until positive terminal evidence arrives.
            applySessionListSnapshot(result, fullRequestSequence);
          }
        } catch {
          // Transport is still indeterminate; retain the local intent and guard.
        }
        if (optimisticRenamesRef.current.get(sessionId)?.token !== token)
          return;
        if (runEpochGenerationRef.current !== runEpochGeneration) {
          void reconcilePendingSessionMutations().catch(() => undefined);
          return;
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(`重命名结果尚未确认，请刷新页面后核对：${message}`);
      });
  };

  const deleteSession = () => {
    if (buildIdentityMismatch) return;
    const dialog = sessionDialog;
    if (!dialog || dialog.mode !== "delete") return;
    const deleting = dialog.session;
    const deletingId = deleting.id;
    if (
      optimisticRenamesRef.current.has(deletingId) ||
      optimisticDeletesRef.current.has(deletingId)
    )
      return;
    const index = sessions.findIndex((session: any) => session.id === deletingId);
    const wasViewed =
      deletingId === desiredSessionIdRef.current ||
      deletingId === viewedSessionIdRef.current;
    const runEpochGeneration = runEpochGenerationRef.current;
    const token = ++optimisticSessionMutationTokenRef.current;
    optimisticDeletesRef.current.set(deletingId, {
      token,
      session: deleting,
      index,
      sessionsTotal,
      wasViewed,
    });
    streamDiagnosticsRef.current?.deleteSession(deletingId);
    // Session ids are path-derived, so a conversation created later can reuse the
    // id of a deleted one; retained failure cards must not survive the delete.
    setLocalFailures((current: any) => forgetLocalFailuresForSession(current, deletingId));
    syncMutatingSessionIds();
    if (wasViewed) cancelPendingNavigation();
    setSessionDialog(null);
    setError("");
    setSessions((current: any) =>
      current.filter((session: any) => session.id !== deletingId),
    );
    setSessionsTotal((current: any) => Math.max(0, current - 1));
    if (wasViewed) createSession();
    void api
      .deleteSession(deletingId)
      .then((data: any) => {
        if (optimisticDeletesRef.current.get(deletingId)?.token !== token)
          return;
        if (runEpochGenerationRef.current !== runEpochGeneration) {
          void reconcilePendingSessionMutations().catch(() => undefined);
          return;
        }
        const finalizedViewed = finalizeDeletedSession(deletingId);
        // Delete responses may reconcile ancillary inventory, but they never
        // carry refresh-order authority for core Runtime projections.
        applyBootstrapMetadata(data);
        selectDeletionFallback(deletingId, data.sessions, finalizedViewed);
        setNotice("对话已删除");
      })
      .catch(async (cause: any) => {
        const pending = optimisticDeletesRef.current.get(deletingId);
        if (!pending || pending.token !== token) return;
        if (runEpochGenerationRef.current !== runEpochGeneration) {
          void reconcilePendingSessionMutations().catch(() => undefined);
          return;
        }
        try {
          const { outcome, result, fullRequestSequence } =
            await reconcileSessionMutation(deletingId, "delete");
          if (
            optimisticDeletesRef.current.get(deletingId)?.token !== token ||
            runEpochGenerationRef.current !== runEpochGeneration ||
            fullRequestSequence < sidebarCommittedFullSequenceRef.current
          ) {
            if (runEpochGenerationRef.current !== runEpochGeneration)
              void reconcilePendingSessionMutations().catch(() => undefined);
            return;
          }
          if (outcome === "committed") {
            const finalizedViewed = finalizeDeletedSession(deletingId);
            applySessionListSnapshot(result, fullRequestSequence);
            selectDeletionFallback(
              deletingId,
              result.sessions,
              finalizedViewed,
            );
            setNotice("对话已删除");
            return;
          }
          if (outcome === "not-committed") {
            const definiteRejection =
              cause instanceof ApiRequestError &&
              cause.status >= 400 &&
              cause.status < 500 &&
              !resultPendingError(cause);
            if (definiteRejection) {
              optimisticDeletesRef.current.delete(deletingId);
              syncMutatingSessionIds();
              applySessionListSnapshot(result, fullRequestSequence);
              setError(`删除失败，已恢复对话显示：${cause.message}`);
              return;
            }
            // Presence in a fresh inventory does not prove a timed-out delete
            // failed; unlink/index refresh may still be in flight. Keep the row
            // hidden and guarded until absence or a structural SSE proves the
            // terminal outcome.
            applySessionListSnapshot(result, fullRequestSequence);
          }
        } catch {
          // Transport is still indeterminate; retain the local intent and guard.
        }
        if (optimisticDeletesRef.current.get(deletingId)?.token !== token)
          return;
        if (runEpochGenerationRef.current !== runEpochGeneration) {
          void reconcilePendingSessionMutations().catch(() => undefined);
          return;
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(`删除结果尚未确认，请刷新页面后核对：${message}`);
      });
  };


  return {
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
