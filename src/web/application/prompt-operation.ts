import type { PromptDelivery } from "../../shared/types";

export type PromptOperationDelivery = "normal" | PromptDelivery;
export type PromptRetryPhase = "scheduled" | "running" | "exhausted" | "cancelled";

export interface PromptRetryState {
  readonly phase: PromptRetryPhase;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
}

export type PromptOperationPhase =
  | "created"
  | "admitting"
  | "queued"
  | "dispatching"
  | "uncertain"
  | "running"
  | "settled"
  | "failed"
  | "aborted";

export interface PromptOperation {
  /** Browser-local operation identity; never sent to Pi as server authority. */
  readonly promptId: string;
  /** Server-owned identity returned by HTTP admission and echoed by SSE. */
  readonly serverPromptId?: string;
  readonly sessionId: string;
  readonly navigationEpoch: number;
  /** Server Runtime/workspace epoch; distinct from browser navigationEpoch. */
  readonly runEpoch?: string;
  /** Generation observed when this Browser operation was admitted. */
  readonly admissionRuntimeGeneration?: number;
  /** Generation observed from an actual Runtime lifecycle event. */
  readonly observedRuntimeGeneration?: number;
  readonly retry?: PromptRetryState;
  readonly delivery: PromptOperationDelivery;
  readonly phase: PromptOperationPhase;
  readonly createdAt: number;
}

export type PromptOperationEvent =
  | { type: "admit" }
  | { type: "queue" }
  | { type: "dispatch" }
  | { type: "uncertain" }
  | { type: "run"; runtimeGeneration?: number }
  | { type: "settle" }
  | { type: "fail" }
  | { type: "abort" };

export type PromptAuthoritySnapshot = {
  sessionId: string;
  navigationEpoch: number;
  runEpoch?: string;
  runtimeGeneration?: number;
};

/** Facts that remain owned by Pi/server rather than this browser model. */
export const PROMPT_AUTHORITY_CONTRACT = {
  accepted: "pi-runtime-or-server-response-and-event",
  queued: "server-queue",
  running: "runtime-event",
  settled: "runtime-settlement-event",
  failed: "runtime-or-server-failure",
  optimisticTurn: "browser-prompt-projection",
  paneCommit: "pane-authority",
  retry: "pi-native-retry-lifecycle",
  transcript: "pi-jsonl",
} as const;

export function createPromptOperation(input: {
  promptId: string;
  sessionId: string;
  navigationEpoch: number;
  runEpoch?: string;
  runtimeGeneration?: number;
  delivery: PromptOperationDelivery;
  createdAt?: number;
}): PromptOperation {
  return {
    promptId: input.promptId,
    sessionId: input.sessionId,
    navigationEpoch: input.navigationEpoch,
    ...(input.runEpoch ? { runEpoch: input.runEpoch } : null),
    admissionRuntimeGeneration: input.runtimeGeneration,
    delivery: input.delivery,
    createdAt: input.createdAt ?? Date.now(),
    phase: "created",
  };
}

const TRANSITIONS: Readonly<Record<PromptOperationPhase, readonly PromptOperationPhase[]>> = {
  created: ["admitting", "aborted"],
  admitting: ["queued", "dispatching", "uncertain", "running", "failed", "aborted"],
  queued: ["dispatching", "failed", "aborted"],
  dispatching: ["queued", "uncertain", "running", "failed", "aborted"],
  uncertain: ["queued", "running", "settled", "failed", "aborted"],
  running: ["settled", "failed", "aborted"],
  settled: [],
  failed: [],
  aborted: [],
};

const EVENT_TARGET: Readonly<Record<PromptOperationEvent["type"], PromptOperationPhase>> = {
  admit: "admitting",
  queue: "queued",
  dispatch: "dispatching",
  uncertain: "uncertain",
  run: "running",
  settle: "settled",
  fail: "failed",
  abort: "aborted",
};

export function transitionPromptOperation(
  operation: PromptOperation,
  event: PromptOperationEvent,
): PromptOperation | undefined {
  const nextPhase = EVENT_TARGET[event.type];
  if (!TRANSITIONS[operation.phase].includes(nextPhase)) return undefined;
  return {
    ...operation,
    phase: nextPhase,
    ...(event.type === "run" && event.runtimeGeneration !== undefined
      ? { observedRuntimeGeneration: event.runtimeGeneration }
      : null),
  };
}

/** Unknown delivery outcome is intentionally not treated as rejection. */
export function isPromptOperationTerminal(operation: PromptOperation): boolean {
  return operation.phase === "settled" || operation.phase === "failed" || operation.phase === "aborted";
}

/** Check whether a continuation may still affect the same Session operation. */
export function promptOperationIsCurrent(
  operation: PromptOperation,
  current: PromptAuthoritySnapshot,
): boolean {
  if (isPromptOperationTerminal(operation)) return false;
  if (operation.sessionId !== current.sessionId) return false;
  if (operation.navigationEpoch !== current.navigationEpoch) return false;
  if (operation.runEpoch !== undefined
    && current.runEpoch !== undefined
    && operation.runEpoch !== current.runEpoch)
    return false;
  const observedGeneration = operation.observedRuntimeGeneration
    ?? operation.admissionRuntimeGeneration;
  return observedGeneration === undefined
    || current.runtimeGeneration === undefined
    || observedGeneration === current.runtimeGeneration;
}
