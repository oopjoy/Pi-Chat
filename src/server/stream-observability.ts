import type { SseTransportDiagnostic } from "./sse-hub.js";

const SAFE_SESSION_ID = /^[a-f0-9]{20}$/;
const DEFAULT_MAXIMUM_RUNS = 128;

interface ServerStreamRun {
  sessionId: string;
  runGeneration: number;
  snapshotsWritten: number;
  snapshotsBackpressured: number;
  snapshotsScheduled: number;
  snapshotsReplaced: number;
  snapshotsQueued: number;
  snapshotsQueueReplaced: number;
  snapshotsOversized: number;
  snapshotsNoClients: number;
  snapshotsWriteErrors: number;
}

type SummaryObserver = (summary: {
  sessionId: string;
  runGeneration: number;
  details: Record<string, number>;
}) => void;

function increment(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

/** Aggregates hot SseHub outcomes without retaining frames or client identity. */
export class ServerStreamDiagnosticsAggregator {
  private readonly runs = new Map<string, ServerStreamRun>();

  constructor(
    private readonly emit: SummaryObserver,
    private readonly maximumRuns = DEFAULT_MAXIMUM_RUNS,
  ) {}

  get size(): number {
    return this.runs.size;
  }

  observe(event: SseTransportDiagnostic): boolean {
    if (
      event.eventType !== "message_update"
      && event.eventType !== "message_checkpoint"
      && event.eventType !== "message_delta"
      && event.originalEventType !== "message_update"
      && event.originalEventType !== "message_checkpoint"
      && event.originalEventType !== "message_delta"
    ) return false;
    if (
      !event.sessionId
      || !SAFE_SESSION_ID.test(event.sessionId)
      || !Number.isSafeInteger(event.runGeneration)
      || (event.runGeneration || 0) < 0
    ) return true;
    const run = this.ensure(event.sessionId, event.runGeneration || 0);
    if (event.outcome === "written") run.snapshotsWritten = increment(run.snapshotsWritten);
    else if (event.outcome === "written-backpressured") {
      run.snapshotsWritten = increment(run.snapshotsWritten);
      run.snapshotsBackpressured = increment(run.snapshotsBackpressured);
    } else if (event.outcome === "scheduled") run.snapshotsScheduled = increment(run.snapshotsScheduled);
    else if (event.outcome === "scheduled-replaced") run.snapshotsReplaced = increment(run.snapshotsReplaced);
    else if (event.outcome === "queued") run.snapshotsQueued = increment(run.snapshotsQueued);
    else if (event.outcome === "queue-replaced")
      run.snapshotsQueueReplaced = increment(run.snapshotsQueueReplaced);
    else if (event.outcome === "oversized-substitute")
      run.snapshotsOversized = increment(run.snapshotsOversized);
    else if (event.outcome === "no-clients")
      run.snapshotsNoClients = increment(run.snapshotsNoClients);
    else if (event.outcome === "write-error")
      run.snapshotsWriteErrors = increment(run.snapshotsWriteErrors);
    return true;
  }

  flush(sessionId: string, runGeneration: number): boolean {
    const key = this.key(sessionId, runGeneration);
    const run = this.runs.get(key);
    if (!run) return false;
    this.runs.delete(key);
    try {
      this.emit({
        sessionId,
        runGeneration,
        details: {
          snapshotsWritten: run.snapshotsWritten,
          snapshotsBackpressured: run.snapshotsBackpressured,
          snapshotsScheduled: run.snapshotsScheduled,
          snapshotsReplaced: run.snapshotsReplaced,
          snapshotsQueued: run.snapshotsQueued,
          snapshotsQueueReplaced: run.snapshotsQueueReplaced,
          snapshotsOversized: run.snapshotsOversized,
          snapshotsNoClients: run.snapshotsNoClients,
          snapshotsWriteErrors: run.snapshotsWriteErrors,
        },
      });
    } catch {
      // Observation remains fail-open.
    }
    return true;
  }

  checkpoint(): void {
    for (const run of [...this.runs.values()])
      this.flush(run.sessionId, run.runGeneration);
  }

  clear(): void {
    this.runs.clear();
  }

  private ensure(sessionId: string, runGeneration: number): ServerStreamRun {
    const key = this.key(sessionId, runGeneration);
    let run = this.runs.get(key);
    if (run) return run;
    while (this.runs.size >= Math.max(1, this.maximumRuns)) {
      const oldest = this.runs.values().next().value as ServerStreamRun | undefined;
      if (!oldest) break;
      this.flush(oldest.sessionId, oldest.runGeneration);
    }
    run = {
      sessionId,
      runGeneration,
      snapshotsWritten: 0,
      snapshotsBackpressured: 0,
      snapshotsScheduled: 0,
      snapshotsReplaced: 0,
      snapshotsQueued: 0,
      snapshotsQueueReplaced: 0,
      snapshotsOversized: 0,
      snapshotsNoClients: 0,
      snapshotsWriteErrors: 0,
    };
    this.runs.set(key, run);
    return run;
  }

  private key(sessionId: string, runGeneration: number): string {
    return `${sessionId}:${runGeneration}`;
  }
}
