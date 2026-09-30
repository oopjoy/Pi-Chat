import type { PiState } from "../../shared/types.js";

export interface AbortRuntimeResult {
  ok: true;
  isStreaming: boolean;
  queuePaused: boolean;
  abortPending?: boolean;
}

export interface RuntimeAbortPorts {
  pauseQueueForAbort(): void;
  queuePaused(): boolean;
  unavailable(): boolean;
  unavailableResult(): AbortRuntimeResult;
  steeringGeneration(): number;
  hasNativeSteeringPending(generation: number): boolean;
  armNativeSteeringReset(generation: number): void;
  sendAbort(): Promise<void>;
  abortOutcomeUnknown(error: unknown): boolean;
  running(): boolean;
  broadcastUncertainAbort(): void;
  broadcastBeforeStateProbe(): void;
  readState(): Promise<PiState>;
  setRunning(running: boolean): void;
  resetNativeSteering(): Promise<void>;
  broadcastStoppedAbort(): void;
}

/**
 * Run the post-lease abort transaction for one already-selected Runtime.
 * Primary/Secondary callers retain generation mutation, queue storage, Runtime
 * membership and operation leases; this service only preserves the identical
 * write/probe/reset result semantics.
 */
export async function abortRuntime(
  ports: RuntimeAbortPorts,
): Promise<AbortRuntimeResult> {
  ports.pauseQueueForAbort();
  if (ports.unavailable()) return ports.unavailableResult();

  const steeringGeneration = ports.steeringGeneration();
  if (ports.hasNativeSteeringPending(steeringGeneration))
    ports.armNativeSteeringReset(steeringGeneration);

  try {
    await ports.sendAbort();
  } catch (error) {
    if (!ports.abortOutcomeUnknown(error)) throw error;
    const abortPending = ports.running();
    ports.broadcastUncertainAbort();
    return {
      ok: true,
      abortPending,
      isStreaming: abortPending,
      queuePaused: ports.queuePaused(),
    };
  }

  ports.broadcastBeforeStateProbe();
  let isStreaming = false;
  try {
    isStreaming = (await ports.readState()).isStreaming;
  } catch {
    // Abort acknowledgement is sufficient. A later lifecycle event can still
    // settle the Runtime; the bounded probe is presentation-only.
    isStreaming = false;
  }
  ports.setRunning(isStreaming);
  if (ports.hasNativeSteeringPending(steeringGeneration)) {
    await ports.resetNativeSteering();
    isStreaming = false;
    ports.setRunning(false);
  }
  ports.broadcastStoppedAbort();
  return { ok: true, isStreaming, queuePaused: ports.queuePaused() };
}
