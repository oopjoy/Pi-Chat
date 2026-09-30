export interface SessionNavigationActionDependencies {
  /** The existing App navigation transaction; it remains the authority owner. */
  navigate(sessionId: string, navigationName?: string): void;
  /** Forget only the child view projection before opening it. */
  forgetCurrent(sessionId: string): void;
  /** Verified direct-parent addresses retained by the App. */
  addresses: Map<string, { parentSessionId: string; label: string }>;
}

export interface SessionNavigationActions {
  openSubagentSession(parentSessionId: string, childSessionId: string, label: string): void;
  navigateSubagentAncestor(sessionId: string, label: string): void;
}

/**
 * Small navigation action boundary. It owns no navigation epoch, cache, or
 * address state; those remain in the supplied App-owned authorities. This is
 * intentionally the first safe slice before moving the larger viewSession
 * transaction.
 */
export function createSessionNavigationActions(
  dependencies: SessionNavigationActionDependencies,
): SessionNavigationActions {
  const { addresses, forgetCurrent, navigate } = dependencies;
  return {
    openSubagentSession(parentSessionId, childSessionId, label) {
      addresses.delete(childSessionId);
      addresses.set(childSessionId, { parentSessionId, label });
      while (addresses.size > 64) {
        const oldest = addresses.keys().next().value;
        if (typeof oldest !== "string") break;
        addresses.delete(oldest);
      }
      forgetCurrent(childSessionId);
      navigate(childSessionId, label);
    },
    navigateSubagentAncestor(sessionId, label) {
      if (!/^[a-f0-9]{20}$/.test(sessionId)) return;
      navigate(sessionId, label);
    },
  };
}
