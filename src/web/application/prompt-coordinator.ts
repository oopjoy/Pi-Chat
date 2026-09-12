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
  /** SSE can win the race against the HTTP response; retain only the latest fact per Server ID. */
  private readonly unboundServerLifecycle = new Map<
    string,
    { eventType: "agent_start" | "agent_settled" | "pi_chat_process_error"; runtimeGeneration?: number }
  >();

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

  getByServerPromptId(serverPromptId: string): PromptOperation | undefined {
    for (const operation of this.operations.values())
      if (operation.serverPromptId === serverPromptId) return operation;
    return undefined;
  }

  bindServerPromptId(promptId: string, serverPromptId: string): PromptOperation {
    const current = this.operations.get(promptId);
    if (!current) throw new Error("Prompt operation 不存在");
    if (!serverPromptId.trim()) throw new Error("Server prompt ID 不能为空");
    const existing = this.getByServerPromptId(serverPromptId);
    if (existing && existing.promptId !== promptId)
      throw new Error("Server prompt ID 已绑定到其他 operation");
    const next = { ...current, serverPromptId };
    this.operations.set(promptId, next);
    const pending = this.unboundServerLifecycle.get(serverPromptId);
    if (pending) {
      this.unboundServerLifecycle.delete(serverPromptId);
      this.observeServerLifecycle(serverPromptId, pending.eventType, pending.runtimeGeneration);
    }
    return this.get(promptId)!;
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

  /** Apply only the small lifecycle facts that Server explicitly exposes over SSE. */
  observeServerLifecycle(
    serverPromptId: string,
    eventType: "agent_start" | "agent_settled" | "pi_chat_process_error",
    runtimeGeneration?: number,
  ): PromptOperation | undefined {
    const current = this.getByServerPromptId(serverPromptId);
    if (!current) {
      this.unboundServerLifecycle.set(serverPromptId, { eventType, runtimeGeneration });
      while (this.unboundServerLifecycle.size > 128)
        this.unboundServerLifecycle.delete(this.unboundServerLifecycle.keys().next().value!);
      return undefined;
    }
    if (isPromptOperationTerminal(current)) return current;
    if (eventType === "agent_start") {
      if (current.phase === "queued") this.transition(current.promptId, { type: "dispatch" });
      const afterDispatch = this.get(current.promptId)!;
      if (["admitting", "dispatching", "uncertain"].includes(afterDispatch.phase))
        return this.transition(current.promptId, { type: "run", runtimeGeneration });
      return afterDispatch;
    }
    if (eventType === "agent_settled") {
      if (current.phase === "queued") this.transition(current.promptId, { type: "dispatch" });
      const afterDispatch = this.get(current.promptId)!;
      if (["dispatching", "uncertain"].includes(afterDispatch.phase))
        this.transition(current.promptId, { type: "run", runtimeGeneration });
      const afterRun = this.get(current.promptId)!;
      if (["running", "uncertain"].includes(afterRun.phase))
        return this.transition(current.promptId, { type: "settle" });
      return afterRun;
    }
    if (["queued", "dispatching", "admitting"].includes(current.phase)) {
      // A process error before a runtime event is still a definite server-side
      // terminal fact, unlike an HTTP acknowledgement timeout.
      return this.transition(current.promptId, { type: "fail" });
    }
    if (["running", "uncertain"].includes(current.phase))
      return this.transition(current.promptId, { type: "fail" });
    return current;
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
    const operation = this.operations.get(promptId);
    this.operations.delete(promptId);
    if (operation?.serverPromptId) this.unboundServerLifecycle.delete(operation.serverPromptId);
  }

  clearTerminal(): void {
    for (const [promptId, operation] of this.operations)
      if (isPromptOperationTerminal(operation)) {
        this.operations.delete(promptId);
        if (operation.serverPromptId) this.unboundServerLifecycle.delete(operation.serverPromptId);
      }
  }
}
