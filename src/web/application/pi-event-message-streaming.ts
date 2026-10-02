import type { ExtensionUiRequest, ModelInfo, PiMessage, PrimaryRuntimeReadiness, QueuedPrompt, SessionActivityState } from "../../shared/types";
import type { StreamingMessageAppend } from "../../shared/streaming-wire";

export function handlePiMessageAndStreamingEvents(scope: Record<string, any>): boolean {
  const {
    type,
    MESSAGE_CHECKPOINT_EVENT,
    MESSAGE_DELTA_EVENT,
    WAITING_FOR_PI_STATUS,
    appendTerminalSessionCache,
    applySessionView,
    applySidebarRunningOverride,
    applyStreamingDelta,
    assistantMessage,
    assistantMessageRequestsTool,
    capturePaneAuthority,
    clearPendingLiveMessage,
    completedCompactionSessionIdsRef,
    consumeLocalSteeringTurn,
    decodeStreamingCheckpoint,
    dispatchPane,
    event,
    eventRunEpoch,
    eventRunGeneration,
    eventRunStartedAt,
    eventSessionId,
    fetchSessionView,
    latestQueueProjectionRef,
    localUserTurnsRef,
    paneAuthorityCanCommit,
    patchSessionCache,
    pendingSteersRef,
    queueProjectionRevisionRef,
    recordSseRejectionDiagnostic,
    refresh,
    releasePromptBusy,
    reportBackgroundRefreshError,
    requestPromptReconcileRef,
    scheduleLiveMessage,
    sessionEventVersionRef,
    sessionRunningOverridesRef,
    setCloseComplete,
    setError,
    setEventSourceGeneration,
    setManagementSection,
    setNotice,
    setRuntimeWarming,
    setSessions,
    source,
    sseReconnectTimerRef,
    streamDiagnosticsRef,
    streamGapRecoveriesRef,
    streamingWireProjectionsRef,
    syncPendingSteers,
    terminalAssistantSessionIdsRef,
    terminalAssistantStreamGenerationsRef,
    terminalEvent,
    updateLiveSessionCache,
    viewingEventSession,
    withStreamingAppendHints,
  } = scope;
  if (type === "pi_chat_application_closing") {

          source.close();
          setManagementSection(null);
          setCloseComplete("application");
          window.setTimeout(() => window.close(), 40);

    return true;
  }
  if (type === "agent_start") {

          if (eventSessionId) {
            completedCompactionSessionIdsRef.current.delete(eventSessionId);
            releasePromptBusy(eventSessionId, eventRunGeneration, eventRunEpoch);
            sessionRunningOverridesRef.current.set(eventSessionId, true);
            setSessions((current: any) =>
              current.map((session: any) =>
                session.id === eventSessionId
                  ? applySidebarRunningOverride(session, true)
                  : session,
              ),
            );
            patchSessionCache(eventSessionId, {
              isStreaming: true,
              toolStatus: WAITING_FOR_PI_STATUS,
              state: { isStreaming: true },
            });
            // A queue-dispatch frame may be coalesced or missed while the socket
            // is recovering. Once Pi proves execution has started, reconcile only
            // the affected Session view so an already-running prompt cannot remain
            // stranded in the waiting queue UI.
            const knownQueue = latestQueueProjectionRef.current.get(eventSessionId);
            if (knownQueue?.queue.length) {
              const queueRequestRevision =
                queueProjectionRevisionRef.current.get(eventSessionId) || 0;
              const requestVersion =
                sessionEventVersionRef.current.get(eventSessionId) || 0;
              const authority = capturePaneAuthority(eventSessionId);
              void fetchSessionView(eventSessionId)
                .then((view: any) => {
                  if (
                    (sessionEventVersionRef.current.get(eventSessionId) || 0) ===
                    requestVersion
                  )
                    applySessionView(view, authority, queueRequestRevision);
                })
                .catch(() => undefined);
            }
          }
          if (viewingEventSession) {
            setRuntimeWarming(eventSessionId, false);
            dispatchPane({
              type: "AGENT_STARTED",
              sessionId: eventSessionId,
              toolStatus: WAITING_FOR_PI_STATUS,
              ...(eventRunStartedAt !== undefined ? { runStartedAt: eventRunStartedAt } : null),
            });
          }

    return true;
  }
  if (type === "compaction_start") {

          if (eventSessionId) {
            completedCompactionSessionIdsRef.current.delete(eventSessionId);
            patchSessionCache(eventSessionId, {
              state: { isCompacting: true },
            });
          }
          if (viewingEventSession) {
            const reason = String(event.reason || "");
            dispatchPane({
              type: "COMPACTION_STARTED",
              sessionId: eventSessionId,
              status:
                reason === "overflow"
                  ? "上下文溢出，正在自动压缩…"
                  : "正在压缩上下文…",
            });
          }

    return true;
  }
  if (type === "compaction_end") {

          if (eventSessionId) {
            completedCompactionSessionIdsRef.current.add(eventSessionId);
            patchSessionCache(eventSessionId, {
              toolStatus: "",
              state: { isCompacting: false },
            });
          }
          if (viewingEventSession) {
            dispatchPane({
              type: "COMPACTION_FINISHED",
              sessionId: eventSessionId,
            });
            const errorMessage =
              typeof event.errorMessage === "string" ? event.errorMessage : "";
            if (errorMessage) setError(errorMessage);
            else if (event.aborted === false) {
              setNotice("上下文压缩完成");
              // Refresh usage/history in the background. Never surface a 65s view
              // timeout here — compaction often ends while the model turn continues,
              // and a busy RPC used to paint a false-red error long after success.
              const requestVersion =
                sessionEventVersionRef.current.get(eventSessionId) || 0;
              const queueRequestRevision =
                queueProjectionRevisionRef.current.get(eventSessionId) || 0;
              const authority = capturePaneAuthority(eventSessionId);
              void fetchSessionView(eventSessionId)
                .then((view: any) => {
                  if (
                    paneAuthorityCanCommit(authority) &&
                    (sessionEventVersionRef.current.get(eventSessionId) || 0) ===
                      requestVersion
                  )
                    applySessionView(view, authority, queueRequestRevision);
                })
                .catch(() => undefined);
            }
          }

    return true;
  }
  if (type === "message_start"
        || type === "message_update"
        || type === MESSAGE_CHECKPOINT_EVENT
        || type === MESSAGE_DELTA_EVENT) {

          const rawMessage =
            event.message && typeof event.message === "object"
              ? (event.message as PiMessage)
              : null;
          const nativeSteeringConsumed =
            (event as { nativeSteeringConsumed?: boolean }).nativeSteeringConsumed === true;
          const nativeSteeringId =
            typeof (event as { nativeSteeringId?: unknown }).nativeSteeringId === "string" &&
            /^[a-f0-9-]{36}$/i.test((event as { nativeSteeringId: string }).nativeSteeringId)
              ? (event as { nativeSteeringId: string }).nativeSteeringId
              : undefined;
          if (type === "message_start" && eventSessionId)
            streamingWireProjectionsRef.current.delete(eventSessionId);
          if (type === "message_start" && rawMessage?.role === "user" && eventSessionId) {
            const localTurns = localUserTurnsRef.current.get(eventSessionId) || [];
            // Only a server-verified native steer consumption may reveal a hidden
            // local Steer turn. Pi dequeues the steering message before forwarding
            // this message_start, so an ordinary prompt sharing the same text can
            // never be mistaken for a consumed Steer.
            const consumed = nativeSteeringConsumed
              ? consumeLocalSteeringTurn(localTurns, rawMessage, nativeSteeringId)
              : undefined;
            if (consumed) {
              const acceptedTurnTotal = consumed.expectedTurnTotal;
              setSessions((current: any) =>
                current.map((session: any) =>
                  session.id === eventSessionId &&
                  acceptedTurnTotal > (session.turnCount || 0)
                    ? { ...session, turnCount: acceptedTurnTotal }
                    : session,
                ),
              );
            }
            if (consumed || nativeSteeringId) {
              const consumedId = consumed?.queueId || nativeSteeringId;
              syncPendingSteers(
                eventSessionId,
                consumedId
                  ? (pendingSteersRef.current.get(eventSessionId) || []).filter(
                      (item: any) => item.id !== consumedId,
                    )
                  : [],
              );
            }
            if (consumed && viewingEventSession) {
              consumed.renderedInTranscript = true;
              dispatchPane({
                type: "PROMPT_ACKNOWLEDGED",
                sessionId: eventSessionId,
                messages: (current: any) =>
                  current.includes(consumed.message)
                    ? current
                    : [...current, consumed.message],
              });
            }
          }

          let assistant: PiMessage | null = null;
          let streamStart = type === "message_start";
          if (type === MESSAGE_CHECKPOINT_EVENT) {
            const checkpoint = decodeStreamingCheckpoint(event);
            if (!checkpoint || !eventSessionId) {
              recordSseRejectionDiagnostic({
                sessionId: eventSessionId,
                runGeneration: eventRunGeneration,
                eventType: type,
                decisionReason: "malformed-critical-event",
              });
              return true;
            }
            const projection = {
              message: checkpoint.message,
              sequence: checkpoint.piChatSequence,
            };
            streamingWireProjectionsRef.current.set(eventSessionId, projection);
            assistant = projection.message;
            streamStart = checkpoint.piChatStreamStart === true;
          } else if (type === MESSAGE_DELTA_EVENT) {
            const projection = eventSessionId
              ? applyStreamingDelta(
                  streamingWireProjectionsRef.current.get(eventSessionId),
                  event,
                )
              : null;
            if (!projection || !eventSessionId) {
              recordSseRejectionDiagnostic({
                sessionId: eventSessionId,
                runGeneration: eventRunGeneration,
                eventType: type,
                decisionReason: "stream-sequence-gap",
              });
              if (eventSessionId)
                streamingWireProjectionsRef.current.delete(eventSessionId);
              if (viewingEventSession) clearPendingLiveMessage();
              source.close();
              const now = Date.now();
              const previousRecovery = eventSessionId
                ? streamGapRecoveriesRef.current.get(eventSessionId)
                : undefined;
              const count = previousRecovery && now - previousRecovery.at < 30_000
                ? previousRecovery.count + 1
                : 1;
              if (eventSessionId)
                streamGapRecoveriesRef.current.set(eventSessionId, { at: now, count });
              const delay = count === 1
                ? 0
                : Math.min(30_000, 1_000 * 2 ** Math.min(count - 2, 5));
              if (sseReconnectTimerRef.current !== null)
                window.clearTimeout(sseReconnectTimerRef.current);
              sseReconnectTimerRef.current = window.setTimeout(() => {
                sseReconnectTimerRef.current = null;
                setEventSourceGeneration((generation: any) => generation + 1);
              }, delay);
              void refresh().catch(reportBackgroundRefreshError);
              return true;
            }
            streamingWireProjectionsRef.current.set(eventSessionId, projection);
            streamGapRecoveriesRef.current.delete(eventSessionId);
            assistant = withStreamingAppendHints(
              projection.message,
              projection.sequence,
              event.operations as StreamingMessageAppend[],
            );
          } else {
            assistant = assistantMessage(event);
            if (assistant && eventSessionId)
              streamingWireProjectionsRef.current.delete(eventSessionId);
          }

          let rejectedPostTerminalAssistantUpdate = false;
          if (assistant && eventSessionId && typeof eventRunGeneration === "number") {
            if (streamStart) {
              // A new assistant start is the only browser-visible boundary that
              // reopens a stream after its prior canonical terminal. This keeps
              // tool-use continuations in the same Pi generation valid.
              if (
                terminalAssistantStreamGenerationsRef.current.get(eventSessionId) ===
                eventRunGeneration
              )
                terminalAssistantStreamGenerationsRef.current.delete(eventSessionId);
            } else if (
              terminalAssistantStreamGenerationsRef.current.get(eventSessionId) ===
                eventRunGeneration
            ) {
              rejectedPostTerminalAssistantUpdate = true;
              recordSseRejectionDiagnostic({
                sessionId: eventSessionId,
                runGeneration: eventRunGeneration,
                eventType: type,
                decisionReason: "post-assistant-terminal",
              });
            }
          }
          if (assistant && eventSessionId && !rejectedPostTerminalAssistantUpdate) {
            releasePromptBusy(eventSessionId, eventRunGeneration, eventRunEpoch);
            updateLiveSessionCache(eventSessionId, assistant);
            if (typeof eventRunGeneration === "number")
              streamDiagnosticsRef.current?.receive(
                { sessionId: eventSessionId, runGeneration: eventRunGeneration },
                viewingEventSession,
                viewingEventSession
                  && document.visibilityState === "visible"
                  && document.hasFocus(),
              );
          }
          // Only the selected destination is allowed to turn an SSE draft into a
          // React update. Off-screen panes retain their latest draft in cache.
          if (assistant && !rejectedPostTerminalAssistantUpdate && viewingEventSession)
            scheduleLiveMessage({
              message: assistant,
              authority: capturePaneAuthority(eventSessionId),
              runGeneration: eventRunGeneration ?? -1,
            });

    return true;
  }
  if (type === "message_end" && terminalEvent) {

          if (eventSessionId) {
            streamingWireProjectionsRef.current.delete(eventSessionId);
            streamGapRecoveriesRef.current.delete(eventSessionId);
          }
          const terminal = terminalEvent.message;
          if (terminalEvent.terminalKind === "assistant") {
            if (eventSessionId)
              releasePromptBusy(
                eventSessionId,
                eventRunGeneration,
                eventRunEpoch,
              );
            // The server owns terminal repair. Cancel a pending browser throttle,
            // but never substitute its local draft for the canonical terminal.
            if (viewingEventSession) clearPendingLiveMessage();
            if (eventSessionId) {
              terminalAssistantSessionIdsRef.current.add(eventSessionId);
              if (typeof eventRunGeneration === "number")
                terminalAssistantStreamGenerationsRef.current.set(
                  eventSessionId,
                  eventRunGeneration,
                );
              appendTerminalSessionCache(eventSessionId, terminal);
            }
            if (viewingEventSession) {
              dispatchPane({
                type: "TERMINAL_MESSAGE_COMMITTED",
                sessionId: eventSessionId,
                message: terminal,
              });
              if (typeof eventRunGeneration === "number")
                streamDiagnosticsRef.current?.terminalAssistantCommitted({
                  sessionId: eventSessionId,
                  runGeneration: eventRunGeneration,
                });
              // A final assistant message normally precedes agent_settled by only
              // one frame. If that lifecycle frame is lost, verify the hot
              // Runtime after the normal grace instead of leaving Stop/Queue
              // painted forever. Tool-call assistant terminals are not final.
              if (!assistantMessageRequestsTool(terminal))
                requestPromptReconcileRef.current(eventSessionId);
            }
          } else {
            // User message_end is a transport echo of the prompt. The sender's
            // LocalUserTurn and the later JSONL view already own that row; caching
            // this echo can duplicate it when Pi assigns a nearby timestamp.
            if (terminalEvent.terminalKind !== "user-echo" && eventSessionId)
              appendTerminalSessionCache(eventSessionId, terminal);
            if (viewingEventSession && terminalEvent.terminalKind === "tool-result")
              dispatchPane({
                type: "TOOL_RESULT_COMMITTED",
                sessionId: eventSessionId,
                message: terminal,
              });
          }

    return true;
  }
  return false;
}
