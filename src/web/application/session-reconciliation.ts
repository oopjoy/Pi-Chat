import type { SessionViewData } from "../../shared/types";

/** A view is terminal only when every live/runtime fact is idle. */
export function sessionViewConfirmsIdle(view: SessionViewData): boolean {
  return view.isStreaming !== true
    && view.state.isStreaming !== true
    && view.session.running !== true
    && !view.liveMessage
    && !view.toolStatus;
}

/**
 * Pure terminal reconciliation for a fresh Session view. Browser-owned sidebar
 * overrides and cache writes remain in App; this function only derives the
 * authoritative view shape and never owns Session state.
 */
export function reconcileIdleSessionView(view: SessionViewData): SessionViewData {
  if (!sessionViewConfirmsIdle(view)) return view;
  return {
    ...view,
    session: {
      ...view.session,
      running: false,
      activity: view.session.activity
        ? (() => {
            const { runStartedAt: _runStartedAt, ...withoutRunStart } = view.session.activity!;
            return {
              ...withoutRunStart,
              execution: "idle" as const,
              awaitingConfirmation: false,
            };
          })()
        : view.session.activity,
    },
    isStreaming: false,
    liveMessage: undefined,
    queuePaused: Array.isArray(view.queue)
      ? view.queue.length > 0 && view.queuePaused === true
      : view.queuePaused,
    toolStatus: "",
    state: { ...view.state, isStreaming: false },
  };
}
