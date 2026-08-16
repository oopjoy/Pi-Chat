export const PROMPT_EVIDENCE_FACT_KINDS = [
  "admitted",
  "queued",
  "cancelled",
  "dispatch",
  "requeued",
  "rpc-allocated",
  "rpc-written",
  "rpc-response-success",
  "rpc-response-error",
  "rpc-not-written",
  "rpc-written-outcome-unknown",
  "rpc-process-rejected",
  "delivery-uncertain",
  "agent-start",
  "settled",
  "settlement-barrier",
  "process-failed",
] as const;

export type PromptEvidenceFactKind = typeof PROMPT_EVIDENCE_FACT_KINDS[number];
export type PromptDeliveryCertainty = "unknown" | "not-delivered" | "uncertain" | "confirmed";
export type PromptExecutionStatus = "unknown" | "queued" | "dispatching" | "started" | "settled" | "failed" | "cancelled";

export interface PromptEvidenceFact {
  sequence: number;
  observedAt: string;
  promptId: string;
  sessionId: string;
  kind: PromptEvidenceFactKind;
  rpcGeneration?: number;
  runGeneration?: number;
}

export interface PromptEvidenceRecord {
  promptId: string;
  sessionId: string;
  firstObservedAt: string;
  lastObservedAt: string;
  delivery: PromptDeliveryCertainty;
  execution: PromptExecutionStatus;
  rpcGeneration?: number;
  runGeneration?: number;
  facts: PromptEvidenceFactKind[];
  /** Privacy export may retain a bounded head/tail view of a longer fact history. */
  factCount?: number;
  factsTruncated?: boolean;
  conflicted?: boolean;
}

export interface PromptEvidenceStatus {
  recordCount: number;
  windowMs: number;
  maximumRecords: number;
  approximateBytes: number;
  maximumBytes: number;
}

export interface PromptEvidenceSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  status: PromptEvidenceStatus;
  records: PromptEvidenceRecord[];
}

const FACT_KIND_SET = new Set<string>(PROMPT_EVIDENCE_FACT_KINDS);
const DELIVERY_SET = new Set<string>(["unknown", "not-delivered", "uncertain", "confirmed"]);
const EXECUTION_SET = new Set<string>(["unknown", "queued", "dispatching", "started", "settled", "failed", "cancelled"]);
const RPC_FACTS = new Set<PromptEvidenceFactKind>([
  "rpc-allocated",
  "rpc-written",
  "rpc-response-success",
  "rpc-response-error",
  "rpc-not-written",
  "rpc-written-outcome-unknown",
  "rpc-process-rejected",
]);
const LIFECYCLE_FACTS = new Set<PromptEvidenceFactKind>([
  "agent-start",
  "settled",
  "settlement-barrier",
  "process-failed",
]);
const POSITIVE_DELIVERY_FACTS = new Set<PromptEvidenceFactKind>([
  "rpc-response-success",
  "rpc-response-error",
  "agent-start",
  "settled",
  "settlement-barrier",
]);
const UNCERTAIN_DELIVERY_FACTS = new Set<PromptEvidenceFactKind>([
  "rpc-written",
  "rpc-written-outcome-unknown",
  "delivery-uncertain",
]);
const TERMINAL_EXECUTION = new Set<PromptExecutionStatus>(["settled", "failed", "cancelled"]);

export function isPromptEvidenceFactKind(value: unknown): value is PromptEvidenceFactKind {
  return typeof value === "string" && FACT_KIND_SET.has(value);
}

export function isPromptDeliveryCertainty(value: unknown): value is PromptDeliveryCertainty {
  return typeof value === "string" && DELIVERY_SET.has(value);
}

export function isPromptExecutionStatus(value: unknown): value is PromptExecutionStatus {
  return typeof value === "string" && EXECUTION_SET.has(value);
}

function safeGeneration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function conflictsWithTerminal(
  current: PromptExecutionStatus,
  next: PromptExecutionStatus,
): boolean {
  return TERMINAL_EXECUTION.has(current) && current !== next;
}

function withExecution(
  record: PromptEvidenceRecord,
  next: PromptExecutionStatus,
  allowFailedRetry = false,
): PromptEvidenceRecord {
  if (record.execution === next) return record;
  if (allowFailedRetry && record.execution === "failed" && next === "queued")
    return { ...record, execution: next };
  if (conflictsWithTerminal(record.execution, next))
    return { ...record, execution: "unknown", conflicted: true };
  return { ...record, execution: next };
}

function applyDelivery(
  record: PromptEvidenceRecord,
  kind: PromptEvidenceFactKind,
): PromptEvidenceRecord {
  if (kind === "requeued" && record.delivery === "not-delivered")
    return { ...record, delivery: "unknown" };
  if (kind === "rpc-not-written") {
    if (record.delivery === "confirmed" || record.delivery === "uncertain")
      return { ...record, delivery: "unknown", conflicted: true };
    return { ...record, delivery: "not-delivered" };
  }
  if (POSITIVE_DELIVERY_FACTS.has(kind)) {
    if (record.delivery === "not-delivered")
      return { ...record, delivery: "unknown", conflicted: true };
    return { ...record, delivery: "confirmed" };
  }
  if (UNCERTAIN_DELIVERY_FACTS.has(kind)) {
    if (record.delivery === "not-delivered")
      return { ...record, delivery: "unknown", conflicted: true };
    if (record.delivery === "confirmed") return record;
    return { ...record, delivery: "uncertain" };
  }
  return record;
}

function applyExecution(
  record: PromptEvidenceRecord,
  kind: PromptEvidenceFactKind,
): PromptEvidenceRecord {
  switch (kind) {
    case "queued":
      return record.execution === "unknown" || record.execution === "queued"
        ? { ...record, execution: "queued" }
        : withExecution(record, "queued");
    case "dispatch":
      return withExecution(record, "dispatching");
    case "requeued":
      return withExecution(record, "queued", true);
    case "cancelled":
      return record.execution === "queued"
        ? { ...record, execution: "cancelled" }
        : { ...record, execution: "unknown", conflicted: true };
    case "agent-start":
      return withExecution(record, "started");
    case "settled":
      return withExecution(record, "settled");
    case "rpc-response-error":
    case "rpc-not-written":
    case "rpc-process-rejected":
    case "process-failed":
      return withExecution(record, "failed");
    default:
      return record;
  }
}

/** Pure fold for one already validated, server-local prompt fact. */
export function reducePromptEvidenceRecord(
  previous: PromptEvidenceRecord | undefined,
  fact: PromptEvidenceFact,
): PromptEvidenceRecord {
  const rpcGeneration = safeGeneration(fact.rpcGeneration);
  const runGeneration = safeGeneration(fact.runGeneration);
  const base: PromptEvidenceRecord = previous || {
    promptId: fact.promptId,
    sessionId: fact.sessionId,
    firstObservedAt: fact.observedAt,
    lastObservedAt: fact.observedAt,
    delivery: "unknown",
    execution: "unknown",
    facts: [],
  };
  if (base.promptId !== fact.promptId || base.sessionId !== fact.sessionId) return base;
  if (
    LIFECYCLE_FACTS.has(fact.kind)
    && base.rpcGeneration !== undefined
    && base.rpcGeneration > 0
    && rpcGeneration !== undefined
    && rpcGeneration > 0
    && base.rpcGeneration !== rpcGeneration
  ) return base;
  if (
    RPC_FACTS.has(fact.kind)
    && base.rpcGeneration !== undefined
    && base.rpcGeneration > 0
    && rpcGeneration !== undefined
    && rpcGeneration > 0
    && base.rpcGeneration !== rpcGeneration
  ) return base;
  if (
    LIFECYCLE_FACTS.has(fact.kind)
    && base.runGeneration !== undefined
    && runGeneration !== undefined
    && base.runGeneration !== runGeneration
  ) return base;
  if (base.facts.at(-1) === fact.kind) return base;

  let next: PromptEvidenceRecord = {
    ...base,
    lastObservedAt: fact.observedAt,
    facts: [...base.facts, fact.kind],
    ...(RPC_FACTS.has(fact.kind) && rpcGeneration !== undefined && rpcGeneration > 0
      ? { rpcGeneration }
      : null),
    ...(LIFECYCLE_FACTS.has(fact.kind) && runGeneration !== undefined
      ? { runGeneration }
      : null),
  };
  next = applyDelivery(next, fact.kind);
  next = applyExecution(next, fact.kind);
  if (fact.kind === "requeued") {
    const {
      rpcGeneration: _completedAttemptRpcGeneration,
      runGeneration: _completedAttemptRunGeneration,
      ...unboundRetry
    } = next;
    next = unboundRetry;
  }
  return next;
}

export function replayPromptEvidence(facts: PromptEvidenceFact[]): PromptEvidenceRecord | undefined {
  let record: PromptEvidenceRecord | undefined;
  for (const fact of [...facts].sort((left, right) => left.sequence - right.sequence))
    record = reducePromptEvidenceRecord(record, fact);
  return record;
}
