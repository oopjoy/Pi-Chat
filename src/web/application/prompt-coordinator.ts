import {
  createPromptOperation,
  isPromptOperationTerminal,
  promptOperationIsCurrent,
  transitionPromptOperation,
  type PromptAuthoritySnapshot,
  type PromptOperation,
  type PromptOperationDelivery,
  type PromptOperationEvent,
} from "./prompt-operation";

export interface PromptAdmissionInput {
  promptId: string;
  sessionId: string;
  navigationEpoch: number;
  runtimeGeneration?: number;
  delivery: PromptOperationDelivery;
  createdAt?: number;
}

export interface PromptAdmissionOptions<TResult> {
  /** Classify a successful response without knowing the API response shape. */
  phaseForResult?: (result: TResult) => Extract<PromptOperationEvent, { type: "queue" | "run" | "uncertain" }>;
  /** Only the caller knows whether an exception means unknown delivery. */
  phaseForError?: (error: unknown) => Extract<PromptOperationEvent, { type: "uncertain" | "fail" }>;
}

/**
 * Owns browser-side Prompt operation identity and admission bookkeeping.
 *
 * This is deliberately not a scheduler and does not know api.prompt(), retry,
 * queue storage, or Pi Runtime execution. The caller supplies the one network
 * operation and classifies its result; server/Pi remain the source of truth.
 */
export class PromptCoordinator {
  private readonly operations = new Map<string, PromptOperation>();

  begin(input: PromptAdmissionInput): PromptOperation {
    if (this.operations.has(input.promptId))
      throw new Error("Prompt operation ID 已存在");
    const operation = createPromptOperation(input);
    this.operations.set(operation.promptId, operation);
    return operation;
  }

  get(promptId: string): PromptOperation | undefined {
    return this.operations.get(promptId);
  }

  transition(promptId: string, event: PromptOperationEvent): PromptOperation {
    const current = this.operations.get(promptId);
    if (!current) throw new Error("Prompt operation 不存在");
    const next = transitionPromptOperation(current, event);
    if (!next) throw new Error(`Prompt operation 状态迁移无效：${current.phase} → ${event.type}`);
    this.operations.set(promptId, next);
    return next;
  }

  async admit<TResult>(
    input: PromptAdmissionInput,
    execute: (operation: PromptOperation) => Promise<TResult>,
    options: PromptAdmissionOptions<TResult> = {},
  ): Promise<TResult> {
    const operation = this.begin(input);
    this.transition(operation.promptId, { type: "admit" });
    this.transition(operation.promptId, { type: "dispatch" });
    try {
      const result = await execute(this.operations.get(operation.promptId)!);
      const phase = options.phaseForResult?.(result) || { type: "run" as const };
      this.transition(operation.promptId, phase);
      return result;
    } catch (error) {
      const phase = options.phaseForError?.(error) || { type: "fail" as const };
      this.transition(operation.promptId, phase);
      throw error;
    }
  }

  markSettled(promptId: string): PromptOperation {
    return this.transition(promptId, { type: "settle" });
  }

  markAborted(promptId: string): PromptOperation {
    return this.transition(promptId, { type: "abort" });
  }

  isCurrent(promptId: string, current: PromptAuthoritySnapshot): boolean {
    const operation = this.operations.get(promptId);
    return operation ? promptOperationIsCurrent(operation, current) : false;
  }

  delete(promptId: string): void {
    this.operations.delete(promptId);
  }

  clearTerminal(): void {
    for (const [promptId, operation] of this.operations)
      if (isPromptOperationTerminal(operation)) this.operations.delete(promptId);
  }
}
