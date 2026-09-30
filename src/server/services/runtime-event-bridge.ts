import { decodeCanonicalMessageEndPayload } from "../../shared/runtime-events.js";
import { normalizePromptFailure } from "../../shared/assistant-error.js";

export interface RuntimeEventBridgePorts {
  traceRejected(event: string, sessionId: string, runGeneration?: number): void;
  runEpoch(): string;
  eventRunTiming(sessionId: string, type: string, runGeneration?: number): {
    startedAt?: number;
    durationMs?: number;
    endedAt?: number;
  };
  broadcast(event: Record<string, unknown>): void;
}

/** Browser-bound Runtime event bridge: filtering, redaction, identity stamping. */
export function forwardRuntimeEvent(
  ports: RuntimeEventBridgePorts,
  event: Record<string, unknown>,
  sessionId: string,
  runGeneration?: number,
): void {
  if (event.type === "tool_execution_update") return;
  if (event.type === "auto_retry_start" || event.type === "auto_retry_end") return;
  const allowedEvent = event.type === "message_end"
    ? decodeCanonicalMessageEndPayload(event)
    : event;
  if (!allowedEvent) {
    ports.traceRejected("malformed-critical-event", sessionId, runGeneration);
    return;
  }
  const eventForBrowser: Record<string, unknown> = allowedEvent.type === "pi_chat_process_error"
    ? (() => {
        const raw = typeof allowedEvent.error === "string" ? allowedEvent.error : "Pi RPC 已退出";
        const failure = normalizePromptFailure(raw, {
          provider: allowedEvent.provider,
          model: allowedEvent.model,
          api: allowedEvent.api,
          status: allowedEvent.status,
          retryAttempts: allowedEvent.retryAttempts,
          requestId: allowedEvent.requestId,
          incidentId: allowedEvent.incidentId,
          aborted: allowedEvent.failureKind === "user-aborted",
          runtimeExit: allowedEvent.errorCode === "RPC_CHILD_EXIT"
            || allowedEvent.errorCode === "PI_RPC_EXIT_UNCONFIRMED",
          modelUnavailable: allowedEvent.errorCode === "MODEL_UNAVAILABLE",
        });
        return { ...allowedEvent, error: failure.message, failure };
      })()
    : allowedEvent;
  const {
    piChatSessionId: _session,
    piChatRunEpoch: _epoch,
    piChatRunGeneration: _generation,
    ...runtimeEvent
  } = eventForBrowser;
  const type = typeof runtimeEvent.type === "string" ? runtimeEvent.type : "";
  const timing = ports.eventRunTiming(sessionId, type, runGeneration);
  ports.broadcast({
    ...runtimeEvent,
    piChatSessionId: sessionId,
    piChatRunEpoch: ports.runEpoch(),
    ...(typeof runGeneration === "number" ? { piChatRunGeneration: runGeneration } : null),
    ...(timing.startedAt !== undefined ? { piChatRunStartedAt: timing.startedAt } : null),
    ...(timing.durationMs !== undefined ? { piChatRunDurationMs: timing.durationMs } : null),
    ...(timing.endedAt !== undefined ? { piChatRunEndedAt: timing.endedAt } : null),
  });
}
