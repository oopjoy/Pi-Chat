import type { PiMessage } from "../../shared/types";

/** A locally accepted user turn that JSONL has not yet exposed to a view read. */
export interface LocalUserTurn {
  sessionId: string;
  message: PiMessage;
  /** Cumulative user-turn count at which this individual turn is persisted. */
  expectedTurnTotal: number;
  /** Assigned after a queued-prompt acknowledgement; used to deduplicate dispatch. */
  queueId?: string;
  /** Queued turns stay out of the transcript until the scheduler dispatches them. */
  queueState?: "waiting" | "dispatched";
  /** Observer queue events omit image bytes, so only the authoritative turn slot can confirm them. */
  confirmByPosition?: boolean;
  /** True after a stale view has rendered this message into the transcript. */
  renderedInTranscript?: boolean;
}

function contentIdentity(message: PiMessage): string {
  const content = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
  try { return JSON.stringify(content); }
  catch { return String(content); }
}

function sameUserInstruction(left: PiMessage, right: PiMessage): boolean {
  return left.role === "user" && right.role === "user" && contentIdentity(left) === contentIdentity(right);
}

function textAndImageCount(message: PiMessage): { text: string; imageCount: number } {
  if (typeof message.content === "string") return { text: message.content, imageCount: 0 };
  if (!Array.isArray(message.content)) return { text: "", imageCount: 0 };
  return {
    text: message.content.filter((block) => block.type === "text").map((block) => block.text || "").join("\n"),
    imageCount: message.content.filter((block) => block.type === "image").length,
  };
}

function bindQueuedTurn(turns: LocalUserTurn[], queueId: string, message: string, imageCount: number): LocalUserTurn | undefined {
  if (!queueId) return undefined;
  const existing = turns.find((turn) => turn.queueId === queueId);
  if (existing) return existing;
  const candidate = turns.find((turn) => {
    if (turn.queueId) return false;
    const shape = textAndImageCount(turn.message);
    return shape.text === message && shape.imageCount === imageCount;
  });
  if (candidate) candidate.queueId = queueId;
  return candidate;
}

/** Bind queue admission that beat its HTTP acknowledgement. */
export function bindQueuedAdmission(turns: LocalUserTurn[], queueId: string, message: string, imageCount: number): LocalUserTurn | undefined {
  const turn = bindQueuedTurn(turns, queueId, message, imageCount);
  if (turn && turn.queueState !== "dispatched") turn.queueState = "waiting";
  return turn;
}

/** Bind a dispatch that beat its HTTP acknowledgement to the existing local turn. */
export function bindQueuedDispatch(turns: LocalUserTurn[], queueId: string, message: string, imageCount: number): LocalUserTurn | undefined {
  const turn = bindQueuedTurn(turns, queueId, message, imageCount);
  if (turn) turn.queueState = "dispatched";
  return turn;
}

export function localTurnBelongsInTranscript(turn: LocalUserTurn): boolean {
  return turn.queueState !== "waiting";
}

/**
 * A late prompt acknowledgement may arrive after a view has already confirmed
 * and removed this local turn. Render only the still-pending object once.
 */
export function appendLocalTurnOnce(messages: PiMessage[], turn: LocalUserTurn | undefined): PiMessage[] {
  if (!turn || turn.renderedInTranscript) return messages;
  turn.renderedInTranscript = true;
  return messages.includes(turn.message) ? messages : [...messages, turn.message];
}

export function markLocalTurnQueued(turn: LocalUserTurn, queueId: string): void {
  turn.queueId = queueId;
  if (turn.queueState !== "dispatched") turn.queueState = "waiting";
}

export function removeLocalTurnAndRebase(turns: LocalUserTurn[], removed: LocalUserTurn): LocalUserTurn[] {
  if (!turns.includes(removed)) return turns;
  for (const turn of turns) {
    if (turn !== removed && turn.expectedTurnTotal > removed.expectedTurnTotal) turn.expectedTurnTotal -= 1;
  }
  return turns.filter((turn) => turn !== removed);
}

export function transcriptTurnTotal(messages: PiMessage[], total?: number): number {
  const visibleTurns = messages.filter((message) => message.role === "user").length;
  return typeof total === "number" && Number.isFinite(total)
    ? Math.max(total, visibleTurns)
    : visibleTurns;
}

export function nextLocalTurnTotal(messages: PiMessage[], total: number | undefined, pending: LocalUserTurn[]): number {
  return Math.max(transcriptTurnTotal(messages, total), ...pending.map((turn) => turn.expectedTurnTotal), 0) + 1;
}

export function transcriptConfirmsLocalTurn(turn: LocalUserTurn, messages: PiMessage[], total?: number): boolean {
  const authoritativeTotal = transcriptTurnTotal(messages, total);
  if (authoritativeTotal < turn.expectedTurnTotal) return false;
  const visibleUsers = messages.filter((message) => message.role === "user");
  const firstVisibleTurn = authoritativeTotal - visibleUsers.length + 1;
  // The authoritative suffix has advanced beyond this old local turn. It can no
  // longer be visible, but the later turn watermark proves it was persisted.
  if (turn.expectedTurnTotal < firstVisibleTurn) return true;
  const candidate = visibleUsers[turn.expectedTurnTotal - firstVisibleTurn];
  return Boolean(candidate && (turn.confirmByPosition || sameUserInstruction(candidate, turn.message)));
}

export interface ProtectedTranscript {
  messages: PiMessage[];
  messageTotal: number;
  turnTotal: number;
  pendingTurns: LocalUserTurn[];
}

/**
 * The immediate composer overlay and the protected local-turn overlay can
 * briefly coexist while an SSE-driven view refresh races the prompt HTTP
 * acknowledgement. They represent the same client-created object, not two
 * user instructions. Object identity is intentional: timestamps have only
 * millisecond precision, so equivalent but independently submitted messages
 * must remain separate turns.
 */
export function appendPendingUserMessage(messages: PiMessage[], pending: PiMessage | null): PiMessage[] {
  return !pending || messages.includes(pending) ? messages : [...messages, pending];
}

/**
 * Keep every accepted local user turn visible until an authoritative JSONL
 * view contains its corresponding cumulative user-turn count. Queued prompts
 * can coexist, so a single pending-turn watermark is insufficient.
 */
export function protectTranscriptWithLocalTurns(
  turns: LocalUserTurn[] | undefined,
  messages: PiMessage[],
  messageTotal: number | undefined,
  turnTotal: number | undefined,
): ProtectedTranscript {
  const resolvedMessageTotal = typeof messageTotal === "number" && Number.isFinite(messageTotal) ? messageTotal : messages.length;
  const resolvedTurnTotal = transcriptTurnTotal(messages, turnTotal);
  const pendingTurns = (turns || []).filter((turn) => !transcriptConfirmsLocalTurn(turn, messages, resolvedTurnTotal));
  if (!pendingTurns.length) {
    return { messages, messageTotal: resolvedMessageTotal, turnTotal: resolvedTurnTotal, pendingTurns };
  }
  const protectedMessages = [...messages];
  const visiblePendingTurns = pendingTurns.filter(localTurnBelongsInTranscript);
  for (const turn of visiblePendingTurns) {
    const localTimestamp = typeof turn.message.timestamp === "number" && Number.isFinite(turn.message.timestamp)
      ? turn.message.timestamp
      : undefined;
    const insertAt = localTimestamp === undefined
      ? -1
      : protectedMessages.findIndex((message) => typeof message.timestamp === "number" && Number.isFinite(message.timestamp) && message.timestamp > localTimestamp);
    if (insertAt < 0) protectedMessages.push(turn.message);
    else protectedMessages.splice(insertAt, 0, turn.message);
  }
  return {
    messages: protectedMessages,
    messageTotal: Math.max(resolvedMessageTotal + visiblePendingTurns.length, protectedMessages.length),
    turnTotal: visiblePendingTurns.at(-1)?.expectedTurnTotal || resolvedTurnTotal,
    pendingTurns,
  };
}
