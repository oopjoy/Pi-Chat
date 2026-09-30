import type { PromptDelivery, PromptImage, SessionViewData } from "../../shared/types";

export function createStopGeneration(host: Record<string, any>) {
  const {
    api,
    applySessionView,
    buildIdentityMismatch,
    captureViewOperation,
    clearStoppingForSession,
    commitPaneIfCurrent,
    commitSessionViewCache,
    fetchSessionView,
    patchSessionCacheForAuthority,
    queueProjectionForView,
    queueProjectionRevisionRef,
    scheduleSidebarRefresh,
    sessionEventVersionRef,
    sessionRunningOverridesRef,
    setError,
    setNotice,
    setSessions,
    setStoppingSessionIds,
    settleSidebarActivity,
    stoppingOperationTokensRef,
    subagentAddressesRef,
    viewOperationIsCurrent,
    viewOperationIsInCurrentRun,
    viewedSessionIdRef
  } = host;
    return async () => {{
    if (buildIdentityMismatch) return;
    // Child transcript identity is read-only. This guard is deliberately in
    // the mutation path as well as the renderer so a stale button/event cannot
    // abort a child Runtime or claim child control.
    if (subagentAddressesRef.current.has(viewedSessionIdRef.current)) return;
    const operation = captureViewOperation();
    if (stoppingOperationTokensRef.current.has(operation.sessionId)) return;
    const operationToken = Symbol("stop-generation");
    stoppingOperationTokensRef.current.set(operation.sessionId, operationToken);
    setStoppingSessionIds((current: any) =>
      current.includes(operation.sessionId)
        ? current
        : [...current, operation.sessionId],
    );
    setError("");
    let abortPending = false;
    try {
      const result = await api.abort(operation.sessionId);
      if (!viewOperationIsInCurrentRun(operation)) return;
      if (result.abortPending) {
        abortPending = true;
        commitPaneIfCurrent(operation, {
          type: "PROMPT_PREPARING",
          target: { kind: "session", sessionId: operation.sessionId },
          status: "已发送停止请求，正在等待当前操作结束…",
        });
        setNotice("已发送停止请求，Pi 正在结束当前操作");
        return;
      }
      patchSessionCacheForAuthority(
        operation.sessionId,
        {
          state: { isStreaming: result.isStreaming },
          isStreaming: result.isStreaming,
          queuePaused: result.queuePaused,
          ...(result.isStreaming
            ? null
            : { liveMessage: undefined, toolStatus: "" }),
        },
        operation,
      );
      if (!result.isStreaming) {
        clearStoppingForSession(operation.sessionId, operationToken);
        sessionRunningOverridesRef.current.set(operation.sessionId, false);
        setSessions((current: any) =>
          current.map((session: any) =>
            session.id === operation.sessionId
              ? settleSidebarActivity(session)
              : session,
          ),
        );
      }
      if (
        !commitPaneIfCurrent(operation, {
          type: "STOP_COMPLETED",
          sessionId: operation.sessionId,
          isStreaming: result.isStreaming,
          queuePaused: result.queuePaused,
        })
      )
        return;
      if (!result.isStreaming) {
        // Never await full bootstrap/refresh here: while the worker is still
        // draining after abort, get_messages/bootstrap can hang for the full
        // API timeout and leave the UI stuck on "停止中…".
        scheduleSidebarRefresh();
        const requestVersion =
          sessionEventVersionRef.current.get(operation.sessionId) || 0;
        const queueRequestRevision =
          queueProjectionRevisionRef.current.get(operation.sessionId) || 0;
        void fetchSessionView(operation.sessionId)
          .then((view: any) => {
            if (
              viewOperationIsCurrent(operation) &&
              (sessionEventVersionRef.current.get(operation.sessionId) || 0) ===
                requestVersion
            )
              applySessionView(view, operation, queueRequestRevision);
            else {
              const projection = queueProjectionForView(
                operation.sessionId,
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
                operation,
              );
            }
          })
          .catch(() => undefined);
      }
      setNotice(
        result.queuePaused
          ? "已停止；队列保持暂停，可撤销或继续"
          : "已停止生成",
      );
    } catch (cause: any) {
      if (viewOperationIsCurrent(operation))
        setError(cause instanceof Error ? cause.message : String(cause));
      if (viewOperationIsCurrent(operation)) throw cause;
    } finally {
      if (!abortPending && viewOperationIsInCurrentRun(operation))
        clearStoppingForSession(operation.sessionId, operationToken);
    }
  }
  };
}
