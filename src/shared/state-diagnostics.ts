export type StateDiagnosticSource = "server" | "browser";
export type StateDiagnosticValue = string | number | boolean | null;

export interface StateDiagnosticEntry {
  sequence: number;
  timestamp: string;
  source: StateDiagnosticSource;
  category: string;
  name: string;
  sessionId?: string;
  /** Process-local prompt correlation. Export replaces server UUIDs with p1, p2, ... aliases. */
  promptId?: string;
  runGeneration?: number;
  rpcGeneration?: number;
  details: Record<string, StateDiagnosticValue>;
}

export interface StateDiagnosticStatus {
  entryCount: number;
  windowMs: number;
  maximumEntries: number;
  approximateBytes: number;
  maximumBytes: number;
}

export interface ServerStateDiagnosticSnapshot {
  schemaVersion: 3;
  generatedAt: string;
  runEpoch: string;
  buildFingerprint: string;
  status: StateDiagnosticStatus;
  entries: StateDiagnosticEntry[];
}

export interface BrowserStateDiagnosticSnapshot {
  schemaVersion: 3;
  generatedAt: string;
  pageStartedAt: string;
  status: StateDiagnosticStatus;
  entries: StateDiagnosticEntry[];
}

export interface StateDiagnosticExportBundle {
  schemaVersion: 3;
  generatedAt: string;
  warning: string;
  server: ServerStateDiagnosticSnapshot;
  browser: BrowserStateDiagnosticSnapshot;
}

const BOOLEAN_DETAIL_KEYS = new Set([
  "authorityPresent",
  "compacting",
  "composerDisabled",
  "composerQueueVisible",
  "composerSendVisible",
  "composerSteerEligible",
  "composerStopVisible",
  "controlledByThisWindow",
  "dispatching",
  "eventQueuePaused",
  "eventRunning",
  "failed",
  "foreignOwnerPresent",
  "found",
  "hasLive",
  "observing",
  "terminal",
  "pendingConfirmation",
  "promptStarting",
  "queuePaused",
  "running",
  "sessionRunning",
  "sidebarQueued",
  "sidebarRunning",
  "stateStreaming",
  "stopping",
  "toolActive",
  "viewStreaming",
  "viewed",
  "viewing",
  "visible",
]);

const NUMBER_DETAIL_KEYS = new Set([
  "durationMs",
  "paintDelayMs",
  "eventQueueLength",
  "navigationEpoch",
  "openWindows",
  "pendingBytes",
  "queueLength",
  "readyState",
  "sidebarConfirmationCount",
  "sidebarFailedCount",
  "sidebarForeignOwnerCount",
  "sidebarPausedCount",
  "sidebarQueuedCount",
  "sidebarRows",
  "sidebarRunningCount",
  "size",
  "sourceGeneration",
  "snapshotsAdmitted",
  "snapshotsBackpressured",
  "snapshotsCleared",
  "snapshotsCommitted",
  "snapshotsDrained",
  "snapshotsOffscreen",
  "snapshotsOversized",
  "snapshotsNoClients",
  "snapshotsQueueReplaced",
  "snapshotsQueued",
  "snapshotsReceived",
  "snapshotsReplaced",
  "snapshotsScheduled",
  "snapshotsWriteErrors",
  "snapshotsWritten",
  "status",
  "transcriptCount",
  "transportClients",
]);

const EXECUTION_VALUES = new Set([
  "idle",
  "queued",
  "dispatching",
  "running",
  "paused",
  "failed",
  "none",
  "unknown",
]);

const EVENT_TYPE_VALUES = new Set([
  "agent_start",
  "agent_settled",
  "compaction_start",
  "compaction_end",
  "extension_error",
  "extension_ui_request",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "pi_chat_active_session_changed",
  "pi_chat_application_closing",
  "pi_chat_application_lifecycle",
  "pi_chat_extension_request_resolved",
  "pi_chat_extension_request_timeout",
  "pi_chat_gate_mode_changed",
  "pi_chat_heartbeat",
  "pi_chat_native_steering_cleared",
  "pi_chat_oversized_event",
  "pi_chat_primary_runtime_status",
  "pi_chat_process_error",
  "pi_chat_process_recovered",
  "pi_chat_prompt_delivery_uncertain",
  "pi_chat_queue_dispatch",
  "pi_chat_queue_error",
  "pi_chat_queue_update",
  "pi_chat_reloaded",
  "pi_chat_session_control_changed",
  "pi_chat_session_status",
  "pi_chat_sessions_changed",
  "pi_chat_sse_resync",
  "pi_chat_workspace_changed",
  "unknown",
]);

const STATIC_API_ROUTES = new Set([
  "/api/bootstrap",
  "/api/bootstrap/handshake",
  "/api/chat/abort",
  "/api/chat/compact",
  "/api/chat/prompt",
  "/api/chat/queue/resume",
  "/api/diagnostics/snapshot",
  "/api/events",
  "/api/extension-ui/respond",
  "/api/extension/respond",
  "/api/health",
  "/api/local-files/clipboard",
  "/api/local-files/pick",
  "/api/models",
  "/api/models/set",
  "/api/presence",
  "/api/resources/browse",
  "/api/resources/extensions",
  "/api/resources/packages",
  "/api/resources/skills",
  "/api/restart",
  "/api/sessions",
  "/api/sessions/new",
  "/api/sessions/viewing/clear",
  "/api/shutdown",
  "/api/thinking/set",
  "/api/window/close",
  "/api/workspace/draft-pick",
  "/api/workspace/pick",
  "/api/workspace/set",
]);

const DYNAMIC_API_ROUTES: Array<[RegExp, string]> = [
  [/^\/api\/chat\/queue\/[a-f0-9-]{36}$/i, "/api/chat/queue/:queueId"],
  [/^\/api\/sessions\/[a-f0-9]{20}$/i, "/api/sessions/:sessionId"],
  [/^\/api\/sessions\/[a-f0-9]{20}\/activate$/i, "/api/sessions/:sessionId/activate"],
  [/^\/api\/sessions\/[a-f0-9]{20}\/control$/i, "/api/sessions/:sessionId/control"],
  [/^\/api\/sessions\/[a-f0-9]{20}\/view$/i, "/api/sessions/:sessionId/view"],
  [/^\/api\/sessions\/[a-f0-9]{20}\/viewing$/i, "/api/sessions/:sessionId/viewing"],
  [/^\/api\/sessions\/[a-f0-9]{20}\/warm$/i, "/api/sessions/:sessionId/warm"],
];

function canonicalApiRoute(value: string): string {
  if (STATIC_API_ROUTES.has(value)) return value;
  for (const [pattern, template] of DYNAMIC_API_ROUTES) {
    if (pattern.test(value)) return template;
  }
  return "/api/unknown";
}

const ENUM_DETAIL_VALUES: Record<string, ReadonlySet<string>> = {
  activityExecution: EXECUTION_VALUES,
  channel: new Set(["pi", "ready", "unknown"]),
  decisionReason: new Set([
    "accepted",
    "committed",
    "missing-session",
    "session-deleted",
    "settled-run-generation",
    "stale-draft-authority",
    "stale-pane-authority",
    "stale-refresh-authority",
    "stale-run-epoch",
    "stale-run-generation",
    "unknown",
  ]),
  disconnectReason: new Set([
    "request-close",
    "write-error",
    "pending-buffer-limit",
    "shutdown",
    "unknown",
  ]),
  errorType: new Set([
    "AbortError",
    "DOMException",
    "Error",
    "RangeError",
    "SyntaxError",
    "TimeoutError",
    "TypeError",
    "object",
    "string",
    "unknown",
  ]),
  eventExecution: EXECUTION_VALUES,
  eventType: EVENT_TYPE_VALUES,
  execution: EXECUTION_VALUES,
  lifecycle: new Set([
    "idle",
    "restarting",
    "shutting-down",
    "workspace-changing",
    "resources-reloading",
    "unknown",
  ]),
  method: new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "unknown"]),
  originalEventType: EVENT_TYPE_VALUES,
  outcome: new Set([
    "no-clients",
    "scheduled",
    "scheduled-replaced",
    "oversized-substitute",
    "written",
    "written-backpressured",
    "queued",
    "queue-replaced",
    "write-error",
    "disconnected",
    "unknown",
  ]),
  paneKind: new Set(["draft", "none", "session", "unknown"]),
  primaryStatus: new Set(["failed", "ready", "starting", "unknown"]),
  runtimeStatus: new Set(["active", "draft", "none", "restoring", "view-only", "unknown"]),
  sidebarExecution: EXECUTION_VALUES,
  viewSource: new Set(["browser-cache", "cold-jsonl", "hot-memory", "none", "unknown"]),
};

const STATE_DIAGNOSTIC_EVENT_PAIRS = new Set([
  "diagnostic:export-requested",
  "prompt:admitted",
  "prompt:agent-start",
  "prompt:cancelled",
  "prompt:delivery-uncertain",
  "prompt:dispatch",
  "prompt:process-failed",
  "prompt:queued",
  "prompt:requeued",
  "prompt:rpc-allocated",
  "prompt:rpc-failed",
  "prompt:rpc-response",
  "prompt:rpc-written",
  "prompt:settled",
  "prompt:settlement-barrier",
  "http:request-end",
  "http:request-error",
  "http:request-start",
  "projection:bootstrap",
  "projection:bootstrap-accepted",
  "projection:bootstrap-committed",
  "projection:bootstrap-received",
  "projection:bootstrap-rejected",
  "projection:session-view",
  "projection:session-view-accepted",
  "projection:session-view-committed",
  "projection:session-view-fast",
  "projection:session-view-received",
  "projection:session-view-rejected",
  "projection:sidebar-session",
  "projection:ui-state",
  "render:first-assistant-paint-opportunity",
  "render:stream-summary",
  "rpc-event:received",
  "sse:admitted",
  "sse:broadcast-control",
  "sse:broadcast-intent",
  "sse:connected",
  "sse:error",
  "sse:ready",
  "sse:received",
  "sse:rejected",
  "sse-transport:disconnected",
  "sse-transport:snapshot-summary",
  "sse-transport:no-clients",
  "sse-transport:oversized-substitute",
  "sse-transport:queue-replaced",
  "sse-transport:queued",
  "sse-transport:scheduled",
  "sse-transport:scheduled-replaced",
  "sse-transport:write-error",
  "sse-transport:written",
  "sse-transport:written-backpressured",
]);

const HIGH_FREQUENCY_EVENT_TYPES = new Set([
  "message_update",
  "tool_execution_update",
  "pi_chat_heartbeat",
]);

/** Diagnostic names are closed metadata, never caller-controlled labels. */
export function isAllowedStateDiagnosticEvent(category: string, name: string): boolean {
  return STATE_DIAGNOSTIC_EVENT_PAIRS.has(`${category}:${name}`);
}

export function isHighFrequencyStateDiagnosticEventType(value: unknown): boolean {
  return typeof value === "string" && HIGH_FREQUENCY_EVENT_TYPES.has(value);
}

/** Filter hot cumulative frames before projection building or JSON encoding. */
export function shouldRetainStateDiagnosticEvent(
  category: string,
  name: string,
  details: Record<string, unknown> | undefined,
): boolean {
  const rejectedSse = category === "sse" && name === "rejected";
  if (isHighFrequencyStateDiagnosticEventType(details?.eventType) && !rejectedSse) return false;
  if (!isAllowedStateDiagnosticEvent(category, name)) return false;
  if (category === "sse-transport" && (name === "scheduled" || name === "scheduled-replaced"))
    return false;
  return true;
}

function safeDiagnosticString(key: string, value: string): string | undefined {
  if (key === "route") return canonicalApiRoute(value);
  const allowed = ENUM_DETAIL_VALUES[key];
  if (!allowed) return undefined;
  return allowed.has(value) ? value : "unknown";
}

/**
 * Closed, scalar-only diagnostic detail schema shared by server and browser.
 * Unknown keys are dropped; unknown enum values become `unknown` rather than
 * retaining attacker-, extension-, or model-controlled text.
 */
export function sanitizeStateDiagnosticDetails(
  details: Record<string, unknown> | undefined,
): Record<string, StateDiagnosticValue> {
  const safe: Record<string, StateDiagnosticValue> = {};
  if (!details) return safe;
  for (const [key, value] of Object.entries(details).slice(0, 40)) {
    if (BOOLEAN_DETAIL_KEYS.has(key)) {
      if (typeof value === "boolean") safe[key] = value;
      continue;
    }
    if (NUMBER_DETAIL_KEYS.has(key)) {
      if (typeof value === "number" && Number.isFinite(value))
        safe[key] = Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, value));
      continue;
    }
    if (typeof value !== "string") continue;
    const normalized = safeDiagnosticString(key, value);
    if (normalized !== undefined) safe[key] = normalized;
  }
  return safe;
}
