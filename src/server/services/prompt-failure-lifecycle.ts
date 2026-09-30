import type { PiMessage, PromptSettingsSnapshot } from "../../shared/types.js";
import type { PromptFailure } from "../../shared/assistant-error.js";
import type { PromptEvidenceFactKind } from "../../shared/prompt-evidence.js";
import { normalizePromptFailure } from "../../shared/assistant-error.js";
import { classifyNativeRetryEvent } from "../../shared/retry-lifecycle.js";

export interface ActivePromptFailureLifecycle {
  promptId: string;
  rpcGeneration: number;
  route?: PromptSettingsSnapshot["model"];
  failure?: PromptFailure;
  retryAttempt?: number;
  retryPending?: boolean;
  retryExhausted?: boolean;
  retryExhaustedPublished?: boolean;
  terminalPublished?: boolean;
}

export interface PromptFailureLifecyclePorts {
  runEpoch(): string;
  broadcast(event: Record<string, unknown>): void;
  recordEvidence(input: {
    sessionId: string;
    promptId: string;
    kind: PromptEvidenceFactKind;
    rpcGeneration: number;
    runGeneration: number;
    attempt?: number;
    maxAttempts?: number;
    delayMs?: number;
  }): void;
}

/** Project native retry/failure facts without becoming a retry authority. */
export function projectPromptFailureLifecycle(input: {
  active: ActivePromptFailureLifecycle;
  sessionId: string;
  event: Record<string, unknown>;
  runGeneration: number;
  rpcGeneration: number;
}, ports: PromptFailureLifecyclePorts): void {
  const { active, sessionId, event, runGeneration, rpcGeneration } = input;
  const route: Partial<NonNullable<PromptSettingsSnapshot["model"]>> = active.route || {};
  const recordRetryFact = (kind: "retry-scheduled" | "retry-started" | "retry-exhausted", attempt?: number, maxAttempts?: number, delayMs?: number) => {
    ports.recordEvidence({
      sessionId,
      promptId: active.promptId,
      kind,
      rpcGeneration,
      runGeneration,
      ...(attempt !== undefined ? { attempt } : null),
      ...(maxAttempts !== undefined ? { maxAttempts } : null),
      ...(delayMs !== undefined ? { delayMs } : null),
    });
  };
  const lifecycleFor = (failure: PromptFailure, retryAttempt?: number) => ({
    piChatSessionId: sessionId,
    piChatRunEpoch: ports.runEpoch(),
    piChatRunGeneration: runGeneration,
    piChatPromptId: active.promptId,
    failureKind: failure.kind,
    ...(failure.provider || route.provider ? { provider: failure.provider || route.provider } : null),
    ...(failure.model || route.modelId ? { model: failure.model || route.modelId } : null),
    ...(failure.api || route.api ? { api: failure.api || route.api } : null),
    ...(failure.status !== undefined ? { status: failure.status } : null),
    ...(failure.retryAttempts !== undefined ? { retryAttempts: failure.retryAttempts } : null),
    ...(failure.requestId ? { requestId: failure.requestId } : null),
    ...(failure.incidentId ? { incidentId: failure.incidentId } : null),
    ...(retryAttempt !== undefined ? { retryAttempt } : null),
  });
  const retry = classifyNativeRetryEvent(event);
  if (retry?.kind === "scheduled") {
    const raw = typeof event.errorMessage === "string" ? event.errorMessage : "模型请求失败";
    const failure = normalizePromptFailure(raw, {
      provider: route.provider,
      model: route.modelId,
      api: route.api,
      retryAttempts: retry.attempt,
    });
    active.retryPending = true;
    active.retryAttempt = retry.attempt;
    active.failure = failure;
    recordRetryFact("retry-scheduled", retry.attempt, retry.maxAttempts, retry.delayMs);
    ports.broadcast({
      type: "pi_chat_prompt_retry_scheduled",
      ...lifecycleFor(failure, retry.attempt),
      ...(retry.delayMs !== undefined ? { delayMs: retry.delayMs } : null),
      ...(retry.maxAttempts !== undefined ? { maxAttempts: retry.maxAttempts } : null),
    });
    return;
  }
  if (retry?.kind === "completed" || retry?.kind === "inconclusive" || retry?.kind === "exhausted") {
    active.retryPending = false;
    if (retry.kind === "completed" || retry.kind === "inconclusive") {
      active.failure = undefined;
      active.retryExhausted = false;
      return;
    }
    const failure = normalizePromptFailure(event.finalError as string, {
      provider: route.provider,
      model: route.modelId,
      api: route.api,
      retryAttempts: retry.attempt,
    });
    active.failure = failure;
    active.retryExhausted = true;
    recordRetryFact("retry-exhausted", retry.attempt);
    if (!active.retryExhaustedPublished) {
      active.retryExhaustedPublished = true;
      ports.broadcast({ type: "pi_chat_prompt_retry_exhausted", ...lifecycleFor(failure, retry.attempt), retryExhausted: true });
    }
    return;
  }
  if (event.type === "agent_start") {
    if (!active.retryPending || !active.failure) return;
    active.retryPending = false;
    recordRetryFact("retry-started", active.retryAttempt);
    ports.broadcast({ type: "pi_chat_prompt_retry_started", ...lifecycleFor(active.failure, active.retryAttempt) });
    return;
  }
  if (event.type === "message_end" && event.message && typeof event.message === "object") {
    const message = event.message as PiMessage;
    if (message.role !== "assistant" || typeof message.errorMessage !== "string" || !message.errorMessage.trim()) {
      active.failure = undefined;
      return;
    }
    active.failure = normalizePromptFailure(message.errorMessage, {
      provider: message.provider || route.provider,
      model: message.model || route.modelId,
      api: message.api || route.api,
    });
    return;
  }
  if (event.type === "pi_chat_process_error") {
    const raw = typeof event.error === "string" && event.error.trim() ? event.error : "Pi RPC 已退出";
    active.failure = normalizePromptFailure(raw, {
      provider: event.provider || route.provider,
      model: event.model || route.modelId,
      api: event.api || route.api,
      status: event.status,
      retryAttempts: event.retryAttempts,
      requestId: event.requestId,
      incidentId: event.incidentId,
      aborted: event.failureKind === "user-aborted",
      runtimeExit: event.errorCode === "RPC_CHILD_EXIT" || event.errorCode === "PI_RPC_EXIT_UNCONFIRMED",
      modelUnavailable: event.errorCode === "MODEL_UNAVAILABLE",
    });
  }
  if ((event.type === "agent_settled" || event.type === "pi_chat_process_error") && active.failure && !active.terminalPublished) {
    active.terminalPublished = true;
    const lifecycle = lifecycleFor(active.failure, active.retryAttempt);
    ports.broadcast({ type: "pi_chat_prompt_failed", ...lifecycle });
    if ((active.retryExhausted || active.failure.retryExhausted) && !active.retryExhaustedPublished) {
      active.retryExhaustedPublished = true;
      ports.broadcast({ type: "pi_chat_prompt_retry_exhausted", ...lifecycle, retryExhausted: true });
    }
  }
}
