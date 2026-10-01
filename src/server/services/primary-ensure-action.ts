import type { PiState } from "../../shared/types.js";

export function createPrimaryEnsureAction(host: Record<string, any>) {
  const {
    OperationAdmissionClosedError,
    PrimaryRuntimeReadinessController,
    PrimaryRuntimeUnavailableError,
    asState,
    idForPath,
  } = host;
  async function ensurePrimaryRuntime(): Promise<void> {
    if (host.closed) throw new Error("Pi Chat 已关闭");
    if (host.primaryOperationAdmission.isClosed) {
      if (!host.options.rpc.isExitConfirmed?.())
        throw new OperationAdmissionClosedError("Primary Runtime 正在确认退出，请稍后重试");
      host.primaryOperationAdmission.reopen(host.primaryOperationAdmission.generation);
    }
    const primaryRuntime = host.options.primaryRuntime;
    let readiness = primaryRuntime?.snapshot();
    // waitUntilReady() intentionally preserves a failed readiness snapshot for
    // read-only callers. Mutating callers, however, are the recovery boundary:
    // an initial spawn/probe failure must be allowed to retry without requiring
    // a whole server restart.
    if (primaryRuntime && readiness?.status !== "failed") {
      try {
        await primaryRuntime.waitUntilReady();
      } catch (error) {
        readiness = primaryRuntime.snapshot();
        if (readiness.status !== "failed") throw error;
      }
    }
    readiness = primaryRuntime?.snapshot();
    // Reaching this point after waitUntilReady() means the normal startup path
    // is ready. A failed snapshot deliberately skips that wait and falls into
    // the single-flight recovery below.
    if (!host.primaryNeedsRecovery(readiness)) return;
    if (host.primaryRecovery) return host.primaryRecovery;
    const recovery = (async () => {
      try {
        // A cold service may still be completing its initial asynchronous
        // Primary spawn. If it won the race, consume that worker rather than
        // stopping/restarting it a second time.
        if (host.primaryNeedsRecovery(readiness)) {
          host.clearNativeSteeringState(host.activeSessionId, "recovery");
          host.clearPromptDiagnostic(host.activeSessionId);
          // The controller's adopter completes App binding before recover()
          // resolves. Never issue a second get_state here: that recreated the
          // split authority where SSE said ready while App was still adopting.
          if (primaryRuntime) {
            host.options.rpc.setDiagnosticSessionId?.(host.activeSessionId);
            await host.recoverPrimaryRuntimeWithQueueFence(
              primaryRuntime,
              host.activeSessionPath || undefined,
              host.primaryRuntimeCwd,
            );
            if (host.closed) return;
            if (!(primaryRuntime instanceof PrimaryRuntimeReadinessController)) {
              const state = asState(
                await host.options.rpc.send({ type: "get_state" }),
              );
              host.lastPrimaryState = state;
              host.running = state.isStreaming;
              host.primaryFailed = false;
              host.toolStatus = "";
              host.bindPrimaryIdentity(state);
            }
          } else {
            // Legacy in-process embeddings do not have the controller/adopter
            // contract. Preserve their explicit post-restart state bind; the
            // production entrypoint always takes the controller branch above.
            const response = await host.options.rpc.restart(
              host.activeSessionPath || undefined,
              host.primaryRuntimeCwd,
            );
            if (host.closed) return;
            const state = asState(
              response || (await host.options.rpc.send({ type: "get_state" })),
            );
            if (host.closed) return;
            host.lastPrimaryState = state;
            host.running = state.isStreaming;
            host.primaryFailed = false;
            host.toolStatus = "";
            host.bindPrimaryIdentity(state);
          }
          if (host.closed) return;
          host.clearRuntimeFailure(host.activeSessionId);
          const runGeneration = host.advanceSessionRunGeneration(
            host.activeSessionId,
          );
          host.broadcast({
            type: "pi_chat_process_recovered",
            piChatSessionId: host.activeSessionId,
            piChatRunEpoch: host.runEpoch,
            piChatRunGeneration: runGeneration,
          });
          host.broadcastSessionActivity(host.activeSessionId);
          host.resumeRecoveredPrimaryQueue();
        }
      } catch (error) {
        host.primaryFailed = true;
        if (error instanceof PrimaryRuntimeUnavailableError) throw error;
        if (host.rpcOutcomeUnknown(error)) {
          // A failed Primary restart may still own its JSONL. Fence new
          // operations until the RPC client proves that child ownership ended.
          host.primaryOperationAdmission.fence();
          throw error;
        }
        throw new Error(
          `主 Pi RPC 恢复失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    })();
    host.primaryRecovery = recovery;
    try {
      await recovery;
    } finally {
      if (host.primaryRecovery === recovery) host.primaryRecovery = null;
    }
  }

  /** Bind event attribution only to the child generation that produced get_state. */
  function bindPrimaryIdentity(state: PiState): void {
    const sessionId = state.sessionFile
      ? idForPath(state.sessionFile)
      : state.sessionId || "";
    if (!sessionId) return;
    const previousSessionId = host.primaryBoundSessionId;
    const previousRpcGeneration = host.primaryRpcGeneration;
    const sameRuntimeFastMode = Boolean(
      previousSessionId &&
      previousRpcGeneration &&
      previousRpcGeneration ===
        (host.options.rpc.currentGeneration?.() || 0) &&
      host.fastModeBySession.get(previousSessionId) === true,
    );
    host.activeSessionId = sessionId;
    host.activeSessionPath = state.sessionFile || host.activeSessionPath;
    host.primaryBoundSessionId = sessionId;
    host.options.rpc.setDiagnosticSessionId?.(sessionId);
    host.primaryRpcGeneration = host.options.rpc.currentGeneration?.() || 0;
    const pendingFastMode = host.pendingPrimaryFastMode;
    host.pendingPrimaryFastMode = undefined;
    if (previousSessionId && previousSessionId !== sessionId)
      host.setFastModeActive(previousSessionId, false);
    if (
      pendingFastMode &&
      pendingFastMode.rpcGeneration === host.primaryRpcGeneration
    )
      host.setFastModeActive(sessionId, pendingFastMode.active);
    else if (previousSessionId !== sessionId)
      host.setFastModeActive(sessionId, sameRuntimeFastMode);
    else if (
      previousRpcGeneration &&
      previousRpcGeneration !== host.primaryRpcGeneration
    )
      host.setFastModeActive(sessionId, false);
  }

  /** Bind Primary's Session only after the readiness gate passed. */

  return { ensurePrimaryRuntime, bindPrimaryIdentity };
}
