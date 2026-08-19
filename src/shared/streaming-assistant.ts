import type { PiContentBlock, PiMessage } from "./types.js";

const MAX_ASSISTANT_CONTENT_BLOCKS = 256;

interface AssistantStreamEvent {
  type?: unknown;
  contentIndex?: unknown;
  delta?: unknown;
  content?: unknown;
  toolCall?: unknown;
}

/**
 * Pi's stream event type is authoritative while an assistant message is live.
 * Some provider adapters briefly expose a thinking block as text in the
 * snapshot, then correct it later. Normalize that exact content slot as soon
 * as Pi says the delta is thinking, so private thought never reaches chat UI.
 */
export function normalizeStreamingAssistantMessage(message: PiMessage, assistantMessageEvent: unknown): PiMessage {
  const streamEvent = assistantMessageEvent as AssistantStreamEvent | undefined;
  if (!streamEvent || typeof streamEvent.type !== "string" || !streamEvent.type.startsWith("thinking_")) return message;
  const contentIndex = streamEvent.contentIndex;
  if (
    typeof contentIndex !== "number"
    || !Number.isInteger(contentIndex)
    || contentIndex < 0
    || contentIndex >= MAX_ASSISTANT_CONTENT_BLOCKS
  ) return message;

  const rawBlocks = Array.isArray(message.content)
    ? message.content
    : contentIndex === 0 ? [{ type: "text", text: message.content }] : [];
  const existing = rawBlocks[contentIndex] || { type: "thinking" };
  const thinking = typeof existing.thinking === "string"
    ? existing.thinking
    : typeof existing.text === "string"
      ? existing.text
      : typeof streamEvent.content === "string"
        ? streamEvent.content
        : typeof streamEvent.delta === "string"
          ? streamEvent.delta
          : "";
  const { text: _text, ...rest } = existing;
  const normalized: PiContentBlock = { ...rest, type: "thinking", thinking };
  const blocks = [...rawBlocks];
  blocks[contentIndex] = normalized;
  return { ...message, content: blocks };
}

function assistantBlocks(message: PiMessage | undefined): PiContentBlock[] {
  if (!message) return [];
  if (typeof message.content === "string")
    return message.content ? [{ type: "text", text: message.content }] : [];
  return Array.isArray(message.content)
    ? message.content.map((block) => ({ ...block }))
    : [];
}

function hasAssistantPayload(message: PiMessage): boolean {
  if (typeof message.content === "string") return message.content.length > 0;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block) => {
    if (block.type === "text") return Boolean(block.text);
    if (block.type === "thinking") return Boolean(block.thinking);
    if (block.type === "toolCall") return Boolean(block.id || block.name || block.arguments);
    if (block.type === "image") return Boolean(block.data && block.mimeType);
    return true;
  });
}

function validContentIndex(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value < MAX_ASSISTANT_CONTENT_BLOCKS;
}

function ensureBlockSlot(blocks: PiContentBlock[], index: number): void {
  while (blocks.length <= index) blocks.push({ type: "text", text: "" });
}

/**
 * Project Pi's token delta protocol into one cumulative live assistant message.
 * Some RPC builds expose only `assistantMessageEvent.delta` while leaving both
 * `message.content` and `assistantMessageEvent.partial` empty. The TUI consumes
 * those deltas directly; Pi Chat must do the same before applying its cumulative
 * SSE/browser throttles. Providers that already supply a non-empty cumulative
 * message remain authoritative and are never double-appended.
 */
export function accumulateStreamingAssistantMessage(
  previous: PiMessage | undefined,
  incoming: PiMessage,
  assistantMessageEvent: unknown,
): PiMessage {
  // Check the Runtime envelope before thinking normalization: normalization can
  // synthesize one block from the current delta, but that single delta is not a
  // cumulative snapshot and must still be appended to the previous projection.
  const incomingHasPayload = hasAssistantPayload(incoming);
  const normalized = normalizeStreamingAssistantMessage(incoming, assistantMessageEvent);
  const previousAssistant = previous?.role === "assistant" ? previous : undefined;
  const merged: PiMessage = {
    ...previousAssistant,
    ...normalized,
    role: "assistant",
  };
  if (incomingHasPayload) return merged;

  const blocks = assistantBlocks(previousAssistant);
  const streamEvent = assistantMessageEvent as AssistantStreamEvent | undefined;
  const type = typeof streamEvent?.type === "string" ? streamEvent.type : "";
  const index = streamEvent?.contentIndex;
  if (!validContentIndex(index)) return { ...merged, content: blocks };
  ensureBlockSlot(blocks, index);

  if (type === "text_start") {
    blocks[index] = { type: "text", text: "" };
  } else if (type === "text_delta") {
    const current = blocks[index];
    const text = current?.type === "text" && typeof current.text === "string"
      ? current.text
      : "";
    blocks[index] = {
      ...(current?.type === "text" ? current : null),
      type: "text",
      text: text + (typeof streamEvent?.delta === "string" ? streamEvent.delta : ""),
    };
  } else if (type === "text_end") {
    blocks[index] = {
      ...(blocks[index]?.type === "text" ? blocks[index] : null),
      type: "text",
      text: typeof streamEvent?.content === "string" ? streamEvent.content : "",
    };
  } else if (type === "thinking_start") {
    blocks[index] = { type: "thinking", thinking: "" };
  } else if (type === "thinking_delta") {
    const current = blocks[index];
    const thinking = current?.type === "thinking" && typeof current.thinking === "string"
      ? current.thinking
      : "";
    blocks[index] = {
      ...(current?.type === "thinking" ? current : null),
      type: "thinking",
      thinking: thinking + (typeof streamEvent?.delta === "string" ? streamEvent.delta : ""),
    };
  } else if (type === "thinking_end") {
    blocks[index] = {
      ...(blocks[index]?.type === "thinking" ? blocks[index] : null),
      type: "thinking",
      thinking: typeof streamEvent?.content === "string" ? streamEvent.content : "",
    };
  } else if (type === "toolcall_end" && streamEvent?.toolCall && typeof streamEvent.toolCall === "object") {
    blocks[index] = {
      ...(streamEvent.toolCall as Omit<PiContentBlock, "type">),
      type: "toolCall",
    } as PiContentBlock;
  }
  return { ...merged, content: blocks };
}

function contentIdentity(content: PiMessage["content"]): string {
  const canonical = typeof content === "string"
    ? [{ type: "text", text: content }]
    : content ?? null;
  try { return JSON.stringify(canonical) ?? String(canonical ?? ""); }
  catch { return String(canonical ?? ""); }
}

/**
 * Pi providers may persist replay/verification signatures that are absent from
 * the same SSE message_end snapshot. They are transport metadata, not visible
 * terminal semantics, and must not keep one logical answer alive as a second
 * lease while JSONL catches up.
 */
function terminalContentIdentity(content: PiMessage["content"]): string {
  if (!Array.isArray(content)) return contentIdentity(content);
  const canonical = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const {
      textSignature: _textSignature,
      thinkingSignature: _thinkingSignature,
      ...semantic
    } = block as unknown as Record<string, unknown>;
    return semantic;
  });
  try { return JSON.stringify(canonical) ?? String(canonical ?? ""); }
  catch { return String(canonical ?? ""); }
}

function sameTerminalContent(left: PiMessage["content"], right: PiMessage["content"]): boolean {
  return terminalContentIdentity(left) === terminalContentIdentity(right);
}

/** Prefer server-projected structural identity before legacy correlation. */
export function messageIdentity(message: PiMessage): string {
  if (message.piChatPersistedMessageId) return `persisted:${message.piChatPersistedMessageId}`;
  if (message.piChatLiveMessageId) return `live:${message.piChatLiveMessageId}`;
  if (message.role === "toolResult" && message.toolCallId) return `tool:${message.toolCallId}`;
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return `time:${message.role}:${message.timestamp}`;
  return `content:${message.role}:${message.toolCallId || ""}:${message.toolName || ""}:${contentIdentity(message.content)}`;
}

export function sameMessage(left: PiMessage, right: PiMessage): boolean {
  if (left.role !== right.role) return false;
  if (left.piChatPersistedMessageId && right.piChatPersistedMessageId)
    return left.piChatPersistedMessageId === right.piChatPersistedMessageId;
  if (left.piChatLiveMessageId && right.piChatLiveMessageId)
    return left.piChatLiveMessageId === right.piChatLiveMessageId;
  if (left.role === "toolResult" && (left.toolCallId || right.toolCallId)) return left.toolCallId === right.toolCallId;
  const leftTime = typeof left.timestamp === "number" && Number.isFinite(left.timestamp) ? left.timestamp : undefined;
  const rightTime = typeof right.timestamp === "number" && Number.isFinite(right.timestamp) ? right.timestamp : undefined;
  if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) return false;
  return left.toolCallId === right.toolCallId
    && left.toolName === right.toolName
    && left.summary === right.summary
    && left.tokensBefore === right.tokensBefore
    && contentIdentity(left.content) === contentIdentity(right.content);
}

export function userTurnCount(messages: PiMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

/**
 * An assistant terminal is a short-lived SSE lease until JSONL/RPC publishes
 * the same answer. Pi may stamp those two projections independently, so a
 * timestamp mismatch alone must not create a second copy of the one terminal.
 * This deliberately applies only to the latest assistant after the latest user
 * boundary; ordinary persisted transcript rows retain strict identity.
 */
function persistedConfirmsTerminal(persisted: PiMessage[], terminal: PiMessage): boolean {
  if (persisted.some((message) => sameMessage(message, terminal))) return true;
  if (terminal.role !== "assistant") return false;
  for (let index = persisted.length - 1; index >= 0; index -= 1) {
    const candidate = persisted[index];
    if (candidate.role === "user") break;
    if (candidate.role === "assistant")
      return sameTerminalContent(candidate.content, terminal.content);
  }
  return false;
}

/** Collapse only adjacent duplicate assistant SSE terminal leases. */
function appendTerminalLease(tail: PiMessage[], terminal: PiMessage): PiMessage[] {
  const previous = tail.at(-1);
  if (previous?.role === "assistant" && terminal.role === "assistant") {
    if (previous.piChatLiveMessageId && terminal.piChatLiveMessageId) {
      if (previous.piChatLiveMessageId === terminal.piChatLiveMessageId)
        return [...tail.slice(0, -1), terminal];
      return appendTerminalMessage(tail, terminal);
    }
    if (sameTerminalContent(previous.content, terminal.content))
      return [...tail.slice(0, -1), terminal];
  }
  return appendTerminalMessage(tail, terminal);
}

/**
 * Treat persisted JSONL/RPC history as authoritative and retain only terminal
 * SSE rows that the persisted branch has not exposed yet. This deliberately
 * rejects arbitrary stale Runtime history, which may contain duplicated or
 * abandoned branch segments.
 */
export function reconcilePersistedHistory(persisted: PiMessage[], terminalTail: PiMessage[]): { messages: PiMessage[]; pending: PiMessage[] } {
  const uniqueTail = terminalTail.reduce<PiMessage[]>(appendTerminalLease, []);
  const persistedTimes = persisted
    .map((message) => typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : undefined)
    .filter((value): value is number => value !== undefined);
  const persistedWatermark = persistedTimes.length ? Math.max(...persistedTimes) : undefined;
  const pending = uniqueTail.filter((terminal) => {
    if (persistedConfirmsTerminal(persisted, terminal)) return false;
    const terminalTime = typeof terminal.timestamp === "number" && Number.isFinite(terminal.timestamp) ? terminal.timestamp : undefined;
    // A stale persisted prefix ends before the terminal and must retain it. If
    // the authoritative branch has advanced beyond an absent terminal, the row
    // belonged to a rewound/abandoned branch and must not be resurrected.
    return terminalTime === undefined || persistedWatermark === undefined || persistedWatermark <= terminalTime;
  });
  return {
    messages: pending.reduce((messages, terminal) => appendTerminalMessage(messages, terminal), [...persisted]),
    pending,
  };
}

/** Add a terminal Pi message exactly once, replacing an earlier form if needed. */
export function appendTerminalMessage(messages: PiMessage[], message: PiMessage): PiMessage[] {
  const hasStableIdentity = Boolean(
    message.piChatPersistedMessageId
    || message.piChatLiveMessageId
    || (message.role === "toolResult" && message.toolCallId)
    || (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)),
  );
  const index = hasStableIdentity
    ? messages.findIndex((candidate) => sameMessage(candidate, message))
    : messages.length && sameMessage(messages[messages.length - 1], message) ? messages.length - 1 : -1;
  if (index < 0) return [...messages, message];
  if (messages[index] === message) return messages;
  const next = [...messages];
  next[index] = message;
  return next;
}

export function messageSequenceAt(haystack: PiMessage[], needle: PiMessage[]): number {
  if (!needle.length) return 0;
  if (needle.length > haystack.length) return -1;
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (!sameMessage(haystack[start + index], needle[index])) continue outer;
    }
    return start;
  }
  return -1;
}

function suffixPrefixOverlap(left: PiMessage[], right: PiMessage[]): number {
  const maximum = Math.min(left.length, right.length);
  for (let size = maximum; size > 0; size -= 1) {
    let matches = true;
    for (let index = 0; index < size; index += 1) {
      if (!sameMessage(left[left.length - size + index], right[index])) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}

function timestamp(message: PiMessage): number | undefined {
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : undefined;
}

type DisjointHistoryOrder = "current-first" | "incoming-first";

function mergeDisjointHistory(left: PiMessage[], right: PiMessage[], order: DisjointHistoryOrder): PiMessage[] {
  const first = order === "incoming-first" ? right : left;
  const second = order === "incoming-first" ? left : right;
  const uniqueConcat = (base: PiMessage[], tail: PiMessage[]): PiMessage[] => tail.reduce(
    (merged, message) => merged.some((candidate) => sameMessage(candidate, message)) ? merged : [...merged, message],
    [...base],
  );
  const leftTimes = left.map(timestamp);
  const rightTimes = right.map(timestamp);
  const allTimestamped = [...leftTimes, ...rightTimes].every((value) => value !== undefined);
  if (!allTimestamped) return uniqueConcat(first, second);

  const leftMin = Math.min(...leftTimes as number[]);
  const leftMax = Math.max(...leftTimes as number[]);
  const rightMin = Math.min(...rightTimes as number[]);
  const rightMax = Math.max(...rightTimes as number[]);
  if (leftMax <= rightMin && leftMin < rightMin) return uniqueConcat(left, right);
  if (rightMax <= leftMin && rightMin < leftMin) return uniqueConcat(right, left);

  const preferredSource = order === "incoming-first" ? 1 : 0;
  const tagged = [...left.map((message, index) => ({ message, source: 0, index })), ...right.map((message, index) => ({ message, source: 1, index }))];
  tagged.sort((a, b) => {
    const leftTime = timestamp(a.message) as number;
    const rightTime = timestamp(b.message) as number;
    if (leftTime !== rightTime) return leftTime - rightTime;
    if (a.source !== b.source) return a.source === preferredSource ? -1 : 1;
    return a.index - b.index;
  });
  return tagged.reduce<PiMessage[]>((merged, entry) => {
    if (merged.some((candidate) => sameMessage(candidate, entry.message))) return merged;
    merged.push(entry.message);
    return merged;
  }, []);
}

/** Keep terminal SSE messages when a delayed disk/RPC history is shorter. */
export function mergeMessageHistory(current: PiMessage[], incoming: PiMessage[], disjointOrder: DisjointHistoryOrder = "current-first"): PiMessage[] {
  if (!current.length) return incoming;
  if (!incoming.length) return current;
  if (messageSequenceAt(incoming, current) >= 0) return incoming;
  if (messageSequenceAt(current, incoming) >= 0) return current;
  const forward = suffixPrefixOverlap(current, incoming);
  if (forward) return [...current, ...incoming.slice(forward)];
  const backward = suffixPrefixOverlap(incoming, current);
  if (backward) return [...incoming, ...current.slice(backward)];
  // A just-accepted terminal event may arrive before an async disk warmer has
  // loaded the old prefix. With no common anchor, timestamps establish segment
  // order; exact ties use the caller's explicit base direction.
  return mergeDisjointHistory(current, incoming, disjointOrder);
}
