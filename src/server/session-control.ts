export class SessionControlConflictError extends Error {}

export interface SessionControlState {
  controlOwner?: string;
  controlledByThisWindow?: boolean;
}

export interface SessionControlOptions {
  /** Grace period after the last SSE close before ownership is released. */
  controllerReleaseMs?: number;
  /** Notify host to push per-window control SSE frames for this session. */
  onControlChanged: (sessionId: string) => void;
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
  private readonly controllerReleaseMs: number;

  constructor(private readonly options: SessionControlOptions) {
    this.controllerReleaseMs = Math.max(0, options.controllerReleaseMs ?? 5_000);
  }

  controlState(sessionId: string, clientId = ""): SessionControlState {
    const controlOwner = this.sessionControllers.get(sessionId);
    return {
      ...(controlOwner ? { controlOwner } : {}),
      ...(clientId ? { controlledByThisWindow: controlOwner === clientId } : {}),
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
    if (current && current !== clientId) {
      throw new SessionControlConflictError("此对话正在另一窗口中控制；请先接管控制权");
    }
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

  clientDisconnected(clientId: string): void {
    if (!clientId) return;
    const remaining = Math.max(0, (this.connectedClients.get(clientId) || 1) - 1);
    if (remaining) {
      this.connectedClients.set(clientId, remaining);
      return;
    }
    this.connectedClients.delete(clientId);
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
   * Immediately drop presence and ownership (window close API).
   * @returns the session this window was viewing, if any.
   */
  releaseClient(clientId: string): string {
    if (!clientId) return "";
    const viewedSessionId = this.viewedSessionsByClient.get(clientId) || "";
    const timer = this.controllerReleaseTimers.get(clientId);
    if (timer) clearTimeout(timer);
    this.controllerReleaseTimers.delete(clientId);
    this.connectedClients.delete(clientId);
    this.viewedSessionsByClient.delete(clientId);
    this.clearOwnershipForClient(clientId);
    return viewedSessionId;
  }

  markViewed(clientId: string, sessionId: string): void {
    // A one-off HTTP request must not pin a worker forever. Presence is backed
    // by the browser window's live SSE lease and disappears after disconnect.
    if (clientId && sessionId && this.connectedClients.has(clientId)) {
      this.viewedSessionsByClient.set(clientId, sessionId);
    }
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

  clearSession(sessionId: string): void {
    if (this.sessionControllers.delete(sessionId)) this.options.onControlChanged(sessionId);
    for (const [clientId, viewedId] of this.viewedSessionsByClient) {
      if (viewedId === sessionId) this.viewedSessionsByClient.delete(clientId);
    }
  }

  clear(): void {
    for (const timer of this.controllerReleaseTimers.values()) clearTimeout(timer);
    this.controllerReleaseTimers.clear();
    this.connectedClients.clear();
    this.viewedSessionsByClient.clear();
    this.sessionControllers.clear();
  }

  private clearOwnershipForClient(clientId: string): void {
    for (const [sessionId, owner] of this.sessionControllers) {
      if (owner !== clientId) continue;
      this.sessionControllers.delete(sessionId);
      this.options.onControlChanged(sessionId);
    }
  }
}
