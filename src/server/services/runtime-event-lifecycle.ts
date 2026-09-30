import type { RuntimeEventTransition } from "../runtime-event-transition.js";

export interface RuntimeEventLifecyclePorts {
  transition(): RuntimeEventTransition;
  beginRunTiming(generation: number): void;
  finishRunTiming(generation: number): void;
  traceRejected(eventType: string): void;
  activePromptId(): string | undefined;
  broadcastPromptFailure(
    event: Record<string, unknown>,
    runGeneration: number,
  ): void;
  touch(): void;
  tracePrompt(
    phase: "agent-start" | "process-failed" | "settled",
    runGeneration: number,
  ): string | undefined;
  clearPrompt(promptId: string): void;
  broadcastRpc(event: Record<string, unknown>, runGeneration: number): void;
  broadcastSessionCreated(): void;
  scheduleModelRuntimeSync(): void;
  afterSettled(promptId: string | undefined): void;
  hasNativeSteeringPending(): boolean;
  noteNativeSteeringReset(): void;
  isDispatching(): boolean;
  beginSettlementDispatch(): void;
  broadcastActivity(): void;
  drainAfterSettlement(promptId: string | undefined): void;
  releaseAfterProcessFailure(): void;
}

export interface RuntimeEventLifecycleInput {
  eventType: string;
  consumedNativeSteering?: string;
  droppedNativeSteering?: number;
}

/**
 * Complete the common post-admission transaction for an authoritative Runtime
 * event. RuntimePool membership, RPC-generation fencing, queue ownership, and
 * primary binding intentionally remain in the caller; this service only fixes
 * the ordering of diagnostics, browser transport, and settlement work once a
 * caller has accepted an event for its current Runtime.
 */
export function finalizeAcceptedRuntimeEvent(
  ports: RuntimeEventLifecyclePorts,
  input: RuntimeEventLifecycleInput,
): void {
  const transition = ports.transition();
  const runGeneration = transition.state.runGeneration;
  if (input.eventType === "agent_start" || input.eventType === "tool_execution_start")
    ports.beginRunTiming(runGeneration);
  else if (
    input.eventType === "agent_settled" ||
    input.eventType === "pi_chat_process_error"
  ) ports.finishRunTiming(runGeneration);

  if (!transition.broadcastEvent) {
    ports.traceRejected(input.eventType);
    return;
  }

  let broadcastEvent = transition.broadcastEvent;
  const lifecyclePromptId = (
    input.eventType === "agent_start" ||
    input.eventType === "agent_settled" ||
    input.eventType === "pi_chat_process_error"
  ) ? ports.activePromptId() : undefined;
  if (lifecyclePromptId)
    broadcastEvent = { ...broadcastEvent, piChatPromptId: lifecyclePromptId };
  ports.broadcastPromptFailure(broadcastEvent, runGeneration);
  ports.touch();

  if (input.eventType === "agent_start")
    ports.tracePrompt("agent-start", runGeneration);
  else if (input.eventType === "pi_chat_process_error") {
    const promptId = ports.tracePrompt("process-failed", runGeneration);
    if (promptId) ports.clearPrompt(promptId);
  }

  if (input.consumedNativeSteering || (input.droppedNativeSteering || 0) > 0)
    broadcastEvent = {
      ...broadcastEvent,
      ...(input.consumedNativeSteering
        ? {
          nativeSteeringConsumed: true,
          nativeSteeringId: input.consumedNativeSteering,
        }
        : null),
      ...((input.droppedNativeSteering || 0) > 0
        ? { nativeSteeringDroppedCount: input.droppedNativeSteering }
        : null),
    };

  ports.broadcastRpc(broadcastEvent, runGeneration);
  if (transition.effects.some((effect) => effect.type === "session-created"))
    ports.broadcastSessionCreated();

  if (transition.effects.some((effect) => effect.type === "settled")) {
    ports.scheduleModelRuntimeSync();
    const promptId = ports.tracePrompt("settled", runGeneration);
    ports.afterSettled(promptId);
    if (ports.hasNativeSteeringPending()) ports.noteNativeSteeringReset();
    if (!ports.isDispatching()) {
      ports.beginSettlementDispatch();
      ports.broadcastActivity();
      ports.drainAfterSettlement(promptId);
    }
    return;
  }

  if (
    input.eventType === "agent_start" ||
    input.eventType === "tool_execution_start" ||
    input.eventType === "tool_execution_end"
  ) {
    ports.broadcastActivity();
    return;
  }
  if (input.eventType === "pi_chat_process_error")
    ports.releaseAfterProcessFailure();
}
