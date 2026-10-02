import type { GateMode } from "../lib/gate-mode";
import type { PromptDelivery, PromptImage, PiMessage, PiState, QueuedPrompt, ModelInfo } from "../../shared/types";
import type { DraftPaneAuthority, PaneAuthoritySnapshot } from "../application/pane-authority";
import type { LocalUserTurn } from "../lib/local-user-turn";
import type { RefObject } from "react";
import type { ActiveSessionViewAuthority } from "./active-session-projection-writer";
import { handlePromptSendFailure, type PromptFailureStageHost } from "./prompt-send-failure-stage";
import { reconcilePromptAcknowledgement, type PromptAcknowledgementStageHost } from "./prompt-acknowledgement-stage";
import { preparePromptRuntime, type PromptPreparationStageHost } from "./prompt-preparation-stage";

type PromptViewAuthority = PaneAuthoritySnapshot & ActiveSessionViewAuthority;

export type PromptSendFlowHost = PromptPreparationStageHost
  & PromptAcknowledgementStageHost
  & PromptFailureStageHost
  & {
    LOCAL_DRAFT_BUSY_ID: string;
    authoritativeTurnTotal: (sessionId: string) => number | undefined;
    beginSessionBusy: (sessionId: string) => () => void;
    buildIdentityMismatch: boolean;
    buildProtectedLocalTurn: typeof import("./prompt-submit-flow").buildProtectedLocalTurn;
    captureViewOperation: () => PromptViewAuthority;
    createSession: () => void;
    displayedQueue: QueuedPrompt[];
    gateModesRef: RefObject<Record<string, GateMode>>;
    messages: PiMessage[];
    modelInventoryConfirmed: boolean;
    models: ModelInfo[];
    pendingGateModesRef: RefObject<Map<string, GateMode>>;
    promptPreparationRoute: typeof import("./prompt-submit-flow").promptPreparationRoute;
    queuePaused: boolean;
    promptBusyReleasesRef: RefObject<Map<string, { epoch: string; afterGeneration: number; release: () => void; markAccepted: () => void; markTerminal: () => void }>>;
    promptSubmitFlowRef: RefObject<import("./prompt-submit-flow").PromptSubmitFlow>;
    queueProjectionForView: (sessionId: string, incoming: QueuedPrompt[] | undefined, paused: boolean, requestRevision?: number) => { queue: QueuedPrompt[]; paused: boolean; known: boolean; accepted?: boolean };
    refresh: () => Promise<void>;
    runEpochGenerationRef: RefObject<number>;
    runEpochRef: RefObject<string>;
    runtimeStatus: string;
    state: PiState;
    stickToBottomRef: RefObject<boolean>;
    stopGeneration: () => Promise<void>;
    toolStatus: string;
    turnTotal: number;
    userMessage: typeof import("../lib/pi-events").userMessage;
    viewOperationIsCurrent: (operation: PromptViewAuthority) => boolean;
    viewOperationIsInCurrentRun: (operation: PromptViewAuthority) => boolean;
    viewedSessionId: string;
  };

/**
 * Browser Prompt transaction adapter. App remains the authority owner; this
 * module receives a single explicit host boundary and does not retain state.
 */
export function createPromptSendFlow<THost extends PromptSendFlowHost>(host: THost) {
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
    requestedTargetSessionId: string = "",
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
    const protectLocalPrompt = (
      turn: PiMessage | null = localTurn,
      sessionOverride = targetSessionId,
    ) => {
      const promptTargetSessionId = sessionOverride;
      // A child transcript never receives optimistic parent turns, queue rows,
      // or Runtime projections. The server remains the sole parent authority
      // until that parent is explicitly viewed.
      const pending = localUserTurnsRef.current.get(promptTargetSessionId) || [];
      const nextLocalTurn = buildProtectedLocalTurn({
        turn,
        targetSessionId: promptTargetSessionId,
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
        baselineTurnTotal: authoritativeTurnTotal(promptTargetSessionId),
      });
      if (!nextLocalTurn) return protectedLocalTurn;
      protectedLocalTurn = nextLocalTurn;
      localUserTurnsRef.current.set(promptTargetSessionId, [
        ...pending,
        nextLocalTurn,
      ]);
      recordUserTurnLifecycle("optimistic-created", promptTargetSessionId, nextLocalTurn);
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

      const preparationHost: PromptPreparationStageHost = {
        ...host,
        moveSessionBusyTo,
      };
      const preparation = await preparePromptRuntime(
        preparationHost,
        {
          alreadyStreaming,
          images,
          localDraftRef,
          message,
          modelInventoryConfirmed,
          models,
          moveSessionBusyTo,
          navigationEpochRef,
          pendingGateModesRef,
          pendingSessionPrefsRef,
          promptAuthority,
          promptDraftAuthority,
          promptOperationId,
          promptOperationIsInCurrentRun,
          promptPreparationRoute,
          promptQueueProjectionRevision,
          promptSubmitted,
          protectLocalPrompt,
          runEpochRef,
          runtimeStatus,
          steering,
          targetSessionId,
        },
      );
      if (!preparation) return;
      const {
        capturedDraftGateMode,
        capturedPromptSettings,
        capturedSelection,
        initialPromptResult,
      } = preparation;
      serverPromptId = preparation.serverPromptId;
      targetSessionId = preparation.targetSessionId;
      promptAuthority = preparation.promptAuthority;
      promptDraftAuthority = preparation.promptDraftAuthority;
      promptQueueProjectionRevision = preparation.promptQueueProjectionRevision;
      promptSubmitted = preparation.promptSubmitted;
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
      const acknowledgementHost: PromptAcknowledgementStageHost = host;
      const acknowledgement = await reconcilePromptAcknowledgement(
        acknowledgementHost,
        {
          alreadyStreaming,
          capturedSelection,
          eventVersionBeforePrompt,
          images,
          localTurn,
          localTurnEntry,
          message,
          previousToolStatus,
          promptAuthority,
          promptOperationId,
          promptPaneIsCurrent,
          promptQueueProjectionRevision,
          promptTerminalByEvent,
          protectLocalPrompt,
          protectedLocalTurn,
          queuePaused,
          result,
          serverPromptId,
          steering,
          targetSessionId,
        },
      );
      protectedLocalTurn = acknowledgement.protectedLocalTurn;
      serverPromptId = acknowledgement.serverPromptId;
    } catch (cause: any) {
      const localEntry = localTurnEntry();
      const failureHost: PromptFailureStageHost & { paneState: { isStreaming: boolean } } = {
        ...host,
        paneState: state,
      };
      handlePromptSendFailure(
        failureHost,
        {
          cause,
          localEntry,
          promptAcceptedByEvent,
          promptAuthority,
          promptDraftAuthority,
          promptSubmitted,
          promptTerminalByEvent,
          steering,
          targetSessionId,
        },
      );
      /* Transport failure recovery is isolated in prompt-send-failure-stage. */
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
