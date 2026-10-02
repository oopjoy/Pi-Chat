import type { PromptImage, PromptSettingsSnapshot, ModelInfo, SessionRuntimeReadyData } from "../../shared/types";
import type { DraftPaneAuthority, PaneAuthoritySnapshot } from "./pane-authority";

type Callback = (...args: any[]) => any;
type Ref<T> = { current: T };

export interface PromptPreparationStageHost {
  DRAFT_FAILURE_SCOPE: string;
  DRAFT_PREFS_KEY: string;
  WAITING_FOR_PI_STATUS: string;
  adoptDraftSessionView: Callback;
  api: { activateSession: Callback; compact: Callback; newSession: Callback; submitNewSession: Callback; prompt: Callback; };
  applySessionView: Callback;
  applyWarmReadinessForPane: Callback;
  captureDraftPaneAuthority: Callback;
  capturePaneAuthority: Callback;
  capturePromptSelection: Callback;
  clearViewedPromiseRef: Ref<any>;
  commitPaneIfCurrent: Callback;
  commitSessionViewCache: Callback;
  dispatchPane: Callback;
  draftAuthorityCanCommit: Callback;
  draftIntentAfterSubmit: Callback;
  draftWorkspaceCwd: string;
  forgetLocalFailuresForSession: Callback;
  paneAuthorityCanCommit: Callback;
  prepareRestoringPrompt: Callback;
  promptSubmitControllerRef: Ref<any>;
  queueProjectionRevisionRef: Ref<any>;
  saveSessionComposerSelections: Callback;
  sessionRunGenerationsRef: Ref<any>;
  setComposerSelectionRevision: Callback;
  setError: Callback;
  setLocalFailures: Callback;
  setPendingGateModes: Callback;
  submitNewDraftPrompt: Callback;
  validateSelectedRoute: Callback;
  warmSessionRuntime: Callback;
  workspaceCwd: string;
}

export interface PromptPreparationStageState {
  alreadyStreaming: boolean;
  images: PromptImage[];
  localDraftRef: Ref<any>;
  message: string;
  modelInventoryConfirmed: boolean;
  models: ModelInfo[];
  moveSessionBusyTo: Callback;
  navigationEpochRef: Ref<number>;
  pendingGateModesRef: Ref<Map<string, any>>;
  pendingSessionPrefsRef: Ref<Map<string, any>>;
  promptAuthority: PaneAuthoritySnapshot | null;
  promptDraftAuthority: DraftPaneAuthority | null;
  promptOperationId: string;
  promptOperationIsInCurrentRun: Callback;
  promptPreparationRoute: Callback;
  promptQueueProjectionRevision: number;
  promptSubmitted: boolean;
  protectLocalPrompt: Callback;
  runEpochRef: Ref<string>;
  runtimeStatus: string;
  steering: boolean;
  targetSessionId: string;
}

export interface PromptPreparationStageResult {
  capturedDraftGateMode: any;
  capturedPromptSettings: PromptSettingsSnapshot | undefined;
  capturedSelection: any;
  initialPromptResult: any;
  promptAuthority: PaneAuthoritySnapshot | null;
  promptDraftAuthority: DraftPaneAuthority | null;
  promptQueueProjectionRevision: number;
  promptSubmitted: boolean;
  serverPromptId: string | null;
  targetSessionId: string;
}

/** Captures immutable Composer intent and warms/restores the target Runtime. */
export async function preparePromptRuntime(
  host: PromptPreparationStageHost,
  input: PromptPreparationStageState,
): Promise<PromptPreparationStageResult | null> {
  const {
    DRAFT_FAILURE_SCOPE,
    DRAFT_PREFS_KEY,
    WAITING_FOR_PI_STATUS,
    adoptDraftSessionView,
    api,
    applySessionView,
    applyWarmReadinessForPane,
    captureDraftPaneAuthority,
    capturePaneAuthority,
    capturePromptSelection,
    clearViewedPromiseRef,
    commitPaneIfCurrent,
    commitSessionViewCache,
    dispatchPane,
    draftAuthorityCanCommit,
    draftIntentAfterSubmit,
    draftWorkspaceCwd,
    forgetLocalFailuresForSession,
    moveSessionBusyTo,
    paneAuthorityCanCommit,
    prepareRestoringPrompt,
    promptSubmitControllerRef,
    queueProjectionRevisionRef,
    saveSessionComposerSelections,
    sessionRunGenerationsRef,
    setComposerSelectionRevision,
    setError,
    setLocalFailures,
    setPendingGateModes,
    submitNewDraftPrompt,
    validateSelectedRoute,
    warmSessionRuntime,
    workspaceCwd,
    alreadyStreaming,
    images,
    localDraftRef,
    message,
    modelInventoryConfirmed,
    models,
    navigationEpochRef,
    pendingGateModesRef,
    pendingSessionPrefsRef,
    promptOperationId,
    promptOperationIsInCurrentRun,
    promptPreparationRoute,
    protectLocalPrompt,
    runEpochRef,
    runtimeStatus,
    steering,
  } = { ...host, ...input };
  let { promptAuthority, promptDraftAuthority, promptQueueProjectionRevision, promptSubmitted, targetSessionId } = input;
  let serverPromptId: string | null = null;
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
    let initialPromptResult: Awaited<ReturnType<typeof api.prompt>> | null =
      null;
    const stageResult = () => ({
      capturedDraftGateMode,
      capturedPromptSettings,
      capturedSelection,
      initialPromptResult,
      promptAuthority,
      promptDraftAuthority,
      promptQueueProjectionRevision,
      promptSubmitted,
      serverPromptId,
      targetSessionId,
    });
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
        return null;
      }
    }
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
      if (!promptOperationIsInCurrentRun()) return null;
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
      if (!promptOperationIsInCurrentRun()) return null;
      targetSessionId = initial.sessionId;
      if (initial.promptId) {
        serverPromptId = initial.promptId;
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
        promptSubmitControllerRef.current.bindServerPromptId(
          promptOperationId,
          initial.promptId,
        );
      }
      // The draft's own failure reason is resolved once its first message is
      // accepted; the Session that now exists keeps its own entries.
      setLocalFailures((current: any) => forgetLocalFailuresForSession(current, DRAFT_FAILURE_SCOPE));
      promptQueueProjectionRevision =
        queueProjectionRevisionRef.current.get(targetSessionId) || 0;
      moveSessionBusyTo(targetSessionId);
      protectLocalPrompt(undefined, targetSessionId);
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
        protectLocalTurn: () => { protectLocalPrompt(undefined, targetSessionId); },
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
      if (restoring.cancelled) return null;
    } else if (!alreadyStreaming && promptAuthority) {
      commitPaneIfCurrent(promptAuthority, {
        type: "PROMPT_PREPARING",
        target: { kind: "session", sessionId: targetSessionId },
        status: WAITING_FOR_PI_STATUS,
      });
    }

  return stageResult();
}
