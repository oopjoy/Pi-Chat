import type { ExtensionUiRequest, ModelInfo, PiMessage, PrimaryRuntimeReadiness, QueuedPrompt, SessionActivityState } from "../../shared/types";
import type { StreamingMessageAppend } from "../../shared/streaming-wire";

export function handlePiWorkspaceAndSessionEvents(scope: Record<string, any>): boolean {
  const {
    type,
    acceptQueueProjection,
    applyQueueUpdateEffect,
    applySidebarQueueProjection,
    bindQueuedAdmission,
    cancelPendingNavigation,
    cancellingQueueIdsRef,
    completedCompactionSessionIdsRef,
    deriveApplicationLifecycleEffect,
    deriveQueueSnapshotEffect,
    deriveSessionMutationEffect,
    deriveWorkspaceChangedEffect,
    dispatchPane,
    event,
    eventRunGeneration,
    eventSessionId,
    finalizeDeletedSession,
    localUserTurnsRef,
    mergeModelCatalog,
    modelCatalogueRevisionGate,
    patchSessionCache,
    promoteTurnsAbsentFromQueue,
    recordSseRejectionDiagnostic,
    requestPromptReconcileRef,
    resetResourceReloadTransientState,
    resourceReloadActiveRef,
    runEpochRef,
    runtimeProjectionWriter,
    saveModelCatalog,
    scheduleSidebarRefresh,
    selectDeletionFallback,
    sessionsRef,
    setModelRuntimeSyncPending,
    setModels,
    setNotice,
    setSessions,
    setWorkspaceCwd,
    startIdleRecovery,
    viewCacheWriter,
    viewingEventSession,
    workspaceEpochRef,
    workspaceRevisionRef,
  } = scope;
  if (type === "pi_chat_workspace_changed") {

          const workspace = deriveWorkspaceChangedEffect(
            event,
            runEpochRef.current,
            workspaceRevisionRef.current + 1,
          );
          if (
            workspace &&
            (!workspaceEpochRef.current ||
              workspace.workspaceEpoch === workspaceEpochRef.current) &&
            workspace.workspaceRevision >= workspaceRevisionRef.current
          ) {
            workspaceEpochRef.current =
              workspace.workspaceEpoch || workspaceEpochRef.current;
            workspaceRevisionRef.current = workspace.workspaceRevision;
            setWorkspaceCwd(workspace.cwd);
          }

    return true;
  }
  if (type === "pi_chat_models_updated") {

          if (!modelCatalogueRevisionGate.admitSse(event.revision)) {
            recordSseRejectionDiagnostic({
              eventType: type,
              decisionReason: "stale-model-catalogue",
            });
            return true;
          }
          const nextModels = Array.isArray(event.models)
            ? mergeModelCatalog([], event.models as ModelInfo[])
            : [];
          setModels(nextModels);
          saveModelCatalog(nextModels);
          setModelRuntimeSyncPending(event.runtimeSync === "waiting-for-runtime-reload");
          setNotice(
            event.runtimeSync === "waiting-for-runtime-reload"
              ? "模型配置已更新；当前请求继续使用旧 Runtime，新请求将在 Runtime 刷新后应用。"
              : "模型目录已更新。",
          );

    return true;
  }
  if (type === "pi_chat_application_lifecycle") {

          const effect = deriveApplicationLifecycleEffect(event.lifecycle);
          if (!effect) {
            recordSseRejectionDiagnostic({
              eventType: type,
              decisionReason: "malformed-lifecycle",
            });
            return true;
          }
          if (
            effect.lifecycle === "resources-reloading"
            && !resourceReloadActiveRef.current
          ) {
            resourceReloadActiveRef.current = true;
            resetResourceReloadTransientState();
          }
          runtimeProjectionWriter.observeLifecycle(effect.lifecycle);
          if (effect.cancelsNavigation) cancelPendingNavigation();
          if (effect.lifecycle === "idle") resourceReloadActiveRef.current = false;
          if (effect.notice) setNotice(effect.notice);
          if (effect.startsIdleRecovery) startIdleRecovery(false, true);

    return true;
  }
  if (type === "pi_chat_reloaded") {

          // Older servers may emit the reload marker without a preceding
          // lifecycle frame. Treat it as the same Runtime replacement boundary.
          if (!resourceReloadActiveRef.current) {
            resourceReloadActiveRef.current = true;
            resetResourceReloadTransientState();
            runtimeProjectionWriter.observeLifecycle("resources-reloading");
          }
          setNotice("配置已更新，正在确认新的 Pi Runtime…");

    return true;
  }
  if (type === "pi_chat_sessions_changed") {

          // Prompt admission and streaming creation events are frequent. Retain the
          // old snapshot so returning to a running Session paints immediately; its
          // background view request then merges the current live draft. Only a
          // structural mutation makes the cached view semantically invalid.
          const sessionMutation = deriveSessionMutationEffect(event);
          const structuralAction = sessionMutation.action;
          const structuralSessionId = sessionMutation.sessionId;
          const requiresFullInventory = ["deleted", "renamed", "cloned", "forked"].includes(structuralAction);
          if (
            structuralSessionId &&
            ["deleted", "renamed"].includes(structuralAction)
          ) {
            viewCacheWriter.forgetCurrent(structuralSessionId);
            if (structuralAction === "deleted") {
              completedCompactionSessionIdsRef.current.delete(structuralSessionId);
              const wasViewed = finalizeDeletedSession(structuralSessionId);
              selectDeletionFallback(
                structuralSessionId,
                sessionsRef.current.filter(
                  (session: any) => session.id !== structuralSessionId,
                ),
                wasViewed,
              );
            }
            // A renamed SSE has no resulting name; await authoritative metadata.
          }
          // A structural mutation is a replacement boundary for the sidebar. A
          // base prefix can intentionally retain older loaded rows, but it cannot
          // prove that an externally deleted row still exists. Re-read the full
          // physical inventory for these low-frequency events so deleted rows
          // cannot survive a missed/late projection.
          scheduleSidebarRefresh(requiresFullInventory);

    return true;
  }
  if (type === "pi_chat_queue_update") {

          const queueSnapshot = deriveQueueSnapshotEffect(event);
          if (!queueSnapshot) {
            recordSseRejectionDiagnostic({
              sessionId: eventSessionId,
              runGeneration: eventRunGeneration,
              eventType: type,
              decisionReason: "malformed-queue-snapshot",
            });
            return true;
          }
          if (eventSessionId) {
            applyQueueUpdateEffect({
              sessionId: eventSessionId,
              queue: queueSnapshot.queue,
              paused: queueSnapshot.paused,
              admittedId: queueSnapshot.admittedId,
              viewing: viewingEventSession,
            }, {
              acceptQueue: (sessionId: any, queue: any, paused: any) => acceptQueueProjection(sessionId, queue, paused, "event"),
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
              updateSidebar: (sessionId: any, queue: any, paused: any) => setSessions((current: any) => current.map((session: any) =>
                session.id === sessionId ? applySidebarQueueProjection(session, queue, paused) : session,
              )),
              patchSessionCache: (sessionId: any, queue: any, paused: any) => patchSessionCache(sessionId, { queue, queuePaused: paused }),
            });
          }

    return true;
  }
  return false;
}
