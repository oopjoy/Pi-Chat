import type { ExtensionUiRequest, ModelInfo, PiMessage, PrimaryRuntimeReadiness, QueuedPrompt, SessionActivityState, SessionSummary, SessionViewData, SlashCommand } from "../../shared/types";
import type { StreamingMessageAppend } from "../../shared/streaming-wire";

export function createPiEventHandler(host: Record<string, any>) {
  const {
    MESSAGE_CHECKPOINT_EVENT,
    MESSAGE_DELTA_EVENT,
    WAITING_FOR_PI_STATUS,
    acceptQueueProjection,
    activeSessionProjectionWriter,
    admitStreamEvent,
    appendTerminalSessionCache,
    applyDequeuedSteers,
    applyExtensionUiRequestEffect,
    applyNativeSteeringClearEffect,
    applyQueueDispatchEffect,
    applyQueueErrorEffect,
    applyQueueSnapshotEffect,
    applyQueueUpdateEffect,
    applySessionActivity,
    applySessionView,
    applySidebarQueueProjection,
    applySidebarRunningOverride,
    applyStreamingDelta,
    assistantMessage,
    assistantMessageRequestsTool,
    authoritativeTurnTotal,
    bindQueuedAdmission,
    bindQueuedDispatch,
    block,
    cancelPendingNavigation,
    cancellingQueueIdsRef,
    capturePaneAuthority,
    clearEmptyQueuePause,
    clearPendingLiveMessage,
    clearPromptReconcileTimer,
    clearStoppingForSession,
    clientPromptOperationId,
    commitSessionViewCache,
    completedCompactionSessionIdsRef,
    confirmedQueueDispatchIdsRef,
    consumeLocalSteeringTurn,
    currentQueue,
    decodeStreamingCheckpoint,
    deriveActiveSessionChangedEffect,
    deriveApplicationLifecycleEffect,
    deriveExtensionRequestResolvedEffect,
    deriveFastModeChangedEffect,
    deriveGateModeChangedEffect,
    derivePromptDeliveryUncertainEffect,
    derivePromptRetryEffect,
    deriveQueueDispatchEffect,
    deriveQueueErrorEffect,
    deriveQueueSnapshotEffect,
    deriveSessionControlChangedEffect,
    deriveSessionMutationEffect,
    deriveWorkspaceChangedEffect,
    desiredSessionIdRef,
    dispatchAskQuestionnaire,
    dispatchPane,
    displaySettingsFromEvent,
    fetchSessionView,
    finalizeDeletedSession,
    finiteRunMetric,
    gateModeFromNotice,
    generation,
    incomingPaused,
    invalidatesSessionViewVersion,
    isSessionScopedEvent,
    item,
    lastEventFrameAtRef,
    lastSessionEventTypeRef,
    latestQueueProjectionRef,
    localDraftRef,
    localUserTurnsRef,
    mergeModelCatalog,
    messages,
    modelCatalogueRevisionGate,
    navigationEpochRef,
    pane,
    paneAuthorityCanCommit,
    paneStateRef,
    parseAskQuestionnaire,
    patchSessionCache,
    paused,
    pending,
    pendingGateModesRef,
    pendingSteerProjectionRef,
    pendingSteersRef,
    projectionPaused,
    promoteTurnsAbsentFromQueue,
    promptControllerRef,
    queue,
    queueId,
    queueProjectionRevisionRef,
    queuedIds,
    recordBrowserStateDiagnostic,
    recordLocalFailure,
    recordSseRejectionDiagnostic,
    refresh,
    releasePromptBusy,
    rememberObservedModel,
    reportBackgroundRefreshError,
    requestPromptReconcileRef,
    resetResourceReloadTransientState,
    resourceReloadActiveRef,
    runEpoch,
    runEpochRef,
    runGeneration,
    runtimeProjectionWriter,
    saveModelCatalog,
    scheduleLiveMessage,
    scheduleSidebarRefresh,
    selectDeletionFallback,
    session,
    sessionEventVersionRef,
    sessionId,
    sessionRunGenerationsRef,
    sessionRunningOverridesRef,
    sessionsRef,
    setCloseComplete,
    setError,
    setEventSourceGeneration,
    setFailedSessionIds,
    setManagementSection,
    setModelRuntimeSyncPending,
    setModels,
    setNotice,
    setRuntimeWarming,
    setSessions,
    setUnseenReplySessionIds,
    setWorkspaceCwd,
    settleSidebarActivity,
    settledPaneActivity,
    settledRunGenerationsRef,
    sourceTurnTotalsRef,
    sseFloodCountRef,
    sseReconnectTimerRef,
    stageGateMode,
    startIdleRecovery,
    state,
    steeringClearedMessage,
    streamDiagnosticsRef,
    streamGapRecoveriesRef,
    streamingWireProjectionsRef,
    syncPendingSteers,
    terminalAssistantSessionIdsRef,
    terminalAssistantStreamGenerationsRef,
    tryAutoAllowGate,
    turns,
    unreadSteeringDropMessagesRef,
    updateGateMode,
    updateLiveSessionCache,
    view,
    viewCacheRef,
    viewCacheWriter,
    viewedSessionIdRef,
    withStreamingAppendHints,
    workspaceEpochRef,
    workspaceRevisionRef
  } = host;
    return (rawEvent: Event, source: EventSource): void => {
      lastEventFrameAtRef.current = Date.now();
      const admission = admitStreamEvent(rawEvent, runEpochRef.current);
      if (!admission.accepted) {
        recordSseRejectionDiagnostic({
          sessionId: admission.sessionId,
          runGeneration: admission.runGeneration,
          eventType: admission.eventType,
          decisionReason: admission.reason,
        });
        return;
      }
      const { event, type, sessionId: eventSessionId, runEpoch: eventRunEpoch, runGeneration: eventRunGeneration, terminalEvent } = admission.value;
      sseFloodCountRef.current = 0;
      if (type === "pi_chat_heartbeat") return;
      if (type === "pi_chat_sse_resync" || type === "pi_chat_oversized_event") {
        void refresh().catch(reportBackgroundRefreshError);
        return;
      }
      const eventRunStartedAt = finiteRunMetric(event.piChatRunStartedAt);
      const eventRunDurationMs = finiteRunMetric(event.piChatRunDurationMs);
      if (eventSessionId && typeof eventRunGeneration === "number") {
        const latest = sessionRunGenerationsRef.current.get(eventSessionId);
        const settled = settledRunGenerationsRef.current.get(eventSessionId);
        // A Pi turn is a monotonic lifecycle. Once a generation settles, every
        // non-terminal frame from it is stale, even if SSE/backpressure makes
        // it arrive after settlement. Explicit generation zero is valid before
        // the first agent_start; undefined means that no authority is known yet.
        if (latest !== undefined && eventRunGeneration < latest) {
          recordSseRejectionDiagnostic({
            sessionId: eventSessionId,
            runGeneration: eventRunGeneration,
            eventType: type || "unknown",
            decisionReason: "stale-run-generation",
          });
          return;
        }
        if (
          settled !== undefined
          && eventRunGeneration <= settled
          && type !== "agent_settled"
        ) {
          recordSseRejectionDiagnostic({
            sessionId: eventSessionId,
            runGeneration: eventRunGeneration,
            eventType: type || "unknown",
            decisionReason: "settled-run-generation",
          });
          return;
        }
        sessionRunGenerationsRef.current.set(
          eventSessionId,
          Math.max(latest ?? -1, eventRunGeneration),
        );
        if (type === "agent_settled")
          settledRunGenerationsRef.current.set(
            eventSessionId,
            Math.max(settled ?? -1, eventRunGeneration),
          );
      }
      // Only explicitly global frames may omit a Session ID. A malformed
      // session-scoped frame must never be interpreted as belonging to whatever
      // pane happens to be visible at that instant.
      if (isSessionScopedEvent(type) && !eventSessionId) {
        recordSseRejectionDiagnostic({
          eventType: type || "unknown",
          decisionReason: "missing-session",
        });
        return;
      }
      // A destination is no longer allowed to paint updates from the source
      // pane while navigation is in flight. Its events still update that pane's
      // cache, ready for an immediate return.
      const viewingEventSession =
        Boolean(eventSessionId) &&
        eventSessionId === viewedSessionIdRef.current &&
        viewedSessionIdRef.current === desiredSessionIdRef.current;
      /**
       * Session-status carries the same cumulative queue snapshot as the
       * dedicated queue event. Keep one projection path for both so a
       * coalesced/missed queue_dispatch cannot strand a local turn in FIFO.
       */
      const projectStatusQueue = (queue: QueuedPrompt[], paused: boolean): void => {
        if (!eventSessionId) return;
        applyQueueSnapshotEffect({
          sessionId: eventSessionId,
          queue,
          paused,
          viewing: viewingEventSession,
        }, {
          acceptQueue: (sessionId: any, incoming: any, incomingPaused: any) =>
            acceptQueueProjection(sessionId, incoming, incomingPaused, "event"),
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
          updateSidebar: (sessionId: any, currentQueue: any, projectionPaused: any) => setSessions((current: any) => current.map((session: any) =>
            session.id === sessionId
              ? applySidebarQueueProjection(session, currentQueue, projectionPaused)
              : session,
          )),
          patchSessionCache: (sessionId: any, currentQueue: any, projectionPaused: any) => patchSessionCache(sessionId, {
            queue: currentQueue,
            queuePaused: projectionPaused,
          }),
        });
      };
      if (
        event.piChatPromptId &&
        eventSessionId &&
        (type === "agent_start" ||
          type === "agent_settled" ||
          type === "pi_chat_process_error")
      ) {
        const observed = promptControllerRef.current.observeServerLifecycle(
          String(event.piChatPromptId),
          type,
          eventRunGeneration,
          eventSessionId,
          runEpochRef.current,
        );
        if (observed?.phase === "settled" ||
          observed?.phase === "failed" ||
          observed?.phase === "aborted")
          promptControllerRef.current.clearTerminal();
      }
      recordBrowserStateDiagnostic("sse", "admitted", {
        sessionId: eventSessionId,
        runGeneration: eventRunGeneration,
        details: {
          eventType: type || "unknown",
          viewing: viewingEventSession,
          navigationEpoch: navigationEpochRef.current,
        },
      });
      if (type === "pi_chat_prompt_retry_scheduled"
        || type === "pi_chat_prompt_retry_started"
        || type === "pi_chat_prompt_retry_exhausted"
        || type === "pi_chat_prompt_failed") {
        const retry = derivePromptRetryEffect(type, event);
        const {
          retryAttempt,
          retryAttempts,
          maxAttempts,
          delayMs,
          isRetryLifecycle,
          serverPromptId,
          retryPhase,
          status,
        } = retry;
        const observedRetry = isRetryLifecycle && serverPromptId && eventSessionId
          ? promptControllerRef.current.observeRetry(
              serverPromptId,
              retryPhase,
              eventRunGeneration,
              eventSessionId,
              eventRunEpoch,
              retryAttempt,
              maxAttempts,
              delayMs,
            )
          : undefined;
        // Once a Server Prompt has a terminal lifecycle fact, a late retry frame
        // must not repaint the Pane. Identity-less legacy frames keep the old
        // projection path; identity-bearing frames require an active operation.
        const retryIdentityMatchesEvent = Boolean(
          observedRetry
          && eventSessionId
          && observedRetry.sessionId === eventSessionId
          && (!eventRunEpoch
            || !observedRetry.runEpoch
            || observedRetry.runEpoch === eventRunEpoch),
        );
        const projectRetry = !isRetryLifecycle
          || !serverPromptId
          || Boolean(
            observedRetry
            && retryIdentityMatchesEvent
            && !["settled", "failed", "aborted"].includes(observedRetry.phase),
          );
        if (projectRetry && eventSessionId) {
          patchSessionCache(eventSessionId, { toolStatus: status, isStreaming: type !== "pi_chat_prompt_failed" });
          if (viewingEventSession)
            dispatchPane({ type: "TOOL_STATUS_UPDATED", sessionId: eventSessionId, status });
        }
        recordBrowserStateDiagnostic("retry", type, {
          sessionId: eventSessionId,
          runGeneration: eventRunGeneration,
          details: {
            retryAttempt,
            retryAttempts,
            maxAttempts,
            delayMs,
            provider: retry.provider,
            model: retry.model,
            api: retry.api,
          },
        });
      }
      if (type === "pi_chat_native_steering_dequeued") {
        const ids = Array.isArray(event.ids)
          ? event.ids.filter((id: any): id is string =>
              typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id),
            )
          : [];
        if (eventSessionId && ids.length) {
          const incomingRevision = typeof event.pendingSteerRevision === "number"
            ? event.pendingSteerRevision
            : 0;
          applyDequeuedSteers(eventSessionId, ids, incomingRevision);
        }
        return;
      }
      if (eventSessionId && invalidatesSessionViewVersion(type)) {
        sessionEventVersionRef.current.set(
          eventSessionId,
          (sessionEventVersionRef.current.get(eventSessionId) || 0) + 1,
        );
        lastSessionEventTypeRef.current.set(eventSessionId, type);
      }
      // View snapshots use stale-while-revalidate: retain them through streaming
      // and terminal events for instant navigation, then refresh in the background.
      // Only structural session mutations explicitly discard a snapshot below.
      if (type === "pi_chat_application_closing") {
        source.close();
        setManagementSection(null);
        setCloseComplete("application");
        window.setTimeout(() => window.close(), 40);
      } else if (type === "agent_start") {
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
      } else if (type === "compaction_start") {
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
      } else if (type === "compaction_end") {
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
      } else if (
        type === "message_start"
        || type === "message_update"
        || type === MESSAGE_CHECKPOINT_EVENT
        || type === MESSAGE_DELTA_EVENT
      ) {
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
            return;
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
            return;
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
      } else if (type === "message_end" && terminalEvent) {
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
      } else if (type === "tool_execution_start") {
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
      } else if (type === "tool_execution_end") {
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
      } else if (type === "pi_chat_native_steering_cleared") {
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
      } else if (type === "agent_settled") {
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
      } else if (type === "pi_chat_active_session_changed") {
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
      } else if (type === "pi_chat_primary_runtime_status") {
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
      } else if (type === "pi_chat_workspace_changed") {
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
      } else if (type === "pi_chat_models_updated") {
        if (!modelCatalogueRevisionGate.admitSse(event.revision)) {
          recordSseRejectionDiagnostic({
            eventType: type,
            decisionReason: "stale-model-catalogue",
          });
          return;
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
      } else if (type === "pi_chat_application_lifecycle") {
        const effect = deriveApplicationLifecycleEffect(event.lifecycle);
        if (!effect) {
          recordSseRejectionDiagnostic({
            eventType: type,
            decisionReason: "malformed-lifecycle",
          });
          return;
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
      } else if (type === "pi_chat_reloaded") {
        // Older servers may emit the reload marker without a preceding
        // lifecycle frame. Treat it as the same Runtime replacement boundary.
        if (!resourceReloadActiveRef.current) {
          resourceReloadActiveRef.current = true;
          resetResourceReloadTransientState();
          runtimeProjectionWriter.observeLifecycle("resources-reloading");
        }
        setNotice("配置已更新，正在确认新的 Pi Runtime…");
      } else if (type === "pi_chat_sessions_changed") {
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
      } else if (type === "pi_chat_queue_update") {
        const queueSnapshot = deriveQueueSnapshotEffect(event);
        if (!queueSnapshot) {
          recordSseRejectionDiagnostic({
            sessionId: eventSessionId,
            runGeneration: eventRunGeneration,
            eventType: type,
            decisionReason: "malformed-queue-snapshot",
          });
          return;
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
      } else if (type === "pi_chat_queue_dispatch") {
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
      } else if (type === "pi_chat_prompt_delivery_uncertain") {
        if (viewingEventSession)
          setNotice(derivePromptDeliveryUncertainEffect().notice);
      } else if (type === "pi_chat_queue_error") {
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
      } else if (type === "pi_chat_fast_mode_changed") {
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
      } else if (type === "extension_ui_request") {
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
      } else if (type === "pi_chat_gate_mode_changed") {
        const mode = deriveGateModeChangedEffect(event);
        if (eventSessionId && mode) {
          updateGateMode(eventSessionId, mode.mode);
          if (pendingGateModesRef.current.get(eventSessionId) === mode.mode)
            stageGateMode(eventSessionId, undefined);
        }
      } else if (type === "pi_chat_session_control_changed") {
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
      } else if (type === "pi_chat_extension_request_resolved") {
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
      } else if (type === "extension_error") {
        if (viewingEventSession)
          setError(String(event.error || "扩展执行失败"));
      } else if (type === "pi_chat_session_status") {
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
      } else if (type === "pi_chat_process_recovered") {
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
      } else if (type === "pi_chat_process_error") {
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
      }

  };
}
