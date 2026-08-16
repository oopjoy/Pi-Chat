import {
  isPromptEvidenceFactKind,
  reducePromptEvidenceRecord,
  type PromptEvidenceFact,
  type PromptEvidenceFactKind,
  type PromptEvidenceRecord,
  type PromptEvidenceSnapshot,
} from "../shared/prompt-evidence.js";

export interface PromptEvidenceInput {
  sessionId: string;
  promptId: string;
  kind: PromptEvidenceFactKind;
  rpcGeneration?: number;
  runGeneration?: number;
}

export interface PromptEvidenceLedgerOptions {
  now?: () => number;
  windowMs?: number;
  maximumRecords?: number;
  maximumBytes?: number;
  encodeBytes?: (value: string) => number;
}

interface StoredPromptEvidence {
  record: PromptEvidenceRecord;
  firstSequence: number;
  lastSequence: number;
  bytes: number;
}

const SESSION_ID = /^[a-f0-9]{20}$/;
const PROMPT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DEFAULT_WINDOW_MS = 5 * 60 * 1_000;
const DEFAULT_MAXIMUM_RECORDS = 500;
const DEFAULT_MAXIMUM_BYTES = 512 * 1_024;

function safeGeneration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Observation-only, whole-record-bounded prompt evidence storage. */
export class PromptEvidenceLedger {
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maximumRecords: number;
  private readonly maximumBytes: number;
  private readonly encodeBytes: (value: string) => number;
  private readonly records = new Map<string, StoredPromptEvidence>();
  private sequence = 0;
  private approximateBytes = 0;

  constructor(options: PromptEvidenceLedgerOptions = {}) {
    this.now = options.now || Date.now;
    this.windowMs = Math.max(10_000, Math.floor(options.windowMs ?? DEFAULT_WINDOW_MS));
    this.maximumRecords = Math.max(1, Math.floor(options.maximumRecords ?? DEFAULT_MAXIMUM_RECORDS));
    this.maximumBytes = Math.max(1_024, Math.floor(options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES));
    this.encodeBytes = options.encodeBytes || ((value) => Buffer.byteLength(value, "utf8"));
  }

  record(input: PromptEvidenceInput): void {
    try {
      if (!SESSION_ID.test(input.sessionId) || !PROMPT_ID.test(input.promptId)) return;
      if (!isPromptEvidenceFactKind(input.kind)) return;
      const now = this.now();
      this.prune(now);
      const promptId = input.promptId.toLowerCase();
      const stored = this.records.get(promptId);
      if (stored && stored.record.sessionId !== input.sessionId) return;
      const rpcGeneration = safeGeneration(input.rpcGeneration);
      const runGeneration = safeGeneration(input.runGeneration);
      const fact: PromptEvidenceFact = {
        sequence: ++this.sequence,
        observedAt: new Date(now).toISOString(),
        promptId,
        sessionId: input.sessionId,
        kind: input.kind,
        ...(rpcGeneration !== undefined ? { rpcGeneration } : null),
        ...(runGeneration !== undefined ? { runGeneration } : null),
      };
      const record = reducePromptEvidenceRecord(stored?.record, fact);
      if (record === stored?.record) return;
      const bytes = this.encodeBytes(JSON.stringify(record));
      if (stored) this.approximateBytes -= stored.bytes;
      this.records.set(promptId, {
        record,
        firstSequence: stored?.firstSequence || fact.sequence,
        lastSequence: fact.sequence,
        bytes,
      });
      this.approximateBytes += bytes;
      this.enforceBounds();
    } catch {
      // Evidence is diagnostic only and must never perturb PromptScheduler or RPC.
    }
  }

  clear(): void {
    this.records.clear();
    this.approximateBytes = 0;
  }

  snapshot(): PromptEvidenceSnapshot {
    const now = this.now();
    this.prune(now);
    const records = [...this.records.values()]
      .sort((left, right) => left.firstSequence - right.firstSequence)
      .map(({ record }) => ({ ...record, facts: [...record.facts] }));
    return {
      schemaVersion: 1,
      generatedAt: new Date(now).toISOString(),
      status: {
        recordCount: records.length,
        windowMs: this.windowMs,
        maximumRecords: this.maximumRecords,
        approximateBytes: this.approximateBytes,
        maximumBytes: this.maximumBytes,
      },
      records,
    };
  }

  private prune(now: number): void {
    const minimum = now - this.windowMs;
    for (const [promptId, stored] of this.records) {
      const observedAt = Date.parse(stored.record.lastObservedAt);
      if (!Number.isFinite(observedAt) || observedAt < minimum)
        this.delete(promptId, stored);
    }
  }

  private enforceBounds(): void {
    while (
      this.records.size > this.maximumRecords
      || this.approximateBytes > this.maximumBytes
    ) {
      const oldest = [...this.records.entries()].sort(
        ([, left], [, right]) => left.lastSequence - right.lastSequence,
      )[0];
      if (!oldest) break;
      this.delete(oldest[0], oldest[1]);
    }
  }

  private delete(promptId: string, stored: StoredPromptEvidence): void {
    if (!this.records.delete(promptId)) return;
    this.approximateBytes = Math.max(0, this.approximateBytes - stored.bytes);
  }
}
