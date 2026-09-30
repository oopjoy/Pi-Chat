import type { BootstrapData, SessionViewData } from "../../shared/types";
import { api } from "../api";
import { applySidebarQueueProjection } from "./session-summary-reconciliation";
import { refreshFailureKeepsCommittedView } from "../lib/refresh-navigation-guards";

function bootstrapNeedsHistoryRecovery(data: BootstrapData, activeSessionId: string): boolean {
  if (!activeSessionId || data.messages.length) return false;
  const summary = data.sessions.find((session) => session.id === activeSessionId);
  const preview = summary?.preview?.trim() || "";
  const summaryHasContent = Boolean(preview && preview !== "新对话" && preview !== "尚未发送消息");
  return Boolean(
    (data.messageTotal ?? 0) > 0
    || (data.turnTotal ?? 0) > 0
    || (data.state.messageCount ?? 0) > 0
    || (summary?.turnCount ?? 0) > 0
    || summaryHasContent,
  );
}

/** App-owned refs and projection writers are supplied by ports, never copied. */
export function createSessionBootstrapFlow(host: Record<string, any>) {
  return async function refresh(): Promise<void> {
    const refreshAuthority = host.captureRefreshAuthority();
    const { refreshEpoch, runEpochGeneration } = refreshAuthority;
    const wantedId = host.desiredSessionId() || host.viewedSessionId() || host.rememberedSessionId();
    if (wantedId && !host.desiredSessionId()) host.setDesiredSessionId(wantedId);
    const requestVersion = wantedId ? host.sessionEventVersion(wantedId) : 0;
    const wantedQueueRequestRevision = wantedId ? host.queueProjectionRevision(wantedId) : 0;
    const queueRevisionSnapshot = host.queueRevisionSnapshot();
    const bootstrapAuthority = wantedId ? host.capturePaneAuthority(wantedId) : undefined;
    let earlyViewRequest: Promise<SessionViewData> | null = null;
    let earlyViewAuthority: any = null;
    let earlyViewTimer: number | null = null;
    let earlySidebarInventoryTimer: number | null = null;
    let bootstrapSucceeded = false;
    const startEarlyHistoryView = () => {
      const currentInitialHistory = host.initialHistory();
      if (
        !host.refreshAuthorityIsCurrent(refreshAuthority)
        || bootstrapSucceeded
        || !wantedId
        || host.viewedSessionId()
        || host.hasLocalDraft()
        || (currentInitialHistory?.id === wantedId
          && currentInitialHistory.refreshEpoch === refreshEpoch
          && currentInitialHistory.runEpochGeneration === runEpochGeneration)
      ) return;
      host.setDesiredSessionId(wantedId);
      earlyViewAuthority = host.capturePaneAuthority(wantedId);
      const requestQueueRevision = host.queueProjectionRevision(wantedId);
      const request = host.ensureHandshake(refreshEpoch, runEpochGeneration)
        .then((accepted: boolean) => {
          if (!accepted) throw new Error("stale handshake");
          return host.fetchSessionView(wantedId);
        })
        .finally(() => {
          if (host.initialHistory()?.request === request) host.clearInitialHistory();
        });
      host.setInitialHistory({ id: wantedId, refreshEpoch, runEpochGeneration, request });
      earlyViewRequest = request;
      void request.then((view: SessionViewData) => {
        if (
          !host.refreshAuthorityIsCurrent(refreshAuthority)
          || host.desiredSessionId() !== wantedId
          || host.hasLocalDraft()
          || host.confirmedDeleted().has(wantedId)
          || !earlyViewAuthority
          || !host.paneAuthorityCanCommit(earlyViewAuthority)
        ) return;
        host.applySessionView(view, earlyViewAuthority, requestQueueRevision);
      }).catch(() => undefined);
    };
    const bootstrapRequest = host.loadBootstrap(refreshAuthority);
    if (wantedId && !host.viewedSessionId() && !host.hasLocalDraft())
      earlyViewTimer = window.setTimeout(startEarlyHistoryView, host.earlyHistoryDelayMs());
    earlySidebarInventoryTimer = window.setTimeout(() => {
      if (bootstrapSucceeded || host.sidebarInventoryReady()) return;
      void api.sessions(host.showAllSessions(), [], true).then((result) => {
        if (host.refreshEpoch() !== refreshEpoch || host.runEpochGeneration() !== runEpochGeneration || bootstrapSucceeded) return;
        host.applySidebarInventory({ sessions: result.sessions, sessionsTotal: result.total, sessionDirectories: result.directories });
      }).catch(() => undefined);
    }, host.earlySidebarDelayMs());
    let data: BootstrapData;
    try { data = await bootstrapRequest; }
    catch (cause) {
      if (!host.refreshAuthorityIsCurrent(refreshAuthority)) return;
      throw cause;
    }
    if (!host.refreshAuthorityIsCurrent(refreshAuthority)) {
      host.recordBootstrapRejected("stale-refresh-authority");
      return;
    }
    bootstrapSucceeded = true;
    host.markBootstrapCompleted();
    if (earlyViewTimer !== null) window.clearTimeout(earlyViewTimer);
    if (earlySidebarInventoryTimer !== null) window.clearTimeout(earlySidebarInventoryTimer);
    if (wantedId && host.viewedSessionId() === wantedId && host.sessionEventVersion(wantedId) !== requestVersion) {
      host.applyBootstrapMetadata(data, refreshAuthority);
      return;
    }
    if (host.hasLocalDraft()) {
      const activeQueueSessionId = data.activeSessionId || data.sessions.find((session) => session.active)?.id || "";
      const projection = activeQueueSessionId
        ? host.acceptQueueProjectionIfCurrent(activeQueueSessionId, queueRevisionSnapshot.get(activeQueueSessionId) || 0, data.queue, data.queuePaused)
        : { queue: data.queue, paused: data.queuePaused };
      const filteredData = activeQueueSessionId
        ? {
            ...data,
            sessions: data.sessions.map((session) => session.id === activeQueueSessionId
              ? applySidebarQueueProjection(session, projection.queue, projection.paused)
              : session),
            queue: projection.queue,
          }
        : data;
      host.applyBootstrapMetadata(filteredData, refreshAuthority);
      host.confirmPrimaryCapabilitySnapshot(data, host.paneModel(), refreshAuthority);
      host.clearRecoverableError();
      return;
    }
    const activeId = data.activeSessionId || data.sessions.find((session) => session.active)?.id || "";
    if (wantedId && wantedId !== activeId) {
      if (activeId) {
        const projection = host.acceptQueueProjectionIfCurrent(activeId, queueRevisionSnapshot.get(activeId) || 0, data.queue, data.queuePaused);
        data = {
          ...data,
          sessions: data.sessions.map((session) => session.id === activeId
            ? applySidebarQueueProjection(session, projection.queue, projection.paused)
            : session),
          queue: projection.queue,
          queuePaused: projection.paused,
        };
      }
      host.setDesiredSessionId(wantedId);
      try {
        const viewVersion = host.sessionEventVersion(wantedId);
        const viewAuthority = earlyViewAuthority || host.capturePaneAuthority(wantedId);
        const view = await (earlyViewRequest || host.fetchSessionView(wantedId));
        if (!host.refreshAuthorityIsCurrent(refreshAuthority) || host.desiredSessionId() !== wantedId || !host.paneAuthorityCanCommit(viewAuthority)) return;
        if (host.sessionEventVersion(wantedId) !== viewVersion) {
          host.applyBootstrapMetadata(data, refreshAuthority);
          if (host.viewedSessionId() === wantedId)
            host.schedulePromptReconcile(wantedId, host.sessionEventVersion(wantedId));
          return;
        }
        host.applyBootstrapMetadata(data, refreshAuthority);
        host.applySessionView(view, viewAuthority, wantedQueueRequestRevision);
        host.clearRecoverableError();
        return;
      } catch (cause) {
        if (!host.refreshAuthorityIsCurrent(refreshAuthority)) return;
        if (refreshFailureKeepsCommittedView(cause, host.viewedSessionId())) {
          host.applyBootstrapMetadata(data, refreshAuthority);
          throw cause;
        }
        if (!(cause instanceof Error) || !cause.message.includes("会话不存在")) {
          host.applyBootstrap(data, bootstrapAuthority, wantedQueueRequestRevision, refreshAuthority);
          throw cause;
        }
        host.setDesiredSessionId(activeId);
      }
    }
    if (bootstrapNeedsHistoryRecovery(data, activeId)) {
      host.setDesiredSessionId(activeId);
      const historyAuthority = bootstrapAuthority?.sessionId === activeId ? bootstrapAuthority : host.capturePaneAuthority(activeId);
      const historyVersion = host.sessionEventVersion(activeId);
      const historyQueueRequestRevision = host.queueProjectionRevision(activeId);
      try {
        const view = await host.fetchSessionView(activeId);
        if (!host.refreshAuthorityIsCurrent(refreshAuthority)
          || host.desiredSessionId() !== activeId
          || host.sessionEventVersion(activeId) !== historyVersion
          || !host.paneAuthorityCanCommit(historyAuthority)) return;
        if (view.session.id !== activeId) throw new Error("已保存对话恢复结果与当前 Session 不一致");
        host.applyBootstrapMetadata(data, refreshAuthority);
        host.applySessionView(view, historyAuthority, historyQueueRequestRevision);
        if (view.historyPending || view.reconcilePending || view.isStreaming) host.requestPromptReconcile(activeId);
        host.clearRecoverableError();
        return;
      } catch {
        // Preserve metadata and paint a recoverable saved-Session state.
      }
      if (!host.refreshAuthorityIsCurrent(refreshAuthority)) return;
      host.applyBootstrap(data, historyAuthority, historyQueueRequestRevision, refreshAuthority);
      host.clearRecoverableError();
      return;
    }
    host.applyBootstrap(data, bootstrapAuthority, wantedQueueRequestRevision, refreshAuthority);
    host.clearRecoverableError();
  };
}
