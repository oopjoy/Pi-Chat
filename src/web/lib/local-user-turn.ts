import type { PiMessage, QueuedPrompt } from "../../shared/types";

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
  /** A queue_error requeued this prompt; an active sibling turn must not make it look dispatched. */
  queueRetryPending?: boolean;
  /** Native Pi steering stays hidden until Pi consumes it at message_start. */
  revealOnMessageStart?: boolean;
  /** Observer queue events omit image bytes, so only the authoritative turn slot can confirm them. */
  confirmByPosition?: boolean;
  /** True after a stale view has rendered this message into the transcript. */
  renderedInTranscript?: boolean;
}

/** Compare only the user-visible payload across local, Runtime, and JSONL forms. */
function userInstructionIdentity(message: PiMessage): string {
  type UserPayload =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string };
  const content: UserPayload[] = [];
  if (typeof message.content === "string") {
    content.push({
      type: "text",
      text: message.content.split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10)),
    });
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === "text")
        content.push({
          type: "text",
          text: (block.text || "").split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10)),
        });
      else if (block.type === "image")
        content.push({ type: "image", data: block.data || "", mimeType: block.mimeType || "" });
    }
  }
  try { return JSON.stringify(content); }
  catch { return String(content); }
}

function sameUserInstruction(left: PiMessage, right: PiMessage): boolean {
  return left.role === "user" && right.role === "user" && userInstructionIdentity(left) === userInstructionIdentity(right);
}

function authoritativeUserMatch(turn: LocalUserTurn, messages: PiMessage[], turnTotal?: number): PiMessage | undefined {
  const visibleUsers = messages.filter((message) => message.role === "user");
  const authoritativeTotal = transcriptTurnTotal(messages, turnTotal);
  const firstVisibleTurn = authoritativeTotal - visibleUsers.length + 1;
  const expectedIndex = turn.expectedTurnTotal - firstVisibleTurn;
  const positional = visibleUsers[expectedIndex];
  if (positional && sameUserInstruction(positional, turn.message)) return positional;

  const matches = visibleUsers.filter((message) => sameUserInstruction(message, turn.message));
  const localTime = typeof turn.message.timestamp === "number" && Number.isFinite(turn.message.timestamp)
    ? turn.message.timestamp
    : undefined;
  const singleTimestampCorrelates = matches.length === 1
    && localTime !== undefined
    && typeof matches[0].timestamp === "number"
    && Number.isFinite(matches[0].timestamp)
    && Math.abs(matches[0].timestamp - localTime) <= 10 * 60 * 1_000;
  if (matches.length === 1 && turnTotal !== undefined && singleTimestampCorrelates)
    return matches[0];
  // When a stale/windowed view contains repeated prompts, timestamps provide a
  // safe local correlation without collapsing two real identical turns.
  if (localTime === undefined || matches.length < 2) return undefined;
  const ranked = matches
    .map((message) => ({
      message,
      distance: typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? Math.abs(message.timestamp - localTime)
        : Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => left.distance - right.distance);
  return ranked[0].distance < ranked[1].distance
    && Boolean(ranked[0].message.piChatPersistedMessageId) !== Boolean(ranked[1].message.piChatPersistedMessageId)
    ? ranked[0].message
    : undefined;
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
  if (turn) {
    turn.queueRetryPending = false;
    if (turn.queueState !== "dispatched") turn.queueState = "waiting";
  }
  return turn;
}

/** Bind a dispatch that beat its HTTP acknowledgement to the existing local turn. */
export function bindQueuedDispatch(turns: LocalUserTurn[], queueId: string, message: string, imageCount: number): LocalUserTurn | undefined {
  const turn = bindQueuedTurn(turns, queueId, message, imageCount);
  if (turn) {
    turn.queueRetryPending = false;
    turn.queueState = "dispatched";
  }
  return turn;
}

export function localTurnBelongsInTranscript(turn: LocalUserTurn): boolean {
  return turn.queueState !== "waiting";
}

/** Render a waiting local admission when a complete queue snapshot is temporarily unavailable. */
export function queuedPromptFromLocalTurn(turn: LocalUserTurn): QueuedPrompt | undefined {
  if (turn.queueState !== "waiting" || !turn.queueId) return undefined;
  const shape = textAndImageCount(turn.message);
  const createdAt = typeof turn.message.timestamp === "number" && Number.isFinite(turn.message.timestamp)
    ? turn.message.timestamp
    : Date.now();
  return {
    id: turn.queueId,
    message: shape.text,
    imageCount: shape.imageCount,
    createdAt,
  };
}

/**
 * A late prompt acknowledgement may arrive after a view has already confirmed
 * and removed this local turn. Render only the still-pending object once.
 */
export function appendLocalTurnOnce(messages: PiMessage[], turn: LocalUserTurn | undefined): PiMessage[] {
  if (!turn || turn.renderedInTranscript) return messages;
  const authoritativeMatch = authoritativeUserMatch(turn, messages);
  if (authoritativeMatch) {
    turn.renderedInTranscript = true;
    return messages;
  }
  turn.renderedInTranscript = true;
  return messages.includes(turn.message) ? messages : [...messages, turn.message];
}

export function markLocalTurnQueued(turn: LocalUserTurn, queueId: string): void {
  turn.queueId = queueId;
  turn.queueRetryPending = false;
  if (turn.queueState !== "dispatched") turn.queueState = "waiting";
}

/**
 * A reconnect can miss both queue_dispatch and message_start. A fresh hot view
 * whose explicit queue no longer contains an admitted ID proves that Pi moved
 * that turn out of its waiting queue; reveal it instead of leaving the user
 * message hidden forever. Complete SSE queue snapshots may pass
 * authoritativeQueue even when the Runtime is already idle.
 */
export function promoteTurnsAbsentFromQueue(
  turns: LocalUserTurn[],
  queueIds: ReadonlySet<string> | undefined,
  runtimeActive: boolean,
  authoritativeQueue = false,
  blockedQueueIds?: ReadonlySet<string>,
): LocalUserTurn[] {
  if ((!runtimeActive && !authoritativeQueue) || !queueIds) return [];
  const promoted: LocalUserTurn[] = [];
  for (const turn of turns) {
    if (
      turn.queueState === "waiting"
      && !turn.revealOnMessageStart
      && !turn.queueRetryPending
      && turn.queueId
      && !blockedQueueIds?.has(turn.queueId)
      && !queueIds.has(turn.queueId)
    ) {
      turn.queueState = "dispatched";
      promoted.push(turn);
    }
  }
  return promoted;
}

/** Reveal the native steering turn Pi actually consumes. */
export function consumeLocalSteeringTurn(
  turns: LocalUserTurn[],
  message: PiMessage,
  queueId?: string,
): LocalUserTurn | undefined {
  const incoming = textAndImageCount(message);
  const turn = turns.find((candidate) => {
    if (!candidate.revealOnMessageStart || candidate.queueState !== "waiting") return false;
    if (queueId) return candidate.queueId === queueId;
    const shape = textAndImageCount(candidate.message);
    const sameText =
      shape.text === incoming.text ||
      (!shape.text && incoming.text === "请查看这些图片。");
    return sameText && shape.imageCount === incoming.imageCount;
  });
  if (turn) turn.queueState = "dispatched";
  return turn;
}

/** Drop every unconsumed native steering turn after its Runtime is reset. */
export function removePendingSteeringTurns(turns: LocalUserTurn[]): LocalUserTurn[] {
  let remaining = turns;
  for (const turn of turns) {
    if (turn.revealOnMessageStart && turn.queueState === "waiting")
      remaining = removeLocalTurnAndRebase(remaining, turn);
  }
  return remaining;
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

export interface UserTurnDuplicateDiagnostic {
  kind: "same-identity" | "local-and-persisted" | "same-content" | "unknown";
  pairCount: number;
  messageCount: number;
  localTurnCount: number;
  persistedCount: number;
  identityCount: number;
  contentHash: string;
}

function diagnosticContentHash(message: PiMessage): string {
  const value = userInstructionIdentity(message);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Detect only visible duplicate User rows; does not alter projection authority. */
export function diagnoseVisibleUserTurnDuplicates(
  messages: PiMessage[],
  localTurns: readonly LocalUserTurn[] = [],
): UserTurnDuplicateDiagnostic[] {
  const users = messages.filter((message) => message.role === "user");
  const results: UserTurnDuplicateDiagnostic[] = [];
  for (let left = 0; left < users.length; left += 1) {
    for (let right = left + 1; right < users.length; right += 1) {
      const first = users[left];
      const second = users[right];
      if (!sameUserInstruction(first, second)) continue;
      const sameIdentity = Boolean(
        first.piChatPersistedMessageId &&
        first.piChatPersistedMessageId === second.piChatPersistedMessageId,
      ) || Boolean(
        first.piChatLiveMessageId &&
        first.piChatLiveMessageId === second.piChatLiveMessageId,
      );
      const localMatch = localTurns.some((turn) =>
        sameUserInstruction(turn.message, first) || sameUserInstruction(turn.message, second),
      );
      const persistedCount = [first, second].filter((message) => Boolean(message.piChatPersistedMessageId)).length;
      results.push({
        kind: sameIdentity ? "same-identity" : localMatch && persistedCount > 0 ? "local-and-persisted" : "same-content",
        pairCount: 1,
        messageCount: users.length,
        localTurnCount: localTurns.length,
        persistedCount,
        identityCount: new Set([first.piChatPersistedMessageId || first.piChatLiveMessageId || "", second.piChatPersistedMessageId || second.piChatLiveMessageId || ""]).size,
        contentHash: diagnosticContentHash(first),
      });
    }
  }
  return results;
}

export function nextLocalTurnTotal(messages: PiMessage[], total: number | undefined, pending: LocalUserTurn[]): number {
  return Math.max(transcriptTurnTotal(messages, total), ...pending.map((turn) => turn.expectedTurnTotal), 0) + 1;
}

export function transcriptConfirmsLocalTurn(
  turn: LocalUserTurn,
  messages: PiMessage[],
  total?: number,
  messagesTruncated = false,
): boolean {
  const authoritativeTotal = transcriptTurnTotal(messages, total);
  if (authoritativeTotal < turn.expectedTurnTotal) {
    // A stale/windowed response can carry fewer turns than the local watermark.
    // If it contains the one authoritative representation of this turn, prefer
    // that row and do not render a second local copy beside it.
    return Boolean(authoritativeUserMatch(turn, messages, total)?.piChatPersistedMessageId);
  }
  const visibleUsers = messages.filter((message) => message.role === "user");
  const firstVisibleTurn = authoritativeTotal - visibleUsers.length + 1;
  // The authoritative suffix has advanced beyond this old local turn. It can no
  // longer be visible, but the later turn watermark proves it was persisted.
  if (turn.expectedTurnTotal < firstVisibleTurn) return messagesTruncated;
  const candidate = visibleUsers[turn.expectedTurnTotal - firstVisibleTurn];
  return Boolean(candidate && (turn.confirmByPosition || sameUserInstruction(candidate, turn.message)))
    || Boolean(authoritativeUserMatch(turn, messages, total)?.piChatPersistedMessageId);
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
 * can coexist, so a single pending-turn watermark is insufficient. A complete
 * queue projection also keeps an item waiting while it is still in the FIFO,
 * even if a stale turn watermark would otherwise appear to confirm it.
 */
export function protectTranscriptWithLocalTurns(
  turns: LocalUserTurn[] | undefined,
  messages: PiMessage[],
  messageTotal: number | undefined,
  turnTotal: number | undefined,
  messagesTruncated = false,
  waitingQueueIds?: ReadonlySet<string>,
): ProtectedTranscript {
  const resolvedMessageTotal = typeof messageTotal === "number" && Number.isFinite(messageTotal) ? messageTotal : messages.length;
  const resolvedTurnTotal = transcriptTurnTotal(messages, turnTotal);
  const pendingTurns = (turns || []).filter((turn) => {
    const keepWaitingAdmission =
      turn.queueState === "waiting" &&
      !turn.revealOnMessageStart &&
      (!turn.queueId ||
        turn.queueRetryPending ||
        waitingQueueIds?.has(turn.queueId));
    return keepWaitingAdmission || !transcriptConfirmsLocalTurn(
      turn,
      messages,
      resolvedTurnTotal,
      messagesTruncated,
    );
  });
  if (!pendingTurns.length) {
    return { messages, messageTotal: resolvedMessageTotal, turnTotal: resolvedTurnTotal, pendingTurns };
  }
  const protectedMessages = [...messages];
  const visiblePendingTurns = pendingTurns.filter(localTurnBelongsInTranscript);
  for (const turn of visiblePendingTurns) {
    // A stale view can re-run protection after an SSE/ack handler already
    // inserted this exact optimistic object. Do not append it a second time;
    // object identity is intentional so two genuinely identical prompts stay
    // distinct.
    if (protectedMessages.includes(turn.message)) {
      turn.renderedInTranscript = true;
      continue;
    }
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
