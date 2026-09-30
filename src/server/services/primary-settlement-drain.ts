import type { PiState } from "../../shared/types.js";

export interface PrimarySettlementDrainPorts {
  readState(): Promise<PiState>;
  closed(): boolean;
  isCurrent(sessionId: string, generation: number): boolean;
  activePromptId(sessionId: string, generation: number): string | undefined;
  traceSettled(sessionId: string, promptId: string, generation: number): void;
  traceFailure(sessionId: string, promptId: string, generation: number): void;
  clearPrompt(sessionId: string, promptId: string): void;
  adoptState(state: PiState): void;
  isRunning(): boolean;
  shouldResetSteering(sessionId: string, generation: number): boolean;
  resetSteering(sessionId: string): Promise<void>;
  releaseDispatch(): void;
  broadcastActivity(sessionId: string): void;
  dispatchNext(): void;
  markSettlementFailure(sessionId: string, error: unknown): void;
}

/**
 * Post-settlement FIFO barrier for the Primary Runtime. The App remains the
 * sole owner of Primary identity, state, queue, and recovery; this service
 * establishes only the settled get_state/read-adopt/release ordering.
 */
export async function drainPrimaryAfterSettlement(
  ports: PrimarySettlementDrainPorts,
  sessionId: string,
  sourceGeneration: number,
  promptId?: string,
): Promise<void> {
  try {
    const state = await ports.readState();
    if (ports.closed() || !ports.isCurrent(sessionId, sourceGeneration)) return;
    if (promptId && ports.activePromptId(sessionId, sourceGeneration) === promptId) {
      ports.traceSettled(sessionId, promptId, sourceGeneration);
      ports.clearPrompt(sessionId, promptId);
    }
    ports.adoptState(state);
    if (!ports.isRunning() && ports.shouldResetSteering(sessionId, sourceGeneration)) {
      await ports.resetSteering(sessionId);
      ports.releaseDispatch();
      ports.broadcastActivity(sessionId);
      ports.dispatchNext();
      return;
    }
    ports.releaseDispatch();
    ports.broadcastActivity(sessionId);
    if (!ports.isRunning()) ports.dispatchNext();
  } catch (error) {
    if (ports.closed() || !ports.isCurrent(sessionId, sourceGeneration)) return;
    if (promptId && ports.activePromptId(sessionId, sourceGeneration) === promptId) {
      ports.traceFailure(sessionId, promptId, sourceGeneration);
      ports.clearPrompt(sessionId, promptId);
    }
    ports.releaseDispatch();
    ports.markSettlementFailure(sessionId, error);
  }
}
