import { ApiRequestError } from "../api";
import type { DraftPaneAuthority, PaneAuthoritySnapshot } from "./pane-authority";
import type { LocalUserTurn } from "../lib/local-user-turn";
import type { PiMessage } from "../../shared/types";

type Callback = (...args: any[]) => any;
type Ref<T> = { current: T };

export interface PromptFailureStageHost {
  ApiRequestError: typeof ApiRequestError;
  DRAFT_FAILURE_SCOPE: string;
  DRAFT_PREFS_KEY: string;
  appendLocalTurnOnce: Callback;
  authoritativeStoppedSteerRejection: Callback;
  applySessionView: Callback;
  classifyPromptFailure: Callback;
  queueProjectionRevisionRef: Ref<any>;
  resultPendingError: Callback;
  shouldClearModelSelectionOnFailure: Callback;
  capturePaneAuthority: Callback;
  clearPendingLiveMessage: Callback;
  clearStoppingForSession: Callback;
  commitDraftIfCurrent: Callback;
  commitPaneIfCurrent: Callback;
  commitSessionViewCache: Callback;
  desiredSessionIdRef: Ref<any>;
  fetchSessionView: Callback;
  isTranscriptWorthyFailure: Callback;
  localDraftRef: Ref<any>;
  localUserTurnsRef: Ref<any>;
  modelUnavailableError: Callback;
  navigationEpochRef: Ref<any>;
  paneAuthorityCanCommit: Callback;
  patchSessionCacheForAuthority: Callback;
  pendingSessionPrefsRef: Ref<any>;
  planPromptFailureLocalTurn: Callback;
  presentPromptFailure: Callback;
  reconcilePromptFailureRecord: Callback;
  reconcileStoppedSteerFailure: Callback;
  recordLocalFailure: Callback;
  releasePromptBusy: Callback;
  removeLocalTurnAndRebase: Callback;
  saveSessionComposerSelections: Callback;
  schedulePromptReconcile: Callback;
  scheduleSidebarRefresh: Callback;
  sessionEventVersionRef: Ref<any>;
  sessionRunningOverridesRef: Ref<any>;
  settleSidebarActivity: Callback;
  setComposerSelectionRevision: Callback;
  setError: Callback;
  setNotice: Callback;
  setSessions: Callback;
  viewCacheWriter: { forget: Callback };
  viewedSessionIdRef: Ref<any>;
}

export interface PromptFailureStageState {
  cause: unknown;
  localEntry: LocalUserTurn | undefined;
  promptAcceptedByEvent: boolean;
  promptAuthority: PaneAuthoritySnapshot | null;
  promptDraftAuthority: DraftPaneAuthority | null;
  promptSubmitted: boolean;
  promptTerminalByEvent: boolean;
  steering: boolean;
  targetSessionId: string;
}

/** Failure/uncertain-delivery stage for one browser Prompt transaction. */
export function handlePromptSendFailure(
  host: PromptFailureStageHost & { paneState: { isStreaming: boolean } },
  input: PromptFailureStageState,
): void {
  const {
    ApiRequestError,
    DRAFT_FAILURE_SCOPE,
    DRAFT_PREFS_KEY,
    appendLocalTurnOnce,
    authoritativeStoppedSteerRejection,
    applySessionView,
    capturePaneAuthority,
    classifyPromptFailure,
    clearPendingLiveMessage,
    clearStoppingForSession,
    commitDraftIfCurrent,
    commitPaneIfCurrent,
    commitSessionViewCache,
    desiredSessionIdRef,
    fetchSessionView,
    isTranscriptWorthyFailure,
    localDraftRef,
    localUserTurnsRef,
    modelUnavailableError,
    navigationEpochRef,
    paneAuthorityCanCommit,
    patchSessionCacheForAuthority,
    pendingSessionPrefsRef,
    planPromptFailureLocalTurn,
    presentPromptFailure,
    queueProjectionRevisionRef,
    reconcilePromptFailureRecord,
    reconcileStoppedSteerFailure,
    recordLocalFailure,
    releasePromptBusy,
    removeLocalTurnAndRebase,
    saveSessionComposerSelections,
    schedulePromptReconcile,
    scheduleSidebarRefresh,
    sessionEventVersionRef,
    resultPendingError,
    sessionRunningOverridesRef,
    settleSidebarActivity,
    shouldClearModelSelectionOnFailure,
    setComposerSelectionRevision,
    setError,
    setNotice,
    setSessions,
    paneState,
    viewCacheWriter,
    viewedSessionIdRef,
    cause,
    localEntry,
    promptAcceptedByEvent,
    promptAuthority,
    promptDraftAuthority,
    promptSubmitted,
    promptTerminalByEvent,
    steering,
    targetSessionId,
  } = { ...host, ...input };
    // Transport failure recovery has two ownership layers: the local admission
    // belongs to its Session even if a same-Session refresh committed a newer
    // pane while the request was in flight; only rendering/error presentation
    // belongs to a particular pane revision. Never strand a running-turn
    // admission as hidden `waiting` merely because its old pane token expired.
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
          authority as PaneAuthoritySnapshot,
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
      stateStreaming: paneState.isStreaming,
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
}
