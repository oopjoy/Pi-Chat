export interface SessionScrollPosition {
  top: number;
  atBottom: boolean;
  visibleTurnCount: number;
}

export interface SessionScrollTarget {
  top: number;
  stickToBottom: boolean;
}

const BOTTOM_THRESHOLD = 120;

export class SessionScrollMemory {
  private readonly positions = new Map<string, SessionScrollPosition>();

  remember(sessionId: string, scrollTop: number, scrollHeight: number, clientHeight: number, visibleTurnCount: number): void {
    if (!sessionId) return;
    const top = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
    const distanceFromBottom = Math.max(0, scrollHeight - top - clientHeight);
    this.positions.set(sessionId, { top, atBottom: distanceFromBottom < BOTTOM_THRESHOLD, visibleTurnCount: Math.max(0, visibleTurnCount) });
  }

  turns(sessionId: string): number | undefined {
    const turns = this.positions.get(sessionId)?.visibleTurnCount;
    return turns && turns > 0 ? turns : undefined;
  }

  target(sessionId: string, scrollHeight: number, clientHeight: number): SessionScrollTarget {
    const position = this.positions.get(sessionId);
    if (!position || position.atBottom) return { top: scrollHeight, stickToBottom: true };
    return {
      top: Math.min(position.top, Math.max(0, scrollHeight - clientHeight)),
      stickToBottom: false,
    };
  }

  forget(sessionId: string): void {
    this.positions.delete(sessionId);
  }
}
