export interface SessionScrollPosition {
  top: number;
  atBottom: boolean;
  visibleTurnCount: number;
}

export interface SessionScrollTarget {
  top: number;
  stickToBottom: boolean;
}

// Only a small rounding/layout remainder counts as "at bottom". Treating a
// full message-sized gap as bottom makes a nearby remembered reading position
// jump to the newest reply when the user returns to the Session.
export const BOTTOM_THRESHOLD = 24;

/** Keep every caller's bottom policy identical to the remembered-position policy. */
export function isAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  const top = Number.isFinite(scrollTop) ? scrollTop : 0;
  const height = Number.isFinite(scrollHeight) ? scrollHeight : 0;
  const viewport = Number.isFinite(clientHeight) ? clientHeight : 0;
  return Math.max(0, height - top - viewport) < BOTTOM_THRESHOLD;
}

const INITIAL_TURN_WINDOW = 10;
const TURN_WINDOW_STEP = 10;
const MAX_TURN_WINDOW = 10_000;

/** Convert an observed turn count into a value accepted by the Session view API. */
export function sessionTurnWindow(visibleTurnCount: number): number | undefined {
  if (!Number.isFinite(visibleTurnCount) || visibleTurnCount <= 0) return undefined;
  const turns = Math.floor(visibleTurnCount);
  if (turns <= INITIAL_TURN_WINDOW) return INITIAL_TURN_WINDOW;
  const rounded = INITIAL_TURN_WINDOW + Math.ceil((turns - INITIAL_TURN_WINDOW) / TURN_WINDOW_STEP) * TURN_WINDOW_STEP;
  return Math.min(MAX_TURN_WINDOW, rounded);
}

export class SessionScrollMemory {
  private readonly positions = new Map<string, SessionScrollPosition>();

  remember(sessionId: string, scrollTop: number, scrollHeight: number, clientHeight: number, visibleTurnCount: number): void {
    if (!sessionId) return;
    const top = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
    this.positions.set(sessionId, { top, atBottom: isAtBottom(top, scrollHeight, clientHeight), visibleTurnCount: Math.max(0, visibleTurnCount) });
  }

  turns(sessionId: string): number | undefined {
    return sessionTurnWindow(this.positions.get(sessionId)?.visibleTurnCount || 0);
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
