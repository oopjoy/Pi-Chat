export function refreshFailureKeepsCommittedView(cause: unknown, viewedSessionId: string): boolean {
  return Boolean(viewedSessionId) && (!(cause instanceof Error) || !cause.message.includes("会话不存在"));
}

/**
 * Session navigation is read-only. A prompt may be preparing a Runtime for the
 * current Session, but that must never trap the user in that Session: the next
 * click changes the navigation epoch and late prompt work is routed to its own
 * pane cache instead of repainting the destination.
 */
export function sidebarNavigationBlocked(loading: boolean, lifecycleBlocked: boolean): boolean {
  return loading || lifecycleBlocked;
}
