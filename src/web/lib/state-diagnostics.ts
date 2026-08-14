import {
  sanitizeStateDiagnosticDetails,
  type BrowserStateDiagnosticSnapshot,
  type StateDiagnosticEntry,
  type StateDiagnosticExportBundle,
  type StateDiagnosticStatus,
} from "../../shared/state-diagnostics";

const WINDOW_MS = 5 * 60 * 1_000;
const MAXIMUM_ENTRIES = 2_000;
const MAXIMUM_BYTES = 1024 * 1024;
const SAFE_NAME = /^[a-z0-9_.:-]{1,80}$/i;
const SAFE_SESSION_ID = /^[a-f0-9]{20}$/;
const SAFE_CAPTURE_ID = /^[a-f0-9]{24}$/;
const pageStartedAt = new Date().toISOString();
let active = false;
let captureId = "";
let startedAtMs = 0;
let sequence = 0;
let entries: StateDiagnosticEntry[] = [];
let entryBytes: number[] = [];
let approximateBytes = 0;

function prune(now = Date.now()): void {
  const minimum = now - WINDOW_MS;
  let remove = 0;
  while (remove < entries.length) {
    const timestamp = Date.parse(entries[remove].timestamp);
    if (!Number.isFinite(timestamp) || timestamp >= minimum) break;
    remove += 1;
  }
  if (remove) {
    entries.splice(0, remove);
    const removedBytes = entryBytes.splice(0, remove);
    approximateBytes -= removedBytes.reduce((total, value) => total + value, 0);
  }
}

export function startBrowserStateDiagnostics(): StateDiagnosticStatus {
  active = true;
  captureId = "";
  startedAtMs = Date.now();
  sequence = 0;
  entries = [];
  entryBytes = [];
  approximateBytes = 0;
  recordBrowserStateDiagnostic("capture", "started");
  return browserStateDiagnosticStatus();
}

export function stopBrowserStateDiagnostics(): StateDiagnosticStatus {
  if (active) recordBrowserStateDiagnostic("capture", "stopped");
  active = false;
  return browserStateDiagnosticStatus();
}

export function browserStateDiagnosticsActive(): boolean {
  return active;
}

export function bindBrowserStateDiagnosticCaptureId(value: string): void {
  captureId = SAFE_CAPTURE_ID.test(value) ? value : "";
}

export function recordBrowserStateDiagnostic(
  category: string,
  name: string,
  input: {
    sessionId?: string;
    runGeneration?: number;
    rpcGeneration?: number;
    details?: Record<string, unknown>;
  } = {},
): void {
  if (!active || !SAFE_NAME.test(category) || !SAFE_NAME.test(name)) return;
  const now = Date.now();
  prune(now);
  const entry: StateDiagnosticEntry = {
    sequence: ++sequence,
    timestamp: new Date(now).toISOString(),
    source: "browser",
    category,
    name,
    ...(input.sessionId && SAFE_SESSION_ID.test(input.sessionId)
      ? { sessionId: input.sessionId }
      : null),
    ...(typeof input.runGeneration === "number" && Number.isFinite(input.runGeneration)
      ? { runGeneration: Math.max(0, Math.floor(input.runGeneration)) }
      : null),
    ...(typeof input.rpcGeneration === "number" && Number.isFinite(input.rpcGeneration)
      ? { rpcGeneration: Math.max(0, Math.floor(input.rpcGeneration)) }
      : null),
    details: sanitizeStateDiagnosticDetails(input.details),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
  entries.push(entry);
  entryBytes.push(bytes);
  approximateBytes += bytes;
  while (entries.length > MAXIMUM_ENTRIES || approximateBytes > MAXIMUM_BYTES) {
    entries.shift();
    approximateBytes -= entryBytes.shift() || 0;
  }
}

export function browserStateDiagnosticStatus(): StateDiagnosticStatus {
  prune();
  return {
    active,
    ...(captureId ? { captureId } : null),
    ...(startedAtMs ? { startedAt: new Date(startedAtMs).toISOString() } : null),
    entryCount: entries.length,
    windowMs: WINDOW_MS,
    maximumEntries: MAXIMUM_ENTRIES,
    approximateBytes,
    maximumBytes: MAXIMUM_BYTES,
  };
}

export function browserStateDiagnosticSnapshot(): BrowserStateDiagnosticSnapshot {
  prune();
  return {
    generatedAt: new Date().toISOString(),
    pageStartedAt,
    status: browserStateDiagnosticStatus(),
    entries: entries.map((entry) => ({ ...entry, details: { ...entry.details } })),
  };
}

export function downloadStateDiagnosticBundle(bundle: StateDiagnosticExportBundle): string {
  const stamp = bundle.generatedAt.replace(/[:.]/g, "-");
  const filename = `pi-chat-state-diagnostic-${stamp}.json`;
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(bundle, null, 2)}\n`], {
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
