import type { ExtensionUiRequest, ModelInfo, PiMessage, PrimaryRuntimeReadiness, QueuedPrompt, SessionActivityState } from "../../shared/types";
import type { StreamingMessageAppend } from "../../shared/streaming-wire";

export function handlePiQueueAndExtensionEvents(scope: Record<string, any>): boolean {
  const {
    type,
    acceptQueueProjection,
    applyExtensionUiRequestEffect,
    applyQueueDispatchEffect,
    applyQueueErrorEffect,
    applySidebarQueueProjection,
    authoritativeTurnTotal,
    bindQueuedAdmission,
    bindQueuedDispatch,
    cancellingQueueIdsRef,
    capturePaneAuthority,
    confirmedQueueDispatchIdsRef,
    deriveFastModeChangedEffect,
    deriveGateModeChangedEffect,
    derivePromptDeliveryUncertainEffect,
    deriveQueueDispatchEffect,
    deriveQueueErrorEffect,
    dispatchPane,
    displaySettingsFromEvent,
    event,
    eventSessionId,
    gateModeFromNotice,
    latestQueueProjectionRef,
    localUserTurnsRef,
    paneStateRef,
    patchSessionCache,
    pendingGateModesRef,
    promoteTurnsAbsentFromQueue,
    requestPromptReconcileRef,
    setError,
    setNotice,
    setSessions,
    sourceTurnTotalsRef,
    stageGateMode,
    tryAutoAllowGate,
    updateGateMode,
    viewCacheRef,
    viewingEventSession,
  } = scope;
  if (type === "pi_chat_queue_dispatch") {

          if (eventSessionId) {
            const dispatchEvent = deriveQueueDispatchEffect(event);
            const displaySettings = displaySettingsFromEvent(
              dispatchEvent.settings,
              paneStateRef.current.model,
            );
            applyQueueDispatchEffect({
              sessionId: eventSessionId,
              queueId: dispatchEvent.id,
              message: dispatchEvent.message,
              clientPromptOperationId: dispatchEvent.clientPromptOperationId,
              imageCount: dispatchEvent.imageCount,
              displaySettings,
              viewing: viewingEventSession,
            }, {
              acceptQueue: (sessionId: any, queue: any, paused: any) => acceptQueueProjection(sessionId, queue, paused, "event"),
              sourceQueue: (sessionId: any) => latestQueueProjectionRef.current.get(sessionId)
                || (() => {
                  const cached = viewCacheRef.current.get(sessionId);
                  return cached ? { queue: cached.queue || [], paused: cached.queuePaused === true } : undefined;
                })()
                || { queue: [], paused: false },
              patchQueue: (sessionId: any, queue: any, paused: any) => patchSessionCache(sessionId, { queue, queuePaused: paused }),
              updateSidebar: (sessionId: any, queue: any, paused: any) => setSessions((current: any) => current.map((session: any) =>
                session.id === sessionId ? applySidebarQueueProjection(session, queue, paused) : session,
              )),
              patchSettings: (sessionId: any, state: any) => patchSessionCache(sessionId, { state }),
              dispatchPane,
              clearCancelling: (sessionId: any, queueId: any) => {
                const cancelling = cancellingQueueIdsRef.current.get(sessionId);
                if (cancelling && queueId) {
                  cancelling.delete(queueId);
                  if (!cancelling.size) cancellingQueueIdsRef.current.delete(sessionId);
                }
              },
              localTurns: (sessionId: any) => localUserTurnsRef.current.get(sessionId) || [],
              bindQueuedDispatch,
              confirmedIds: (sessionId: any) => confirmedQueueDispatchIdsRef.current.get(sessionId),
              consumeConfirmedIds: (sessionId: any, queueId: any, clientPromptOperationId: any) => {
                const ids = confirmedQueueDispatchIdsRef.current.get(sessionId);
                if (!ids) return;
                if (queueId) ids.delete(queueId);
                if (clientPromptOperationId) ids.delete(clientPromptOperationId);
                if (!ids.size) confirmedQueueDispatchIdsRef.current.delete(sessionId);
              },
              sourceMessages: (sessionId: any) => viewCacheRef.current.get(sessionId)?.messages || [],
              sourceTurnTotal: (sessionId: any) => viewCacheRef.current.get(sessionId)?.turnTotal
                ?? sourceTurnTotalsRef.current.get(sessionId),
              baselineTurnTotal: authoritativeTurnTotal,
              storeLocalTurns: (sessionId: any, turns: any) => localUserTurnsRef.current.set(sessionId, turns),
              patchRunning: (sessionId: any) => patchSessionCache(sessionId, {
                state: { isStreaming: true },
                isStreaming: true,
              }),
            });
          }

    return true;
  }
  if (type === "pi_chat_prompt_delivery_uncertain") {

          if (viewingEventSession)
            setNotice(derivePromptDeliveryUncertainEffect().notice);

    return true;
  }
  if (type === "pi_chat_queue_error") {

          if (eventSessionId) {
            const queueError = deriveQueueErrorEffect(event, {
              queue: latestQueueProjectionRef.current.get(eventSessionId)?.queue
                || viewCacheRef.current.get(eventSessionId)?.queue || [],
              paused: latestQueueProjectionRef.current.get(eventSessionId)?.paused
                || viewCacheRef.current.get(eventSessionId)?.queuePaused === true,
            });
            const message = String(event.error || "队列消息发送失败");
            const incidentId = typeof event.incidentId === "string"
              && /^PC-[A-Z0-9_-]{8}$/.test(event.incidentId)
              ? event.incidentId
              : "";
            applyQueueErrorEffect({
              sessionId: eventSessionId,
              queue: queueError.queue,
              paused: queueError.paused,
              failedId: queueError.failedId,
              viewing: viewingEventSession,
              errorMessage: incidentId ? `${message}（事件 ID：${incidentId}）` : message,
            }, {
              acceptQueue: (sessionId: any, queue: any, paused: any) => acceptQueueProjection(sessionId, queue, paused, "event"),
              localTurns: (sessionId: any) => localUserTurnsRef.current.get(sessionId) || [],
              bindQueuedAdmission,
              promoteAbsentTurns: (turns: any, queuedIds: any) => promoteTurnsAbsentFromQueue(
                turns, queuedIds, false, true, cancellingQueueIdsRef.current.get(eventSessionId),
              ),
              dispatchPane,
              requestPromptReconcile: requestPromptReconcileRef.current,
              updateSidebar: (sessionId: any, queue: any, paused: any) => setSessions((current: any) => current.map((session: any) =>
                session.id === sessionId ? applySidebarQueueProjection(session, queue, paused) : session,
              )),
              patchSessionCache: (sessionId: any, queue: any, paused: any) => patchSessionCache(sessionId, {
                queue, queuePaused: paused, state: { isStreaming: false }, isStreaming: false,
                liveMessage: undefined, toolStatus: "",
              }),
              showError: setError,
            });
            // A process error can race an accepted queue admission before its
            // queue/dispatch frame reaches this browser. Reconcile durable history.
            requestPromptReconcileRef.current(eventSessionId);
          }

    return true;
  }
  if (type === "pi_chat_fast_mode_changed") {

          const { active } = deriveFastModeChangedEffect(event);
          if (eventSessionId)
            patchSessionCache(eventSessionId, {
              state: { fastModeActive: active },
            });
          if (viewingEventSession)
            dispatchPane({
              type: "FAST_MODE_CHANGED",
              sessionId: eventSessionId,
              active,
            });

    return true;
  }
  if (type === "extension_ui_request") {

          const request = event as unknown as ExtensionUiRequest;
          if (eventSessionId)
            applyExtensionUiRequestEffect(request, eventSessionId, viewingEventSession, {
              setSessionPending: (sessionId: any, pending: any) => setSessions((current: any) => current.map((session: any) =>
                session.id === sessionId ? { ...session, pendingConfirmation: pending } : session,
              )),
              patchSessionRequest: (sessionId: any, next: any) => patchSessionCache(sessionId, { pendingExtensionRequest: next }),
              captureAuthority: (sessionId: any) => capturePaneAuthority(sessionId),
              tryAutoAllowGate,
              dispatchPane,
              updateGateMode,
              clearPendingGate: (sessionId: any) => {
                if (pendingGateModesRef.current.get(sessionId) === gateModeFromNotice(request.message))
                  stageGateMode(sessionId, undefined);
              },
              showNotice: setNotice,
            });

    return true;
  }
  if (type === "pi_chat_gate_mode_changed") {

          const mode = deriveGateModeChangedEffect(event);
          if (eventSessionId && mode) {
            updateGateMode(eventSessionId, mode.mode);
            if (pendingGateModesRef.current.get(eventSessionId) === mode.mode)
              stageGateMode(eventSessionId, undefined);
          }

    return true;
  }
  return false;
}
