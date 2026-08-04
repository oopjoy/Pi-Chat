export class SessionControlConflictError extends Error {}

export interface SessionControlState {
  controlOwner?: string;
  controlledByThisWindow?: boolean;
}

export interface SessionControlOptions {
  /**
   * Grace after the last SSE close before dropping ownership.
   * During grace, other windows without sole-present status still get 409 on writes.
   * The observing banner only appears when the owner still renews foreground presence.
   */
  controllerReleaseMs?: number;
  /** Notify host to push per-window control SSE frames for this session. */
  onControlChanged: (sessionId: string) => void;
  /**
   * A browser must periodically confirm that its renderer is still active.
   * A live TCP socket alone is insufficient for Edge PWA frozen/restore pages.
   */
  presenceTtlMs?: number;
  /** Injectable clock for deterministic expiry tests. */
  now?: () => number;
}

/**
 * Owns multi-window presence and exclusive Session control.
 * Does not own Runtime lifecycle, HTTP, or SSE sockets — only client/session maps.
 */
export class SessionControl {
  /** Shared with PiChatApp for dual-session tests that seed presence maps. */
  readonly sessionControllers = new Map<string, string>();
  readonly connectedClients = new Map<string, number>();
  readonly viewedSessionsByClient = new Map<string, string>();
  private readonly controllerReleaseTimers = new Map<string, NodeJS.Timeout>();
  private readonly presenceAtByClient = new Map<string, number>();
  private readonly presenceExpiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly controllerReleaseMs: number;
  private readonly presenceTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: SessionControlOptions) {
    // Short grace: enough for same-window SSE reconnect, short enough to limit
    // post-close write lock for a second window.
    this.controllerReleaseMs = Math.max(0, options.controllerReleaseMs ?? 1_500);
    // A renderer may be frozen while its EventSource TCP socket remains open.
    // Require a small active-page renewal window before treating it as another
    // writable browser window.
    this.presenceTtlMs = Math.max(1, options.presenceTtlMs ?? 20_000);
    this.now = options.now || Date.now;
  }

  /** Active EventSource / SSE transport lease. */
  isClientConnected(clientId: string): boolean {
    return Boolean(clientId) && this.connectedClients.has(clientId);
  }

  /** Active foreground browser lease, not merely an open transport socket. */
  isClientPresent(clientId: string): boolean {
    if (!this.isClientConnected(clientId)) return false;
    const at = this.presenceAtByClient.get(clientId);
    return typeof at === "number" && this.now() - at < this.presenceTtlMs;
  }

  /** Connected or still inside disconnect grace (ownership not yet released). */
  isClientHeld(clientId: string): boolean {
    return this.isClientConnected(clientId) || this.controllerReleaseTimers.has(clientId);
  }

  controlState(sessionId: string, clientId = ""): SessionControlState {
    const controlOwner = this.sessionControllers.get(sessionId);
    if (!controlOwner) {
      return clientId ? { controlledByThisWindow: false } : {};
    }

    // Self always sees own ownership (bootstrap/prompt may race ahead of SSE).
    if (clientId && controlOwner === clientId) {
      return { controlOwner, controlledByThisWindow: true };
    }

    // Observing banner only for a foreign owner whose browser renderer is still
    // actively renewing presence. A frozen PWA can retain an SSE socket, but must
    // not force the user to take over their own stale window.
    if (!this.isClientPresent(controlOwner)) {
      // A sole visible replacement can recover without a takeover prompt. With
      // multiple visible windows, keep the stale owner visible until expiry so
      // the UI exposes an explicit, deterministic takeover path instead of
      // presenting enabled controls that all fail with 409.
      if (
        clientId &&
        this.isClientPresent(clientId) &&
        this.otherPresentWindowCount(clientId) > 0
      ) {
        return { controlOwner, controlledByThisWindow: false };
      }
      return clientId ? { controlledByThisWindow: false } : {};
    }

    return {
      controlOwner,
      ...(clientId ? { controlledByThisWindow: false } : {}),
    };
  }

  setController(sessionId: string, clientId: string): void {
    if (!clientId || this.sessionControllers.get(sessionId) === clientId) return;
    this.sessionControllers.set(sessionId, clientId);
    this.options.onControlChanged(sessionId);
  }

  assertNoForeignController(sessionId: string, clientId: string): void {
    if (!clientId) return;
    const current = this.sessionControllers.get(sessionId);
    if (!current || current === clientId) return;

    // The only actively present browser window may displace any foreign owner
    // (ghost, grace, or frozen PWA). A single visible PWA must never need
    // “接管控制”. API-only clients retain their explicit exclusive ownership.
    if (this.isClientPresent(clientId) && this.otherPresentWindowCount(clientId) === 0) return;

    throw new SessionControlConflictError("此对话正在另一窗口中控制；请先接管控制权");
  }

  requireControl(sessionId: string, clientId: string): void {
    // Non-browser integrations deliberately have no client identity. The Pi Chat
    // browser supplies X-Pi-Chat-Client for every request after bootstrap.
    this.assertNoForeignController(sessionId, clientId);
    if (clientId) this.setController(sessionId, clientId);
  }

  clientConnected(clientId: string): void {
    if (!clientId) return;
    const timer = this.controllerReleaseTimers.get(clientId);
    if (timer) clearTimeout(timer);
    this.controllerReleaseTimers.delete(clientId);
    this.connectedClients.set(clientId, (this.connectedClients.get(clientId) || 0) + 1);
  }

  /** Renew a foreground browser lease. Calls from a dead/no-SSE client are ignored. */
  noteClientPresence(clientId: string): boolean {
    if (!clientId || !this.isClientConnected(clientId)) return false;
    const wasPresent = this.isClientPresent(clientId);
    this.presenceAtByClient.set(clientId, this.now());
    const previous = this.presenceExpiryTimers.get(clientId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => this.expireClientPresence(clientId), this.presenceTtlMs);
    timer.unref();
    this.presenceExpiryTimers.set(clientId, timer);
    const viewedSessionId = this.viewedSessionsByClient.get(clientId);
    if (viewedSessionId) this.claimIfSolePresentWindow(viewedSessionId, clientId);
    // A recovered visible PWA may again be a legitimate foreign owner. Push its
    // per-window projection without waiting for a sidebar/view refresh.
    if (!wasPresent) this.notifyControlChangedForClient(clientId);
    return true;
  }

  /**
   * A connected EventSource may belong to a hidden or unfocused renderer.
   * It remains a transport/view pin, but cannot retain foreground write control.
   */
  noteClientBackground(clientId: string): boolean {
    if (!clientId || !this.isClientConnected(clientId)) return false;
    this.clearClientPresence(clientId);
    this.clearOwnershipForClient(clientId);
    return true;
  }

  clientDisconnected(clientId: string): void {
    if (!clientId) return;
    const remaining = Math.max(0, (this.connectedClients.get(clientId) || 1) - 1);
    if (remaining) {
      this.connectedClients.set(clientId, remaining);
      return;
    }
    this.connectedClients.delete(clientId);
    this.clearClientPresence(clientId);
    const timer = setTimeout(() => {
      this.controllerReleaseTimers.delete(clientId);
      if (this.connectedClients.has(clientId)) return;
      this.viewedSessionsByClient.delete(clientId);
      this.clearOwnershipForClient(clientId);
    }, this.controllerReleaseMs);
    timer.unref();
    this.controllerReleaseTimers.set(clientId, timer);
  }

  /**
   * Release one window's view and control immediately while its unload-time SSE
   * socket finishes closing. Transport counts remain authoritative so a refresh
   * can reconnect with the same client ID without an old socket deleting it.
   */
  closeWindow(clientId: string): string {
    if (!clientId) return "";
    const viewedSessionId = this.viewedSessionsByClient.get(clientId) || "";
    const timer = this.controllerReleaseTimers.get(clientId);
    if (timer) clearTimeout(timer);
    this.controllerReleaseTimers.delete(clientId);
    this.clearClientPresence(clientId);
    this.viewedSessionsByClient.delete(clientId);
    this.clearOwnershipForClient(clientId);
    return viewedSessionId;
  }

  /** Immediately drop every lease for a client that will not reconnect. */
  releaseClient(clientId: string): string {
    const viewedSessionId = this.closeWindow(clientId);
    this.connectedClients.delete(clientId);
    return viewedSessionId;
  }

  markViewed(clientId: string, sessionId: string): void {
    // Viewing is independent from foreground control. A restored/background
    // page may retain its view pin, but only the visible client-side lifecycle
    // explicitly renews foreground presence through /api/presence.
    if (clientId && sessionId && this.connectedClients.has(clientId)) {
      this.viewedSessionsByClient.set(clientId, sessionId);
      // On a restored PWA, presence commonly arrives before this view marker.
      // Claim here as well: otherwise that ordering leaves a disconnected or
      // frozen former renderer as the displayed owner until another renewal.
      // `claimIfSolePresentWindow` still refuses to displace a second visible
      // browser window, so true multi-window control remains explicit.
      this.claimIfSolePresentWindow(sessionId, clientId);
    }
  }

  /** Compare-and-clear so a delayed local-New request cannot unpin a newer view. */
  clearViewed(clientId: string, expectedSessionId: string): string {
    if (!clientId) return "";
    const current = this.viewedSessionsByClient.get(clientId) || "";
    if (!expectedSessionId || current !== expectedSessionId) return current;
    this.viewedSessionsByClient.delete(clientId);
    return "";
  }

  /**
   * When only one browser window is actively renewing foreground presence,
   * claim control immediately so a visible PWA never sits behind a ghost,
   * disconnect grace, or frozen page that retained its EventSource.
   */
  claimIfSolePresentWindow(sessionId: string, clientId: string): void {
    if (!clientId || !sessionId || !this.isClientPresent(clientId)) return;
    if (this.otherPresentWindowCount(clientId) > 0) return;
    const current = this.sessionControllers.get(sessionId);
    if (current === clientId) return;
    this.setController(sessionId, clientId);
  }

  isViewed(sessionId: string): boolean {
    for (const viewedId of this.viewedSessionsByClient.values()) {
      if (viewedId === sessionId) return true;
    }
    return false;
  }

  otherWindowCount(clientId: string): number {
    return [...this.connectedClients.keys()].filter((id) => id !== clientId).length;
  }

  otherPresentWindowCount(clientId: string): number {
    return [...this.connectedClients.keys()].filter((id) => id !== clientId && this.isClientPresent(id)).length;
  }

  clearSession(sessionId: string): void {
    if (this.sessionControllers.delete(sessionId)) this.options.onControlChanged(sessionId);
    for (const [clientId, viewedId] of this.viewedSessionsByClient) {
      if (viewedId === sessionId) this.viewedSessionsByClient.delete(clientId);
    }
  }

  clear(): void {
    for (const timer of this.controllerReleaseTimers.values()) clearTimeout(timer);
    for (const timer of this.presenceExpiryTimers.values()) clearTimeout(timer);
    this.controllerReleaseTimers.clear();
    this.presenceExpiryTimers.clear();
    this.presenceAtByClient.clear();
    this.connectedClients.clear();
    this.viewedSessionsByClient.clear();
    this.sessionControllers.clear();
  }

  private expireClientPresence(clientId: string): void {
    if (!this.isClientConnected(clientId)) return;
    const at = this.presenceAtByClient.get(clientId);
    if (typeof at !== "number") return;
    const remaining = this.presenceTtlMs - (this.now() - at);
    if (remaining > 0) {
      const timer = setTimeout(() => this.expireClientPresence(clientId), remaining);
      timer.unref();
      this.presenceExpiryTimers.set(clientId, timer);
      return;
    }
    this.clearClientPresence(clientId);
    // Foreground control expiration is not a Runtime/resource policy. Keep the
    // viewed-session pin, but release exclusive write ownership so multiple
    // fresh windows receive an explicit, recoverable control projection.
    this.clearOwnershipForClient(clientId);
  }

  private clearClientPresence(clientId: string): void {
    this.presenceAtByClient.delete(clientId);
    const timer = this.presenceExpiryTimers.get(clientId);
    if (timer) clearTimeout(timer);
    this.presenceExpiryTimers.delete(clientId);
  }

  private notifyControlChangedForClient(clientId: string): void {
    for (const [sessionId, owner] of this.sessionControllers) {
      if (owner === clientId) this.options.onControlChanged(sessionId);
    }
  }

  private clearOwnershipForClient(clientId: string): void {
    for (const [sessionId, owner] of this.sessionControllers) {
      if (owner !== clientId) continue;
      this.sessionControllers.delete(sessionId);
      this.options.onControlChanged(sessionId);
    }
  }
}
