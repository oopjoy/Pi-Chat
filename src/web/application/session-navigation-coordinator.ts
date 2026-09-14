export interface NavigationBegin {
  epoch: number;
  controller: AbortController;
}

/**
 * Owns browser navigation intent and cancellation facts for the selected
 * Session. It deliberately does not fetch JSONL, mutate the pane, or decide
 * whether an async result may commit; callers still perform pane-authority
 * checks with the captured epoch and committed revision.
 */
export class SessionNavigationCoordinator {
  readonly navigationEpochRef = { current: 0 };
  readonly desiredSessionIdRef = { current: "" };
  readonly navigationAbortRef = { current: null as AbortController | null };
  readonly navigationStartedAtRef = { current: new Map<number, number>() };

  begin(sessionId: string, startedAt: number): NavigationBegin {
    this.navigationAbortRef.current?.abort();
    this.navigationAbortRef.current = new AbortController();
    this.navigationStartedAtRef.current.clear();
    const epoch = ++this.navigationEpochRef.current;
    this.desiredSessionIdRef.current = sessionId;
    this.navigationStartedAtRef.current.set(epoch, startedAt);
    return { epoch, controller: this.navigationAbortRef.current };
  }

  cancel(invalidate: boolean, committedSessionId: string): void {
    this.navigationAbortRef.current?.abort();
    this.navigationAbortRef.current = null;
    this.navigationStartedAtRef.current.clear();
    if (!invalidate) return;
    this.navigationEpochRef.current += 1;
    this.desiredSessionIdRef.current = committedSessionId;
  }

  consumeStartedAt(epoch: number): number | undefined {
    const startedAt = this.navigationStartedAtRef.current.get(epoch);
    if (startedAt !== undefined) this.navigationStartedAtRef.current.delete(epoch);
    return startedAt;
  }

  finish(epoch: number, controller: AbortController): void {
    if (this.navigationAbortRef.current === controller)
      this.navigationAbortRef.current = null;
    if (this.navigationEpochRef.current === epoch)
      this.navigationStartedAtRef.current.delete(epoch);
  }
}
