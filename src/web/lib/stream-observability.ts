import { recordBrowserStateDiagnostic } from "./state-diagnostics";

const SAFE_SESSION_ID = /^[a-f0-9]{20}$/;
const DEFAULT_MAXIMUM_RUNS = 128;

export type LiveMessageSchedulerOutcome =
  | "scheduled"
  | "replaced"
  | "committed"
  | "drained"
  | "cleared";

export interface BrowserStreamIdentity {
  sessionId: string;
  runGeneration: number;
}

interface BrowserStreamRun {
  identity: BrowserStreamIdentity;
  snapshotsReceived: number;
  snapshotsAdmitted: number;
  snapshotsOffscreen: number;
  snapshotsScheduled: number;
  snapshotsReplaced: number;
  snapshotsCommitted: number;
  snapshotsDrained: number;
  snapshotsCleared: number;
  firstVisibleReceivedAt?: number;
  visibleCommitted: boolean;
  paintRecorded: boolean;
  terminalRecorded: boolean;
}

type DiagnosticRecord = (
  category: string,
  name: string,
  input: {
    sessionId?: string;
    runGeneration?: number;
    details?: Record<string, unknown>;
  },
) => void;

function validIdentity(identity: BrowserStreamIdentity): boolean {
  return SAFE_SESSION_ID.test(identity.sessionId)
    && Number.isSafeInteger(identity.runGeneration)
    && identity.runGeneration >= 0;
}

function increment(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

function hasCounters(run: BrowserStreamRun): boolean {
  return run.snapshotsReceived > 0
    || run.snapshotsAdmitted > 0
    || run.snapshotsOffscreen > 0
    || run.snapshotsScheduled > 0
    || run.snapshotsReplaced > 0
    || run.snapshotsCommitted > 0
    || run.snapshotsDrained > 0
    || run.snapshotsCleared > 0;
}

function resetCounters(run: BrowserStreamRun): void {
  run.snapshotsReceived = 0;
  run.snapshotsAdmitted = 0;
  run.snapshotsOffscreen = 0;
  run.snapshotsScheduled = 0;
  run.snapshotsReplaced = 0;
  run.snapshotsCommitted = 0;
  run.snapshotsDrained = 0;
  run.snapshotsCleared = 0;
}

/** Bounded, page-local observation only; it owns no Pane or Runtime state. */
export class BrowserStreamDiagnosticsAggregator {
  private readonly runs = new Map<string, BrowserStreamRun>();

  constructor(
    private readonly record: DiagnosticRecord = recordBrowserStateDiagnostic,
    private readonly now: () => number = () => performance.now(),
    private readonly maximumRuns = DEFAULT_MAXIMUM_RUNS,
  ) {}

  get size(): number {
    return this.runs.size;
  }

  receive(
    identity: BrowserStreamIdentity,
    viewing: boolean,
    visible = viewing,
  ): void {
    try {
      const run = this.ensure(identity);
      if (!run) return;
      run.snapshotsReceived = increment(run.snapshotsReceived);
      if (viewing) {
        run.snapshotsAdmitted = increment(run.snapshotsAdmitted);
        if (visible && run.firstVisibleReceivedAt === undefined) {
          const receivedAt = this.safeNow();
          if (receivedAt !== undefined) run.firstVisibleReceivedAt = receivedAt;
        }
      } else {
        run.snapshotsOffscreen = increment(run.snapshotsOffscreen);
      }
    } catch {
      // Observation may never perturb SSE admission.
    }
  }

  scheduler(outcome: LiveMessageSchedulerOutcome, identity: BrowserStreamIdentity): void {
    try {
      const run = this.runs.get(this.key(identity));
      if (!run || !validIdentity(identity)) return;
      if (outcome === "scheduled") run.snapshotsScheduled = increment(run.snapshotsScheduled);
      else if (outcome === "replaced") run.snapshotsReplaced = increment(run.snapshotsReplaced);
      else if (outcome === "committed") {
        run.snapshotsCommitted = increment(run.snapshotsCommitted);
        run.visibleCommitted = true;
      } else if (outcome === "drained") {
        run.snapshotsDrained = increment(run.snapshotsDrained);
      } else run.snapshotsCleared = increment(run.snapshotsCleared);
    } catch {
      // Observation may never perturb render scheduling.
    }
  }

  /** A viewing message_end committed the terminal assistant outside the throttle. */
  terminalAssistantCommitted(identity: BrowserStreamIdentity): void {
    try {
      const run = this.runs.get(this.key(identity));
      if (!run || !validIdentity(identity)) return;
      run.visibleCommitted = true;
    } catch {
      // Observation may never perturb terminal rendering.
    }
  }

  hasPaintCandidate(identity: BrowserStreamIdentity): boolean {
    try {
      const run = this.runs.get(this.key(identity));
      return Boolean(
        run
        && validIdentity(identity)
        && run.visibleCommitted
        && !run.paintRecorded
        && run.firstVisibleReceivedAt !== undefined
      );
    } catch {
      return false;
    }
  }

  terminal(identity: BrowserStreamIdentity): void {
    try {
      const key = this.key(identity);
      const run = this.runs.get(key);
      if (!run || !validIdentity(identity) || run.terminalRecorded) return;
      run.terminalRecorded = true;
      this.emit("stream-summary", run, { terminal: true });
      if (!run.visibleCommitted || run.paintRecorded) this.runs.delete(key);
    } catch {
      // Observation may never perturb terminal event handling.
    }
  }

  /** Emit active aggregate segments before export without losing paint idempotence. */
  checkpoint(): void {
    try {
      for (const run of this.runs.values()) {
        if (run.terminalRecorded || !hasCounters(run)) continue;
        this.emit("stream-summary", run, { terminal: false });
        resetCounters(run);
      }
    } catch {
      // Observation may never perturb diagnostic export.
    }
  }

  paint(identity: BrowserStreamIdentity): boolean {
    try {
      const key = this.key(identity);
      const run = this.runs.get(key);
      if (
        !run
        || !validIdentity(identity)
        || !run.visibleCommitted
        || run.paintRecorded
        || run.firstVisibleReceivedAt === undefined
      ) return false;
      const paintedAt = this.safeNow();
      if (paintedAt === undefined) return false;
      run.paintRecorded = true;
      this.safeRecord("render", "first-assistant-paint-opportunity", {
        sessionId: identity.sessionId,
        runGeneration: identity.runGeneration,
        details: {
          paintDelayMs: Math.max(0, paintedAt - run.firstVisibleReceivedAt),
          visible: true,
        },
      });
      if (run.terminalRecorded) this.runs.delete(key);
      return true;
    } catch {
      return false;
    }
  }

  deleteSession(sessionId: string): void {
    try {
      if (!SAFE_SESSION_ID.test(sessionId)) return;
      for (const [key, run] of this.runs)
        if (run.identity.sessionId === sessionId) this.runs.delete(key);
    } catch {
      // Observation cleanup remains fail-open.
    }
  }

  clear(): void {
    try { this.runs.clear(); }
    catch { /* Observation cleanup remains fail-open. */ }
  }

  private ensure(identity: BrowserStreamIdentity): BrowserStreamRun | undefined {
    if (!validIdentity(identity)) return undefined;
    const key = this.key(identity);
    let run = this.runs.get(key);
    if (run) return run;
    while (this.runs.size >= Math.max(1, this.maximumRuns)) {
      const oldest = this.runs.keys().next().value as string | undefined;
      if (!oldest) break;
      this.runs.delete(oldest);
    }
    run = {
      identity: { ...identity },
      snapshotsReceived: 0,
      snapshotsAdmitted: 0,
      snapshotsOffscreen: 0,
      snapshotsScheduled: 0,
      snapshotsReplaced: 0,
      snapshotsCommitted: 0,
      snapshotsDrained: 0,
      snapshotsCleared: 0,
      visibleCommitted: false,
      paintRecorded: false,
      terminalRecorded: false,
    };
    this.runs.set(key, run);
    return run;
  }

  private emit(name: string, run: BrowserStreamRun, extra: Record<string, unknown>): void {
    this.safeRecord("render", name, {
      sessionId: run.identity.sessionId,
      runGeneration: run.identity.runGeneration,
      details: {
        snapshotsReceived: run.snapshotsReceived,
        snapshotsAdmitted: run.snapshotsAdmitted,
        snapshotsOffscreen: run.snapshotsOffscreen,
        snapshotsScheduled: run.snapshotsScheduled,
        snapshotsReplaced: run.snapshotsReplaced,
        snapshotsCommitted: run.snapshotsCommitted,
        snapshotsDrained: run.snapshotsDrained,
        snapshotsCleared: run.snapshotsCleared,
        ...extra,
      },
    });
  }

  private safeNow(): number | undefined {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private safeRecord(
    category: string,
    name: string,
    input: Parameters<DiagnosticRecord>[2],
  ): void {
    try { this.record(category, name, input); }
    catch { /* Observation remains fail-open. */ }
  }

  private key(identity: BrowserStreamIdentity): string {
    return `${identity.sessionId}:${identity.runGeneration}`;
  }
}
