import type { RpcEventSource } from "../rpc-client.js";
import type { PiChatAppOptions } from "../app.js";
import type { RuntimeEventTransition } from "../runtime-event-transition.js";
import type { SecondaryRuntime, RuntimePool } from "../runtime-pool.js";
import { fastModeStatusFromExtensionEvent } from "../runtime-event-transition.js";
import { finalizeAcceptedRuntimeEvent } from "./runtime-event-lifecycle.js";

type RuntimeEvent = Record<string, unknown>;
type RuntimeEventRpc = PiChatAppOptions["rpc"];
type PromptDiagnostic = { promptId?: string };
type PendingExtensionRequest = { id: string };

export interface RuntimeEventHost {
  activePromptDiagnostic: (sessionId: string, rpcGeneration: number) => PromptDiagnostic | undefined;
  applyRuntimeEventTransition: (sessionId: string, runtime: SecondaryRuntime | undefined, event: RuntimeEvent) => RuntimeEventTransition;
  beginSessionRunTiming: (sessionId: string, generation: number) => void;
  broadcast: (event: RuntimeEvent) => void;
  broadcastPromptFailureLifecycle: (sessionId: string, event: RuntimeEvent, runGeneration: number, rpcGeneration: number) => void;
  broadcastQueue: (sessionId?: string) => void;
  broadcastRpcEvent: (event: RuntimeEvent, sessionId: string, runGeneration?: number) => void;
  broadcastSessionActivity: (sessionId?: string) => void;
  cancelInteractiveCopyHook: (sessionId: string, rpc: RuntimeEventRpc, event: RuntimeEvent) => boolean;
  clearNativeSteeringState: (sessionId: string, reason: string) => number;
  clearPendingRequest: (sessionId: string, requestId?: string) => boolean;
  clearPromptDiagnostic: (sessionId: string, promptId?: string) => void;
  closed: boolean;
  consumeNativeSteeringAdmission: (sessionId: string, event: RuntimeEvent, generation: number) => string | undefined;
  dispatching: boolean;
  queuePaused: boolean;
  dispatchRuntimeNext: (runtime: SecondaryRuntime) => Promise<void>;
  drainPrimaryAfterSettlement: (sessionId: string, sourceGeneration?: number, promptId?: string) => Promise<void>;
  drainSecondaryAfterSettlement: (runtime: SecondaryRuntime, sourceGeneration?: number, promptId?: string) => Promise<void>;
  finalizePersistedDraftWhenVisible: (runtime: SecondaryRuntime) => Promise<void>;
  finishSessionRunTiming: (sessionId: string, generation: number) => void;
  hasNativeSteeringPending: (sessionId: string, generation: number) => boolean;
  nativeSteeringResetAfterSettlement: Map<string, number>;
  pendingPrimaryFastMode: { rpcGeneration: number; active: boolean } | undefined;
  pendingRequestForSession: (sessionId: string) => PendingExtensionRequest | undefined;
  primaryBoundSessionId: string;
  primaryRpcGeneration: number;
  recordRuntimeFailure: (sessionId: string, error: unknown, incidentId?: string) => void;
  rpcOutcomePendingBySession: Set<string>;
  rpcOutcomeTokensBySession: Map<string, string>;
  runtimePool: Pick<RuntimePool, "get" | "touch">;
  scheduleModelRuntimeSync: () => void;
  settleNativeSteeringDequeue: (sessionId: string, event: RuntimeEvent, generation: number) => Array<{ id: string; message: string }>;
  setFastModeActive: (sessionId: string, active: boolean) => void;
  traceActivePrompt: (name: string, sessionId: string, rpcGeneration: number, runGeneration?: number) => string | undefined;
  traceState: (category: string, name: string, sessionId?: string, details?: Record<string, unknown>, rpcGeneration?: number, runGeneration?: number, promptId?: string) => void;
  uncertainCompactionBySession: Set<string>;
  uncertainExtensionResponseBySession: Set<string>;
  updateHotCompactionState: (runtime: SecondaryRuntime | undefined, isCompacting: boolean) => void;
  updateNativeSteeringSnapshot: (sessionId: string, event: RuntimeEvent, generation: number) => void;
  warmPrimaryMessageSnapshot: () => void;
  warmRuntimeMessageSnapshot: (runtime: SecondaryRuntime) => void;
  options: Pick<PiChatAppOptions, "rpc" | "primaryRuntime">;
}

export function handleSecondaryEvent(host: RuntimeEventHost, runtime: SecondaryRuntime, event: Record<string, unknown>, source?: RpcEventSource): void {

    if (host.closed) return;
    const currentGeneration = runtime.rpc.currentGeneration?.() || 0;
    const sourceGeneration = source?.generation || currentGeneration;
    const fastMode = fastModeStatusFromExtensionEvent(event);
    const unpublished = host.runtimePool.get(runtime.id) !== runtime;
    const staleGeneration = Boolean(
      sourceGeneration &&
      ((currentGeneration && sourceGeneration !== currentGeneration) ||
        (runtime.rpcGeneration &&
          sourceGeneration !== runtime.rpcGeneration)),
    );
    if (unpublished || staleGeneration) {
      if (
        fastMode !== null &&
        sourceGeneration &&
        (!currentGeneration || sourceGeneration === currentGeneration)
      )
        runtime.pendingFastMode = {
          rpcGeneration: sourceGeneration,
          active: fastMode,
        };
      if (
        event.type === "pi_chat_process_error" &&
        runtime.pendingFastMode?.rpcGeneration === sourceGeneration
      )
        runtime.pendingFastMode = undefined;
      return;
    }
    const type = String(event.type || "");
    const uncertainCompaction =
      host.uncertainCompactionBySession.has(runtime.id);
    const uncertainExtensionResponse =
      host.uncertainExtensionResponseBySession.has(runtime.id);
    if (type === "compaction_end") {
      host.uncertainCompactionBySession.delete(runtime.id);
      if (uncertainCompaction) {
        host.rpcOutcomePendingBySession.delete(runtime.id);
        host.rpcOutcomeTokensBySession.delete(runtime.id);
      }
    } else if (type === "agent_settled" || type === "pi_chat_process_error") {
      host.uncertainCompactionBySession.delete(runtime.id);
      host.uncertainExtensionResponseBySession.delete(runtime.id);
      host.rpcOutcomePendingBySession.delete(runtime.id);
      host.rpcOutcomeTokensBySession.delete(runtime.id);
      // An uncertain Extension answer is resolved by the lifecycle boundary,
      // not merely by dropping the uncertainty bit. Otherwise settlement can
      // leave a stale dialog visible and allow a second answer to be sent.
      if (type === "agent_settled" && uncertainExtensionResponse) {
        const pending = host.pendingRequestForSession(runtime.id);
        if (pending) host.clearPendingRequest(runtime.id, pending.id);
      }
    }
    if (host.cancelInteractiveCopyHook(runtime.id, runtime.rpc, event)) return;
    const generation = runtime.rpcGeneration;
    if (type === "pi_chat_queue_dequeued") {
      host.settleNativeSteeringDequeue(runtime.id, event, generation);
      return;
    }
    const queuePausedBeforeEvent = runtime.queuePaused;
    host.traceState("rpc-event", "received", runtime.id, {
      eventType: type || "unknown",
      sourceGeneration: source?.generation || 0,
    }, generation);
    let droppedNativeSteering = 0;
    if (type === "pi_chat_process_error") {
      host.setFastModeActive(runtime.id, false);
      host.recordRuntimeFailure(
        runtime.id,
        event.error,
        typeof event.incidentId === "string" ? event.incidentId : undefined,
      );
      droppedNativeSteering = host.clearNativeSteeringState(
        runtime.id,
        "process-error",
      );
    }
    if (type === "compaction_start")
      host.updateHotCompactionState(runtime, true);
    else if (
      type === "compaction_end" ||
      type === "agent_settled" ||
      type === "pi_chat_process_error"
    )
      host.updateHotCompactionState(runtime, false);
    host.updateNativeSteeringSnapshot(runtime.id, event, generation);
    const consumedSteering = host.consumeNativeSteeringAdmission(
      runtime.id,
      event,
      generation,
    );
    finalizeAcceptedRuntimeEvent({
      transition: () => host.applyRuntimeEventTransition(runtime.id, runtime, event),
      beginRunTiming: (runGeneration) => host.beginSessionRunTiming(runtime.id, runGeneration),
      finishRunTiming: (runGeneration) => host.finishSessionRunTiming(runtime.id, runGeneration),
      traceRejected: (eventType) => host.traceState("rpc-event", "rejected", runtime.id, {
        eventType: eventType || "unknown",
        decisionReason: "malformed-critical-event",
      }, generation),
      activePromptId: () => host.activePromptDiagnostic(runtime.id, generation)?.promptId,
      broadcastPromptFailure: (broadcastEvent, runGeneration) =>
        host.broadcastPromptFailureLifecycle(runtime.id, broadcastEvent, runGeneration, generation),
      touch: () => host.runtimePool.touch(runtime),
      tracePrompt: (phase, runGeneration) =>
        host.traceActivePrompt(phase, runtime.id, generation, runGeneration),
      clearPrompt: (promptId) => host.clearPromptDiagnostic(runtime.id, promptId),
      broadcastRpc: (broadcastEvent, runGeneration) =>
        host.broadcastRpcEvent(broadcastEvent, runtime.id, runGeneration),
      broadcastSessionCreated: () => host.broadcast({
        type: "pi_chat_sessions_changed",
        action: "created",
        sessionId: runtime.id,
      }),
      scheduleModelRuntimeSync: () => host.scheduleModelRuntimeSync(),
      afterSettled: () => {
        void host.finalizePersistedDraftWhenVisible(runtime);
        setTimeout(() => host.warmRuntimeMessageSnapshot(runtime), 0);
      },
      hasNativeSteeringPending: () => host.hasNativeSteeringPending(runtime.id, generation),
      noteNativeSteeringReset: () =>
        host.nativeSteeringResetAfterSettlement.set(runtime.id, generation),
      isDispatching: () => runtime.dispatching,
      beginSettlementDispatch: () => { runtime.dispatching = true; },
      broadcastActivity: () => host.broadcastSessionActivity(runtime.id),
      drainAfterSettlement: (promptId) => {
        // Pi stdout supplies no run id. Keep a FIFO state barrier after the
        // terminal event before this Runtime may dispatch another prompt.
        void host.drainSecondaryAfterSettlement(runtime, runtime.rpcGeneration, promptId);
      },
      releaseAfterProcessFailure: () => {
        runtime.dispatching = false;
        runtime.queuePaused = queuePausedBeforeEvent;
        host.broadcastQueue(runtime.id);
        host.broadcastSessionActivity(runtime.id);
      },
    }, {
      eventType: type,
      consumedNativeSteering: consumedSteering,
      droppedNativeSteering,
    });

}

export function handleRpcEvent(host: RuntimeEventHost, event: Record<string, unknown>, source?: RpcEventSource): void {

    if (host.closed) return;
    const currentGeneration = host.options.rpc.currentGeneration?.() || 0;
    const sourceGeneration = source?.generation || currentGeneration;
    if (
      event.type === "pi_chat_process_error" &&
      (!source?.generation ||
        !currentGeneration ||
        source.generation === currentGeneration)
    ) {
      // Primary can exit after compatibility succeeds but before get_state has
      // bound it to a Session. Readiness must reflect that failure even though
      // no Session-scoped transition or SSE frame can yet be attributed. A
      // source-tagged late event from a replaced child cannot fail its successor.
      host.options.primaryRuntime?.markFailed(event);
    }
    const unboundFastMode = fastModeStatusFromExtensionEvent(event);
    const awaitingPrimaryBinding =
      !host.primaryBoundSessionId ||
      Boolean(
        sourceGeneration &&
        ((currentGeneration && sourceGeneration !== currentGeneration) ||
          sourceGeneration !== host.primaryRpcGeneration),
      );
    if (awaitingPrimaryBinding) {
      if (
        unboundFastMode !== null &&
        sourceGeneration &&
        (!currentGeneration || sourceGeneration === currentGeneration)
      )
        host.pendingPrimaryFastMode = {
          rpcGeneration: sourceGeneration,
          active: unboundFastMode,
        };
      if (
        event.type === "pi_chat_process_error" &&
        host.pendingPrimaryFastMode?.rpcGeneration === sourceGeneration
      )
        host.pendingPrimaryFastMode = undefined;
      return;
    }
    const sessionId = host.primaryBoundSessionId;
    const type = String(event.type || "");
    const uncertainCompaction = Boolean(
      sessionId && host.uncertainCompactionBySession.has(sessionId),
    );
    const uncertainExtensionResponse = Boolean(
      sessionId && host.uncertainExtensionResponseBySession.has(sessionId),
    );
    if (sessionId && type === "compaction_end") {
      host.uncertainCompactionBySession.delete(sessionId);
      if (uncertainCompaction) {
        host.rpcOutcomePendingBySession.delete(sessionId);
        host.rpcOutcomeTokensBySession.delete(sessionId);
      }
    } else if (sessionId && (type === "agent_settled" || type === "pi_chat_process_error")) {
      host.uncertainCompactionBySession.delete(sessionId);
      host.uncertainExtensionResponseBySession.delete(sessionId);
      host.rpcOutcomePendingBySession.delete(sessionId);
      host.rpcOutcomeTokensBySession.delete(sessionId);
      if (type === "agent_settled" && uncertainExtensionResponse) {
        const pending = host.pendingRequestForSession(sessionId);
        if (pending) host.clearPendingRequest(sessionId, pending.id);
      }
    }
    if (host.cancelInteractiveCopyHook(sessionId, host.options.rpc, event)) return;
    const generation = host.primaryRpcGeneration;
    if (type === "pi_chat_queue_dequeued") {
      host.settleNativeSteeringDequeue(sessionId, event, generation);
      return;
    }
    const queuePausedBeforeEvent = host.queuePaused;
    host.traceState("rpc-event", "received", sessionId, {
      eventType: type || "unknown",
      sourceGeneration,
    }, generation);
    let droppedNativeSteering = 0;
    if (type === "pi_chat_process_error") {
      host.setFastModeActive(sessionId, false);
      host.recordRuntimeFailure(
        sessionId,
        event.error,
        typeof event.incidentId === "string" ? event.incidentId : undefined,
      );
      droppedNativeSteering = host.clearNativeSteeringState(
        sessionId,
        "process-error",
      );
    }
    if (type === "compaction_start") host.updateHotCompactionState(undefined, true);
    else if (
      type === "compaction_end" ||
      type === "agent_settled" ||
      type === "pi_chat_process_error"
    )
      host.updateHotCompactionState(undefined, false);
    host.updateNativeSteeringSnapshot(sessionId, event, generation);
    const consumedSteering = host.consumeNativeSteeringAdmission(
      sessionId,
      event,
      generation,
    );
    finalizeAcceptedRuntimeEvent({
      transition: () => host.applyRuntimeEventTransition(sessionId, undefined, event),
      beginRunTiming: (runGeneration) => host.beginSessionRunTiming(sessionId, runGeneration),
      finishRunTiming: (runGeneration) => host.finishSessionRunTiming(sessionId, runGeneration),
      traceRejected: (eventType) => host.traceState("rpc-event", "rejected", sessionId, {
        eventType: eventType || "unknown",
        decisionReason: "malformed-critical-event",
      }, generation),
      activePromptId: () => host.activePromptDiagnostic(sessionId, generation)?.promptId,
      broadcastPromptFailure: (broadcastEvent, runGeneration) =>
        host.broadcastPromptFailureLifecycle(sessionId, broadcastEvent, runGeneration, generation),
      touch: () => {},
      tracePrompt: (phase, runGeneration) =>
        host.traceActivePrompt(phase, sessionId, generation, runGeneration),
      clearPrompt: (promptId) => host.clearPromptDiagnostic(sessionId, promptId),
      broadcastRpc: (broadcastEvent, runGeneration) =>
        host.broadcastRpcEvent(broadcastEvent, sessionId, runGeneration),
      broadcastSessionCreated: () => host.broadcast({
        type: "pi_chat_sessions_changed",
        action: "created",
        sessionId,
      }),
      scheduleModelRuntimeSync: () => host.scheduleModelRuntimeSync(),
      afterSettled: () => setTimeout(() => host.warmPrimaryMessageSnapshot(), 0),
      hasNativeSteeringPending: () => host.hasNativeSteeringPending(sessionId, generation),
      noteNativeSteeringReset: () =>
        host.nativeSteeringResetAfterSettlement.set(sessionId, generation),
      isDispatching: () => host.dispatching,
      beginSettlementDispatch: () => { host.dispatching = true; },
      broadcastActivity: () => host.broadcastSessionActivity(sessionId),
      drainAfterSettlement: (promptId) => {
        void host.drainPrimaryAfterSettlement(sessionId, sourceGeneration, promptId);
      },
      releaseAfterProcessFailure: () => {
        host.dispatching = false;
        host.queuePaused = queuePausedBeforeEvent;
        host.broadcastQueue(sessionId);
        host.broadcastSessionActivity(sessionId);
      },
    }, {
      eventType: type,
      consumedNativeSteering: consumedSteering,
      droppedNativeSteering,
    });

}
