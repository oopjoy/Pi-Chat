export function refreshFailureKeepsCommittedView(cause: unknown, viewedSessionId: string): boolean {
  return Boolean(viewedSessionId) && (!(cause instanceof Error) || !cause.message.includes("会话不存在"));
}

export function sidebarNavigationBlocked(loading: boolean, lifecycleBlocked: boolean, busy: boolean, viewedSessionIsListed: boolean): boolean {
  return loading || lifecycleBlocked || (busy && viewedSessionIsListed);
}
