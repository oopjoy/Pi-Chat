import { canonicalMessageEndPayload } from "../shared/runtime-events.js";
import { accumulateStreamingAssistantMessage, appendTerminalMessage } from "../shared/streaming-assistant.js";
import type { ExtensionUiRequest, GateMode, PiMessage } from "../shared/types.js";

export type RuntimeEventState = {
  runGeneration: number;
  running: boolean;
  dispatching: boolean;
  failed: boolean;
  queuePaused: boolean;
  queueLength: number;
  liveMessage?: PiMessage;
  toolStatus: string;
  pendingTerminalMessages: PiMessage[];
  pendingTerminalSessionId?: string;
  extensionUiPending?: boolean;
  /** Secondary historically preserves its last live draft on process failure. */
  preserveLiveMessageOnProcessError?: boolean;
};

export type RuntimeEventEffect =
  | { type: "context-start" }
  | { type: "context-pending" }
  | { type: "context-complete" }
  | { type: "gate-mode"; mode: GateMode }
  | { type: "fast-mode"; active: boolean }
  | { type: "extension-request"; request: ExtensionUiRequest }
  | { type: "clear-extension-request" }
  | { type: "queue-changed" }
  | { type: "session-created" }
  | { type: "session-status" }
  | { type: "settled" };

export type RuntimeEventTransition = {
  state: RuntimeEventState;
  broadcastEvent: Record<string, unknown> | null;
  effects: RuntimeEventEffect[];
};

function gateModeFromNotice(message: unknown): GateMode | null {
  const value = typeof message === "string" ? message : "";
  const match = /^Gate mode:\s*(strict|open)\b/im.exec(value);
  return match ? match[1] as GateMode : null;
}

function interactiveExtension(event: Record<string, unknown>, sessionId: string): ExtensionUiRequest | null {
  if (!["select", "confirm", "input", "editor"].includes(String(event.method || ""))) return null;
  if (typeof event.id !== "string") return null;
  return { ...(event as unknown as ExtensionUiRequest), piChatSessionId: sessionId };
}

/** The installed Fast extension owns one RPC footer status key. */
export function fastModeStatusFromExtensionEvent(event: Record<string, unknown>): boolean | null {
  if (event.type !== "extension_ui_request" || event.method !== "setStatus" || event.statusKey !== "fast") return null;
  return typeof event.statusText === "string" && event.statusText.trim().length > 0;
}

/**
 * Pure common projection for an already provenance-validated RPC event.
 * Transport binding, timers, snapshot warming, queue dispatch and broadcasts
 * deliberately remain with the Primary/Secondary owners.
 */
export function transitionRuntimeEvent(
  sessionId: string,
  previous: RuntimeEventState,
  event: Record<string, unknown>,
): RuntimeEventTransition {
  const type = String(event.type || "");
  let state: RuntimeEventState = { ...previous, pendingTerminalMessages: [...previous.pendingTerminalMessages] };
  let broadcastEvent = event;
  const effects: RuntimeEventEffect[] = [];

  if (type === "agent_start") {
    // Scheduler uses dispatching only until Pi accepts and starts the queued
    // turn. Settlement then owns it again for the FIFO get_state barrier.
    state = { ...state, runGeneration: state.runGeneration + 1, running: true, dispatching: false, toolStatus: "Pi 正在思考…" };
    effects.push({ type: "context-start" }, { type: "session-created" });
  }
  if (type === "message_start") effects.push({ type: "session-created" });
  if (type === "compaction_start") {
    state = {
      ...state,
      toolStatus:
        String(event.reason || "") === "overflow"
          ? "上下文溢出，正在自动压缩…"
          : "正在压缩上下文…",
    };
  }
  if (type === "compaction_end") {
    // The pre-compaction tool is no longer the current phase. Keeping its
    // terminal label here lets a subsequent hot Session View resurrect an old
    // “bash completed” banner after the browser already observed compaction_end.
    state = { ...state, toolStatus: "" };
    if (event.aborted === false) effects.push({ type: "context-pending" });
  }
  if (
    (type === "message_start" || type === "message_update")
    && event.message
    && typeof event.message === "object"
    && (event.message as PiMessage).role === "assistant"
  ) {
    const liveMessage = accumulateStreamingAssistantMessage(
      state.liveMessage,
      event.message as PiMessage,
      event.assistantMessageEvent,
    );
    state = { ...state, liveMessage };
    // Browser and SSE throttles operate on cumulative snapshots. Never forward
    // a delta-only Runtime envelope whose empty message would hide all text
    // until message_end (or abort) produces a terminal payload.
    broadcastEvent = { ...event, message: liveMessage };
  }
  if (type === "message_end") {
    if (!event.message || typeof event.message !== "object")
      return { state, broadcastEvent: null, effects: [] };
    const raw = event.message as PiMessage;
    const hasPayload = typeof raw.content === "string" ? raw.content.length > 0 : Array.isArray(raw.content) && raw.content.length > 0;
    const message = raw.role === "assistant" && !hasPayload && state.liveMessage
      ? { ...state.liveMessage, ...raw, content: state.liveMessage.content }
      : raw;
    const canonical = canonicalMessageEndPayload(message);
    if (!canonical) return { state, broadcastEvent: null, effects: [] };
    broadcastEvent = canonical;
    const terminal = canonical.message;
    const pending = state.pendingTerminalSessionId && state.pendingTerminalSessionId !== sessionId
      ? []
      : state.pendingTerminalMessages;
    state = {
      ...state,
      pendingTerminalSessionId: sessionId,
      pendingTerminalMessages: terminal.role === "user" ? pending : appendTerminalMessage(pending, terminal),
      ...(terminal.role === "assistant" ? { liveMessage: undefined } : null),
    };
  }
  if (type === "tool_execution_start") state = { ...state, toolStatus: `正在运行工具：${String(event.toolName || "unknown")}` };
  if (type === "tool_execution_end") state = { ...state, toolStatus: `${String(event.toolName || "工具")} ${event.isError ? "执行失败" : "已完成，Pi 正在继续…"}` };
  if (type === "extension_ui_request") {
    const mode = String(event.method || "") === "notify" ? gateModeFromNotice(event.message) : null;
    if (mode) effects.push({ type: "gate-mode", mode });
    const fastMode = fastModeStatusFromExtensionEvent(event);
    if (fastMode !== null) effects.push({ type: "fast-mode", active: fastMode });
    const request = interactiveExtension(event, sessionId);
    // Secondary previously marked supported interactive methods pending even
    // when malformed. Preserve that owner-visible fact while only arming a
    // request/timer for an ID-bearing request.
    state = { ...state, extensionUiPending: ["select", "confirm", "input", "editor"].includes(String(event.method || "")) };
    if (request) effects.push({ type: "extension-request", request });
  }
  if (type === "extension_error") effects.push({ type: "clear-extension-request" });
  if (type === "pi_chat_process_error") {
    state = {
      ...state,
      running: false,
      dispatching: false,
      failed: true,
      queuePaused: state.queueLength > 0,
      ...(state.preserveLiveMessageOnProcessError ? null : { liveMessage: undefined }),
      toolStatus: "",
    };
    effects.push({ type: "clear-extension-request" }, { type: "queue-changed" }, { type: "session-status" });
  }
  if (type === "agent_settled") {
    state = { ...state, running: false, liveMessage: undefined, toolStatus: "" };
    effects.push({ type: "context-complete" }, { type: "settled" });
  }
  return { state, broadcastEvent, effects };
}
