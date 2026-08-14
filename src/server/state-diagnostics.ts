import { randomBytes } from "node:crypto";
import {
  sanitizeStateDiagnosticDetails,
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
  buildRevision: string;
  now?: () => number;
  windowMs?: number;
  maximumEntries?: number;
  maximumBytes?: number;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1_000;
const DEFAULT_MAXIMUM_ENTRIES = 2_000;
const DEFAULT_MAXIMUM_BYTES = 1024 * 1024;
const SAFE_NAME = /^[a-z0-9_.:-]{1,80}$/i;
const SAFE_SESSION_ID = /^[a-f0-9]{20}$/;

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

export const sanitizeDiagnosticDetails = sanitizeStateDiagnosticDetails;

export class StateDiagnosticsRecorder {
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maximumEntries: number;
  private readonly maximumBytes: number;
  private entries: StateDiagnosticEntry[] = [];
  private entryBytes: number[] = [];
  private approximateBytes = 0;
  private active = false;
  private captureId = "";
  private ownerId = "";
  private startedAtMs = 0;
  private sequence = 0;

  constructor(private readonly options: StateDiagnosticsRecorderOptions) {
    this.now = options.now || Date.now;
    this.windowMs = Math.max(10_000, Math.floor(options.windowMs ?? DEFAULT_WINDOW_MS));
    this.maximumEntries = Math.max(100, Math.floor(options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES));
    this.maximumBytes = Math.max(64 * 1024, Math.floor(options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES));
  }

  isActive(): boolean {
    return this.active;
  }

  start(ownerId = "test-owner"): StateDiagnosticStatus {
    this.active = true;
    this.captureId = randomBytes(12).toString("hex");
    this.ownerId = ownerId;
    this.startedAtMs = this.now();
    this.sequence = 0;
    this.entries = [];
    this.entryBytes = [];
    this.approximateBytes = 0;
    this.record({ category: "capture", name: "started" });
    return this.status();
  }

  stop(): StateDiagnosticStatus {
    if (this.active) this.record({ category: "capture", name: "stopped" });
    this.active = false;
    return this.status();
  }

  ownedBy(ownerId: string): boolean {
    return Boolean(ownerId) && ownerId === this.ownerId;
  }

  captureMatches(captureId: string): boolean {
    return Boolean(captureId) && captureId === this.captureId;
  }

  record(input: StateDiagnosticRecord): void {
    if (!this.active || !SAFE_NAME.test(input.category) || !SAFE_NAME.test(input.name)) return;
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
    const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    this.entries.push(entry);
    this.entryBytes.push(bytes);
    this.approximateBytes += bytes;
    while (
      this.entries.length > this.maximumEntries ||
      this.approximateBytes > this.maximumBytes
    ) {
      this.entries.shift();
      this.approximateBytes -= this.entryBytes.shift() || 0;
    }
  }

  status(): StateDiagnosticStatus {
    this.prune(this.now());
    return {
      active: this.active,
      ...(this.captureId ? { captureId: this.captureId } : null),
      ...(this.startedAtMs ? { startedAt: new Date(this.startedAtMs).toISOString() } : null),
      entryCount: this.entries.length,
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
      schemaVersion: 1,
      generatedAt: new Date(now).toISOString(),
      runEpoch: this.options.runEpoch,
      buildRevision: this.options.buildRevision,
      status: this.status(),
      entries: this.entries.map((entry) => ({ ...entry, details: { ...entry.details } })),
    };
  }

  private prune(now: number): void {
    const minimum = now - this.windowMs;
    let remove = 0;
    while (remove < this.entries.length) {
      const timestamp = Date.parse(this.entries[remove].timestamp);
      if (!Number.isFinite(timestamp) || timestamp >= minimum) break;
      remove += 1;
    }
    if (remove) {
      this.entries.splice(0, remove);
      const removedBytes = this.entryBytes.splice(0, remove);
      this.approximateBytes -= removedBytes.reduce((total, value) => total + value, 0);
    }
  }
}
