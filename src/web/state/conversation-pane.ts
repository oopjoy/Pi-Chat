import { appendTerminalMessage } from "../../shared/streaming-assistant";
import type {
  ExtensionUiRequest,
  PiMessage,
  PiState,
  QueuedPrompt,
  SessionStats,
  SlashCommand,
} from "../../shared/types";

export type ConversationPaneIdentity =
  | { kind: "none"; sessionId: "" }
  | { kind: "draft"; sessionId: "" }
  | { kind: "session"; sessionId: string };

export type ConversationRuntimeStatus =
  | "active"
  | "restoring"
  | "view-only"
  | "draft";

export interface ConversationPaneState {
  identity: ConversationPaneIdentity;
  piState: PiState;
  messages: PiMessage[];
  pendingUserMessage: PiMessage | null;
  messageTotal: number;
  turnTotal: number;
  visibleTurnCount: number;
  messagesTruncated: boolean;
  stats?: SessionStats;
  liveMessage: PiMessage | null;
  commands: SlashCommand[];
  queue: QueuedPrompt[];
  queuePaused: boolean;
  toolStatus: string;
  extensionRequest: ExtensionUiRequest | null;
  runtimeStatus: ConversationRuntimeStatus;
  control: {
    controlOwner?: string;
    controlledByThisWindow?: boolean;
  };
  gateAvailableOverride: boolean | null;
  draftWorkspaceCwd: string;
  promptStarting: boolean;
}

export type ConversationPaneCommit = Omit<ConversationPaneState, "identity"> & {
  identity: ConversationPaneIdentity;
};

/** A synchronous reducer target only; async authority remains in App. */
export type ConversationPaneTarget =
  | { kind: "draft" }
  | { kind: "session"; sessionId: string };

export type ConversationPaneAction =
  | { type: "COMMIT_BOOTSTRAP"; pane: ConversationPaneCommit }
  /** A hot view may intentionally omit command discovery; retain the prior pane value. */
  | { type: "COMMIT_VIEW"; pane: ConversationPaneCommit }
  | {
      type: "RESET_DRAFT";
      model: PiState["model"];
      thinkingLevel?: string;
      draftWorkspaceCwd: string;
    }
  | { type: "CLEAR_PANE" }
  | { type: "RUNTIME_READY"; sessionId: string; state: Partial<PiState> }
  | { type: "RUNTIME_FAILED"; sessionId: string }
  | {
      type: "SETTINGS_CONFIRMED";
      sessionId: string;
      state: Partial<Pick<PiState, "model" | "thinkingLevel">>;
    }
  | {
      type: "PREFERENCES_STAGED";
      target: ConversationPaneTarget;
      model?: PiState["model"];
      thinkingLevel?: PiState["thinkingLevel"];
    }
  | {
      type: "COMPACTION_STARTED";
      sessionId: string;
      status: string;
    }
  | { type: "COMPACTION_FINISHED"; sessionId: string }
  | {
      type: "LIVE_MESSAGE_UPDATED";
      sessionId: string;
      message: PiMessage | null;
    }
  | {
      type: "TOOL_RESULT_COMMITTED";
      sessionId: string;
      message: PiMessage;
    }
  | { type: "TOOL_STATUS_UPDATED"; sessionId: string; status: string }
  | { type: "FAST_MODE_CHANGED"; sessionId: string; active: boolean }
  | {
      type: "EXTENSION_REQUEST_CHANGED";
      sessionId: string;
      request: ExtensionUiRequest | null;
    }
  | {
      type: "EXTENSION_REQUEST_RESOLVED";
      sessionId: string;
      requestId: string;
    }
  | {
      type: "RUNTIME_STATUS_CHANGED";
      sessionId: string;
      status: ConversationRuntimeStatus;
    }
  | {
      type: "PROMPT_STARTED";
      target: ConversationPaneTarget;
      pendingUserMessage: PiMessage | null;
    }
  | {
      type: "PROMPT_PREPARING";
      target: ConversationPaneTarget;
      status: string;
      clearPending?: boolean;
      runtimeStatus?: ConversationRuntimeStatus;
    }
  | {
      type: "CONTROL_UPDATED";
      sessionId: string;
      control: ConversationPaneState["control"];
    }
  | { type: "DRAFT_WORKSPACE_SELECTED"; cwd: string }
  | {
      type: "PROMPT_ACKNOWLEDGED";
      sessionId: string;
      messages?: PiMessage[] | ((current: PiMessage[]) => PiMessage[]);
      queue?: QueuedPrompt[];
      isStreaming?: boolean;
      toolStatus?: string;
    }
  | {
      type: "PROMPT_REJECTED";
      sessionId: string;
      messages?: PiMessage[] | ((current: PiMessage[]) => PiMessage[]);
      /** An authoritative Steer conflict can prove the previously shown turn is already idle. */
      isStreaming?: boolean;
      toolStatus?: string;
    }
  | { type: "DRAFT_PROMPT_REJECTED" }
  | { type: "AGENT_STARTED"; sessionId: string; toolStatus: string }
  | { type: "TERMINAL_MESSAGE_COMMITTED"; sessionId: string; message: PiMessage }
  | { type: "AGENT_SETTLED"; sessionId: string }
  | {
      type: "QUEUE_UPDATED";
      sessionId: string;
      queue: QueuedPrompt[];
      paused: boolean;
      messages?: PiMessage[] | ((current: PiMessage[]) => PiMessage[]);
      pendingUserMessage?: PiMessage | null | ((current: PiMessage | null) => PiMessage | null);
    }
  | {
      type: "QUEUE_DISPATCHED";
      sessionId: string;
      queue: QueuedPrompt[];
      messages?: PiMessage[] | ((current: PiMessage[]) => PiMessage[]);
      pendingUserMessage?: PiMessage | null | ((current: PiMessage | null) => PiMessage | null);
    }
  | {
      type: "QUEUE_FAILED";
      sessionId: string;
      queue?: QueuedPrompt[];
      paused?: boolean;
      messages?: PiMessage[] | ((current: PiMessage[]) => PiMessage[]);
      pendingUserMessage?: PiMessage | null | ((current: PiMessage | null) => PiMessage | null);
    }
  | { type: "PROCESS_FAILED"; sessionId: string }
  | { type: "STOP_COMPLETED"; sessionId: string; isStreaming: boolean; queuePaused: boolean };

const EMPTY_PI_STATE: PiState = { model: null, isStreaming: false };

export function emptyConversationPane(): ConversationPaneState {
  return {
    identity: { kind: "none", sessionId: "" },
    piState: EMPTY_PI_STATE,
    messages: [],
    pendingUserMessage: null,
    messageTotal: 0,
    turnTotal: 0,
    visibleTurnCount: 0,
    messagesTruncated: false,
    stats: undefined,
    liveMessage: null,
    commands: [],
    queue: [],
    queuePaused: false,
    toolStatus: "",
    extensionRequest: null,
    runtimeStatus: "view-only",
    control: {},
    gateAvailableOverride: null,
    draftWorkspaceCwd: "",
    promptStarting: false,
  };
}

function sameIdentity(left: ConversationPaneIdentity, right: ConversationPaneIdentity): boolean {
  return left.kind === right.kind && left.sessionId === right.sessionId;
}

function visibleSession(state: ConversationPaneState, sessionId: string): boolean {
  return state.identity.kind === "session" && state.identity.sessionId === sessionId;
}

function withActiveAssistantMetadata(state: ConversationPaneState, message: PiMessage): PiMessage {
  if (message.role !== "assistant") return message;
  const live = state.liveMessage?.role === "assistant" ? state.liveMessage : null;
  const provider = message.provider || live?.provider || state.piState.model?.provider;
  const model = message.model || live?.model || state.piState.model?.id;
  const thinkingLevel = message.thinkingLevel || live?.thinkingLevel || state.piState.thinkingLevel;
  return {
    ...message,
    ...(provider ? { provider } : null),
    ...(model ? { model } : null),
    ...(thinkingLevel ? { thinkingLevel } : null),
  };
}

function resolve<T>(value: T | ((current: T) => T), current: T): T {
  return typeof value === "function" ? (value as (current: T) => T)(current) : value;
}

function matchesTarget(state: ConversationPaneState, target: ConversationPaneTarget): boolean {
  return target.kind === "draft"
    ? state.identity.kind === "draft"
    : visibleSession(state, target.sessionId);
}

export function conversationPaneReducer(
  state: ConversationPaneState,
  action: ConversationPaneAction,
): ConversationPaneState {
  switch (action.type) {
    case "COMMIT_BOOTSTRAP":
      return { ...action.pane, control: { ...action.pane.control } };
    case "COMMIT_VIEW":
      // The coordinator normalizes every merge before this atomic replacement.
      return { ...action.pane, control: { ...action.pane.control } };
    case "RESET_DRAFT":
      return {
        ...emptyConversationPane(),
        identity: { kind: "draft", sessionId: "" },
        piState: {
          ...EMPTY_PI_STATE,
          model: action.model,
          thinkingLevel: action.thinkingLevel,
        },
        runtimeStatus: "draft",
        draftWorkspaceCwd: action.draftWorkspaceCwd,
      };
    case "CLEAR_PANE":
      return emptyConversationPane();
    case "RUNTIME_READY":
      return visibleSession(state, action.sessionId)
        ? {
            ...state,
            piState: { ...state.piState, ...action.state },
            runtimeStatus: "active",
          }
        : state;
    case "RUNTIME_FAILED":
      return visibleSession(state, action.sessionId)
        ? { ...state, runtimeStatus: "view-only" }
        : state;
    case "SETTINGS_CONFIRMED":
      return visibleSession(state, action.sessionId)
        ? { ...state, piState: { ...state.piState, ...action.state } }
        : state;
    case "PREFERENCES_STAGED":
      return matchesTarget(state, action.target)
        ? {
            ...state,
            piState: {
              ...state.piState,
              ...(action.model !== undefined ? { model: action.model } : null),
              ...(action.thinkingLevel !== undefined
                ? { thinkingLevel: action.thinkingLevel }
                : null),
            },
          }
        : state;
    case "COMPACTION_STARTED":
      return visibleSession(state, action.sessionId)
        ? {
            ...state,
            piState: { ...state.piState, isCompacting: true },
            toolStatus: action.status,
          }
        : state;
    case "COMPACTION_FINISHED":
      return visibleSession(state, action.sessionId)
        ? {
            ...state,
            piState: { ...state.piState, isCompacting: false },
            toolStatus: "",
          }
        : state;
    case "LIVE_MESSAGE_UPDATED":
      return visibleSession(state, action.sessionId)
        ? {
            ...state,
            liveMessage: action.message
              ? withActiveAssistantMetadata(state, action.message)
              : null,
            ...(action.message ? { promptStarting: false } : null),
          }
        : state;
    case "TOOL_RESULT_COMMITTED":
      return visibleSession(state, action.sessionId)
        ? { ...state, messages: appendTerminalMessage(state.messages, action.message) }
        : state;
    case "TOOL_STATUS_UPDATED":
      return visibleSession(state, action.sessionId)
        ? { ...state, toolStatus: action.status }
        : state;
    case "FAST_MODE_CHANGED":
      return visibleSession(state, action.sessionId)
        ? { ...state, piState: { ...state.piState, fastModeActive: action.active } }
        : state;
    case "EXTENSION_REQUEST_CHANGED":
      return visibleSession(state, action.sessionId)
        ? { ...state, extensionRequest: action.request }
        : state;
    case "EXTENSION_REQUEST_RESOLVED":
      return visibleSession(state, action.sessionId)
        ? {
            ...state,
            extensionRequest:
              state.extensionRequest?.id === action.requestId
                ? null
                : state.extensionRequest,
          }
        : state;
    case "RUNTIME_STATUS_CHANGED":
      return visibleSession(state, action.sessionId)
        ? { ...state, runtimeStatus: action.status }
        : state;
    case "PROMPT_STARTED":
      return matchesTarget(state, action.target)
        ? {
            ...state,
            pendingUserMessage: action.pendingUserMessage,
          }
        : state;
    case "PROMPT_PREPARING":
      return matchesTarget(state, action.target)
        ? {
            ...state,
            toolStatus: action.status,
            promptStarting: true,
            ...(action.clearPending ? { pendingUserMessage: null } : null),
            ...(action.runtimeStatus ? { runtimeStatus: action.runtimeStatus } : null),
          }
        : state;
    case "CONTROL_UPDATED":
      return visibleSession(state, action.sessionId)
        ? { ...state, control: { ...action.control } }
        : state;
    case "DRAFT_WORKSPACE_SELECTED":
      return state.identity.kind === "draft"
        ? { ...state, draftWorkspaceCwd: action.cwd }
        : state;
    case "PROMPT_ACKNOWLEDGED":
      return visibleSession(state, action.sessionId)
        ? {
            ...state,
            ...(action.messages ? { messages: resolve(action.messages, state.messages) } : null),
            ...(action.queue ? { queue: action.queue } : null),
            ...(action.isStreaming === undefined
              ? null
              : { piState: { ...state.piState, isStreaming: action.isStreaming } }),
            ...(action.toolStatus === undefined ? null : { toolStatus: action.toolStatus }),
            pendingUserMessage: null,
            promptStarting: false,
          }
        : state;
    case "PROMPT_REJECTED":
      return visibleSession(state, action.sessionId)
        ? {
            ...state,
            ...(action.messages ? { messages: resolve(action.messages, state.messages) } : null),
            ...(action.isStreaming === undefined
              ? null
              : {
                  piState: { ...state.piState, isStreaming: action.isStreaming },
                  ...(action.isStreaming
                    ? null
                    : { liveMessage: null, toolStatus: "" }),
                }),
            ...(action.toolStatus === undefined ? null : { toolStatus: action.toolStatus }),
            pendingUserMessage: null,
            promptStarting: false,
          }
        : state;
    case "DRAFT_PROMPT_REJECTED":
      return state.identity.kind === "draft"
        ? { ...state, pendingUserMessage: null, promptStarting: false, toolStatus: "" }
        : state;
    case "AGENT_STARTED":
      return visibleSession(state, action.sessionId)
        ? {
            ...state,
            piState: { ...state.piState, isStreaming: true, isCompacting: false },
            runtimeStatus: "active",
            toolStatus: action.toolStatus,
            promptStarting: false,
          }
        : state;
    case "TERMINAL_MESSAGE_COMMITTED":
      return visibleSession(state, action.sessionId)
        ? {
            ...state,
            messages: appendTerminalMessage(
              state.messages,
              withActiveAssistantMetadata(state, action.message),
            ),
            liveMessage: null,
            promptStarting: false,
          }
        : state;
    case "AGENT_SETTLED":
      return visibleSession(state, action.sessionId)
        ? {
            ...state,
            piState: { ...state.piState, isStreaming: false, isCompacting: false },
            liveMessage: null,
            toolStatus: "",
            promptStarting: false,
          }
        : state;
    case "QUEUE_UPDATED":
      return visibleSession(state, action.sessionId)
        ? {
            ...state,
            queue: action.queue,
            queuePaused: action.paused,
            ...(action.messages ? { messages: resolve(action.messages, state.messages) } : null),
            ...(action.pendingUserMessage === undefined ? null : { pendingUserMessage: resolve(action.pendingUserMessage, state.pendingUserMessage) }),
          }
        : state;
    case "QUEUE_DISPATCHED":
      return visibleSession(state, action.sessionId)
        ? {
            ...state,
            piState: { ...state.piState, isStreaming: true },
            queue: action.queue,
            ...(action.messages ? { messages: resolve(action.messages, state.messages) } : null),
            ...(action.pendingUserMessage === undefined ? null : { pendingUserMessage: resolve(action.pendingUserMessage, state.pendingUserMessage) }),
          }
        : state;
    case "QUEUE_FAILED":
      return visibleSession(state, action.sessionId)
        ? {
            ...state,
            piState: { ...state.piState, isStreaming: false },
            liveMessage: null,
            toolStatus: "",
            ...(action.queue ? { queue: action.queue } : null),
            ...(action.paused === undefined ? null : { queuePaused: action.paused }),
            ...(action.messages ? { messages: resolve(action.messages, state.messages) } : null),
            ...(action.pendingUserMessage === undefined ? null : { pendingUserMessage: resolve(action.pendingUserMessage, state.pendingUserMessage) }),
          }
        : state;
    case "PROCESS_FAILED":
      return visibleSession(state, action.sessionId)
        ? {
            ...state,
            piState: { ...state.piState, isStreaming: false, isCompacting: false },
            liveMessage: null,
            toolStatus: "",
            promptStarting: false,
            runtimeStatus: "view-only",
          }
        : state;
    case "STOP_COMPLETED":
      return visibleSession(state, action.sessionId)
        ? {
            ...state,
            piState: { ...state.piState, isStreaming: action.isStreaming },
            queuePaused: action.queuePaused,
            ...(action.isStreaming ? null : {
              liveMessage: null,
              toolStatus: "",
              promptStarting: false,
            }),
          }
        : state;
  }
}
