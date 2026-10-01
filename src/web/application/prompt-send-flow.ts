import type { PromptDelivery, PromptImage, PiMessage, SessionRuntimeReadyData } from "../../shared/types";
import type { DraftPaneAuthority } from "../application/pane-authority";
import type { LocalUserTurn } from "../lib/local-user-turn";
type SessionViewCommitAuthority = any;

/**
 * Browser Prompt transaction adapter. App remains the authority owner; this
 * module receives a single explicit host boundary and does not retain state.
 */
export function createPromptSendFlow(host: Record<string, any>) {
  const {
    ApiRequestError,
    DRAFT_FAILURE_SCOPE,
    DRAFT_PREFS_KEY,
    LOCAL_DRAFT_BUSY_ID,
    WAITING_FOR_PI_STATUS,
    acceptQueueProjection,
    adoptDraftSessionView,
    api,
    appendLocalTurnOnce,
    applySessionView,
    applySidebarQueueProjection,
    applyWarmReadinessForPane,
    authoritativeStoppedSteerRejection,
    authoritativeTurnTotal,
    beginSessionBusy,
    bindLocalTurnPromptIdentity,
    buildIdentityMismatch,
    buildProtectedLocalTurn,
    cancellingQueueIdsRef,
    captureDraftPaneAuthority,
    capturePaneAuthority,
    capturePromptSelection,
    captureViewOperation,
    classifyPromptFailure,
    clearPendingLiveMessage,
    clearStoppingForSession,
    clearViewedPromiseRef,
    commitDraftIfCurrent,
    commitPaneIfCurrent,
    commitSessionViewCache,
    composerCommands,
    createSession,
    desiredSessionIdRef,
    dispatchPane,
    displayedQueue,
    draftAuthorityCanCommit,
    draftIntentAfterSubmit,
    draftWorkspaceCwd,
    fetchSessionView,
    forgetLocalFailuresForSession,
    gateModeFromCommand,
    gateModesRef,
    isTranscriptWorthyFailure,
    lastSessionEventTypeRef,
    latestQueueProjectionRef,
    localDraftRef,
    localUserTurnsRef,
    markLocalTurnQueued,
    messages,
    modelInventoryConfirmed,
    modelUnavailableError,
    models,
    navigationEpochRef,
    paneAuthorityCanCommit,
    patchSessionCacheForAuthority,
    pendingGateModesRef,
    pendingSessionPrefsRef,
    pendingSteerFromAcknowledgement,
    pendingSteersRef,
    planAcknowledgedQueueProjection,
    planAcknowledgedTurn,
    planPromptFailureLocalTurn,
    prepareRestoringPrompt,
    presentPromptFailure,
    promoteTurnsAbsentFromQueue,
    promptAcknowledgementKind,
    promptBusyReleasesRef,
    promptPreparationRoute,
    promptSubmitControllerRef,
    promptSubmitFlowRef,
    queuePaused,
    queueProjectionForView,
    queueProjectionRevisionRef,
    queueProjectionSourceRef,
    reconcileOrdinaryPromptAcknowledgement,
    reconcilePromptFailureRecord,
    reconcileQueuedPromptAcknowledgement,
    reconcileSpecialPromptAcknowledgement,
    reconcileStalePromptAcknowledgement,
    reconcileStoppedSteerFailure,
    recordLocalFailure,
    recordUserTurnLifecycle,
    refresh,
    releasePromptBusy,
    removeLocalTurnAndRebase,
    requestPromptReconcileRef,
    resultPendingError,
    runEpochGenerationRef,
    runEpochRef,
    runtimeStatus,
    saveSessionComposerSelections,
    schedulePromptReconcile,
    scheduleSidebarRefresh,
    sessionEventVersionRef,
    sessionRunGenerationsRef,
    sessionRunningOverridesRef,
    setComposerSelectionRevision,
    setError,
    setLocalFailures,
    setNotice,
    setPendingGateModes,
    setSessions,
    settleSidebarActivity,
    shouldClearModelSelectionOnFailure,
    state,
    stickToBottomRef,
    stopGeneration,
    submitNewDraftPrompt,
    syncPendingSteers,
    toolStatus,
    turnTotal,
    updateGateMode,
    userMessage,
    validateSelectedRoute,
    viewCacheWriter,
    viewOperationIsCurrent,
    viewOperationIsInCurrentRun,
    viewedSessionId,
    viewedSessionIdRef,
    warmSessionRuntime,
    workspaceCwd,
  } = host;
  return async (
    message: string,
    images: PromptImage[],
    delivery: PromptDelivery = "queue",
    requestedTargetSessionId: any = "",
  ): Promise<void> => {{
    if (buildIdentityMismatch) return;
    const steering = delivery === "steer";
    if (requestedTargetSessionId && steering)
      throw new Error("子代理视图不能向父对话发送 Steer 消息");
    if (steering && !state.isStreaming)
      throw new Error("当前对话已不再运行，无法发送 Steer 消息");
    setError("");
    stickToBottomRef.current = true;
    const initialSessionId =
      requestedTargetSessionId ||
      viewedSessionIdRef.current ||
      (localDraftRef.current ? LOCAL_DRAFT_BUSY_ID : "");
    let busySessionId = initialSessionId;
    let finishSessionBusy = beginSessionBusy(busySessionId);
    const moveSessionBusyTo = (sessionId: string) => {
      if (!sessionId || sessionId === busySessionId) return;
      finishSessionBusy();
      busySessionId = sessionId;
      finishSessionBusy = beginSessionBusy(busySessionId);
    };
    const alreadyStreaming = state.isStreaming;
    const willQueueLocally =
      !steering && (alreadyStreaming || queuePaused || displayedQueue.length > 0);
    const previousToolStatus = toolStatus;
    const optimisticMessage =
      !steering &&
      !message.startsWith("/") &&
      (Boolean(state.isCompacting) || !willQueueLocally)
        ? userMessage(message, images)
        : null;
    const localTurn = optimisticMessage || userMessage(message, images);
    let targetSessionId = requestedTargetSessionId || viewedSessionIdRef.current;
    let promptQueueProjectionRevision = targetSessionId
      ? queueProjectionRevisionRef.current.get(targetSessionId) || 0
      : 0;
    const promptRunEpochGeneration = runEpochGenerationRef.current;
    const promptOperationIsInCurrentRun = () =>
      runEpochGenerationRef.current === promptRunEpochGeneration;
    let promptAuthority: ReturnType<typeof capturePaneAuthority> | null =
      targetSessionId && targetSessionId === viewedSessionIdRef.current
        ? capturePaneAuthority(targetSessionId)
        : null;
    let promptDraftAuthority: DraftPaneAuthority | null = targetSessionId
      ? null
      : captureDraftPaneAuthority();
    // Prompt acknowledgements and failures are both asynchronous pane facts.
    // A matching Session ID is not enough after A → B → A. The first New
    // submission begins in a draft, so it uses the matching draft token until
    // its atomic Session commit creates a session authority.
    const promptPaneIsCurrent = () =>
      promptAuthority
        ? paneAuthorityCanCommit(promptAuthority)
        : Boolean(
            promptDraftAuthority &&
            draftAuthorityCanCommit(promptDraftAuthority),
          );
    let protectedLocalTurn: LocalUserTurn | null = null;
    let promptBusyRelease: (() => void) | null = null;
    let promptAcceptedByEvent = false;
    let promptTerminalByEvent = false;
    let promptSubmitted = false;
    let promptOperationId = crypto.randomUUID();
    let serverPromptId: string | null = null;
    const protectLocalPrompt = (turn: PiMessage | null = localTurn) => {
      // A child transcript never receives optimistic parent turns, queue rows,
      // or Runtime projections. The server remains the sole parent authority
      // until that parent is explicitly viewed.
      const pending = localUserTurnsRef.current.get(targetSessionId) || [];
      const nextLocalTurn = buildProtectedLocalTurn({
        turn,
        targetSessionId,
        viewedSessionId: viewedSessionIdRef.current,
        protectedLocalTurn,
        pendingTurns: pending,
        promptOperationId,
        messages,
        turnTotal,
        willQueueLocally,
        steering,
        message,
        images,
        baselineTurnTotal: authoritativeTurnTotal(targetSessionId),
      });
      if (!nextLocalTurn) return protectedLocalTurn;
      protectedLocalTurn = nextLocalTurn;
      localUserTurnsRef.current.set(targetSessionId, [
        ...pending,
        nextLocalTurn,
      ]);
      recordUserTurnLifecycle("optimistic-created", targetSessionId, nextLocalTurn);
      return nextLocalTurn;
    };
    const localTurnEntry = (): LocalUserTurn | undefined => {
      if (!targetSessionId) return undefined;
      const turns = localUserTurnsRef.current.get(targetSessionId) || [];
      return turns.find(
        (turn: any) =>
          turn.promptOperationId === promptOperationId
          || (serverPromptId && turn.serverPromptId === serverPromptId)
          || turn.message === localTurn,
      );
    };
    dispatchPane({
      type: "PROMPT_STARTED",
      target: targetSessionId
        ? { kind: "session", sessionId: targetSessionId }
        : { kind: "draft" },
      pendingUserMessage: optimisticMessage,
    });
    try {
      const command = /^\/(new|compact|abort)(?:\s+([\s\S]*))?$/.exec(message);
      if (command?.[1] === "new") {
        createSession();
        return;
      }
      if (command?.[1] === "compact") {
        if (localDraftRef.current)
          throw new Error("新对话尚未发送消息，无需压缩上下文");
        const authority = captureViewOperation();
        if (runtimeStatus !== "active") {
          dispatchPane({
            type: "RUNTIME_STATUS_CHANGED",
            sessionId: authority.sessionId,
            status: "restoring",
          });
          const queueRequestRevision =
            queueProjectionRevisionRef.current.get(authority.sessionId) || 0;
          const view = await api.activateSession(viewedSessionId);
          if (!viewOperationIsInCurrentRun(authority)) return;
          viewCacheWriter.forget(view.session.id, authority);
          if (viewOperationIsCurrent(authority))
            applySessionView(view, authority, queueRequestRevision);
          else {
            const projection = queueProjectionForView(
              view.session.id,
              view.queue,
              view.queuePaused === true,
              queueRequestRevision,
            );
            commitSessionViewCache(
              projection.known || projection.queue.length || projection.paused
                ? {
                    ...view,
                    queue: projection.queue,
                    queuePaused: projection.paused,
                  }
                : view,
              authority,
            );
          }
        }
        await api.compact(command[2] || "", authority.sessionId);
        if (!viewOperationIsInCurrentRun(authority)) return;
        await refresh();
        if (viewOperationIsCurrent(authority)) setNotice("上下文压缩完成");
        return;
      }
      if (command?.[1] === "abort") {
        await stopGeneration();
        return;
      }

      // ModelInfo.input is advisory metadata only. Prompt delivery owns the
      // transport boundary; upstream Pi/model handling decides whether the
      // selected provider can interpret attached images.

      // Capture one immutable selection with the send operation. The visible
      // Composer may change while a cold Runtime warms, but that later choice
      // belongs to a later prompt and must not rewrite this one.
      const prefsKey = localDraftRef.current
        ? DRAFT_PREFS_KEY
        : targetSessionId;
      const staged = pendingSessionPrefsRef.current.get(prefsKey);
      // A draft has no Runtime-confirmed Gate state yet. Capture its explicit
      // local intent with this first request without promoting it to authority.
      const captured = capturePromptSelection({
        stagedSelection: staged,
        models,
        isDraft: Boolean(localDraftRef.current),
        draftGateMode: pendingGateModesRef.current.get(DRAFT_PREFS_KEY),
      });
      const capturedSelection = captured.selection;
      const capturedPromptSettings = captured.promptSettings;
      const capturedDraftGateMode = captured.draftGateMode;
      if (capturedSelection?.model && modelInventoryConfirmed) {
        const route = validateSelectedRoute(
          models,
          capturedSelection.model.provider,
          capturedSelection.model.id,
          capturedSelection.model.api,
        );
        if (!route.ok) {
          setError(
            `当前模型路由无效：${capturedSelection.model.provider}/${capturedSelection.model.id}`
            + (capturedSelection.model.api ? `（${capturedSelection.model.api}）` : "")
            + " 不在当前 Runtime 的模型目录中，请重新选择模型。",
          );
          return;
        }
      }
      let initialPromptResult: Awaited<ReturnType<typeof api.prompt>> | null =
        null;
      const preparationRoute = promptPreparationRoute({
        isDraft: Boolean(localDraftRef.current),
        runtimeStatus,
        alreadyStreaming,
      });
      if (preparationRoute === "draft") {
        const draftAuthority = captureDraftPaneAuthority();
        dispatchPane({
          type: "PROMPT_PREPARING",
          target: { kind: "draft" },
          status: WAITING_FOR_PI_STATUS,
        });
        // Once the combined mutation is written its outcome may be unknown;
        // retain the protected local bubble until SSE/JSONL proves otherwise.
        promptSubmitted = true;
        const clearViewedRequest = clearViewedPromiseRef.current;
        await clearViewedRequest;
        if (clearViewedPromiseRef.current === clearViewedRequest)
          clearViewedPromiseRef.current = null;
        if (!promptOperationIsInCurrentRun()) return;
        // One host transaction owns the empty draft through model/thinking/Gate
        // setup and prompt acceptance. Do not expose three extra browser round
        // trips after the dedicated Runtime has just cold-started.
        const initial = await submitNewDraftPrompt(
          {
            submitNewSession: api.submitNewSession,
            newSession: api.newSession,
            prompt: (promptMessage: any, promptImages: any, sessionId: any, gateMode: any, settings: any, clientPromptOperationId: any) =>
              api.prompt(
                promptMessage,
                promptImages,
                sessionId,
                gateMode,
                "queue",
                settings,
                undefined,
                clientPromptOperationId,
              ),
            isCurrent: promptOperationIsInCurrentRun,
          },
          {
            cwd: draftWorkspaceCwd || workspaceCwd,
            message,
            images,
            // PiState supplies the displayed default only. Creating a new
            // Runtime must mutate Model/Thinking solely for an explicit Composer
            // selection captured with this first prompt.
            model: capturedSelection?.model,
            thinkingLevel: capturedPromptSettings?.thinkingLevel,
            gateMode: capturedDraftGateMode,
            clientPromptOperationId: promptOperationId,
            promptSettings: capturedPromptSettings,
          },
        );
        if (!promptOperationIsInCurrentRun()) return;
        targetSessionId = initial.sessionId;
        if (initial.promptId) {
          promptSubmitControllerRef.current.adoptAccepted(
            {
              promptId: promptOperationId,
              sessionId: targetSessionId,
              navigationEpoch: navigationEpochRef.current,
              runEpoch: runEpochRef.current,
              runtimeGeneration: sessionRunGenerationsRef.current.get(targetSessionId),
              delivery: steering ? "steer" : "queue",
            },
            initial.deliveryUncertain ? { type: "uncertain" } : { type: "run" },
          );
        }
        // The draft's own failure reason is resolved once its first message is
        // accepted; the Session that now exists keeps its own entries.
        setLocalFailures((current: any) => forgetLocalFailuresForSession(current, DRAFT_FAILURE_SCOPE));
        promptQueueProjectionRevision =
          queueProjectionRevisionRef.current.get(targetSessionId) || 0;
        moveSessionBusyTo(targetSessionId);
        protectLocalPrompt();
        const adoption = adoptDraftSessionView({
          initial,
          targetSessionId,
          draftAuthority,
          host: {
            draftAuthorityCanCommit,
            applySessionView,
            capturePaneAuthority,
            commitPane: commitPaneIfCurrent,
            commitSessionViewCache,
          },
        });
        const initialView = adoption.view;
        if (adoption.paneAuthority) {
          promptAuthority = adoption.paneAuthority;
          promptDraftAuthority = null;
        }
        // A choice made after Send started remains the draft's newer revision;
        // move it to the just-created ordinary target instead of dropping it.
        // A replacement New owns a newer draft authority and must keep its own
        // selection: an old async first-send completion may not touch it.
        if (draftAuthorityCanCommit(draftAuthority)) {
          const intent = draftIntentAfterSubmit({
            capturedSelection,
            newestDraftSelection: pendingSessionPrefsRef.current.get(DRAFT_PREFS_KEY),
            capturedGateMode: capturedDraftGateMode,
            newestDraftGateMode: pendingGateModesRef.current.get(DRAFT_PREFS_KEY),
          });
          if (intent.selectionForTarget) {
            pendingSessionPrefsRef.current.set(targetSessionId, intent.selectionForTarget);
            setComposerSelectionRevision((revision: any) => revision + 1);
          }
          if (intent.clearDraftSelection) {
            pendingSessionPrefsRef.current.delete(DRAFT_PREFS_KEY);
            saveSessionComposerSelections(pendingSessionPrefsRef.current);
          }
          // A distinct Gate intent belongs to the next turn; the captured
          // value is already being confirmed by this atomic first request.
          if (intent.gateModeForTarget)
            pendingGateModesRef.current.set(targetSessionId, intent.gateModeForTarget);
          if (intent.clearDraftGateMode) {
            pendingGateModesRef.current.delete(DRAFT_PREFS_KEY);
            setComposerSelectionRevision((revision: any) => revision + 1);
            setPendingGateModes(Object.fromEntries(pendingGateModesRef.current));
          }
        }
        // Preserve the ordinary acknowledgement/optimistic-turn path below;
        // only the transport setup was collapsed into this first request.
        initialPromptResult = initial;
        promptQueueProjectionRevision =
          queueProjectionRevisionRef.current.get(targetSessionId) || 0;
      } else if (preparationRoute === "restore") {
        const activationAuthority = capturePaneAuthority(targetSessionId);
        promptAuthority = activationAuthority;
        const restoring = await prepareRestoringPrompt({
          sessionId: targetSessionId,
          authority: activationAuthority,
          dispatchPreparing: (authority: any, sessionId: any) => {
            if (paneAuthorityCanCommit(authority))
              dispatchPane({
                type: "PROMPT_PREPARING",
                target: { kind: "session", sessionId },
                status: WAITING_FOR_PI_STATUS,
                runtimeStatus: "restoring",
              });
          },
          protectLocalTurn: () => { protectLocalPrompt(); },
          warmRuntime: (sessionId: string): Promise<SessionRuntimeReadyData> => warmSessionRuntime(sessionId),
          isCurrent: promptOperationIsInCurrentRun,
          applyWarmReadiness: (sessionId: any, ready: any, authority: any) => applyWarmReadinessForPane(sessionId, ready, authority, true) as boolean,
          commitPreparing: (authority: any, sessionId: any) => {
            commitPaneIfCurrent(authority, {
              type: "PROMPT_PREPARING",
              target: { kind: "session", sessionId },
              status: WAITING_FOR_PI_STATUS,
              // Runtime readiness is not prompt acknowledgement. Keep the local
              // user bubble visible until PROMPT_ACKNOWLEDGED moves it into messages.
            });
          },
        });
        if (restoring.cancelled) return;
      } else if (!alreadyStreaming && promptAuthority) {
        commitPaneIfCurrent(promptAuthority, {
          type: "PROMPT_PREPARING",
          target: { kind: "session", sessionId: targetSessionId },
          status: WAITING_FOR_PI_STATUS,
        });
      }

      promptBusyRelease = () => {
        finishSessionBusy();
      };
      if (!alreadyStreaming)
        promptBusyReleasesRef.current.set(targetSessionId, {
          epoch: runEpochRef.current,
          afterGeneration:
            sessionRunGenerationsRef.current.get(targetSessionId) || 0,
          release: promptBusyRelease,
          markAccepted: () => {
            promptAcceptedByEvent = true;
          },
          markTerminal: () => {
            promptTerminalByEvent = true;
          },
        });
      const eventVersionBeforePrompt =
        sessionEventVersionRef.current.get(targetSessionId) || 0;
      // Protect the prompt across every asynchronous refresh until a JSONL view
      // confirms the additional user turn. This also covers active Sessions,
      // which have no Runtime-start view to pass through above.
      const admittedLocalTurn = protectLocalPrompt();
      promptSubmitted = true;
      const requestedGateMode =
        pendingGateModesRef.current.get(targetSessionId) ??
        gateModesRef.current[targetSessionId];
      if (!promptOperationIsInCurrentRun()) return;
      if (!initialPromptResult) promptOperationId = crypto.randomUUID();
      if (admittedLocalTurn && promptOperationId)
        admittedLocalTurn.promptOperationId = promptOperationId;
      const result =
        initialPromptResult ||
        await promptSubmitFlowRef.current.admit({
          admission: {
            promptId: promptOperationId!,
            sessionId: targetSessionId,
            navigationEpoch: navigationEpochRef.current,
            runEpoch: runEpochRef.current,
            runtimeGeneration: sessionRunGenerationsRef.current.get(targetSessionId),
            delivery: steering ? "steer" : "queue",
          },
          execute: () => (steering
            ? api.prompt(
                message,
                images,
                targetSessionId,
                requestedGateMode,
                "steer",
                undefined,
                admittedLocalTurn?.queueId,
                promptOperationId,
              )
            : capturedPromptSettings
              ? api.prompt(
                  message,
                  images,
                  targetSessionId,
                  requestedGateMode,
                  "queue",
                  capturedPromptSettings,
                  undefined,
                  promptOperationId,
                )
              : api.prompt(
                  message,
                  images,
                  targetSessionId,
                  requestedGateMode,
                  "queue",
                  undefined,
                  undefined,
                  promptOperationId,
                )),
          facts: {
            promptSubmitted,
            promptAcceptedByEvent,
            promptTerminalByEvent,
          },
        });
      if (promptOperationId && result.promptId) {
        serverPromptId = result.promptId;
        const boundOperation = promptSubmitControllerRef.current.bindServerPromptId(
          promptOperationId,
          result.promptId,
        );
        if (["settled", "failed", "aborted"].includes(boundOperation.phase))
          promptSubmitControllerRef.current.clearTerminal();
      }
      if (
        targetSessionId &&
        !result.queued &&
        !result.steered &&
        capturedSelection &&
        promptPaneIsCurrent()
      ) {
        const displaySettings = {
          ...(capturedSelection.model ? { model: capturedSelection.model } : null),
          ...(capturedSelection.thinkingLevel
            ? { thinkingLevel: capturedSelection.thinkingLevel }
            : null),
        };
        patchSessionCacheForAuthority(
          targetSessionId,
          { state: displaySettings },
          promptAuthority!,
        );
        commitPaneIfCurrent(promptAuthority!, {
          type: "RUNTIME_SETTINGS_ADOPTED",
          target: { kind: "session", sessionId: targetSessionId },
          state: displaySettings,
        });
      }
      // This Session-scoped selection remains the Composer's next-normal-turn
      // default after admission, matching a persistent Model chooser. The
      // immutable captured object above still prevents a later click from
      // rewriting this already-admitted prompt.
      // HTTP acceptance can mean the prompt was queued, before Gate reaches its
      // dispatch boundary. First reconcile its Session-local admission even if
      // a refresh/navigation committed a newer pane while this response was in
      // flight. In particular, losing the old pane authority must never drop a
      // queue ID and strand a waiting local turn outside both Queue and history.
      // Only the later DOM/notice writes are pane-authority guarded.
      if (result.extension && protectedLocalTurn) {
        const pending = localUserTurnsRef.current.get(targetSessionId) || [];
        const remaining = removeLocalTurnAndRebase(pending, protectedLocalTurn);
        if (remaining.length)
          localUserTurnsRef.current.set(targetSessionId, remaining);
        else localUserTurnsRef.current.delete(targetSessionId);
        protectedLocalTurn = null;
      }
      const acceptedLocalTurn = localTurnEntry();
      if (acceptedLocalTurn && !result.steered) {
        const serverPromptId =
          typeof result.promptId === "string"
            ? result.promptId
            : result.queued && typeof result.id === "string"
              ? result.id
              : undefined;
        if (serverPromptId) {
          bindLocalTurnPromptIdentity(acceptedLocalTurn, { serverPromptId });
          recordUserTurnLifecycle("identity-bound", targetSessionId, acceptedLocalTurn, serverPromptId);
        }
      }
      const promptNavigationIsCurrent = Boolean(
        promptAuthority &&
        promptAuthority.navigationEpoch === navigationEpochRef.current &&
        viewedSessionIdRef.current === targetSessionId &&
        desiredSessionIdRef.current === targetSessionId,
      );
      // Bind the server queue ID as Session-scoped bookkeeping even when the
      // acknowledgement crossed navigation. Pane authority still fences the
      // visible projection below, but dropping this binding would strand an
      // accepted waiting turn without a recoverable queue identity.
      if (
        result.queued &&
        acceptedLocalTurn &&
        typeof result.id === "string"
      )
        markLocalTurnQueued(acceptedLocalTurn, result.id);
      const currentQueueProjection = latestQueueProjectionRef.current.get(
        targetSessionId,
      ) || { queue: [], paused: queuePaused };
      const acknowledgedTurn = localTurnEntry();
      const queuePlan = promptNavigationIsCurrent
        ? planAcknowledgedQueueProjection({
            incoming: result.queue,
            incomingPaused: queuePaused,
            currentRevision: queueProjectionRevisionRef.current.get(targetSessionId) || 0,
            requestRevision: promptQueueProjectionRevision,
            current: currentQueueProjection,
            source: queueProjectionSourceRef.current.get(targetSessionId),
            resultQueued: result.queued,
            resultId: typeof result.id === "string" ? result.id : undefined,
            acknowledgedTurnQueueId: acknowledgedTurn?.queueId,
            acknowledgedTurnQueueState: acknowledgedTurn?.queueState,
          })
        : undefined;
      const acknowledgedProjection = queuePlan
        ? queuePlan.accepted
          ? {
              ...acceptQueueProjection(
                targetSessionId,
                queuePlan.queue,
                queuePlan.paused,
                "ack",
              ),
              accepted: true,
            }
          : queuePlan
        : undefined;
      const acknowledgedQueue = acknowledgedProjection?.accepted
        ? acknowledgedProjection.queue
        : undefined;
      let promotedAcknowledgedTurns: LocalUserTurn[] = [];
      const acknowledgementKind = promptAcknowledgementKind(result);
      const acknowledgementTurnPlan = planAcknowledgedTurn({
        kind: acknowledgementKind,
        acceptedTurnPresent: Boolean(acceptedLocalTurn),
        resultId: typeof result.id === "string" ? result.id : undefined,
        currentQueue: latestQueueProjectionRef.current.get(targetSessionId)?.queue,
      });
      const acknowledgedSteer = pendingSteerFromAcknowledgement({
        steered: result.steered === true,
        queueState: acceptedLocalTurn?.queueState,
        queueId: acceptedLocalTurn?.queueId,
        message,
        imageCount: images.length,
        createdAt: Date.now(),
      });
      if (acknowledgedSteer) {
        syncPendingSteers(targetSessionId, [
          ...(pendingSteersRef.current.get(targetSessionId) || []),
          acknowledgedSteer,
        ]);
      } else if (acknowledgementTurnPlan.promoteFromQueue) {
        // Dispatch SSE may beat this acknowledgement. Never demote a turn that
        // the scheduler has already started into the waiting-only queue UI.
        // A newer complete queue projection can prove that this acknowledged
        // item has already left the FIFO even when queue_dispatch was lost.
        const currentProjection = latestQueueProjectionRef.current.get(targetSessionId);
        if (
          currentProjection &&
          !currentProjection.queue.some((item: any) => item.id === result.id)
        )
          promotedAcknowledgedTurns = promoteTurnsAbsentFromQueue(
            localUserTurnsRef.current.get(targetSessionId) || [],
            new Set(currentProjection.queue.map((item: any) => item.id)),
            false,
            true,
            cancellingQueueIdsRef.current.get(targetSessionId),
          );
      } else if (acknowledgementTurnPlan.markDispatched && acceptedLocalTurn) {
        acceptedLocalTurn.queueState = "dispatched";
      }
      if (acknowledgementKind !== "extension" && acknowledgementKind !== "steer" && acceptedLocalTurn) {
        const acceptedTurnTotal = acceptedLocalTurn.expectedTurnTotal;
        setSessions((current: any) =>
          current.map((session: any) =>
            session.id === targetSessionId &&
            acceptedTurnTotal > (session.turnCount || 0)
              ? { ...session, turnCount: acceptedTurnTotal }
              : session,
          ),
        );
      }
      const promotedAcknowledgedForPane = promptPaneIsCurrent()
        ? promotedAcknowledgedTurns.filter(
            (candidate: any) => !candidate.renderedInTranscript,
          )
        : [];
      for (const promoted of promotedAcknowledgedForPane)
        promoted.renderedInTranscript = true;
      // A prompt acknowledgement that crossed a real navigation boundary must
      // not schedule a background reconcile against the later pane. The later
      // A view owns its own authority and will reconcile the Session on entry;
      // allowing the stale chain to schedule here can retain a deferred React
      // update after unmount (and can repeatedly poll a stale test/consumer).
      if (targetSessionId && promotedAcknowledgedTurns.length && promptNavigationIsCurrent)
        requestPromptReconcileRef.current(targetSessionId);
      // A late acknowledgement is useful for Session reconciliation, but it
      // must not write into a later A pane after A → B → A. Queue state is
      // Session-owned: after a same-Session view commit (e.g. an SSE-driven
      // refresh snapshot taken before the acknowledgement) the ack is the only
      // authority and must restore the queue. After a real navigation the
      // newer view is authoritative, so the stale ack must stay inert.
      if (!promptPaneIsCurrent()) {
        reconcileStalePromptAcknowledgement({
          sessionId: targetSessionId,
          queued: result.queued === true,
          queue: acknowledgedQueue,
          queuePaused: acknowledgedProjection?.paused,
          navigationEpochMatches: promptAuthority?.navigationEpoch === navigationEpochRef.current,
          viewingSameSession: viewedSessionIdRef.current === targetSessionId,
          desiredSameSession: desiredSessionIdRef.current === targetSessionId,
          authority: promptAuthority,
          previousToolStatus,
        }, {
          patchSessionCache: patchSessionCacheForAuthority,
          capturePaneAuthority,
          commitPane: commitPaneIfCurrent,
          updateSidebarQueue: (sessionId: any, queue: any) => setSessions((current: any) => current.map((session: any) =>
            session.id === sessionId ? applySidebarQueueProjection(session, queue) : session,
          )),
          scheduleSidebarRefresh,
        });
        return;
      }
      if (reconcileSpecialPromptAcknowledgement({
        result,
        message,
        sessionId: targetSessionId,
        authority: promptAuthority!,
        gateModeFromCommand,
      }, {
        commitPane: commitPaneIfCurrent,
        protectLocalTurn: () => { protectLocalPrompt(localTurn); },
        updateGateMode,
        showNotice: setNotice,
        composerCommands,
        previousToolStatus,
        alreadyStreaming,
      })) {
        // Extension/Steer acknowledgement effects are host-driven; queue and
        // ordinary Prompt paths continue below.
      } else if (result.queued) {
        const queuedTurn = localTurnEntry();
        reconcileQueuedPromptAcknowledgement({
          sessionId: targetSessionId,
          authority: promptAuthority!,
          queuedTurn,
          acknowledgedQueue,
          acknowledgedPaused: acknowledgedProjection?.paused,
          promotedTurns: promotedAcknowledgedForPane,
          alreadyStreaming,
          previousToolStatus,
        }, {
          patchSessionCache: (sessionId: any, patch: any, authority: any) =>
            patchSessionCacheForAuthority(sessionId, patch, authority),
          commitPane: commitPaneIfCurrent,
          updateSidebarQueue: (sessionId: any, queue: any, paused: any) => {
            setSessions((current: any) => current.map((session: any) =>
              session.id === sessionId
                ? applySidebarQueueProjection(session, queue, paused)
                : session,
            ));
          },
          showNotice: setNotice,
        });
      } else {
        await reconcileOrdinaryPromptAcknowledgement({
          sessionId: targetSessionId,
          authority: promptAuthority!,
          eventVersionBefore: eventVersionBeforePrompt,
          eventVersionAfter: sessionEventVersionRef.current.get(targetSessionId) || 0,
          lastEventType: lastSessionEventTypeRef.current.get(targetSessionId),
          promptTerminalByEvent,
        }, {
          protectLocalTurn: () => { protectLocalPrompt(localTurn); },
          localTurnEntry,
          commitPane: commitPaneIfCurrent,
          fetchSessionView,
          currentEventVersion: (sessionId: any) => sessionEventVersionRef.current.get(sessionId) || 0,
          currentPaneAuthority: paneAuthorityCanCommit,
          applySessionView,
          queueRevision: (sessionId: any) => queueProjectionRevisionRef.current.get(sessionId) || 0,
          schedulePromptReconcile: requestPromptReconcileRef.current,
        });
        if (result.deliveryUncertain)
          setNotice("消息已交给 Pi，正在确认执行状态；请勿重复发送");
      }
    } catch (cause: any) {
      // Transport failure recovery has two ownership layers: the local admission
      // belongs to its Session even if a same-Session refresh committed a newer
      // pane while the request was in flight; only rendering/error presentation
      // belongs to a particular pane revision. Never strand a running-turn
      // admission as hidden `waiting` merely because its old pane token expired.
      const localEntry = localTurnEntry();
      const resultPending = resultPendingError(cause);
      // Whether this failure is definite is decided before anything is recorded:
      // a request that may still be executing must not leave a permanent failure
      // card under a running turn.
      const explicitClientRejection =
        cause instanceof ApiRequestError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        !resultPending;
      const failureClassification = classifyPromptFailure({
        resultPending,
        promptSubmitted,
        promptAcceptedByEvent,
        promptTerminalByEvent,
        explicitClientRejection,
        upstreamOutcomeUnknown:
          cause instanceof ApiRequestError && cause.outcomeUnknown,
      });
      const outcomeUnknown = failureClassification.outcomeUnknown;
      {
        // A failed upstream call never becomes an assistant message, so its reason
        // is kept in the transcript instead of only in the five-second toast.
        // Input validation stays a toast: the composer already explains it. A
        // steer keeps the composer's own surface, and a failure whose outcome is
        // unknown may still complete, so neither is recorded here.
        const failureText = cause instanceof Error ? cause.message : String(cause);
        const failureStatus = cause instanceof ApiRequestError ? cause.status : undefined;
        const failureCode = cause instanceof ApiRequestError ? cause.code : undefined;
        const scope = targetSessionId || (localDraftRef.current ? DRAFT_FAILURE_SCOPE : "");
        reconcilePromptFailureRecord({
          scope,
          message: failureText,
          status: failureStatus,
          code: failureCode,
          incidentId: cause instanceof ApiRequestError ? cause.incidentId : undefined,
          failureIsDefinite: failureClassification.failureIsDefinite,
          steering,
        }, {
          isTranscriptWorthyFailure,
          recordLocalFailure: (failureScope: any, message: any, incidentId: any) =>
            recordLocalFailure(failureScope, message, incidentId),
        });
      }
      if (shouldClearModelSelectionOnFailure(cause, modelUnavailableError)) {
        // The Runtime rejected this Model, so the staged selection can never be
        // applied to this Session by retrying the same prompt. Dropping it makes
        // the pane fall back to the Runtime-confirmed Model instead of failing
        // every later prompt the same way.
        pendingSessionPrefsRef.current.delete(targetSessionId || DRAFT_PREFS_KEY);
        saveSessionComposerSelections(pendingSessionPrefsRef.current);
        setComposerSelectionRevision((revision: any) => revision + 1);
      }
      const stoppedSteerRejection = authoritativeStoppedSteerRejection(
        cause,
        steering,
      );
      let rejectionMessages:
        PiMessage[] | ((current: PiMessage[]) => PiMessage[]) | undefined;
      const localTurnPlan = planPromptFailureLocalTurn({
        localEntry,
        pendingTurns: localUserTurnsRef.current.get(targetSessionId) || [],
        outcomeUnknown,
        steering,
      });
      if (localTurnPlan.retainAsDispatched && localEntry) {
        localEntry.queueState = "dispatched";
        rejectionMessages = (current: any) => appendLocalTurnOnce(current, localEntry);
        schedulePromptReconcile(targetSessionId);
      } else if (localTurnPlan.removeFromPending && localEntry) {
        const pending = localUserTurnsRef.current.get(targetSessionId) || [];
        const remaining = removeLocalTurnAndRebase(pending, localEntry);
        if (remaining.length) localUserTurnsRef.current.set(targetSessionId, remaining);
        else localUserTurnsRef.current.delete(targetSessionId);
        viewCacheWriter.forget(targetSessionId, promptAuthority || promptDraftAuthority!);
        if (localTurnPlan.renderedMessage)
          rejectionMessages = (current: any) => current.filter((candidate: any) => candidate !== localTurnPlan.renderedMessage);
      }
      // A stale A failure must never surface after A → B → A. A same-session
      // refresh is different: it only changes the pane revision, and must not
      // strand this Session-owned admission offscreen while reconciliation is
      // still pending.
      const sameSessionRefreshAuthority =
        promptAuthority &&
        promptAuthority.navigationEpoch === navigationEpochRef.current &&
        viewedSessionIdRef.current === targetSessionId &&
        desiredSessionIdRef.current === targetSessionId
          ? capturePaneAuthority(targetSessionId)
          : null;
      const failureAuthority =
        promptAuthority && paneAuthorityCanCommit(promptAuthority)
          ? promptAuthority
          : sameSessionRefreshAuthority;
      if (stoppedSteerRejection) {
        reconcileStoppedSteerFailure({
          sessionId: targetSessionId,
          authority: promptAuthority!,
        }, {
          setRunningOverride: (sessionId: any, running: any) => sessionRunningOverridesRef.current.set(sessionId, running),
          settleSidebar: (sessionId: any) => setSessions((current: any) => current.map((session: any) =>
            session.id === sessionId ? settleSidebarActivity(session) : session,
          )),
          patchStoppedSession: (sessionId: any, authority: any) => patchSessionCacheForAuthority(
            sessionId,
            { isStreaming: false, liveMessage: undefined, toolStatus: "", state: { isStreaming: false, isCompacting: false } },
            authority as SessionViewCommitAuthority,
          ),
          releasePromptBusy: (sessionId: any) => releasePromptBusy(sessionId, undefined, undefined, true),
          clearStopping: (sessionId: any) => clearStoppingForSession(sessionId),
        });
      }
      const visibleFailure = presentPromptFailure({
        sessionId: targetSessionId,
        paneAuthority: failureAuthority,
        draftAuthority: promptDraftAuthority,
        rejectionMessages,
        stoppedSteerRejection,
        stateStreaming: state.isStreaming,
        promptAcceptedByEvent,
        resultPending,
        causeMessage: cause instanceof Error ? cause.message : String(cause),
      }, {
        commitPane: commitPaneIfCurrent,
        commitDraft: commitDraftIfCurrent,
        scheduleSidebarRefresh,
        showNotice: setNotice,
        showError: setError,
      });
      if (visibleFailure && stoppedSteerRejection) {
        clearPendingLiveMessage();
        const requestVersion =
          sessionEventVersionRef.current.get(targetSessionId) || 0;
        const queueRequestRevision =
          queueProjectionRevisionRef.current.get(targetSessionId) || 0;
        const authority = capturePaneAuthority(targetSessionId);
        void fetchSessionView(targetSessionId)
          .then((view: any) => {
            if (
              (sessionEventVersionRef.current.get(targetSessionId) || 0) !==
              requestVersion
            )
              return;
            if (paneAuthorityCanCommit(authority))
              applySessionView(view, authority, queueRequestRevision);
            else commitSessionViewCache(view, authority);
          })
          .catch(() => undefined);
        scheduleSidebarRefresh();
      }
      // Rendering remains pane-authority guarded, but the editor-owned pump
      // must learn every definite rejection so it can retain the originating
      // scoped snapshot even when the user has navigated elsewhere.
      if (!outcomeUnknown) throw cause;
    } finally {
      if (promptOperationId && !serverPromptId)
        promptSubmitControllerRef.current.delete(promptOperationId);
      if (
        promptBusyRelease &&
        promptBusyReleasesRef.current.get(targetSessionId)?.release ===
          promptBusyRelease
      )
        promptBusyReleasesRef.current.delete(targetSessionId);
      finishSessionBusy();
    }
  }
  };
}
