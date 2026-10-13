import { ApiRequestError } from "../api";
import type { SessionHistoryPage, SessionViewData } from "../../shared/types";

export function createHistoryPaginationFlow(host: Record<string, any>) {
  return async function loadEarlierTurns(): Promise<void> {
    const id = host.viewedSessionId();
    const navigationEpoch = host.navigationEpoch();
    const authority = host.capturePaneAuthority(id);
    const existingRequest = host.loadingRequest(id);
    if (!id || !host.messagesTruncated() || existingRequest?.navigationEpoch === navigationEpoch) return;
    const timeline = host.scrollElement();
    const previousHeight = timeline?.scrollHeight || 0;
    // A byte-bounded window can end at e.g. 21 turns; the server still admits
    // only multiples of ten, so adding ten directly would send an invalid 31.
    const requestedTurns = Math.min(10_000, Math.ceil(host.visibleTurnCount() / 10) * 10 + 10);
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
      let paged = false;
      if (view.messagesTruncated && (view.visibleTurnCount ?? 0) <= host.visibleTurnCount()) {
        // Expanding the same tail cannot cross its byte budget. Seek strictly
        // before the displayed persisted boundary instead of retrying forever.
        const current: SessionViewData | undefined = host.currentView?.(id);
        const before = current?.messages.find(message => message.piChatPersistedMessageId)?.piChatPersistedMessageId;
        if (!before || !host.fetchHistoryPage) throw new Error("历史读取窗口未能扩展，请重新打开对话后重试");
        const page: SessionHistoryPage = await host.fetchHistoryPage(id, before, controller.signal);
        if (!host.paneAuthorityCanCommit(authority)) return;
        if (page.sessionId !== id || page.beforeMessageId !== before) throw new Error("历史响应与当前会话不匹配");
        const merged: SessionViewData | undefined = host.prependHistoryPage(page, authority);
        if (!merged) throw new Error("历史边界已变化，请重新打开对话后重试");
        view = merged;
        paged = true;
      }
      const eventVersion = host.sessionEventVersion(id);
      const loadedView = paged || eventVersion === requestVersion
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
