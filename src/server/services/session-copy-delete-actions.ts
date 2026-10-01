import type { BootstrapData, SessionCopyData, SessionForkOrigin } from "../../shared/types.js";

export function createSessionCopyDeleteActions(host: Record<string, any>) {
  const {
    HttpRequestError,
    RpcProcessExitUnconfirmedError,
    asState,
    finalizeSessionCopy,
    finalizeSessionDelete,
    prepareSessionDeletionRuntime,
    randomUUID,
    rpcData,
    validateSessionCopyPreparation,
    validateSessionDeletePath,
  } = host;
  async function copySession(
    id: string,
    mode: "clone" | "fork",
    persistedMessageId?: string,
  ): Promise<SessionCopyData> {
    if (
      host.copyRecoveryPendingSessionIds.has(id) ||
      host.copyProjectionPendingSessionIds.has(id) ||
      host.sessionMutationOutcomePending(id)
    )
      throw new HttpRequestError(409, "上次新对话已创建，但恢复或列表投影尚未确认；请勿重复操作");
    const releasePromptAdmission = await host.beginPromptAdmission(id);
    try {
      const knownSessions = await host.options.sessions.list();
      const knownSessionIds = new Set(knownSessions.map((session: any) => session.id));
      let runtime = host.runtimePool.get(id);
      const primary = id === host.activeSessionId && !runtime;
      if (!primary && !runtime) runtime = await host.ensureRuntime(id);
      const candidateSourcePath = runtime?.sessionPath
        || host.options.sessions.pathForId(id)
        || (primary ? host.lastPrimaryState.sessionFile : undefined);
      const candidateSummary = runtime?.summarySnapshot
        || host.options.sessions.summaryForId(id)
        || (primary ? host.primarySummarySnapshot || undefined : undefined);
      const target = mode === "fork"
        ? await host.options.sessions.forkTargetForId(id, persistedMessageId || "")
        : null;
      const copyPreparation = validateSessionCopyPreparation({
        mode,
        sourcePath: candidateSourcePath,
        summary: candidateSummary,
        draft: Boolean(runtime?.draftSession),
        primary,
        primaryBusy: host.primaryTurnActive()
          || host.dispatching
          || host.promptQueue.length > 0
          || host.queuePaused
          || Boolean(host.pendingExtensionRequest)
          || host.lastPrimaryState.isCompacting === true,
        secondaryBusy: Boolean(runtime && (!host.runtimePool.isIdle(runtime) || runtime.failed)),
        forkTargetAvailable: Boolean(target),
      });
      const sourcePath = copyPreparation.sourcePath;
      const summary = copyPreparation.summary;

      const operationAdmission = runtime
        ? runtime.operationAdmission
        : host.primaryOperationAdmission;
      const operationGeneration = await operationAdmission.closeAndDrain();
      if (operationGeneration === null)
        throw new HttpRequestError(409, "该会话正在休眠或切换，请刷新后重试");
      let copied;
      try {
        copied = await host.runBoundSessionCopy({
          id,
          sourcePath,
          mode,
          knownSessionIds,
          runtime,
          ...(target ? { entryId: target.entryId } : null),
        });
      } finally {
        operationAdmission.reopen(operationGeneration);
      }

      return finalizeSessionCopy({        host: {
          now: () => host.now(),
          recordFork: (destinationSessionId: any, origin: any) => host.sessionRelations.recordFork(destinationSessionId, origin),
          reportRelationFailure: (operation: any, error: any) => host.reportSessionRelationFailure(operation, error),
          listSessions: () => host.options.sessions.list(),
          summaryForId: (sessionId: any) => host.options.sessions.summaryForId(sessionId),
          pathForId: (sessionId: any) => host.options.sessions.pathForId(sessionId),
          markProjectionPending: (sourceSessionId: any) => host.copyProjectionPendingSessionIds.add(sourceSessionId),
          clearOutcome: (sourceSessionId: any) => {
            host.copyOutcomePendingSessionIds.delete(sourceSessionId);
            host.rpcOutcomePendingBySession.delete(sourceSessionId);
            host.rpcOutcomeTokensBySession.delete(sourceSessionId);
          },
          broadcastCopied: ({ action, sessionId, sourceSessionId }: any) =>
            host.broadcast({ type: "pi_chat_sessions_changed", action, sessionId, sourceSessionId }),
        },
        sourceSessionId: id,
        sourceName: summary.name,
            copied,
        ...(target ? { forkTarget: target } : null),
        ...(persistedMessageId ? { persistedMessageId } : null),
      });
    } finally {
      releasePromptAdmission();
    }
  }

  /** Test/embedding compatibility wrapper around the destructive path guard. */
  async function validatedSessionDeletePath(path: string, sessionId: string): Promise<string> {
    return validateSessionDeletePath({
      sessionRoot: () => host.options.sessions.root,
      indexedPath: (candidate: any) => host.options.sessions.pathForId(candidate),
    }, path, sessionId);
  }

  async function deleteSession(id: string): Promise<BootstrapData> {
    if (host.deletionOutcomePendingBySession.has(id)) {
      const fencedRuntime = host.runtimePool.get(id);
      // A prior deletion stop failed only because child exit was unconfirmed.
      // Once the same Runtime proves its child is gone, the destructive delete
      // itself has not yet run and may safely be retried.
      if (
        fencedRuntime?.admissionFenceReason === "deletion" &&
        fencedRuntime.rpc.isExitConfirmed?.()
      )
        host.deletionOutcomePendingBySession.delete(id);
      else
        throw new HttpRequestError(
          409,
          "删除结果尚未确认；请刷新对话列表核对，不要重复操作",
          "RESULT_PENDING",
          true,
        );
    }
    if (host.sessionMutationOutcomePending(id))
      throw new HttpRequestError(
        409,
        "上一次操作结果尚未确认；请刷新页面核对，不要重复执行会话操作",
        "RESULT_PENDING",
        true,
      );
    const orphanedStart = host.runtimePool.orphanedStart(id);
    if (orphanedStart) {
      try {
        await host.runtimePool.releaseOrphanedStart(id);
      } catch (error) {
        host.rethrowResultPending(error, "删除会话");
      }
    }
    await host.options.sessions.list(undefined, host.currentCwd);
    const runtime = host.runtimePool.get(id);
    const indexedPath = runtime?.sessionPath || runtime?.draftSessionPath || host.options.sessions.pathForId(id);
    const finalize = (path: string | undefined) => finalizeSessionDelete({
      getForkOrigin: (sessionId: any) => host.sessionRelations.getForkOrigin(sessionId),
      removeForkDestination: (sessionId: any) => host.sessionRelations.removeDestination(sessionId),
      restoreForkOrigin: (sessionId: any, origin: any) => host.sessionRelations.recordFork(sessionId, origin as SessionForkOrigin),
      reportRelationFailure: (operation: any, error: any) => host.reportSessionRelationFailure(operation, error),
      validateDeletePath: (candidatePath: any, sessionId: any) => validateSessionDeletePath({
        sessionRoot: () => host.options.sessions.root,
        indexedPath: (candidate: any) => host.options.sessions.pathForId(candidate),
      }, candidatePath, sessionId),
      clearDeletedSessionState: (sessionId: any) => {
        host.deletionOutcomePendingBySession.delete(sessionId);
        host.clearSessionRuntimeTransientState(sessionId, "deleted", { removeGatePreference: true });
        host.lastUserPromptAtBySession.delete(sessionId);
        host.pendingAcceptedPromptsBySession.delete(sessionId);
        host.persistedPromptIdsBySession.delete(sessionId);
        host.pendingConsumedSteersBySession.delete(sessionId);
        host.persistedSteerProjectionsBySession.delete(sessionId);
        host.nativeSteeringProjectionRevisions.delete(sessionId);
        host.runGenerationsBySession.delete(sessionId);
        host.copyOutcomePendingSessionIds.delete(sessionId);
        host.copyProjectionPendingSessionIds.delete(sessionId);
        host.sessionControl.clearSession(sessionId);
      },
      refreshSessions: async () => { await host.options.sessions.list(host.activeSessionPath, host.currentCwd); },
      broadcastDeleted: (sessionId: any) => host.broadcast({ type: "pi_chat_sessions_changed", action: "deleted", sessionId }),
      bootstrap: () => host.bootstrap(),
    }, id, path) as Promise<BootstrapData>;
    if (id !== host.activeSessionId && !indexedPath && !runtime) {
      // The fresh SessionIndex scan above proved that this is a stale sidebar
      // row. Delete is idempotent: retire its projections rather than showing
      // an error for a JSONL another process already removed.
      return finalize(undefined);
    }
    const deletionRuntime = await prepareSessionDeletionRuntime({
      activeSessionId: () => host.activeSessionId,
      primaryState: async () => asState(await host.options.rpc.send({ type: "get_state" }, 12_000)),
      primaryTurnActive: () => host.primaryTurnActive(),
      primaryQueueLength: () => host.promptQueue.length,
      primaryExtensionPending: () => Boolean(host.pendingExtensionRequest),
      resetPrimarySession: async () => {
        const outcomeToken = randomUUID();
        try {
          return rpcData(
            await host.options.rpc.send(
              { type: "new_session" },
              30_000,
              { onLateResponse: host.lateRpcOutcomeHandler(id, outcomeToken, "delete") },
            ),
          );
        } catch (error) {
          if (host.rpcOutcomeUnknown(error)) {
            host.deletionOutcomePendingBySession.add(id);
            host.markRpcOutcomePending(id, error, outcomeToken);
          }
          host.rethrowResultPending(error, "删除会话");
        }
      },
      runtime: () => runtime,
      indexedSessionPath: (sessionId: any) => host.options.sessions.pathForId(sessionId),
      runtimeSessionPath: (candidate: any) => candidate.sessionPath || candidate.draftSessionPath,
      runtimeTurnActive: (candidate: any) => host.runtimeTurnActive(candidate),
      runtimeQueueLength: (candidate: any) => candidate.promptQueue.length,
      runtimeExtensionPending: (candidate: any) => candidate.extensionUiPending,
      releaseRuntimeForDeletion: async (sessionId: any) => {
        try {
          return Boolean(await host.runtimePool.releaseForDeletion(sessionId));
        } catch (error) {
          if (error instanceof RpcProcessExitUnconfirmedError)
            host.deletionOutcomePendingBySession.add(sessionId);
          host.rethrowResultPending(error, "删除会话");
        }
      },
    }, id);
    return finalize(deletionRuntime.path);
  }


  return {
    copySession,
    validatedSessionDeletePath,
    deleteSession,
  };
}
