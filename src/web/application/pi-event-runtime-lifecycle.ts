import type { ExtensionUiRequest, ModelInfo, PiMessage, PrimaryRuntimeReadiness, QueuedPrompt, SessionActivityState } from "../../shared/types";
import type { StreamingMessageAppend } from "../../shared/streaming-wire";

export function handlePiRuntimeLifecycleEvents(scope: Record<string, any>): boolean {
  const {
    type,
    activeSessionProjectionWriter,
    applyNativeSteeringClearEffect,
    applySessionView,
    applySidebarRunningOverride,
    capturePaneAuthority,
    clearEmptyQueuePause,
    clearPromptReconcileTimer,
    clearStoppingForSession,
    completedCompactionSessionIdsRef,
    deriveActiveSessionChangedEffect,
    dispatchAskQuestionnaire,
    dispatchPane,
    event,
    eventRunDurationMs,
    eventRunEpoch,
    eventRunGeneration,
    eventRunStartedAt,
    eventSessionId,
    fetchSessionView,
    lastSessionEventTypeRef,
    localDraftRef,
    localUserTurnsRef,
    pane,
    paneAuthorityCanCommit,
    paneStateRef,
    parseAskQuestionnaire,
    patchSessionCache,
    pendingSteerProjectionRef,
    queueProjectionRevisionRef,
    recordBrowserStateDiagnostic,
    refresh,
    releasePromptBusy,
    rememberObservedModel,
    reportBackgroundRefreshError,
    runtimeProjectionWriter,
    scheduleSidebarRefresh,
    sessionEventVersionRef,
    sessionRunningOverridesRef,
    setError,
    setNotice,
    setSessions,
    setUnseenReplySessionIds,
    settleSidebarActivity,
    settledPaneActivity,
    steeringClearedMessage,
    streamDiagnosticsRef,
    streamGapRecoveriesRef,
    streamingWireProjectionsRef,
    syncPendingSteers,
    terminalAssistantSessionIdsRef,
    unreadSteeringDropMessagesRef,
    viewCacheRef,
    viewedSessionIdRef,
    viewingEventSession,
  } = scope;
  if (type === "tool_execution_start") {

          const toolName = String(event.toolName || "unknown");
          const status = `正在运行工具：${toolName}`;
          if (eventSessionId)
            completedCompactionSessionIdsRef.current.delete(eventSessionId);
          if (eventSessionId && toolName === "ask_user_question") {
            const questionnaire = parseAskQuestionnaire(event.toolCallId, event.args);
            if (questionnaire)
              dispatchAskQuestionnaire({
                type: "OPEN",
                sessionId: eventSessionId,
                questionnaire,
              });
          }
          if (eventSessionId) {
            // A tool invocation is authoritative active-turn evidence even when a
            // lagging get_state snapshot or a missed agent_start painted idle.
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
              toolStatus: status,
              state: { isStreaming: true, isCompacting: false },
            });
          }
          if (viewingEventSession)
            dispatchPane({
              type: "AGENT_STARTED",
              sessionId: eventSessionId,
              toolStatus: status,
              ...(eventRunStartedAt !== undefined ? { runStartedAt: eventRunStartedAt } : null),
            });

    return true;
  }
  if (type === "tool_execution_end") {

          if (eventSessionId && String(event.toolName || "") === "ask_user_question")
            dispatchAskQuestionnaire({
              type: "CLOSE_IF_MATCH",
              sessionId: eventSessionId,
              toolCallId: String(event.toolCallId || ""),
            });
          const status = `${String(event.toolName || "工具")} ${event.isError ? "执行失败" : "已完成，Pi 正在继续…"}`;
          // A terminal compaction frame invalidates the preceding tool phase. If
          // its delayed tool terminal arrives afterward, retain the running fact
          // but do not repaint that obsolete tool label. A genuine later tool has
          // already cleared this fence in tool_execution_start.
          const staleAcrossCompletedCompaction = Boolean(
            eventSessionId &&
              completedCompactionSessionIdsRef.current.has(eventSessionId),
          );
          // Current servers attach a run generation. If that generation had
          // already settled, the event fence above returned before this branch;
          // otherwise this tool frame proves the turn is still active. Preserve
          // the older-server fallback without reviving an explicitly idle pane.
          const sessionStillRunning = Boolean(
            eventSessionId &&
              (typeof eventRunGeneration === "number" ||
                sessionRunningOverridesRef.current.get(eventSessionId) !== false),
          );
          if (eventSessionId && sessionStillRunning) {
            releasePromptBusy(eventSessionId, eventRunGeneration, eventRunEpoch);
            sessionRunningOverridesRef.current.set(eventSessionId, true);
            setSessions((current: any) =>
              current.map((session: any) =>
                session.id === eventSessionId
                  ? applySidebarRunningOverride(session, true)
                  : session,
              ),
            );
            // A completed tool proves that the turn continues, but says nothing
            // about a following auto-compaction. Only compaction_start/end own
            // the compaction fact; do not clear a newer compaction projection.
            const cacheCompacting =
              viewCacheRef.current.get(eventSessionId)?.state.isCompacting ===
              true;
            patchSessionCache(eventSessionId, {
              isStreaming: true,
              // A preceding compaction_start owns the visible phase until its
              // matching terminal event; a delayed tool terminal is stale for
              // that field even though it still proves the turn remains active.
              ...(cacheCompacting || staleAcrossCompletedCompaction
                ? null
                : { toolStatus: status }),
              state: { isStreaming: true },
            });
          }
          const paneCompacting =
            viewedSessionIdRef.current === eventSessionId &&
            paneStateRef.current.isCompacting === true;
          if (
            viewingEventSession &&
            sessionStillRunning &&
            !paneCompacting &&
            !staleAcrossCompletedCompaction
          )
            dispatchPane({
              type: "TOOL_STATUS_UPDATED",
              sessionId: eventSessionId,
              status,
            });

    return true;
  }
  if (type === "pi_chat_native_steering_cleared") {

          if (eventSessionId) {
            const revision = typeof event.pendingSteerRevision === "number"
              ? event.pendingSteerRevision
              : 0;
            applyNativeSteeringClearEffect({
              sessionId: eventSessionId,
              revision,
              droppedCount: Number(event.droppedCount || 0),
            }, {
              projection: (id: any) => pendingSteerProjectionRef.current.get(id),
              commitProjection: (id: any, projection: any) =>
                pendingSteerProjectionRef.current.set(id, projection),
              localTurns: (id: any) => localUserTurnsRef.current.get(id) || [],
              storeLocalTurns: (id: any, turns: any) => {
                if (turns.length) localUserTurnsRef.current.set(id, turns);
                else localUserTurnsRef.current.delete(id);
              },
              syncPendingSteers,
              removeVisibleTurns: (id: any, messages: any) => {
                if (!viewingEventSession || id !== eventSessionId) return;
                dispatchPane({
                  type: "PROMPT_ACKNOWLEDGED",
                  sessionId: id,
                  messages: (current: any) => current.filter((message: any) => !messages.has(message)),
                });
              },
              reportDropped: (id: any) => {
                const message = steeringClearedMessage(String(event.reason || "cleared"));
                if (viewingEventSession && id === eventSessionId) setError(message);
                else unreadSteeringDropMessagesRef.current.set(id, message);
              },
            });
          }

    return true;
  }
  if (type === "agent_settled") {

          if (eventSessionId) {
            streamingWireProjectionsRef.current.delete(eventSessionId);
            streamGapRecoveriesRef.current.delete(eventSessionId);
          }
          if (eventSessionId)
            dispatchAskQuestionnaire({
              type: "CLOSE_SESSION",
              sessionId: eventSessionId,
            });
          if (eventSessionId && clearStoppingForSession(eventSessionId)) {
            setNotice((current: any) =>
              current === "已发送停止请求，Pi 正在结束当前操作" ? "" : current,
            );
          }
          if (eventSessionId)
            releasePromptBusy(
              eventSessionId,
              eventRunGeneration,
              eventRunEpoch,
              true,
            );
          const completedAssistantReply =
            eventSessionId &&
            terminalAssistantSessionIdsRef.current.delete(eventSessionId);
          if (eventSessionId) {
            const settledMessages = viewCacheRef.current.get(eventSessionId)?.messages || (viewingEventSession ? pane.messages : []);
            const assistantMessages = settledMessages.filter((message: any) => message.role === "assistant");
            const visibleAssistantMessages = assistantMessages.filter((message: any) => {
              if (typeof message.content === "string") return Boolean(message.content.trim());
              return Array.isArray(message.content) && message.content.some(
                (block: any) => block.type === "text" && Boolean(block.text?.trim()),
              );
            });
            if (!completedAssistantReply && visibleAssistantMessages.length === 0) {
              recordBrowserStateDiagnostic("projection", "assistant-settlement-gap", {
                sessionId: eventSessionId,
                runGeneration: eventRunGeneration,
                details: {
                  settlementSource: "agent-settled",
                  messageCount: settledMessages.length,
                  assistantCount: assistantMessages.length,
                  visibleAssistantCount: visibleAssistantMessages.length,
                  eventType: lastSessionEventTypeRef.current.get(eventSessionId) || "unknown",
                  projectionSource: "sse",
                },
              });
            }
          }
          if (completedAssistantReply && !viewingEventSession) {
            setUnseenReplySessionIds((current: any) =>
              current.includes(eventSessionId)
                ? current
                : [...current, eventSessionId],
            );
          }
          if (eventSessionId) {
            clearEmptyQueuePause(eventSessionId);
            // Settlement is terminal even if the user navigated away before this
            // SSE frame arrived; always release the owning stop lease.
            completedCompactionSessionIdsRef.current.add(eventSessionId);
            clearStoppingForSession(eventSessionId);
            sessionRunningOverridesRef.current.set(eventSessionId, false);
            setSessions((current: any) =>
              current.map((session: any) =>
                session.id === eventSessionId
                  ? settleSidebarActivity(session)
                  : session,
              ),
            );
            patchSessionCache(eventSessionId, {
              isStreaming: false,
              liveMessage: undefined,
              toolStatus: "",
              sessionActivity: settledPaneActivity(
                viewCacheRef.current.get(eventSessionId)?.session.activity,
                eventRunDurationMs,
              ),
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
              type: "AGENT_SETTLED",
              sessionId: eventSessionId,
              ...(eventRunDurationMs !== undefined ? { runDurationMs: eventRunDurationMs } : null),
            });
            // A post-compaction turn has now persisted its new usage snapshot.
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
          scheduleSidebarRefresh();

    return true;
  }
  if (type === "pi_chat_active_session_changed") {

          const effect = deriveActiveSessionChangedEffect(
            event,
            viewedSessionIdRef.current,
          );
          activeSessionProjectionWriter.observeSse(effect.activeSessionIds);
          if (effect.viewedSessionBecameViewOnly)
            dispatchPane({
              type: "RUNTIME_STATUS_CHANGED",
              sessionId: effect.sessionId,
              status: "view-only",
            });
          scheduleSidebarRefresh();

    return true;
  }
  if (type === "pi_chat_primary_runtime_status") {

          const readiness = event.primaryRuntime as
            Partial<PrimaryRuntimeReadiness> | undefined;
          if (
            readiness &&
            (readiness.status === "starting" ||
              readiness.status === "ready" ||
              readiness.status === "failed") &&
            typeof readiness.generation === "number"
          ) {
            const incoming = readiness as PrimaryRuntimeReadiness;
            const { previous: current, next, committed } =
              runtimeProjectionWriter.observeRuntimeStatus(incoming);
            if (committed) {
              // A new startup or failure invalidates the preceding generation's
              // ModelInfo.input assertion before a later ready can paint.
              if (next.status !== "ready") {
                // Fast is Runtime-generation state. Clear the old visible/cache
                // projection as soon as a Primary replacement starts; a later
                // current-generation extension event may explicitly re-enable it.
                const previousPrimarySessionId = current.sessionId || "";
                const resetFastSessionId =
                  next.sessionId || previousPrimarySessionId;
                if (resetFastSessionId) {
                  patchSessionCache(resetFastSessionId, {
                    state: { fastModeActive: false },
                  });
                  if (viewedSessionIdRef.current === resetFastSessionId)
                    dispatchPane({
                      type: "FAST_MODE_CHANGED",
                      sessionId: resetFastSessionId,
                      active: false,
                    });
                }
              }
              // Ready is now an adopted state/capability snapshot, not a request
              // to issue another bootstrap/get_state. Update only the exact
              // visible Primary pane or local draft; cold/Secondary panes keep
              // their independent Session state.
              if (next.status === "ready" && next.model) {
                rememberObservedModel(next.model);
                const target = localDraftRef.current
                  ? { kind: "draft" as const }
                  : next.sessionId
                    ? { kind: "session" as const, sessionId: next.sessionId }
                    : { kind: "draft" as const };
                dispatchPane({
                  type: "RUNTIME_SETTINGS_ADOPTED",
                  target,
                  state: {
                    model: next.model,
                    thinkingLevel: next.thinkingLevel,
                  },
                });
              }
            }
            // Commands, stats, and the complete model catalogue remain Bootstrap
            // metadata. This refresh is safe after atomic adoption because the
            // server no longer sends a second get_state for an adopted child.
            if (incoming.status === "ready")
              void refresh().catch(reportBackgroundRefreshError);
          }

    return true;
  }
  return false;
}
