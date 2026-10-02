import type { ExtensionUiRequest, ModelInfo, PiMessage, PrimaryRuntimeReadiness, QueuedPrompt, SessionActivityState } from "../../shared/types";
import type { StreamingMessageAppend } from "../../shared/streaming-wire";

export function handlePiFailureAndControlEvents(scope: Record<string, any>): boolean {
  const {
    type,
    applySessionActivity,
    applySessionView,
    applySidebarRunningOverride,
    capturePaneAuthority,
    clearEmptyQueuePause,
    clearPendingLiveMessage,
    clearPromptReconcileTimer,
    clearStoppingForSession,
    commitSessionViewCache,
    completedCompactionSessionIdsRef,
    deriveExtensionRequestResolvedEffect,
    deriveSessionControlChangedEffect,
    dispatchAskQuestionnaire,
    dispatchPane,
    event,
    eventRunDurationMs,
    eventRunEpoch,
    eventRunGeneration,
    eventSessionId,
    fetchSessionView,
    finiteRunMetric,
    paneAuthorityCanCommit,
    patchSessionCache,
    projectStatusQueue,
    queueProjectionRevisionRef,
    recordLocalFailure,
    releasePromptBusy,
    requestPromptReconcileRef,
    sessionEventVersionRef,
    sessionRunningOverridesRef,
    sessionsRef,
    setError,
    setFailedSessionIds,
    setSessions,
    settledPaneActivity,
    settledRunGenerationsRef,
    steeringClearedMessage,
    streamDiagnosticsRef,
    streamGapRecoveriesRef,
    streamingWireProjectionsRef,
    terminalAssistantSessionIdsRef,
    viewCacheRef,
    viewedSessionIdRef,
    viewingEventSession,
  } = scope;
  if (type === "pi_chat_session_control_changed") {

          const control = deriveSessionControlChangedEffect(event);
          const id = control.sessionId;
          const owner = control.controlOwner;
          const controlledByThisWindow = control.controlledByThisWindow;
          if (id)
            patchSessionCache(id, {
              controlOwner: owner,
              controlledByThisWindow,
            });
          if (id === viewedSessionIdRef.current)
            dispatchPane({
              type: "CONTROL_UPDATED",
              sessionId: id,
              control: { controlOwner: owner, controlledByThisWindow },
            });
          if (id)
            setSessions((current: any) =>
              current.map((session: any) =>
                session.id === id
                  ? { ...session, controlOwner: owner, controlledByThisWindow }
                  : session,
              ),
            );

    return true;
  }
  if (type === "pi_chat_extension_request_resolved") {

          const resolved = deriveExtensionRequestResolvedEffect(event);
          if (viewingEventSession && resolved)
            dispatchPane({
              type: "EXTENSION_REQUEST_RESOLVED",
              sessionId: eventSessionId,
              requestId: resolved.requestId,
            });
          if (eventSessionId) {
            patchSessionCache(eventSessionId, {
              pendingExtensionRequest: undefined,
            });
            setSessions((current: any) =>
              current.map((session: any) =>
                session.id === eventSessionId
                  ? { ...session, pendingConfirmation: false }
                  : session,
              ),
            );
          }

    return true;
  }
  if (type === "extension_error") {

          if (viewingEventSession)
            setError(String(event.error || "扩展执行失败"));

    return true;
  }
  if (type === "pi_chat_session_status") {

          const activity = event.activity as
            Partial<SessionActivityState> | undefined;
          if (
            eventSessionId &&
            activity &&
            [
              "idle",
              "queued",
              "dispatching",
              "running",
              "paused",
              "failed",
            ].includes(String(activity.execution)) &&
            typeof activity.awaitingConfirmation === "boolean"
          ) {
            const next = activity as SessionActivityState;
            applySessionActivity(eventSessionId, next);
            if (Array.isArray(event.queue))
              projectStatusQueue(
                event.queue as unknown as QueuedPrompt[],
                event.paused === true,
              );
            if (viewingEventSession) {
              dispatchPane({
                type: "RUN_TIMING_UPDATED",
                sessionId: eventSessionId,
                ...(finiteRunMetric(next.runStartedAt) !== undefined
                  ? { runStartedAt: finiteRunMetric(next.runStartedAt) }
                  : ["idle", "queued", "failed"].includes(String(next.execution))
                    ? { runStartedAt: null }
                    : null),
                ...(finiteRunMetric(next.lastRunDurationMs) !== undefined
                  ? { lastRunDurationMs: finiteRunMetric(next.lastRunDurationMs) }
                  : null),
              });
            }
            const streaming =
              next.execution === "running" || next.execution === "dispatching";
            const terminalActivity =
              next.execution === "idle" ||
              next.execution === "queued" ||
              next.execution === "failed";
            // `queued` closes the preceding visible turn but is not a settled
            // generation: the scheduler can dispatch the next FIFO item under
            // the same generation before its agent_start advances the counter.
            // Marking queued as settled rejects that dispatch's queue snapshot.
            const settledActivity =
              next.execution === "idle" || next.execution === "failed";
            if (settledActivity && typeof eventRunGeneration === "number")
              settledRunGenerationsRef.current.set(
                eventSessionId,
                Math.max(
                  settledRunGenerationsRef.current.get(eventSessionId) || 0,
                  eventRunGeneration,
                ),
              );
            // `paused` means the follow-up queue is paused; the current Pi turn
            // may still be running while abort settles. It is not terminal proof.
            if (terminalActivity) {
              clearStoppingForSession(eventSessionId);
              clearEmptyQueuePause(eventSessionId);
            }
            patchSessionCache(eventSessionId, terminalActivity
              ? {
                  isStreaming: false,
                  liveMessage: undefined,
                  toolStatus: "",
                  state: { isStreaming: false, isCompacting: false },
                }
              : streaming
                ? {
                    isStreaming: true,
                    state: { isStreaming: true },
                  }
                : {});
            if (terminalActivity) {
              releasePromptBusy(
                eventSessionId,
                eventRunGeneration,
                eventRunEpoch,
                true,
              );
            }
            if (viewingEventSession && terminalActivity) {
              clearPendingLiveMessage();
              dispatchPane({
                type: "AGENT_SETTLED",
                sessionId: eventSessionId,
                ...(eventRunDurationMs !== undefined ? { runDurationMs: eventRunDurationMs } : null),
              });
              // This activity fallback is used when message_end/agent_settled was
              // missed. Reconcile persisted history through the same generation
              // and pane-authority barriers instead of permanently discarding the
              // last live draft with no terminal replacement.
              const requestVersion =
                sessionEventVersionRef.current.get(eventSessionId) || 0;
              const queueRequestRevision =
                queueProjectionRevisionRef.current.get(eventSessionId) || 0;
              const authority = capturePaneAuthority(eventSessionId);
              void fetchSessionView(eventSessionId)
                .then((view: any) => {
                  const versionUnchanged =
                    (sessionEventVersionRef.current.get(eventSessionId) || 0) ===
                    requestVersion;
                  if (!versionUnchanged) return;
                  if (paneAuthorityCanCommit(authority))
                    applySessionView(view, authority, queueRequestRevision);
                  else commitSessionViewCache(view, authority);
                })
                .catch(() => undefined);
            }
            if (terminalActivity && typeof eventRunGeneration === "number")
              streamDiagnosticsRef.current?.terminal({
                sessionId: eventSessionId,
                runGeneration: eventRunGeneration,
              });
          } else if (eventSessionId && typeof event.running === "boolean") {
            // Older servers still publish this partial event during a rolling update.
            const running = event.running === true;
            if (!running && typeof eventRunGeneration === "number")
              settledRunGenerationsRef.current.set(
                eventSessionId,
                Math.max(
                  settledRunGenerationsRef.current.get(eventSessionId) || 0,
                  eventRunGeneration,
                ),
              );
            if (!running) {
              clearStoppingForSession(eventSessionId);
              clearEmptyQueuePause(eventSessionId);
            }
            sessionRunningOverridesRef.current.set(eventSessionId, running);
            setSessions((current: any) =>
              current.map((session: any) =>
                session.id === eventSessionId
                  ? applySidebarRunningOverride(session, running)
                  : session,
              ),
            );
            patchSessionCache(eventSessionId, {
              isStreaming: running,
              ...(running
                ? null
                : {
                    liveMessage: undefined,
                    toolStatus: "",
                  }),
              state: {
                isStreaming: running,
                ...(running ? null : { isCompacting: false }),
              },
            });
            if (!running)
              releasePromptBusy(
                eventSessionId,
                eventRunGeneration,
                eventRunEpoch,
                true,
              );
            if (!running) {
              patchSessionCache(eventSessionId, {
                sessionActivity: settledPaneActivity(
                  viewCacheRef.current.get(eventSessionId)?.session.activity,
                  eventRunDurationMs,
                ),
              });
            }
            if (viewingEventSession && !running) {
              clearPendingLiveMessage();
              dispatchPane({
                type: "AGENT_SETTLED",
                sessionId: eventSessionId,
                ...(eventRunDurationMs !== undefined ? { runDurationMs: eventRunDurationMs } : null),
              });
              const requestVersion =
                sessionEventVersionRef.current.get(eventSessionId) || 0;
              const queueRequestRevision =
                queueProjectionRevisionRef.current.get(eventSessionId) || 0;
              const authority = capturePaneAuthority(eventSessionId);
              void fetchSessionView(eventSessionId)
                .then((view: any) => {
                  const versionUnchanged =
                    (sessionEventVersionRef.current.get(eventSessionId) || 0) ===
                    requestVersion;
                  if (!versionUnchanged) return;
                  if (paneAuthorityCanCommit(authority))
                    applySessionView(view, authority, queueRequestRevision);
                  else commitSessionViewCache(view, authority);
                })
                .catch(() => undefined);
            }
            if (!running && typeof eventRunGeneration === "number")
              streamDiagnosticsRef.current?.terminal({
                sessionId: eventSessionId,
                runGeneration: eventRunGeneration,
              });
          }

    return true;
  }
  if (type === "pi_chat_process_recovered") {

          if (eventSessionId) {
            completedCompactionSessionIdsRef.current.delete(eventSessionId);
            // Recovery itself is authoritative enough to remove an old red
            // projection. The following session-status frame refines this short
            // optimistic activity to the recovered Runtime's exact queue/run state.
            const previous = sessionsRef.current.find(
              (session: any) => session.id === eventSessionId,
            );
            const activity: SessionActivityState = {
              execution: previous?.running
                ? "running"
                : previous?.queued
                  ? "queued"
                  : "idle",
              awaitingConfirmation: previous?.pendingConfirmation === true,
            };
            sessionRunningOverridesRef.current.set(
              eventSessionId,
              activity.execution === "running",
            );
            setFailedSessionIds((current: any) =>
              current.filter((id: any) => id !== eventSessionId),
            );
            setSessions((current: any) =>
              current.map((session: any) =>
                session.id === eventSessionId
                  ? {
                      ...session,
                      activity,
                      pendingConfirmation: activity.awaitingConfirmation,
                    }
                  : session,
              ),
            );
            patchSessionCache(eventSessionId, { sessionActivity: activity });
          }

    return true;
  }
  if (type === "pi_chat_process_error") {

          if (eventSessionId) {
            streamingWireProjectionsRef.current.delete(eventSessionId);
            streamGapRecoveriesRef.current.delete(eventSessionId);
          }
          if (eventSessionId)
            dispatchAskQuestionnaire({
              type: "CLOSE_SESSION",
              sessionId: eventSessionId,
            });
          if (eventSessionId) {
            completedCompactionSessionIdsRef.current.delete(eventSessionId);
            clearStoppingForSession(eventSessionId);
            releasePromptBusy(
              eventSessionId,
              eventRunGeneration,
              eventRunEpoch,
              true,
            );
            terminalAssistantSessionIdsRef.current.delete(eventSessionId);
            sessionRunningOverridesRef.current.set(eventSessionId, false);
            setFailedSessionIds((current: any) => [
              ...new Set([...current, eventSessionId]),
            ]);
            const errorText =
              typeof event.error === "string" && event.error.trim()
                ? event.error.trim()
                : undefined;
            const incidentId =
              typeof event.incidentId === "string" &&
              /^PC-[A-Z0-9_-]{8}$/.test(event.incidentId)
                ? event.incidentId
                : undefined;
            // A Runtime failure keeps its reason in this Session's transcript, not
            // only in the five-second toast that the user cannot revisit. The text
            // matches the toast's fallback so an empty frame still names the cause.
            recordLocalFailure(
              eventSessionId,
              errorText || "Pi RPC 已退出",
              incidentId || undefined,
            );
            const error = errorText
              ? incidentId
                ? `${errorText}（事件 ID：${incidentId}）`
                : errorText
              : undefined;
            const activity: SessionActivityState = {
              execution: "failed",
              awaitingConfirmation: false,
              ...(eventRunDurationMs !== undefined ? { lastRunDurationMs: eventRunDurationMs } : null),
              ...(error ? { error } : null),
            };
            setSessions((current: any) =>
              current.map((session: any) =>
                session.id === eventSessionId
                  ? {
                      ...session,
                      running: false,
                      pendingConfirmation: false,
                      activity,
                    }
                  : session,
              ),
            );
            patchSessionCache(eventSessionId, {
              isStreaming: false,
              liveMessage: undefined,
              toolStatus: "",
              runtimeStatus: "view-only",
              sessionActivity: activity,
              state: { isStreaming: false, isCompacting: false },
            });
          }
          if (eventSessionId && typeof eventRunGeneration === "number")
            streamDiagnosticsRef.current?.terminal({
              sessionId: eventSessionId,
              runGeneration: eventRunGeneration,
            });
          if (viewingEventSession) {
            clearPromptReconcileTimer();
            dispatchPane({
              type: "PROCESS_FAILED",
              sessionId: eventSessionId,
              ...(eventRunDurationMs !== undefined ? { runDurationMs: eventRunDurationMs } : null),
            });
            const message =
              Number(event.nativeSteeringDroppedCount || 0) > 0
                ? steeringClearedMessage("process-error")
                : String(event.error || "Pi RPC 已退出");
            const incidentId =
              typeof event.incidentId === "string" &&
              /^PC-[A-Z0-9_-]{8}$/.test(event.incidentId)
                ? event.incidentId
                : "";
            setError(
              incidentId ? `${message}（事件 ID：${incidentId}）` : message,
            );
            // A process error can race an accepted queue admission before its
            // queue/dispatch frame reaches this browser. Reconcile the durable
            // Session instead of leaving a local turn dependent on navigation.
            requestPromptReconcileRef.current(eventSessionId);
          }

    return true;
  }
  return false;
}
