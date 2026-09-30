import { api } from "../api";

export function createStreamErrorHandler(host: Record<string, any>) {
  return (source: EventSource): void => {
    source.close();
    if (host.currentLifecycle() === "restarting") {
      host.waitForHandoff();
      return;
    }
    host.setError("与 Pi Chat 服务的事件连接已断开，正在重新连接；当前任务状态待确认…");
    const retainedSessionId = host.viewedSessionId() || host.desiredSessionId();
    const retainedSession = retainedSessionId ? host.sessions().find((session: any) => session.id === retainedSessionId) : undefined;
    const retainedTurnActive = Boolean(retainedSession?.running || host.paneStreaming());
    host.recoveringConnection() || host.setRecoveringConnection(
      api.recoverConnection().then(() => {
        host.clearRecoveringConnection();
        host.advanceRunEpochGeneration();
        host.resetProcessProjection();
        host.resetInventory();
        host.setTransportRecoveryPending(true);
        host.retainSession(retainedSession, retainedTurnActive);
        host.resetAskAndTransientUi();
        host.setError("");
        host.bumpEventSourceGeneration();
        return Promise.resolve(host.refresh()).then(() => undefined);
      }).catch((cause: unknown) => {
        host.reportBackgroundRefreshError(cause);
        host.clearRecoveringConnection();
      }),
    );
  };
}

export function createOversizedEventHandler(host: Record<string, any>) {
  return (source: EventSource): void => {
    source.close();
    host.noteEventFrame();
    const count = host.incrementFloodCount();
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(count - 1, 5));
    host.clearReconnectTimer();
    void host.refresh().catch(host.reportBackgroundRefreshError);
    host.setReconnectTimer(window.setTimeout(() => {
      host.clearReconnectTimer();
      host.bumpEventSourceGeneration();
    }, delay));
  };
}
