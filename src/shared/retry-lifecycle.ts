export interface NativeRetryScheduled {
  kind: "scheduled";
  attempt: number;
  maxAttempts?: number;
  delayMs?: number;
}

export interface NativeRetryCompleted {
  kind: "completed";
  attempt: number;
}

export interface NativeRetryExhausted {
  kind: "exhausted";
  attempt: number;
}

/** `success: false` without a final error is intentionally not exhaustion. */
export interface NativeRetryInconclusive {
  kind: "inconclusive";
  attempt: number;
}

export type NativeRetryLifecycle =
  | NativeRetryScheduled
  | NativeRetryCompleted
  | NativeRetryExhausted
  | NativeRetryInconclusive;

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Normalize only the stable native retry envelope. Raw provider error bodies
 * are deliberately not returned; the Server lifecycle projector can attach
 * its own redacted failure category later.
 */
export function classifyNativeRetryEvent(
  event: unknown,
): NativeRetryLifecycle | undefined {
  if (!event || typeof event !== "object") return undefined;
  const raw = event as Record<string, unknown>;
  if (raw.type === "auto_retry_start") {
    const attempt = positiveInteger(raw.attempt);
    if (attempt === undefined) return undefined;
    const maxAttempts = positiveInteger(raw.maxAttempts);
    const delayMs = nonNegativeInteger(raw.delayMs);
    return {
      kind: "scheduled",
      attempt,
      ...(maxAttempts !== undefined ? { maxAttempts } : null),
      ...(delayMs !== undefined ? { delayMs } : null),
    };
  }
  if (raw.type !== "auto_retry_end") return undefined;
  const attempt = positiveInteger(raw.attempt);
  if (attempt === undefined || typeof raw.success !== "boolean") return undefined;
  if (raw.success === true) return { kind: "completed", attempt };
  return {
    kind:
      typeof raw.finalError === "string" && raw.finalError.trim()
        ? "exhausted"
        : "inconclusive",
    attempt,
  };
}
