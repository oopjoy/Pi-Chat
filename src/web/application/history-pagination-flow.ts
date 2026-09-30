import { ApiRequestError } from "../api";
import type { SessionViewData } from "../../shared/types";

export function createHistoryPaginationFlow(host: Record<string, any>) {
  return async function loadEarlierTurns(): Promise<void> {
    const id = host.viewedSessionId();
    const navigationEpoch = host.navigationEpoch();
    const authority = host.capturePaneAuthority(id);
    const existingRequest = host.loadingRequest(id);
    if (!id || !host.messagesTruncated() || existingRequest?.navigationEpoch === navigationEpoch) return;
    const timeline = host.scrollElement();
    const previousHeight = timeline?.scrollHeight || 0;
    const requestedTurns = Math.min(10_000, host.visibleTurnCount() + 10);
    const requestToken = Symbol(id);
    const controller = new AbortController();
    host.setLoadingRequest(id, { token: requestToken, navigationEpoch, controller });
    host.bumpLoadingRevision();
    host.setError("");
    host.setStickToBottom(false);
    try {
      const requestVersion = host.sessionEventVersion(id);
      const queueRequestRevision = host.queueProjectionRevision(id);
      const requestStartRevision = host.viewCacheRevision(id);
      let view: SessionViewData;
      try {
        view = await host.fetchSessionView(id, requestedTurns, { fast: true, signal: controller.signal });
        const visible = view.visibleTurnCount ?? 0;
        if (view.historyPending || (view.turnTotal ?? 0) < host.turnTotal() || (view.messagesTruncated && visible <= host.visibleTurnCount()))
          throw new ApiRequestError("热会话历史尚未就绪", 409, "HOT_VIEW_UNAVAILABLE");
      } catch (cause) {
        if (!(cause instanceof ApiRequestError) || cause.code !== "HOT_VIEW_UNAVAILABLE") throw cause;
        view = await host.fetchSessionView(id, requestedTurns, { signal: controller.signal });
      }
      if (!host.paneAuthorityCanCommit(authority)) {
        host.recordRejected(id, "stale-pane-authority");
        return;
      }
      const eventVersion = host.sessionEventVersion(id);
      const loadedView = eventVersion === requestVersion
        ? view
        : host.mergeNavigationView(view, requestStartRevision, authority);
      if (!loadedView) return;
      host.applySessionView(loadedView, authority, queueRequestRevision);
      requestAnimationFrame(() => {
        if (!host.paneAuthorityCanCommit(authority)) return;
        const element = host.scrollElement();
        if (element) element.scrollTop = Math.max(0, element.scrollHeight - previousHeight);
      });
    } catch (cause) {
      const currentRequest = host.loadingRequest(id);
      if (!controller.signal.aborted && currentRequest?.token === requestToken && currentRequest.navigationEpoch === navigationEpoch && host.paneAuthorityCanCommit(authority))
        host.setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (host.loadingRequest(id)?.token === requestToken) {
        host.deleteLoadingRequest(id);
        host.bumpLoadingRevision();
      }
    }
  };
}
