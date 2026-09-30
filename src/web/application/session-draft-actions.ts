/** Browser-local New draft action; no Runtime/Session authority is created here. */
export function createNewDraft(host: Record<string, any>): void {
  if (host.buildIdentityMismatch()) return;
  const previousViewedSessionId = host.viewedSessionId();
  host.cancelPendingNavigation();
  host.rememberCurrentScroll();
  host.clearPendingScrollRestore();
  host.advanceNavigationEpoch();
  host.advanceRefreshEpoch();
  host.setViewSwitching(false);
  host.cancelDraftWorkspacePicker();
  host.clearPromptReconcileTimer();
  host.clearDraftPreferences();
  host.resetDraftComposer({
    model: host.currentModel(),
    thinkingLevel: host.currentThinkingLevel(),
    draftWorkspaceCwd: host.workspaceCwd(),
  });
  host.stickToBottom();
  host.setError("");
  host.setNotice("已新建独立会话");
  host.clearViewedPreviousSession(previousViewedSessionId);
}

/** Join a coalesced warm Runtime without transferring display authority. */
export function joinWarmRuntime(host: Record<string, any>, sessionId: string, authority: any): void {
  const warm = host.warmingRuntime(sessionId);
  if (!warm) return;
  void warm.then((ready: any) => {
    const state = host.applyWarmReadiness(sessionId, ready, authority, true);
    return state;
  }).catch((cause: unknown) => {
    if (!host.commitPaneIfCurrent(authority, { type: "RUNTIME_FAILED", sessionId })) return;
    host.setError(cause instanceof Error ? cause.message : String(cause));
  });
}
