import {
  PromptCoordinator,
  type PromptAdmissionInput,
  type PromptAdmissionOptions,
} from "./prompt-coordinator";
import type { PromptOperation, PromptOperationEvent, PromptOperationDelivery } from "./prompt-operation";

/**
 * The submit controller is deliberately an authority adapter, not a second
 * Prompt store. PromptCoordinator remains the only owner of operation state;
 * this object only gives App's async submit use-case a narrow seam around it.
 */
export interface PromptSubmitDependencies {
  promptCoordinator: PromptCoordinator;
}

export interface PromptResultFacts {
  deliveryUncertain?: boolean;
  queued?: boolean;
}

export function promptPhaseForResult(
  result: PromptResultFacts,
): Extract<PromptOperationEvent, { type: "queue" | "run" | "uncertain" }> {
  return result.deliveryUncertain
    ? { type: "uncertain" }
    : result.queued
      ? { type: "queue" }
      : { type: "run" };
}

export interface PromptErrorPhaseInput {
  error: unknown;
  promptSubmitted: boolean;
  promptAcceptedByEvent: boolean;
  promptTerminalByEvent: boolean;
  isResultPending: (error: unknown) => boolean;
  isExplicitClientRejection: (error: unknown, resultPending: boolean) => boolean;
}

export function promptPhaseForError(
  input: PromptErrorPhaseInput,
): Extract<PromptOperationEvent, { type: "uncertain" | "fail" }> {
  const resultPending = input.isResultPending(input.error);
  const explicitClientRejection = input.isExplicitClientRejection(
    input.error,
    resultPending,
  );
  const outcomeUnknown =
    resultPending
    || (input.promptSubmitted
      && (
        input.promptAcceptedByEvent
        || input.promptTerminalByEvent
        || !explicitClientRejection
      ));
  return outcomeUnknown ? { type: "uncertain" } : { type: "fail" };
}

export interface PromptSubmitRequest<TResult> {
  input: PromptAdmissionInput;
  execute: (operation: PromptOperation) => Promise<TResult>;
  options?: PromptAdmissionOptions<TResult>;
}

export interface PromptSubmitController {
  admit<TResult>(request: PromptSubmitRequest<TResult>): Promise<TResult>;
  adoptAccepted(
    input: PromptAdmissionInput,
    phase: Extract<PromptOperationEvent, { type: "queue" | "run" | "uncertain" }>,
  ): PromptOperation;
  bindServerPromptId(promptId: string, serverPromptId: string): PromptOperation;
  delete(promptId: string): void;
  phaseForResult(result: PromptResultFacts): Extract<PromptOperationEvent, { type: "queue" | "run" | "uncertain" }>;
  phaseForError(input: PromptErrorPhaseInput): Extract<PromptOperationEvent, { type: "uncertain" | "fail" }>;
  observeServerLifecycle(serverPromptId: string, eventType: "agent_start" | "agent_settled" | "pi_chat_process_error", runtimeGeneration?: number, sessionId?: string, runEpoch?: string): PromptOperation | undefined;
  observeRetry(serverPromptId: string, phase: import("./prompt-operation").PromptRetryPhase, runtimeGeneration?: number, sessionId?: string, runEpoch?: string, attempt?: number, maxAttempts?: number, delayMs?: number): PromptOperation | undefined;
  clearTerminal(): void;
}

export function createPromptSubmitController(
  dependencies: PromptSubmitDependencies,
): PromptSubmitController {
  const { promptCoordinator } = dependencies;
  return {
    admit: <TResult>(request: PromptSubmitRequest<TResult>) =>
      promptCoordinator.admit(request.input, request.execute, request.options),
    adoptAccepted: (input, phase) =>
      promptCoordinator.adoptAccepted(input, phase),
    bindServerPromptId: (promptId, serverPromptId) =>
      promptCoordinator.bindServerPromptId(promptId, serverPromptId),
    delete: (promptId) => {
      promptCoordinator.delete(promptId);
    },
    phaseForResult: promptPhaseForResult,
    phaseForError: promptPhaseForError,
    observeServerLifecycle: (...args) => promptCoordinator.observeServerLifecycle(...args),
    observeRetry: (...args) => promptCoordinator.observeRetry(...args),
    clearTerminal: () => promptCoordinator.clearTerminal(),
  };
}

export type { PromptAdmissionInput, PromptAdmissionOptions, PromptOperationDelivery };
