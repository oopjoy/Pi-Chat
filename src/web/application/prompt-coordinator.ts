import {
  createPromptOperation,
  isPromptOperationTerminal,
  promptOperationIsCurrent,
  transitionPromptOperation,
  type PromptAuthoritySnapshot,
  type PromptOperation,
  type PromptOperationDelivery,
  type PromptOperationEvent,
  type PromptRetryPhase,
} from "./prompt-operation";

export interface PromptAdmissionInput {
  promptId: string;
  sessionId: string;
  navigationEpoch: number;
  runEpoch?: string;
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
const MAX_UNBOUND_SERVER_LIFECYCLE = 128;
const PENDING_SERVER_LIFECYCLE_TTL_MS = 5 * 60 * 1000;
const MAX_RETIRED_SERVER_PROMPTS = 128;
type ServerLifecycleFact = {
  eventType: "agent_start" | "agent_settled" | "pi_chat_process_error";
  runtimeGeneration?: number;
  sessionId?: string;
  runEpoch?: string;
  observedAt: number;
};

function retryPhaseRank(value: PromptRetryPhase): number {
  return value === "scheduled" ? 0 : value === "running" ? 1 : 2;
}

type ServerRetryFact = {
  phase: PromptRetryPhase;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  runtimeGeneration?: number;
  sessionId?: string;
  runEpoch?: string;
  observedAt: number;
};

export class PromptCoordinator {
  private readonly operations = new Map<string, PromptOperation>();
  /** Keep terminal facts alive until their in-flight HTTP admission settles. */
  private readonly pendingAdmissions = new Set<string>();
  private readonly serverPromptIndex = new Map<string, string>();
  private readonly retiredServerPromptIds = new Set<string>();
  /** SSE can win the race against the HTTP response; retain only the latest fact per Server ID. */
  private readonly unboundServerLifecycle = new Map<string, ServerLifecycleFact>();
  private readonly unboundServerRetry = new Map<string, ServerRetryFact>();

  private retireServerPromptId(serverPromptId: string): void {
    this.retiredServerPromptIds.delete(serverPromptId);
    this.retiredServerPromptIds.add(serverPromptId);
    while (this.retiredServerPromptIds.size > MAX_RETIRED_SERVER_PROMPTS)
      this.retiredServerPromptIds.delete(this.retiredServerPromptIds.values().next().value!);
  }

  private pruneUnboundServerLifecycle(now = Date.now()): void {
    for (const [serverPromptId, fact] of this.unboundServerLifecycle)
      if (now - fact.observedAt > PENDING_SERVER_LIFECYCLE_TTL_MS)
        this.unboundServerLifecycle.delete(serverPromptId);
    for (const [serverPromptId, fact] of this.unboundServerRetry)
      if (now - fact.observedAt > PENDING_SERVER_LIFECYCLE_TTL_MS)
        this.unboundServerRetry.delete(serverPromptId);
  }

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
    const promptId = this.serverPromptIndex.get(serverPromptId);
    return promptId ? this.operations.get(promptId) : undefined;
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
    this.serverPromptIndex.set(serverPromptId, promptId);
    this.pruneUnboundServerLifecycle();
    const pending = this.unboundServerLifecycle.get(serverPromptId);
    if (pending) {
      this.unboundServerLifecycle.delete(serverPromptId);
      this.observeServerLifecycle(
        serverPromptId,
        pending.eventType,
        pending.runtimeGeneration,
        pending.sessionId,
        pending.runEpoch,
      );
    }
    const pendingRetry = this.unboundServerRetry.get(serverPromptId);
    if (pendingRetry) {
      this.unboundServerRetry.delete(serverPromptId);
      this.observeRetry(
        serverPromptId,
        pendingRetry.phase,
        pendingRetry.runtimeGeneration,
        pendingRetry.sessionId,
        pendingRetry.runEpoch,
        pendingRetry.attempt,
        pendingRetry.maxAttempts,
        pendingRetry.delayMs,
      );
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
    this.pendingAdmissions.add(operation.promptId);
    try {
      const result = await execute(this.operations.get(operation.promptId)!);
      const current = this.operations.get(operation.promptId);
      // A Runtime lifecycle may have settled/failed the operation while the
      // HTTP acknowledgement was still in flight. Preserve that stronger fact
      // and let the late response complete transport bookkeeping only.
      if (!current || isPromptOperationTerminal(current)) return result;
      const phase = options.phaseForResult?.(result) || { type: "run" as const };
      this.transition(operation.promptId, phase);
      return result;
    } catch (error) {
      const current = this.operations.get(operation.promptId);
      if (current && !isPromptOperationTerminal(current)) {
        const phase = options.phaseForError?.(error) || { type: "fail" as const };
        this.transition(operation.promptId, phase);
      }
      throw error;
    } finally {
      this.pendingAdmissions.delete(operation.promptId);
      this.clearTerminal();
    }
  }

  /**
   * Adopt a combined server transaction after it returned its accepted Prompt.
   * New-draft creation owns Session allocation and prompt delivery in one HTTP
   * request, so the browser cannot run the ordinary `admit()` wrapper around
   * the transport. It still records the same operation lifecycle before
   * binding the Server prompt identity and replaying any earlier SSE facts.
   */
  adoptAccepted(
    input: PromptAdmissionInput,
    phase: Extract<PromptOperationEvent, { type: "queue" | "run" | "uncertain" }>,
  ): PromptOperation {
    const operation = this.begin(input);
    this.transition(operation.promptId, { type: "admit" });
    this.transition(operation.promptId, { type: "dispatch" });
    return this.transition(operation.promptId, phase);
  }

  /** Apply only the small lifecycle facts that Server explicitly exposes over SSE. */
  observeServerLifecycle(
    serverPromptId: string,
    eventType: "agent_start" | "agent_settled" | "pi_chat_process_error",
    runtimeGeneration?: number,
    sessionId?: string,
    runEpoch?: string,
  ): PromptOperation | undefined {
    if (this.retiredServerPromptIds.has(serverPromptId)) return undefined;
    this.pruneUnboundServerLifecycle();
    const current = this.getByServerPromptId(serverPromptId);
    if (!current) {
      this.unboundServerLifecycle.set(serverPromptId, {
        eventType,
        runtimeGeneration,
        sessionId,
        runEpoch,
        observedAt: Date.now(),
      });
      while (this.unboundServerLifecycle.size > MAX_UNBOUND_SERVER_LIFECYCLE)
        this.unboundServerLifecycle.delete(this.unboundServerLifecycle.keys().next().value!);
      return undefined;
    }
    if (isPromptOperationTerminal(current)) return current;
    // Server prompt identity is globally opaque, but keep Session identity as a
    // second fence so a malformed/replayed frame cannot settle another Session.
    if (sessionId && current.sessionId !== sessionId) return current;
    if (current.runEpoch !== undefined && current.runEpoch !== runEpoch) return current;
    const admissionGeneration = current.admissionRuntimeGeneration;
    const observedGeneration = current.observedRuntimeGeneration;
    if (runtimeGeneration !== undefined
      && ((admissionGeneration !== undefined && runtimeGeneration < admissionGeneration)
        || (observedGeneration !== undefined && runtimeGeneration < observedGeneration)))
      return current;
    if (eventType === "agent_start") {
      if (current.phase === "queued") this.transition(current.promptId, { type: "dispatch" });
      const afterDispatch = this.get(current.promptId)!;
      if (["admitting", "dispatching", "uncertain"].includes(afterDispatch.phase))
        return this.transition(current.promptId, { type: "run", runtimeGeneration });
      if (runtimeGeneration !== undefined
        && afterDispatch.observedRuntimeGeneration !== runtimeGeneration) {
        const observed = { ...afterDispatch, observedRuntimeGeneration: runtimeGeneration };
        this.operations.set(observed.promptId, observed);
        return observed;
      }
      return afterDispatch;
    }
    if (eventType === "agent_settled") {
      if (current.phase === "queued") this.transition(current.promptId, { type: "dispatch" });
      const afterDispatch = this.get(current.promptId)!;
      if (["dispatching", "uncertain"].includes(afterDispatch.phase))
        this.transition(current.promptId, { type: "run", runtimeGeneration });
      let afterRun = this.get(current.promptId)!;
      if (runtimeGeneration !== undefined
        && afterRun.observedRuntimeGeneration !== runtimeGeneration) {
        afterRun = { ...afterRun, observedRuntimeGeneration: runtimeGeneration };
        this.operations.set(afterRun.promptId, afterRun);
      }
      if (["running", "uncertain"].includes(afterRun.phase))
        return this.transition(afterRun.promptId, { type: "settle" });
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

  /** Apply retry metadata without changing the Prompt operation phase. */
  observeRetry(
    serverPromptId: string,
    phase: PromptRetryPhase,
    runtimeGeneration?: number,
    sessionId?: string,
    runEpoch?: string,
    attempt?: number,
    maxAttempts?: number,
    delayMs?: number,
  ): PromptOperation | undefined {
    if (this.retiredServerPromptIds.has(serverPromptId)) return undefined;
    this.pruneUnboundServerLifecycle();
    const current = this.getByServerPromptId(serverPromptId);
    if (!current) {
      const previousPending = this.unboundServerRetry.get(serverPromptId);
      if (previousPending) {
        if (retryPhaseRank(phase) < retryPhaseRank(previousPending.phase)) return undefined;
        if (
          retryPhaseRank(phase) === retryPhaseRank(previousPending.phase)
          && attempt !== undefined
          && previousPending.attempt !== undefined
          && attempt < previousPending.attempt
        ) return undefined;
      }
      this.unboundServerRetry.set(serverPromptId, {
        phase,
        attempt,
        maxAttempts,
        delayMs,
        runtimeGeneration,
        sessionId,
        runEpoch,
        observedAt: Date.now(),
      });
      while (this.unboundServerRetry.size > MAX_UNBOUND_SERVER_LIFECYCLE)
        this.unboundServerRetry.delete(this.unboundServerRetry.keys().next().value!);
      return undefined;
    }
    if (isPromptOperationTerminal(current)) return current;
    if (sessionId && current.sessionId !== sessionId) return current;
    if (current.runEpoch !== undefined && current.runEpoch !== runEpoch) return current;
    const admissionGeneration = current.admissionRuntimeGeneration;
    const observedGeneration = current.observedRuntimeGeneration;
    if (runtimeGeneration !== undefined
      && ((admissionGeneration !== undefined && runtimeGeneration < admissionGeneration)
        || (observedGeneration !== undefined && runtimeGeneration < observedGeneration)))
      return current;
    const previousRetry = current.retry;
    if (previousRetry) {
      if (phase === "exhausted" && previousRetry.phase === "cancelled") return current;
      if (phase === "cancelled" && previousRetry.phase === "exhausted") return current;
      if (retryPhaseRank(phase) < retryPhaseRank(previousRetry.phase)) return current;
      if (
        retryPhaseRank(phase) === retryPhaseRank(previousRetry.phase)
        && attempt !== undefined
        && previousRetry.attempt !== undefined
        && attempt < previousRetry.attempt
      ) return current;
    }
    const retry = {
      phase,
      ...(attempt !== undefined ? { attempt } : null),
      ...(maxAttempts !== undefined ? { maxAttempts } : null),
      ...(delayMs !== undefined ? { delayMs } : null),
    } as const;
    const next = {
      ...current,
      retry,
      ...(runtimeGeneration !== undefined && phase !== "scheduled"
        ? { observedRuntimeGeneration: runtimeGeneration }
        : null),
    };
    this.operations.set(current.promptId, next);
    return next;
  }

  /** Server confirmed that the active turn is no longer streaming. */
  abortRunning(sessionId: string): PromptOperation[] {
    const active = [...this.operations.values()].filter(
      (operation) =>
        operation.sessionId === sessionId
        && ["running", "uncertain"].includes(operation.phase),
    );
    // The current API does not identify the active Prompt. Prefer the newest
    // observed Runtime generation, then the admission generation, then the
    // explicit creation timestamp. Preserve older uncertain operations.
    active.sort((left, right) => {
      const leftGeneration = left.observedRuntimeGeneration ?? left.admissionRuntimeGeneration ?? -1;
      const rightGeneration = right.observedRuntimeGeneration ?? right.admissionRuntimeGeneration ?? -1;
      return rightGeneration - leftGeneration || right.createdAt - left.createdAt;
    });
    const latest = active[0];
    return latest ? [this.transition(latest.promptId, { type: "abort" })] : [];
  }

  /** Server confirmed cancellation of a queue item; do not cancel a raced dispatch. */
  cancelQueued(serverPromptId: string): PromptOperation | undefined {
    const operation = this.getByServerPromptId(serverPromptId);
    if (!operation || operation.phase !== "queued") return operation;
    return this.transition(operation.promptId, { type: "abort" });
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
    this.pendingAdmissions.delete(promptId);
    const operation = this.operations.get(promptId);
    this.operations.delete(promptId);
    if (operation?.serverPromptId) {
      this.serverPromptIndex.delete(operation.serverPromptId);
      this.unboundServerLifecycle.delete(operation.serverPromptId);
      this.unboundServerRetry.delete(operation.serverPromptId);
      this.retireServerPromptId(operation.serverPromptId);
    }
  }

  /** Remove every local operation and pending lifecycle fact for an authoritative Session deletion. */
  deleteSession(sessionId: string): void {
    for (const [promptId, operation] of this.operations)
      if (operation.sessionId === sessionId) this.delete(promptId);
    for (const [serverPromptId, pending] of this.unboundServerLifecycle)
      if (pending.sessionId === sessionId) {
        this.unboundServerLifecycle.delete(serverPromptId);
        this.unboundServerRetry.delete(serverPromptId);
        this.retireServerPromptId(serverPromptId);
      }
  }

  clearTerminal(): void {
    for (const [promptId, operation] of this.operations)
      if (isPromptOperationTerminal(operation) && !this.pendingAdmissions.has(promptId))
        this.delete(promptId);
    this.pruneUnboundServerLifecycle();
  }
}
