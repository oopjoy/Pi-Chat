/** Explicit delivery behavior for a message submitted while Pi is already running. */
export type PromptDelivery = "queue" | "steer";

/** Authoritative Runtime work phase for Sidebar presentation and HTTP snapshots. */
export type SessionExecutionState = "idle" | "queued" | "dispatching" | "running" | "paused" | "failed";

/** Server-owned activity facts. Browser-local unseen completion remains separate. */
export interface SessionActivityState {
  execution: SessionExecutionState;
  awaitingConfirmation: boolean;
  /** Short runtime diagnostic retained while this Session remains failed. */
  error?: string;
}

export interface SessionDirectorySummary {
  cwd: string;
  count: number;
  lastUserPromptAt: number;
}

export interface SessionSummary {
  id: string;
  sessionId: string;
  name: string;
  preview: string;
  cwd: string;
  /** Last JSONL/file activity; shown as relative time, but never used to reorder active streams. */
  updatedAt: number;
  /** Persisted/accepted user-instruction time used for stable sidebar recency ordering. */
  lastUserPromptAt?: number;
  messageCount: number;
  /** Number of user-initiated turns, including turns later aborted or failed. */
  turnCount?: number;
  active: boolean;
  writable?: boolean;
  running?: boolean;
  queued?: boolean;
  pendingConfirmation?: boolean;
  /** Authoritative execution/confirmation snapshot used by Sidebar status. */
  activity?: SessionActivityState;
  /** One browser window may control a Session; other windows are read-only observers. */
  controlOwner?: string;
  controlledByThisWindow?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  custom?: boolean;
}

export interface CustomModelInput {
  provider: string;
  id: string;
  name?: string;
  baseUrl?: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  apiKey?: string;
  reasoning: boolean;
  imageInput: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CustomModelConfig extends CustomModelInput {
  /** API keys are never returned by the server; an empty value preserves the existing key on save. */
  apiKey: "";
}

export interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
  data?: string;
  mimeType?: string;
}

/** Local-only read-only transcript role for intercom deliveries; never sent to Pi. */
export const LOCAL_COORDINATION_ROLE = "localCoordination";

export interface PiMessage {
  /** Pi Chat-only metadata for a localCoordination event. */
  localCoordination?: { source?: string };
  role: string;
  /** Metadata records such as compactionSummary legitimately omit content. */
  content?: string | PiContentBlock[];
  summary?: string;
  tokensBefore?: number;
  timestamp?: number;
  stopReason?: string;
  provider?: string;
  model?: string;
  /** Thinking level active when this assistant turn was generated, when Pi recorded it. */
  thinkingLevel?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface SessionStats {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  /** Compaction completed; the next turn will establish a new authoritative occupancy. */
  contextUsagePendingRefresh?: boolean;
}

export interface PiState {
  model: ModelInfo | null;
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
}

export interface SlashCommand {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill";
}

export interface ExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: string;
  piChatSessionId?: string;
}

export interface QueuedPrompt {
  id: string;
  message: string;
  imageCount: number;
  createdAt: number;
}

/** Strict confirms write/edit plus best-effort recognized high-risk Bash; open skips Gate prompts. */
export type GateMode = "strict" | "open";

/** A dedicated Session Runtime is ready to accept mutations; full history and
 * command/stat snapshots intentionally remain outside this latency-sensitive
 * capability check. */
export interface SessionRuntimeReadyData {
  sessionId: string;
  state: PiState;
  gateMode: GateMode;
}

export interface InitialPromptRequest {
  message: string;
  images?: PromptImage[];
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  gateMode?: GateMode;
}

export interface InitialPromptData extends SessionRuntimeReadyData {
  /** The draft identity becomes durable for browser routing before JSONL indexing catches up. */
  session: SessionSummary;
  accepted: boolean;
  queued: false;
  /** Pi received the initial JSONL command but its response timed out. */
  deliveryUncertain?: boolean;
  extension?: boolean;
  command?: string;
  description?: string;
  isStreaming?: boolean;
  id?: string;
  queue?: QueuedPrompt[];
}

export interface SessionViewData {
  session: SessionSummary;
  state: PiState;
  messages: PiMessage[];
  messageTotal: number;
  turnTotal?: number;
  visibleTurnCount?: number;
  messagesTruncated: boolean;
  isActive: boolean;
  runtimeStatus?: "active" | "restoring" | "view-only";
  isStreaming: boolean;
  liveMessage?: PiMessage;
  toolStatus?: string;
  stats?: SessionStats;
  queue?: QueuedPrompt[];
  queuePaused?: boolean;
  commands?: SlashCommand[];
  /** Present on cold view-only sessions where no RPC command list exists; live sessions infer it from commands. */
  gateAvailable?: boolean;
  /** Authoritative mode for a live Pi Runtime. Cold view-only sessions omit it. */
  gateMode?: GateMode;
  pendingExtensionRequest?: ExtensionUiRequest;
  controlOwner?: string;
  controlledByThisWindow?: boolean;
  /** A hot-memory view is immediately usable but its JSONL transcript is still warming. */
  historyPending?: boolean;
  /** A follow-up authoritative view should refresh incomplete hot-memory metadata. */
  reconcilePending?: boolean;
  /** Diagnostic source for navigation-performance measurement. */
  viewSource?: "browser-cache" | "hot-memory" | "cold-jsonl";
}

export type ApplicationLifecycle = "idle" | "restarting" | "shutting-down" | "workspace-changing" | "resources-reloading";

/** Primary Pi process capability is separate from Session/JSONL availability. */
export type PrimaryRuntimeStatus = "starting" | "ready" | "failed";
export interface PrimaryRuntimeReadiness {
  status: PrimaryRuntimeStatus;
  /** Safe diagnostic for UI; never a stack trace or raw transport payload. */
  error?: string;
  /** Monotonic controller generation; guards later retry/recovery transitions. */
  generation: number;
}

export interface BuildIdentity {
  schemaVersion: 1;
  packageVersion: string;
  /** Optional build-pipeline revision label; it is never a local path or secret. */
  revision: string;
  /** SHA-256 fingerprint of the project build inputs. This is the equality key. */
  fingerprint: string;
  /** Diagnostic-only timestamp, excluded from identity comparison. */
  builtAt: string;
}

export interface HealthData {
  ok: true;
  service: "pi-chat";
  lifecycle: ApplicationLifecycle;
  buildIdentity: BuildIdentity;
}

export interface BootstrapHandshakeData {
  buildIdentity: BuildIdentity;
  /** Ephemeral same-origin request token, rotated whenever Pi Chat starts. */
  requestToken: string;
}

export interface BootstrapData {
  buildIdentity: BuildIdentity;
  state: PiState;
  messages: PiMessage[];
  sessions: SessionSummary[];
  /** All known cwd groups; rows themselves may be a bounded initial page. */
  sessionDirectories?: SessionDirectorySummary[];
  /** Total matching Sessions before the default recent-list limit. */
  sessionsTotal?: number;
  models: ModelInfo[];
  commands: SlashCommand[];
  queue: QueuedPrompt[];
  queuePaused: boolean;
  workspaceCwd: string;
  /** Scoped to workspaceEpoch; prevents stale bootstrap metadata from undoing workspace SSE. */
  workspaceRevision?: number;
  /** Pi Chat process epoch that scopes workspaceRevision across a handoff. */
  workspaceEpoch?: string;
  messageTotal?: number;
  turnTotal?: number;
  visibleTurnCount?: number;
  messagesTruncated?: boolean;
  activeSessionId?: string;
  activeSessionIds?: string[];
  liveMessage?: PiMessage;
  toolStatus?: string;
  stats?: SessionStats;
  piVersion?: string;
  /** Ephemeral same-origin request token, rotated whenever Pi Chat starts. */
  requestToken?: string;
  pendingExtensionRequest?: ExtensionUiRequest;
  /** Authoritative mode of the active Primary Runtime. */
  gateMode?: GateMode;
  controlOwner?: string;
  controlledByThisWindow?: boolean;
  applicationLifecycle?: ApplicationLifecycle;
  /** Session browsing remains available while this is starting or failed. */
  primaryRuntime: PrimaryRuntimeReadiness;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
  fileName?: string;
  size?: number;
}

export interface SkillResource {
  id: string;
  name: string;
  description: string;
  pathLabel: string;
  source: "user" | "agents" | "package" | "custom";
  packageSource?: string;
  enabled: boolean;
  content: string;
}

export interface PluginResourceItem {
  kind: "extension" | "skill" | "prompt" | "theme";
  name: string;
  relativePath: string;
}

export interface ExtensionResource {
  id: string;
  name: string;
  source: string;
  scope: "global" | "project";
  enabled: boolean;
  installedPath?: string;
  /** Package-owned extensions inherit the package switch and are intentionally read-only here. */
  packageSource?: string;
}

export interface PackageResource {
  id: string;
  name: string;
  source: string;
  scope: "global" | "project";
  enabled: boolean;
  installedPath?: string;
  version?: string;
  description?: string;
  resources: PluginResourceItem[];
}

export interface ResourceResponse<T> {
  resources: T[];
  diagnostics: string[];
}

export interface ApiError {
  error: string;
}
