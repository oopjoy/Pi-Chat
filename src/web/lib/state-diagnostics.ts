import {
  isPromptDeliveryCertainty,
  isPromptEvidenceFactKind,
  isPromptExecutionStatus,
  type PromptEvidenceSnapshot,
} from "../../shared/prompt-evidence";
import {
  isAllowedStateDiagnosticEvent,
  sanitizeStateDiagnosticDetails,
  shouldRetainStateDiagnosticEvent,
  type BrowserStateDiagnosticSnapshot,
  type StateDiagnosticEntry,
  type StateDiagnosticExportBundle,
  type StateDiagnosticStatus,
} from "../../shared/state-diagnostics";

const WINDOW_MS = 5 * 60 * 1_000;
const MAXIMUM_ENTRIES = 2_000;
const MAXIMUM_BYTES = 1024 * 1024;
const SAFE_SESSION_ID = /^[a-f0-9]{20}$/;
const SAFE_PROMPT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const pageStartedAt = new Date().toISOString();

interface BrowserStateDiagnosticsRecorderOptions {
  now?: () => number;
  windowMs?: number;
  maximumEntries?: number;
  maximumBytes?: number;
  encodeBytes?: (value: string) => number;
}

/** Page-local recorder with no business authority and a no-throw record path. */
export class BrowserStateDiagnosticsRecorder {
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

  constructor(options: BrowserStateDiagnosticsRecorderOptions = {}) {
    this.now = options.now || Date.now;
    this.windowMs = Math.max(10_000, Math.floor(options.windowMs ?? WINDOW_MS));
    this.maximumEntries = Math.max(100, Math.floor(options.maximumEntries ?? MAXIMUM_ENTRIES));
    this.maximumBytes = Math.max(64 * 1024, Math.floor(options.maximumBytes ?? MAXIMUM_BYTES));
    this.encodeBytes = options.encodeBytes || ((value) => new TextEncoder().encode(value).byteLength);
  }

  record(
    category: string,
    name: string,
    input: {
      sessionId?: string;
      promptId?: string;
      runGeneration?: number;
      rpcGeneration?: number;
      details?: Record<string, unknown>;
    } = {},
  ): void {
    try {
      if (!shouldRetainStateDiagnosticEvent(category, name, input.details)) return;
      const now = this.now();
      this.prune(now);
      const entry: StateDiagnosticEntry = {
        sequence: ++this.sequence,
        timestamp: new Date(now).toISOString(),
        source: "browser",
        category,
        name,
        ...(input.sessionId && SAFE_SESSION_ID.test(input.sessionId)
          ? { sessionId: input.sessionId }
          : null),
        ...(input.promptId && SAFE_PROMPT_ID.test(input.promptId)
          ? { promptId: input.promptId.toLowerCase() }
          : null),
        ...(typeof input.runGeneration === "number" && Number.isFinite(input.runGeneration)
          ? { runGeneration: Math.max(0, Math.floor(input.runGeneration)) }
          : null),
        ...(typeof input.rpcGeneration === "number" && Number.isFinite(input.rpcGeneration)
          ? { rpcGeneration: Math.max(0, Math.floor(input.rpcGeneration)) }
          : null),
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
      // A diagnostic failure must never block EventSource, fetch, or React state.
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

  entriesSnapshot(): StateDiagnosticEntry[] {
    this.prune(this.now());
    return this.entries
      .slice(this.head)
      .map((entry) => ({ ...entry, details: { ...entry.details } }));
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

const browserRecorder = new BrowserStateDiagnosticsRecorder();

export function recordBrowserStateDiagnostic(
  category: string,
  name: string,
  input: {
    sessionId?: string;
    promptId?: string;
    runGeneration?: number;
    rpcGeneration?: number;
    details?: Record<string, unknown>;
  } = {},
): void {
  browserRecorder.record(category, name, input);
}

export function browserStateDiagnosticStatus(): StateDiagnosticStatus {
  return browserRecorder.status();
}

export function browserStateDiagnosticSnapshot(): BrowserStateDiagnosticSnapshot {
  return {
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    pageStartedAt,
    status: browserRecorder.status(),
    entries: browserRecorder.entriesSnapshot(),
  };
}

const SAFE_EXPORT_METADATA = /^[A-Za-z0-9._-]{1,80}$/;
const EXPORT_WARNING =
  "仅含最近五分钟的脱敏结构状态；服务端与当前浏览器页面各自保持本地顺序，时间戳不代表跨进程绝对顺序。";

function safeExportInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)))
    : 0;
}

function safeExportTimestamp(value: unknown, fallback: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : fallback;
}

function safeExportMetadata(value: unknown): string {
  return typeof value === "string" && SAFE_EXPORT_METADATA.test(value)
    ? value
    : "unknown";
}

function safeBuildFingerprint(value: unknown): string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
    ? value.toLowerCase()
    : "unknown";
}

function safeExportStatus(status: StateDiagnosticStatus): StateDiagnosticStatus {
  return {
    entryCount: safeExportInteger(status.entryCount),
    windowMs: safeExportInteger(status.windowMs),
    maximumEntries: safeExportInteger(status.maximumEntries),
    approximateBytes: safeExportInteger(status.approximateBytes),
    maximumBytes: safeExportInteger(status.maximumBytes),
  };
}

/** Rebuild the exact export schema and alias stable Session IDs across both lanes. */
export function privacySafeStateDiagnosticBundle(
  bundle: StateDiagnosticExportBundle,
): StateDiagnosticExportBundle {
  const generatedAt = safeExportTimestamp(bundle.generatedAt, new Date().toISOString());
  const aliases = new Map<string, string>();
  const promptAliases = new Map<string, string>();
  const alias = (sessionId: string | undefined): string | undefined => {
    if (!sessionId || !SAFE_SESSION_ID.test(sessionId)) return undefined;
    let value = aliases.get(sessionId);
    if (!value) {
      value = `s${aliases.size + 1}`;
      aliases.set(sessionId, value);
    }
    return value;
  };
  const promptAlias = (promptId: string | undefined): string | undefined => {
    if (!promptId || !SAFE_PROMPT_ID.test(promptId)) return undefined;
    const normalized = promptId.toLowerCase();
    let value = promptAliases.get(normalized);
    if (!value) {
      value = `p${promptAliases.size + 1}`;
      promptAliases.set(normalized, value);
    }
    return value;
  };
  const entries = (
    items: StateDiagnosticEntry[],
    source: "server" | "browser",
  ): StateDiagnosticEntry[] => items.flatMap((entry) => {
    if (!isAllowedStateDiagnosticEvent(entry.category, entry.name)) return [];
    const sessionId = alias(entry.sessionId);
    const promptId = promptAlias(entry.promptId);
    const runGeneration = safeExportInteger(entry.runGeneration);
    const rpcGeneration = safeExportInteger(entry.rpcGeneration);
    return [{
      sequence: safeExportInteger(entry.sequence),
      timestamp: safeExportTimestamp(entry.timestamp, generatedAt),
      source,
      category: entry.category,
      name: entry.name,
      ...(sessionId ? { sessionId } : null),
      ...(promptId ? { promptId } : null),
      ...(entry.runGeneration !== undefined ? { runGeneration } : null),
      ...(entry.rpcGeneration !== undefined ? { rpcGeneration } : null),
      details: sanitizeStateDiagnosticDetails(entry.details),
    }];
  });
  const promptEvidence = (): PromptEvidenceSnapshot => {
    const input = bundle.server.promptEvidence;
    const fallbackGeneratedAt = safeExportTimestamp(input?.generatedAt, generatedAt);
    const records = Array.isArray(input?.records) ? input.records.flatMap((record) => {
      if (!record || typeof record !== "object") return [];
      if (!SAFE_SESSION_ID.test(record.sessionId) || !SAFE_PROMPT_ID.test(record.promptId)) return [];
      if (!isPromptDeliveryCertainty(record.delivery) || !isPromptExecutionStatus(record.execution)) return [];
      if (!Array.isArray(record.facts) || !record.facts.every(isPromptEvidenceFactKind)) return [];
      const sessionId = alias(record.sessionId);
      const promptId = promptAlias(record.promptId);
      if (!sessionId || !promptId) return [];
      const factCount = record.facts.length;
      const facts = factCount <= 64
        ? [...record.facts]
        : [...record.facts.slice(0, 16), ...record.facts.slice(-48)];
      return [{
        promptId,
        sessionId,
        firstObservedAt: safeExportTimestamp(record.firstObservedAt, fallbackGeneratedAt),
        lastObservedAt: safeExportTimestamp(record.lastObservedAt, fallbackGeneratedAt),
        delivery: record.delivery,
        execution: record.execution,
        ...(record.rpcGeneration !== undefined
          ? { rpcGeneration: safeExportInteger(record.rpcGeneration) }
          : null),
        ...(record.runGeneration !== undefined
          ? { runGeneration: safeExportInteger(record.runGeneration) }
          : null),
        facts,
        factCount,
        ...(factCount > facts.length ? { factsTruncated: true } : null),
        ...(record.conflicted === true ? { conflicted: true } : null),
      }];
    }) : [];
    return {
      schemaVersion: 1,
      generatedAt: fallbackGeneratedAt,
      status: {
        recordCount: records.length,
        windowMs: safeExportInteger(input?.status?.windowMs),
        maximumRecords: safeExportInteger(input?.status?.maximumRecords),
        approximateBytes: safeExportInteger(input?.status?.approximateBytes),
        maximumBytes: safeExportInteger(input?.status?.maximumBytes),
      },
      records,
    };
  };
  return {
    schemaVersion: 4,
    generatedAt,
    warning: EXPORT_WARNING,
    server: {
      schemaVersion: 4,
      generatedAt: safeExportTimestamp(bundle.server.generatedAt, generatedAt),
      runEpoch: safeExportMetadata(bundle.server.runEpoch),
      buildFingerprint: safeBuildFingerprint(bundle.server.buildFingerprint),
      status: safeExportStatus(bundle.server.status),
      entries: entries(bundle.server.entries, "server"),
      promptEvidence: promptEvidence(),
    },
    browser: {
      schemaVersion: 4,
      generatedAt: safeExportTimestamp(bundle.browser.generatedAt, generatedAt),
      pageStartedAt: safeExportTimestamp(bundle.browser.pageStartedAt, generatedAt),
      status: safeExportStatus(bundle.browser.status),
      entries: entries(bundle.browser.entries, "browser"),
    },
  };
}

export function downloadStateDiagnosticBundle(bundle: StateDiagnosticExportBundle): string {
  const safeBundle = privacySafeStateDiagnosticBundle(bundle);
  const stamp = safeBundle.generatedAt.replace(/[:.]/g, "-");
  const filename = `pi-chat-state-diagnostic-${stamp}.json`;
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(safeBundle, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
}
