import {
  canonicalMessageEndFromEvent,
  parseEventData,
} from "../lib/pi-events";
import type { CanonicalMessageEndEvent } from "../../shared/runtime-events";

export const GLOBAL_SSE_EVENT_TYPES = new Set([
  "pi_chat_heartbeat",
  "pi_chat_sse_resync",
  "pi_chat_oversized_event",
  "pi_chat_application_closing",
  "pi_chat_application_lifecycle",
  "pi_chat_active_session_changed",
  "pi_chat_sessions_changed",
  "pi_chat_primary_runtime_status",
  "pi_chat_workspace_changed",
  "pi_chat_models_updated",
]);

export const SESSION_VIEW_INVALIDATING_EVENT_TYPES = new Set([
  "agent_start",
  "agent_settled",
  "compaction_start",
  "compaction_end",
  "message_start",
  "message_update",
  "message_checkpoint",
  "message_delta",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "pi_chat_process_error",
  "pi_chat_prompt_retry_scheduled",
  "pi_chat_prompt_retry_started",
  "pi_chat_prompt_retry_exhausted",
  "pi_chat_prompt_failed",
  "pi_chat_queue_update",
  "pi_chat_queue_dispatch",
  "pi_chat_queue_error",
  "extension_ui_request",
  "pi_chat_extension_request_resolved",
  "pi_chat_fast_mode_changed",
  "pi_chat_gate_mode_changed",
  "pi_chat_session_control_changed",
  "pi_chat_session_status",
]);

export function invalidatesSessionViewVersion(type: string): boolean {
  return SESSION_VIEW_INVALIDATING_EVENT_TYPES.has(type);
}

export function isSessionScopedEvent(type: string): boolean {
  return !GLOBAL_SSE_EVENT_TYPES.has(type);
}

export interface NormalizedStreamEvent {
  event: Record<string, unknown>;
  type: string;
  sessionId: string;
  runEpoch: string;
  runGeneration?: number;
  terminalEvent: CanonicalMessageEndEvent | null;
}

export type StreamEventAdmission =
  | { accepted: true; value: NormalizedStreamEvent }
  | {
      accepted: false;
      sessionId?: string;
      runGeneration?: number;
      eventType: string;
      reason: "malformed-json" | "malformed-critical-event" | "stale-run-epoch" | "missing-session";
    };

function safeRunGeneration(event: Record<string, unknown>): number | undefined {
  return typeof event.piChatRunGeneration === "number"
    && Number.isSafeInteger(event.piChatRunGeneration)
    && event.piChatRunGeneration >= 0
    ? event.piChatRunGeneration
    : undefined;
}

/**
 * Converts an untrusted SSE MessageEvent into the application event envelope.
 * This is an admission boundary only: it does not mutate Session, Runtime,
 * Prompt, cache, reducer, or recovery state.
 */
export function admitStreamEvent(rawEvent: Event, currentRunEpoch: string): StreamEventAdmission {
  const event = parseEventData(rawEvent);
  if (!event)
    return { accepted: false, eventType: "unknown", reason: "malformed-json" };

  const type = String(event.type || "");
  const runGeneration = safeRunGeneration(event);
  const terminalEvent = type === "message_end"
    ? canonicalMessageEndFromEvent(event)
    : null;
  const rawSessionId = typeof event.piChatSessionId === "string"
    ? event.piChatSessionId
    : type === "pi_chat_session_control_changed" && typeof event.sessionId === "string"
      ? event.sessionId
      : "";
  const sessionId = terminalEvent?.piChatSessionId || rawSessionId;
  const runEpoch = terminalEvent?.piChatRunEpoch
    || (typeof event.piChatRunEpoch === "string" ? event.piChatRunEpoch : "");
  const normalizedGeneration = terminalEvent?.piChatRunGeneration ?? runGeneration;

  if (type === "message_end" && !terminalEvent)
    return {
      accepted: false,
      sessionId,
      runGeneration: normalizedGeneration,
      eventType: type,
      reason: "malformed-critical-event",
    };
  if (runEpoch && currentRunEpoch && runEpoch !== currentRunEpoch)
    return {
      accepted: false,
      sessionId,
      runGeneration: normalizedGeneration,
      eventType: type || "unknown",
      reason: "stale-run-epoch",
    };
  if (isSessionScopedEvent(type) && !sessionId)
    return {
      accepted: false,
      runGeneration: normalizedGeneration,
      eventType: type || "unknown",
      reason: "missing-session",
    };

  return {
    accepted: true,
    value: {
      event,
      type,
      sessionId,
      runEpoch,
      runGeneration: normalizedGeneration,
      terminalEvent,
    },
  };
}
