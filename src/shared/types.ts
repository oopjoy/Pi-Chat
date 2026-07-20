export interface SessionSummary {
  id: string;
  sessionId: string;
  name: string;
  preview: string;
  cwd: string;
  updatedAt: number;
  messageCount: number;
  active: boolean;
  writable?: boolean;
  running?: boolean;
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

export interface PiMessage {
  role: string;
  content: string | PiContentBlock[];
  timestamp?: number;
  stopReason?: string;
  provider?: string;
  model?: string;
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
}

export interface PiState {
  model: ModelInfo | null;
  thinkingLevel?: string;
  isStreaming: boolean;
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

export interface QueuedPrompt {
  id: string;
  message: string;
  imageCount: number;
  createdAt: number;
}

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
}

export interface SessionViewData {
  session: SessionSummary;
  state: PiState;
  messages: PiMessage[];
  messageTotal: number;
  turnTotal?: number;
  messagesTruncated: boolean;
  isActive: boolean;
  isStreaming: boolean;
  liveMessage?: PiMessage;
  toolStatus?: string;
  stats?: SessionStats;
  queue?: QueuedPrompt[];
  queuePaused?: boolean;
  todos?: TodoItem[];
  commands?: SlashCommand[];
}

export interface BootstrapData {
  state: PiState;
  messages: PiMessage[];
  sessions: SessionSummary[];
  models: ModelInfo[];
  commands: SlashCommand[];
  queue: QueuedPrompt[];
  queuePaused: boolean;
  workspaceCwd: string;
  messageTotal?: number;
  turnTotal?: number;
  messagesTruncated?: boolean;
  activeSessionId?: string;
  activeSessionIds?: string[];
  liveMessage?: PiMessage;
  toolStatus?: string;
  stats?: SessionStats;
  piVersion?: string;
  todos?: TodoItem[];
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
  removable: boolean;
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
  removable: boolean;
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
  removable: boolean;
  installedPath?: string;
  version?: string;
  description?: string;
  resources: PluginResourceItem[];
}

/** @deprecated Use PackageResource. Kept as a compatibility alias for API consumers. */
export type PluginResource = PackageResource;

export interface ResourceResponse<T> {
  resources: T[];
  diagnostics: string[];
  reloaded?: boolean;
}

export interface ApiError {
  error: string;
}
