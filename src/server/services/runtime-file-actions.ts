import type { PiState } from "../../shared/types.js";
import { HttpRequestError } from "../http-transport.js";
import { applyModelFileTransaction as applyModelFileTransactionService } from "./model-file-transaction.js";
import type { FileSnapshot } from "../file-transaction.js";

export function createRuntimeFileActions(host: Record<string, any>) {
  const {
    PrimaryRuntimeReadinessController,
    asModels,
    asState,
    basename,
    createCustomModelManagement,
    createProviderManagement,
    createRuntimeSettingsService,
    randomUUID,
    reloadPrimaryResources,
    resolve,
    restartPrimaryRuntimeService,
    restoreSnapshots,
    saveWorkspace,
    snapshotFile,
    stat,
  } = host;
  async function restartPrimaryRuntime(
    sessionFile?: string,
    cwd = host.primaryRuntimeCwd,
  ): Promise<void> {
    await restartPrimaryRuntimeService({
      closed: () => host.closed,
      primaryRuntime: host.options.primaryRuntime,
      isConcreteReadinessController: () => host.options.primaryRuntime instanceof PrimaryRuntimeReadinessController,
      rpc: host.options.rpc,
      primaryRuntimeCwd: () => host.primaryRuntimeCwd,
      activeSessionId: () => host.activeSessionId,
      currentGateMode: () => host.gateModesBySession.get(host.activeSessionId) || host.primaryGateMode,
      recoverPrimary: (runtime: any, file: any, runtimeCwd: any) => host.recoverPrimaryRuntimeWithQueueFence(runtime, file, runtimeCwd),
      legacyRestart: async (file: any, runtimeCwd: any) => { await host.options.rpc.restart(file, runtimeCwd); },
      lateRpcOutcomeHandler: (id: any, token: any) => host.lateRpcOutcomeHandler(id, token, "generic"),
      markRpcOutcomePending: (id: any, error: any, token: any) => host.markRpcOutcomePending(id, error, token),
      isOutcomeUnknown: (error: any) => host.rpcOutcomeUnknown(error),
      fencePrimaryOperation: () => host.primaryOperationAdmission.fence(),
      setPrimaryGateMode: (mode: any) => { host.primaryGateMode = mode; },
    }, sessionFile, cwd);
  }

  async function reloadRpc(knownState?: PiState): Promise<void> {
    host.assertApplicationQuiescent("修改资源配置");
    const state = knownState || asState(await host.options.rpc.send({ type: "get_state" }));
    const replacedSessionIds = new Set([
      host.activeSessionId,
      ...host.runtimePool.runtimes.keys(),
    ]);
    for (const sessionId of replacedSessionIds)
      host.clearSessionRuntimeTransientState(sessionId, "resources-reloading", {
        advanceGeneration: true,
      });
    await reloadPrimaryResources({
      getPrimaryState: async () => state,
      stopSecondaryRuntimes: () => host.runtimePool.stopAll({ terminal: false }),
      restartPrimary: (sessionFile: any) => host.restartPrimaryRuntime(sessionFile),
      rethrowResultPending: (error: any, operation: any) => host.rethrowResultPending(error, operation),
      broadcastReloaded: () => host.broadcast({ type: "pi_chat_reloaded" }),
    }, state);
  }

  async function applyResourceFileTransaction<T>(
    snapshots: FileSnapshot[],
    mutation: () => Promise<T>,
  ): Promise<T> {
    const state = asState(await host.options.rpc.send({ type: "get_state" }));
    if (state.isStreaming)
      throw new Error("请先停止所有并行生成，再修改资源配置");
    let changed = false;
    try {
      const result = await mutation();
      changed = true;
      // ResourceManager inventories are read projections. Invalidate them only
      // after the file transaction commits, before the replacement Runtime
      // starts reading the new settings/resources.
      host.options.resources.invalidate?.();
      await host.reloadRpc(state);
      return result;
    } catch (error) {
      // Once the resource file mutation has committed, an unknown reload RPC
      // outcome must not trigger an immediate rollback/restart race. The
      // caller receives one retry-safe result-pending response instead.
      if (error instanceof HttpRequestError && error.code === "RESULT_PENDING")
        throw error;
      if (!changed) {
        host.options.resources.invalidate?.();
        // The file-manager write itself may have reached disk before its RPC
        // acknowledgement timed out. Treat that outcome as uncertain too;
        // retrying a POST/DELETE/PUT could duplicate the mutation.
        host.rethrowResultPending(error, "更新资源配置");
        throw error;
      }
      const original = error instanceof Error ? error.message : String(error);
      try {
        await restoreSnapshots(snapshots);
        host.options.resources.invalidate?.();
        await host.restartPrimaryRuntime(state.sessionFile);
        host.broadcast({ type: "pi_chat_reloaded" });
      } catch (rollbackError) {
        throw new Error(
          `资源修改失败，自动恢复也失败：${original}；恢复错误：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      throw new Error(`资源修改失败，原配置已自动恢复：${original}`);
    }
  }

  /** Compatibility wrapper; the transaction owner lives in the model service. */
  async function applyModelFileTransaction<T>(mutation: () => Promise<T>): Promise<T> {
    if (!host.options.modelManager) throw new Error("模型管理不可用");
    return applyModelFileTransactionService(
      {
        snapshot: () => snapshotFile(host.options.modelManager!.path),
        restore: (snapshot: any) => restoreSnapshots([snapshot]),
        invalidateCatalogue: () => host.refreshHostModelCatalogue(),
        rethrowResultPending: (error: any, operation: any) => host.rethrowResultPending(error, operation, false) as never,
      },
      "更新模型配置",
      mutation,
    );
  }

  function providerManagementService() {
    if (!host.options.modelManager) throw new Error("模型管理不可用");
    return createProviderManagement({
      manager: host.options.modelManager,
      withLifecycle: (description: any, mutation: any) =>
        host.withLifecycle("models-refreshing", description, mutation),
      withModelFileTransaction: (mutation: any) => host.applyModelFileTransaction(mutation),
      primaryState: async () => host.options.rpc.send({ type: "get_state" }),
      secondaryStates: () => host.runtimePool.rpcStatesForQuiescence(),
      bootstrap: () => host.bootstrap(),
    });
  }

  function runtimeSettingsService() {
    return createRuntimeSettingsService({
      activeSessionId: () => host.activeSessionId,
      primaryRpc: () => host.options.rpc,
      primaryRunning: () => host.running,
      secondaryRuntime: (sessionId: any) => host.runtimePool.get(sessionId) || null,
      ensurePrimaryRuntime: () => host.ensurePrimaryRuntime(),
      recoverSecondary: (runtime: any) => host.recoverRuntime(runtime),
      withSecondaryOperation: (runtime: any, operation: any) => host.runtimePool.withOperation(runtime, operation),
      acquirePrimaryOperation: () => host.primaryOperationAdmission.acquire().release,
      mutationOutcomePending: (sessionId: any) => host.sessionMutationOutcomePending(sessionId),
      availableModels: async (rpc: any) => asModels(await rpc.send({ type: "get_available_models" })),
      lateRpcOutcomeHandler: (sessionId: any, token: any) => host.lateRpcOutcomeHandler(sessionId, token, "generic"),
      markRpcOutcomePending: (sessionId: any, error: any, token: any) => host.markRpcOutcomePending(sessionId, error, token),
      rethrowResultPending: (error: any, operation: any, fence: any = true) => host.rethrowResultPending(error, operation, fence),
      rememberRuntimeModel: (runtime: any, model: any) => host.rememberRuntimeDisplaySettings(runtime, { model }),
      rememberPrimaryModel: (model: any) => host.rememberPrimaryDisplaySettings({ model }),
      stagePrimaryModel: (provider: any, modelId: any) => { host.pendingTurnSettings.model = { provider, modelId }; },
      rememberRuntimeThinking: (runtime: any, level: any) => host.rememberRuntimeDisplaySettings(runtime, { thinkingLevel: level }),
      rememberPrimaryThinking: (level: any) => host.rememberPrimaryDisplaySettings({ thinkingLevel: level }),
      stagePrimaryThinking: (level: any) => { host.pendingTurnSettings.thinkingLevel = level; },
      updateRuntimeState: (runtime: any, state: any) => {
        runtime.lastState = state;
        runtime.running = state.isStreaming;
      },
      updatePrimaryState: (state: any) => {
        host.lastPrimaryState = state;
        host.running = state.isStreaming;
      },
    });
  }

  function customModelManagementService() {
    if (!host.options.modelManager) throw new Error("模型管理不可用");
    return createCustomModelManagement({
      manager: host.options.modelManager,
      withLifecycle: (description: any, mutation: any) =>
        host.withLifecycle("models-refreshing", description, mutation),
      withModelFileTransaction: (mutation: any) => host.applyModelFileTransaction(mutation),
      primaryState: async () => asState(await host.options.rpc.send({ type: "get_state" })),
      primaryTurnActive: () => host.primaryTurnActive(),
      setPrimaryModel: async (provider: any, modelId: any) => {
        const outcomeToken = randomUUID();
        try {
          await host.options.rpc.send(
            { type: "set_model", provider, modelId },
            undefined,
            { onLateResponse: host.lateRpcOutcomeHandler(host.activeSessionId, outcomeToken, "generic") },
          );
        } catch (error) {
          if (host.rpcOutcomeUnknown(error)) {
            host.markRpcOutcomePending(host.activeSessionId, error, outcomeToken);
            host.rethrowResultPending(error, "确认重命名模型");
          }
        }
      },
      bootstrap: () => host.bootstrap(),
    });
  }

  /** Changes only the persisted default/index context for future drafts. Existing
   * Session paths and dedicated Runtime cwd values are immutable. Native folder
   * pickers wait outside this queue; each returned selection gets a short,
   * lifecycle-guarded commit in FIFO order. */
  async function changeWorkspace(
    selected: string,
  ): Promise<{
    workspaceName: string;
    cwd: string;
    workspaceEpoch: string;
    workspaceRevision: number;
  }> {
    let releaseTurn!: () => void;
    const previous = host.workspaceCommitTail;
    const turn = new Promise<void>((resolveTurn: any) => {
      releaseTurn = resolveTurn;
    });
    host.workspaceCommitTail = previous.catch(() => undefined).then(() => turn);
    await previous.catch(() => undefined);
    try {
      const releaseMutation = host.beginMutation();
      try {
        // Normalize equivalent spellings while retaining canonical UNC/WSL
        // workspace identity; Windows path.resolve() preserves UNC roots.
        const selectedCwd = resolve(selected);
        if (!(await stat(selectedCwd)).isDirectory())
          throw new Error("所选工作目录不存在或不是文件夹");
        await saveWorkspace(selectedCwd);
        if (selectedCwd.toLowerCase() !== host.currentCwd.toLowerCase()) {
          host.currentCwd = selectedCwd;
          host.workspaceRevision += 1;
          host.broadcast({
            type: "pi_chat_workspace_changed",
            cwd: selectedCwd,
            workspaceEpoch: host.runEpoch,
            workspaceRevision: host.workspaceRevision,
          });
        }
        return {
          workspaceName: basename(selectedCwd),
          cwd: selectedCwd,
          workspaceEpoch: host.runEpoch,
          workspaceRevision: host.workspaceRevision,
        };
      } finally {
        releaseMutation();
      }
    } finally {
      releaseTurn();
    }
  }


  return {
    restartPrimaryRuntime,
    reloadRpc,
    applyResourceFileTransaction,
    applyModelFileTransaction,
    providerManagementService,
    runtimeSettingsService,
    customModelManagementService,
    changeWorkspace,
  };
}
