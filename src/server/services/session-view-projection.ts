import type {
  GateMode,
  PendingPromptProjection,
  PendingSteer,
  PiMessage,
  PiState,
  QueuedPrompt,
  SessionStats,
  SessionSummary,
  SessionViewData,
  SlashCommand,
} from "../../shared/types.js";
import type { SessionFileSnapshot, SessionSettingsSnapshot, SessionUsageSnapshot } from "../session-index.js";
import { messageWindow } from "../pi-data.js";
import { reconcilePersistedHistory } from "../../shared/streaming-assistant.js";

export interface ColdSessionViewProjectionHost {
  modelFromSettings(settings: SessionSettingsSnapshot): PiState["model"];
  sessionActivity(sessionId: string): SessionSummary["activity"];
  offlineStats(sessionId: string, usage: SessionUsageSnapshot): SessionStats | undefined;
  currentGateMode(sessionId: string): GateMode | undefined;
  pendingRequest(sessionId: string): SessionViewData["pendingExtensionRequest"];
  controlState(sessionId: string, clientId: string): Partial<SessionViewData>;
}

export function projectColdSessionView(
  host: ColdSessionViewProjectionHost,
  input: {
    id: string;
    session: SessionSummary;
    snapshot: Pick<SessionFileSnapshot, "messages" | "settings" | "sourceMessageTotal" | "sourceTurnTotal" | "sourceMessagesTruncated" | "usageComplete"> & { usage?: SessionUsageSnapshot };
    turnLimit: number;
    clientId: string;
  },
): SessionViewData {
  const windowed = messageWindow(input.snapshot.messages, input.turnLimit);
  const messageTotal = input.snapshot.sourceMessageTotal ?? windowed.total;
  const turnTotal = input.snapshot.sourceTurnTotal ?? windowed.turns;
  return {
    session: {
      ...input.session,
      active: false,
      writable: false,
      running: false,
      queued: false,
      activity: host.sessionActivity(input.id),
    },
    state: {
      model: host.modelFromSettings(input.snapshot.settings || {}),
      thinkingLevel: input.snapshot.settings?.thinkingLevel,
      fastModeActive: false,
      isStreaming: false,
      isCompacting: false,
      sessionFile: undefined,
      sessionId: input.session.sessionId,
      sessionName: input.session.name,
      messageCount: input.session.messageCount,
    },
    messages: windowed.messages,
    messageTotal,
    turnTotal,
    visibleTurnCount: windowed.visibleTurns,
    messagesTruncated: windowed.truncated || input.snapshot.sourceMessagesTruncated === true,
    isActive: false,
    runtimeStatus: "view-only",
    isStreaming: false,
    stats: input.snapshot.usage && input.snapshot.usageComplete !== false
      ? host.offlineStats(input.id, input.snapshot.usage)
      : undefined,
    gateAvailable: true,
    gateMode: host.currentGateMode(input.id),
    commands: [],
    viewSource: "cold-jsonl",
    pendingExtensionRequest: host.pendingRequest(input.id),
    ...host.controlState(input.id, input.clientId),
  };
}

export interface HotMemoryViewSource {
  summary: SessionSummary;
  persisted?: PiMessage[];
  terminalTail: PiMessage[];
  state: PiState;
  streaming: boolean;
  liveMessage?: PiMessage;
  toolStatus?: string;
  stats?: SessionStats;
  queue: QueuedPrompt[];
  queuePaused: boolean;
  commands?: SlashCommand[];
  gateMode: GateMode;
  historyPending: boolean;
  reconcilePending: boolean;
}

export interface HotMemoryViewProjectionHost extends ColdSessionViewProjectionHost {
  touch(sessionId: string): void;
  reconcilePendingPrompts(sessionId: string, messages: PiMessage[]): void;
  pendingPrompt(sessionId: string): PendingPromptProjection | undefined;
  pendingSteers(sessionId: string): { items: PendingSteer[]; revision: number };
  stateWithPendingPromptSettings(sessionId: string, state: PiState): PiState;
  stateWithFastMode(sessionId: string, state: PiState): PiState;
}

export function projectHotMemoryView(
  host: HotMemoryViewProjectionHost,
  input: { id: string; turnLimit: number; clientId: string; primary: boolean; source: HotMemoryViewSource },
): SessionViewData {
  const source = input.source;
  host.touch(input.id);
  const messages = reconcilePersistedHistory(source.persisted || [], source.terminalTail).messages;
  host.reconcilePendingPrompts(input.id, source.persisted || []);
  const pendingPrompt = host.pendingPrompt(input.id);
  const pendingSteerProjection = host.pendingSteers(input.id);
  const windowed = messageWindow(messages, input.turnLimit);
  const state = host.stateWithPendingPromptSettings(input.id, source.state);
  return {
    session: {
      ...source.summary,
      active: true,
      writable: true,
      running: source.streaming,
      queued: source.queue.length > 0,
      activity: host.sessionActivity(input.id),
    },
    state: host.stateWithFastMode(input.id, { ...state, isStreaming: source.streaming }),
    messages: windowed.messages,
    messageTotal: windowed.total,
    turnTotal: windowed.turns,
    visibleTurnCount: windowed.visibleTurns,
    messagesTruncated: windowed.truncated,
    isActive: true,
    runtimeStatus: "active",
    isStreaming: source.streaming,
    liveMessage: source.liveMessage,
    toolStatus: source.toolStatus,
    stats: source.stats,
    queue: source.queue,
    queuePaused: source.queuePaused,
    commands: source.commands?.length
      ? source.commands
      : undefined,
    gateMode: source.gateMode,
    pendingExtensionRequest: host.pendingRequest(input.id),
    ...(pendingPrompt ? { pendingPrompt } : null),
    pendingSteers: pendingSteerProjection.items,
    pendingSteerRevision: pendingSteerProjection.revision,
    historyPending: source.historyPending,
    reconcilePending: source.reconcilePending,
    viewSource: "hot-memory",
    ...host.controlState(input.id, input.clientId),
  };
}
