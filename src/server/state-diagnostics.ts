import {
  sanitizeStateDiagnosticDetails,
  shouldRetainStateDiagnosticEvent,
  type ServerStateDiagnosticSnapshot,
  type StateDiagnosticEntry,
  type StateDiagnosticStatus,
} from "../shared/state-diagnostics.js";

export interface StateDiagnosticRecord {
  category: string;
  name: string;
  sessionId?: string;
  runGeneration?: number;
  rpcGeneration?: number;
  details?: Record<string, unknown>;
}

export interface StateDiagnosticsRecorderOptions {
  runEpoch: string;
  buildFingerprint: string;
  now?: () => number;
  windowMs?: number;
  maximumEntries?: number;
  maximumBytes?: number;
  encodeBytes?: (value: string) => number;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1_000;
const DEFAULT_MAXIMUM_ENTRIES = 2_000;
const DEFAULT_MAXIMUM_BYTES = 1024 * 1024;
const SAFE_SESSION_ID = /^[a-f0-9]{20}$/;

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

export const sanitizeDiagnosticDetails = sanitizeStateDiagnosticDetails;

/**
 * Process-local, always-on flight recorder. It owns no Runtime, Session, HTTP,
 * or browser authority; any observation failure simply drops that entry.
 */
export class StateDiagnosticsRecorder {
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maximumEntries: number;
  private readonly maximumBytes: number;
  private readonly encodeBytes: (value: string) => number;
  private entries: StateDiagnosticEntry[] = [];
  private entryBytes: number[] = [];
  private head = 0;
  private approximateBytes = 0;
  private sequence = 0;

  constructor(private readonly options: StateDiagnosticsRecorderOptions) {
    this.now = options.now || Date.now;
    this.windowMs = Math.max(10_000, Math.floor(options.windowMs ?? DEFAULT_WINDOW_MS));
    this.maximumEntries = Math.max(100, Math.floor(options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES));
    this.maximumBytes = Math.max(64 * 1024, Math.floor(options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES));
    this.encodeBytes = options.encodeBytes || ((value) => Buffer.byteLength(value, "utf8"));
  }

  record(input: StateDiagnosticRecord): void {
    try {
      if (!shouldRetainStateDiagnosticEvent(input.category, input.name, input.details)) return;
      const now = this.now();
      this.prune(now);
      const runGeneration = safeInteger(input.runGeneration);
      const rpcGeneration = safeInteger(input.rpcGeneration);
      const entry: StateDiagnosticEntry = {
        sequence: ++this.sequence,
        timestamp: new Date(now).toISOString(),
        source: "server",
        category: input.category,
        name: input.name,
        ...(input.sessionId && SAFE_SESSION_ID.test(input.sessionId)
          ? { sessionId: input.sessionId }
          : null),
        ...(runGeneration !== undefined ? { runGeneration } : null),
        ...(rpcGeneration !== undefined ? { rpcGeneration } : null),
        details: sanitizeStateDiagnosticDetails(input.details),
      };
      const bytes = this.encodeBytes(JSON.stringify(entry));
      this.entries.push(entry);
      this.entryBytes.push(bytes);
      this.approximateBytes += bytes;
      while (
        this.retainedCount() > this.maximumEntries ||
        this.approximateBytes > this.maximumBytes
      ) this.evictOne();
      this.compactStorage();
    } catch {
      // Diagnostics are optional metadata and must never perturb authoritative work.
    }
  }

  status(): StateDiagnosticStatus {
    this.prune(this.now());
    return {
      entryCount: this.retainedCount(),
      windowMs: this.windowMs,
      maximumEntries: this.maximumEntries,
      approximateBytes: this.approximateBytes,
      maximumBytes: this.maximumBytes,
    };
  }

  snapshot(): ServerStateDiagnosticSnapshot {
    const now = this.now();
    this.prune(now);
    return {
      schemaVersion: 2,
      generatedAt: new Date(now).toISOString(),
      runEpoch: this.options.runEpoch,
      buildFingerprint: this.options.buildFingerprint,
      status: this.status(),
      entries: this.entries
        .slice(this.head)
        .map((entry) => ({ ...entry, details: { ...entry.details } })),
    };
  }

  private retainedCount(): number {
    return this.entries.length - this.head;
  }

  private evictOne(): void {
    if (this.head >= this.entries.length) return;
    this.approximateBytes -= this.entryBytes[this.head] || 0;
    this.head += 1;
  }

  private prune(now: number): void {
    const minimum = now - this.windowMs;
    while (this.head < this.entries.length) {
      const timestamp = Date.parse(this.entries[this.head].timestamp);
      if (!Number.isFinite(timestamp) || timestamp >= minimum) break;
      this.evictOne();
    }
    this.compactStorage();
  }

  private compactStorage(): void {
    if (this.head < 256 || this.head * 2 < this.entries.length) return;
    this.entries = this.entries.slice(this.head);
    this.entryBytes = this.entryBytes.slice(this.head);
    this.head = 0;
  }
}
