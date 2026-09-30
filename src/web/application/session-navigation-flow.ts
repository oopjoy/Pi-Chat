import type { SessionSummary, SessionViewData } from "../../shared/types";
import type { SessionViewSnapshot } from "../lib/session-view-cache";
import { ApiRequestError } from "../api";

/**
 * Navigation orchestration owns no React, Pane, Cache, Queue, or Runtime state.
 * The host ports below are the existing App authorities, deliberately passed in
 * per invocation so A→B→A and process-replacement fences stay in App.
 */
export type SessionNavigationFlowHost = Record<string, any>;

export function createSessionNavigationFlow(host: SessionNavigationFlowHost) {
  return async function viewSession(id: string, navigationName?: string): Promise<void> {
    if (host.confirmedDeleted().has(id)) return;
    if (id === host.viewedSessionId() && host.desiredSessionId() === id) return;
    if (host.unseenReplyIds().includes(id)) host.consumeUnseenReply(id);

    const leavingId = host.viewedSessionId();
    const pendingLeavingLive = host.drainPendingLiveMessage();
    if (leavingId && pendingLeavingLive)
      host.updateLiveSessionCache(leavingId, pendingLeavingLive.message);
    const leavingSession = host.sessions().find((session: SessionSummary) => session.id === leavingId);
    if (leavingId && leavingSession && !host.hasLocalDraft()) {
      host.refreshSessionCache(leavingId, {
        session: leavingSession,
        state: host.currentState(),
        isActive: host.activeSessionIds().includes(leavingId),
        runtimeStatus: host.currentRuntimeStatus() === "draft" ? "active" : host.currentRuntimeStatus(),
        isStreaming: host.currentState().isStreaming,
        liveMessage: host.currentLiveMessage() || undefined,
        toolStatus: host.currentToolStatus(),
        stats: host.currentStats(),
        queue: host.currentQueue(),
        queuePaused: host.currentQueuePaused(),
        commands: host.currentCommands(),
        pendingExtensionRequest: host.currentExtensionRequest() || undefined,
        ...(host.gateAvailableOverride() !== null ? { gateAvailable: host.gateAvailableOverride() } : null),
        ...host.currentViewControl(),
      });
    }
    host.rememberCurrentScroll();
    const rememberedTurns = host.scrollTurns(id);
    host.cancelPendingNavigation(false);
    host.abortLoadingEarlierRequests();
    const navigation = host.beginNavigation(id, window.performance.now());
    const { epoch, controller } = navigation;
    host.setScrollMemoryFence({ epoch, targetSessionId: id });
    const navigationAuthority = host.capturePaneAuthority(id);
    host.setViewSwitching(true);
    host.setError("");

    const cached = host.withLatestQueueProjection(host.cachedView(id));
    const cachedTurns = cached?.visibleTurnCount ?? cached?.turnTotal ?? 0;
    if (cached && (!rememberedTurns || cachedTurns >= rememberedTurns)) {
      if (host.navigationEpoch() !== epoch || host.desiredSessionId() !== id) return;
      host.setPendingScrollRestore(id);
      host.recordPaneCommit({ ...cached, viewSource: "browser-cache" });
      host.applySessionView({ ...cached, viewSource: "browser-cache" }, navigationAuthority);
      const reconcileAuthority = host.capturePaneAuthority(id);
      host.joinWarmPane(id, reconcileAuthority);
      host.setViewSwitching(false);
      const needsReconcile = Boolean(
        cached.historyPending
        || cached.reconcilePending
        || cached.isStreaming
        || cached.runtimeStatus === "active"
        || Date.now() - cached.cachedAt >= 15_000,
      );
      if (!needsReconcile) return;
      const requestVersion = host.sessionEventVersion(id);
      const queueRequestRevision = host.queueProjectionRevision(id);
      void host.fetchSessionView(id, rememberedTurns, { signal: controller.signal })
        .then((view: SessionViewData) => {
          if (host.confirmedDeleted().has(id)) {
            host.recordRejectedView(id, "session-deleted");
            return;
          }
          if (!host.paneAuthorityCanCommit(reconcileAuthority)) {
            host.recordRejectedView(id, "stale-pane-authority");
            return;
          }
          if (host.sessionEventVersion(id) !== requestVersion) {
            host.schedulePromptReconcile(id, host.sessionEventVersion(id));
            return;
          }
          const reconciledView = host.acceptAuthoritativeIdleSessionView(view);
          if (!reconciledView.messages.length && cached.messages.length) {
            const projection = Array.isArray(reconciledView.queue)
              ? host.acceptQueueProjectionIfCurrent(
                  id,
                  queueRequestRevision,
                  reconciledView.queue,
                  reconciledView.queuePaused === true,
                )
              : undefined;
            const patched = host.refreshSessionCacheForAuthority(
              id,
              projection
                ? { ...reconciledView, queue: projection.queue, queuePaused: projection.paused }
                : (() => {
                    const { queue: _unknownQueue, queuePaused: _unknownPaused, ...withoutQueueAuthority } = reconciledView;
                    return withoutQueueAuthority;
                  })(),
              reconcileAuthority,
            );
            if (patched)
              host.applySessionView(patched, reconcileAuthority, host.queueProjectionRevision(id));
          } else host.applySessionView(reconciledView, reconcileAuthority, queueRequestRevision);
        })
        .catch(() => undefined);
      return;
    }

    host.setPaneLoading({
      sessionId: id,
      name: navigationName || host.sessions().find((session: SessionSummary) => session.id === id)?.name || "对话",
    });
    try {
      const queueRequestRevision = host.queueProjectionRevision(id);
      const requestStartRevision = host.viewCacheRevision(id);
      const hot = host.activeSessionIds().includes(id);
      let view: SessionViewData;
      try {
        view = await host.fetchSessionView(id, rememberedTurns, { fast: hot, signal: controller.signal });
      } catch (cause) {
        if (!(cause instanceof ApiRequestError) || cause.code !== "HOT_VIEW_UNAVAILABLE") throw cause;
        view = await host.fetchSessionView(id, rememberedTurns, { signal: controller.signal });
      }
      if (host.confirmedDeleted().has(id)) {
        host.recordRejectedView(id, "session-deleted");
        return;
      }
      if (!host.paneAuthorityCanCommit(navigationAuthority)) {
        host.recordRejectedView(id, "stale-pane-authority");
        return;
      }
      host.setPendingScrollRestore(id);
      const committed = host.mergeNavigationView(view, requestStartRevision, navigationAuthority);
      if (!committed) return;
      host.applySessionView(committed, navigationAuthority, queueRequestRevision);
      host.joinWarmPane(id, host.capturePaneAuthority(id));
      if (
        !host.isSubagent(id)
        && (view.historyPending || view.reconcilePending || view.isStreaming)
        && host.viewedSessionId() === id
      ) host.schedulePromptReconcile(id);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        if (host.scrollMemoryFence()?.epoch === epoch) host.clearScrollMemoryFence();
        return;
      }
      if (host.navigationEpoch() === epoch) {
        host.clearNavigationStartedAt(epoch);
        host.setPaneLoading(null);
        host.setDesiredSessionId(host.viewedSessionId());
        host.setError(cause instanceof Error ? cause.message : String(cause));
        if (host.scrollMemoryFence()?.epoch === epoch) host.clearScrollMemoryFence();
      }
    } finally {
      host.finishNavigation(epoch, controller);
      if (host.navigationEpoch() === epoch) host.setViewSwitching(false);
    }
  };
}
