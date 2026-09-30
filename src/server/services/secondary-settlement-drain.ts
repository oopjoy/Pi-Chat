import type { PiState } from "../../shared/types.js";
import type { SecondaryRuntime } from "../runtime-pool.js";

export interface SecondarySettlementDrainPorts {
  closed(): boolean;
  isCurrent(runtime: SecondaryRuntime, generation: number): boolean;
  activePromptId(sessionId: string, generation: number): string | undefined;
  traceSettled(sessionId: string, promptId: string, generation: number): void;
  traceFailure(sessionId: string, promptId: string, generation: number): void;
  clearPrompt(sessionId: string, promptId: string): void;
  adoptState(runtime: SecondaryRuntime, state: PiState): void;
  shouldResetSteering(sessionId: string, generation: number): boolean;
  resetSteering(runtime: SecondaryRuntime): Promise<void>;
  broadcastActivity(sessionId: string): void;
  dispatchNext(runtime: SecondaryRuntime): void;
  sweep(): void;
  markSettlementFailure(runtime: SecondaryRuntime, error: unknown): void;
  timeoutMs(): number;
}

/** Post-settlement FIFO barrier for one Secondary Runtime. */
export async function drainSecondaryAfterSettlement(
  ports: SecondarySettlementDrainPorts,
  runtime: SecondaryRuntime,
  sourceGeneration: number,
  promptId?: string,
): Promise<void> {
  try {
    const response = await runtime.rpc.send(
      { type: "get_state" },
      ports.timeoutMs(),
      { independentRead: true },
    );
    if (ports.closed() || !ports.isCurrent(runtime, sourceGeneration)) return;
    if (promptId && ports.activePromptId(runtime.id, sourceGeneration) === promptId) {
      ports.traceSettled(runtime.id, promptId, sourceGeneration);
      ports.clearPrompt(runtime.id, promptId);
    }
    const state = (response.data || response) as PiState;
    ports.adoptState(runtime, state);
    if (!runtime.running && ports.shouldResetSteering(runtime.id, sourceGeneration)) {
      await ports.resetSteering(runtime);
      runtime.dispatching = false;
      ports.broadcastActivity(runtime.id);
      ports.dispatchNext(runtime);
      ports.sweep();
      return;
    }
    runtime.dispatching = false;
    ports.broadcastActivity(runtime.id);
    if (!runtime.running) {
      ports.dispatchNext(runtime);
      ports.sweep();
    }
  } catch (error) {
    if (ports.closed() || !ports.isCurrent(runtime, sourceGeneration)) return;
    if (promptId && ports.activePromptId(runtime.id, sourceGeneration) === promptId) {
      ports.traceFailure(runtime.id, promptId, sourceGeneration);
      ports.clearPrompt(runtime.id, promptId);
    }
    runtime.dispatching = false;
    runtime.failed = true;
    runtime.queuePaused = runtime.promptQueue.length > 0;
    ports.markSettlementFailure(runtime, error);
  }
}
