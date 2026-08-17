import { LOCAL_COORDINATION_ROLE, type PiContentBlock, type PiMessage } from "../../shared/types";
import { sanitizeAssistantText, visibleAssistantMessage } from "./assistant-text";
import { editDiffFromToolCall, type ToolEditDiff } from "./tool-edit-diff";

export type ProcessEntry =
  | { kind: "thinking"; text: string }
  | { kind: "note"; text: string }
  | { kind: "tool"; id?: string; name: string; arguments?: string; editDiff?: ToolEditDiff; result?: string; completed?: boolean; isError?: boolean };

export type ConversationItem =
  | { kind: "message"; message: PiMessage; key: string; hideAssistantMetadata?: boolean }
  | { kind: "coordination"; message: PiMessage; key: string }
  | { kind: "process"; entries: ProcessEntry[]; key: string; assistantHeader?: PiMessage };

/**
 * Stable list keys for React. Intentionally ignore growing thinking/note text so
 * streaming updates do not remount process cards or open/close state.
 */
export function processItemKey(anchor: string, ordinal = 0): string {
  // A process grows as thinking/tool events arrive. Its key must not include
  // entries, otherwise every read/edit completion remounts <details> and closes
  // a process card the user explicitly opened.
  return `process:${anchor || "start"}:${ordinal}`;
}

export function messageItemKey(message: PiMessage, collisionOrdinal = 0): string {
  if (message.role === "toolResult" && message.toolCallId) return `message:toolResult:${message.toolCallId}:${collisionOrdinal}`;
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    return `message:${message.role}:${message.timestamp}:${compactContentKey(message)}:${collisionOrdinal}`;
  }
  return `message:${message.role}:${compactContentKey(message)}:${collisionOrdinal}`;
}

function compactContentKey(message: PiMessage): string {
  const canonicalContent = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content ?? null;
  let value: string;
  try { value = JSON.stringify(canonicalContent) ?? String(canonicalContent ?? ""); }
  catch { value = String(canonicalContent ?? ""); }
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${message.role}:${(hash >>> 0).toString(36)}`;
}

function blocks(message: PiMessage): PiContentBlock[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content || [];
}

function sameValue(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return left === right; }
}

function cumulativeBlock(earlier: PiContentBlock, later: PiContentBlock): boolean {
  if (earlier.type !== later.type) return false;
  if (earlier.type === "thinking") return Boolean(earlier.thinking) && (later.thinking || "").startsWith(earlier.thinking || "");
  if (earlier.type === "text") return Boolean(earlier.text) && (later.text || "").startsWith(earlier.text || "");
  if (earlier.type === "toolCall") {
    return Boolean(earlier.id) && earlier.id === later.id && earlier.name === later.name && sameValue(earlier.arguments, later.arguments);
  }
  return sameValue(earlier, later);
}

function processBearing(blocksToCheck: PiContentBlock[]): boolean {
  return blocksToCheck.some((block) => block.type === "thinking" || block.type === "toolCall");
}

function cumulativeAssistantMessage(earlier: PiMessage, later: PiMessage): boolean {
  if (earlier.role !== "assistant" || later.role !== "assistant") return false;
  if (typeof earlier.timestamp !== "number" || !Number.isFinite(earlier.timestamp) || earlier.timestamp !== later.timestamp) return false;
  const earlierBlocks = blocks(earlier);
  const laterBlocks = blocks(later);
  if (!processBearing(earlierBlocks) || !processBearing(laterBlocks) || earlierBlocks.length > laterBlocks.length) return false;
  const used = new Set<number>();
  const orderedEarlier = earlierBlocks.map((block, index) => ({ block, index })).sort((left, right) => {
    const specificity = (block: PiContentBlock): number => block.type === "toolCall"
      ? 1_000_000
      : block.type === "thinking"
        ? (block.thinking || "").length
        : block.type === "text"
          ? (block.text || "").length
          : 0;
    return specificity(right.block) - specificity(left.block) || left.index - right.index;
  });
  return orderedEarlier.every(({ block }) => {
    const match = laterBlocks.findIndex((candidate, index) => !used.has(index) && cumulativeBlock(block, candidate));
    if (match < 0) return false;
    used.add(match);
    return true;
  });
}

/** Reconcile only App's explicit cumulative live snapshot with persisted history. */
function withLiveAssistantSnapshot(messages: PiMessage[], liveMessage?: PiMessage): PiMessage[] {
  if (!liveMessage) return messages;
  if (liveMessage.role !== "assistant") return [...messages, liveMessage];

  // A provider can finish and persist a reply before the browser receives its
  // final live snapshot. Some adapters omit or rewrite the snapshot timestamp,
  // so timestamp-only reconciliation paints the one active-turn reply twice.
  // This is deliberately *not* a transcript-wide duplicate rule: it considers
  // only App's explicit live snapshot and only an exact persisted assistant
  // payload after the latest user boundary. Two ordinary persisted assistant
  // turns, including intentionally identical ones, remain distinct.
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role !== "assistant") continue;
    if (sameValue(blocks(candidate), blocks(liveMessage))) return messages;
    break;
  }

  if (typeof liveMessage.timestamp !== "number" || !Number.isFinite(liveMessage.timestamp)) {
    return [...messages, liveMessage];
  }
  let target = liveMessage;
  for (const candidate of messages) {
    if (candidate.role !== "assistant" || candidate.timestamp !== liveMessage.timestamp) continue;
    if (cumulativeAssistantMessage(target, candidate) && blocks(candidate).length >= blocks(target).length) target = candidate;
  }
  const matchingIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (candidate.role !== "assistant" || candidate.timestamp !== target.timestamp) continue;
    if (sameValue(blocks(candidate), blocks(target)) || cumulativeAssistantMessage(candidate, target)) matchingIndexes.push(index);
  }
  if (!matchingIndexes.length) return [...messages, target];
  const firstMatch = matchingIndexes[0];
  const remove = new Set(matchingIndexes);
  const merged: PiMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (index === firstMatch) merged.push(target);
    if (!remove.has(index)) merged.push(messages[index]);
  }
  return merged;
}

function compactValue(value: unknown, depth = 0): unknown {
  if (depth >= 4) return "[…]";
  if (typeof value === "string") return value.length > 2_000 ? `${value.slice(0, 2_000)}… [已截断]` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 20).map(([key, item]) => [key, compactValue(item, depth + 1)]));
}

function detail(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return compactValue(value) as string;
  try { return JSON.stringify(compactValue(value), null, 2); } catch { return String(value); }
}

function toolResultText(message: PiMessage): string | undefined {
  const text = blocks(message)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text || "")
    .join("\n");
  return detail(text);
}

function processFromMessage(message: PiMessage): { entries: ProcessEntry[]; visibleMessage?: PiMessage } {
  if (message.role === "toolResult") {
    const result = toolResultText(message);
    return {
      entries: [{
        kind: "tool",
        id: message.toolCallId,
        name: message.toolName || "工具",
        ...(result !== undefined ? { result } : null),
        // A valid tool result can have no visible text. Keep completion as a
        // separate fact so it still merges with the corresponding tool call.
        completed: true,
        isError: message.isError === true,
      }],
    };
  }
  // Pi persists metadata/custom records alongside chat messages. They have no
  // chat renderer and may legitimately omit `content`; keep them out of the
  // React conversation list rather than creating invisible/crashing rows.
  if (message.role !== "assistant") return message.role === "user"
    ? { entries: [], visibleMessage: message }
    : { entries: [] };

  const content = blocks(message);
  const hasToolCall = content.some((block) => block.type === "toolCall");
  const thinking = content.filter((block) => block.type === "thinking" && block.thinking)
    .map((block) => sanitizeAssistantText(block.thinking as string))
    .filter((text) => Boolean(text.trim()))
    .map((text) => ({ kind: "thinking" as const, text }));
  if (!hasToolCall && thinking.length === 0) return { entries: [], visibleMessage: visibleAssistantMessage(message) };

  const entries: ProcessEntry[] = [...thinking];
  for (const block of content) {
    if (block.type === "toolCall") {
      const editDiff = editDiffFromToolCall(block.name || "", block.arguments);
      entries.push({
        kind: "tool",
        id: block.id,
        name: block.name || "工具",
        arguments: detail(block.arguments),
        ...(editDiff ? { editDiff } : null),
      });
    } else if (hasToolCall && block.type === "text" && block.text?.trim()) {
      const text = sanitizeAssistantText(block.text);
      if (text.trim()) entries.push({ kind: "note", text });
    }
  }

  if (hasToolCall) return { entries };
  return { entries, visibleMessage: visibleAssistantMessage({ ...message, content: content.filter((block) => block.type !== "thinking") }) };
}

function mergeProcessEntries(entries: ProcessEntry[]): ProcessEntry[] {
  const merged: ProcessEntry[] = [];
  const matchingToolIndex = (entry: Extract<ProcessEntry, { kind: "tool" }>): number => {
    if (entry.id) return merged.map((candidate) => candidate.kind === "tool" ? candidate.id : undefined).lastIndexOf(entry.id);
    return merged.map((candidate) => candidate.kind === "tool" ? candidate.name : undefined).lastIndexOf(entry.name);
  };
  for (const entry of entries) {
    if (entry.kind !== "tool") {
      merged.push(entry);
      continue;
    }
    const targetIndex = matchingToolIndex(entry);
    const target = merged[targetIndex];
    if (!entry.completed) {
      // A busy-session refresh can expose a persisted result before the delayed
      // cumulative assistant snapshot carrying its toolCall. Merge in either
      // direction so that transient order does not hide arguments/diff/thinking.
      if (target?.kind === "tool" && target.completed) {
        merged[targetIndex] = {
          ...entry,
          ...(target.result !== undefined ? { result: target.result } : null),
          completed: true,
          isError: target.isError,
        };
      } else if (target?.kind === "tool") {
        merged[targetIndex] = { ...target, ...entry };
      } else merged.push(entry);
      continue;
    }
    // Completion and output are separate: a tool may succeed with no text.
    if (target?.kind === "tool" && !target.completed) {
      merged[targetIndex] = { ...target, ...(entry.result !== undefined ? { result: entry.result } : null), completed: true, isError: entry.isError };
    } else merged.push(entry);
  }
  return merged;
}

export function groupConversation(messages: PiMessage[], options: { liveMessage?: PiMessage; preserveTrailingAssistantPlaceholder?: boolean } = {}): ConversationItem[] {
  const items: ConversationItem[] = [];
  const messageKeyOrdinals = new Map<string, number>();
  const uniqueMessageKey = (message: PiMessage): string => {
    const base = messageItemKey(message);
    const ordinal = messageKeyOrdinals.get(base) || 0;
    messageKeyOrdinals.set(base, ordinal + 1);
    return messageItemKey(message, ordinal);
  };
  let processEntries: ProcessEntry[] = [];
  // A process is anchored to the preceding visible content, not its timestamp.
  // The optimistic user message and Pi's persisted copy can have different
  // timestamps; using them here remounted the same <details>. Content hashing
  // also keeps the anchor stable when older history is prepended.
  const processOrdinalsByAnchor = new Map<string, number>();
  let precedingProcessAnchor = "start";
  let processAssistantTimestamp: number | null = null;
  let processAssistantHeader: PiMessage | null = null;
  let processHasThinking = false;
  const processToolIds = new Set<string>();
  const flushProcess = (fallbackHeader?: PiMessage): boolean => {
    if (!processEntries.length) return false;
    const entries = mergeProcessEntries(processEntries);
    const toolIdentity = [...processToolIds].sort().join(",");
    const processAnchor = processAssistantTimestamp !== null
      ? `time:assistant:${processAssistantTimestamp}`
      : !processHasThinking && toolIdentity
        ? `tools:${toolIdentity}`
        : precedingProcessAnchor;
    const ordinal = processOrdinalsByAnchor.get(processAnchor) || 0;
    processOrdinalsByAnchor.set(processAnchor, ordinal + 1);
    const assistantHeader = processAssistantHeader
      || (fallbackHeader?.role === "assistant" ? fallbackHeader : null);
    items.push({
      kind: "process",
      entries,
      key: processItemKey(processAnchor, ordinal),
      ...(assistantHeader ? { assistantHeader } : null),
    });
    processEntries = [];
    processAssistantTimestamp = null;
    processAssistantHeader = null;
    processHasThinking = false;
    processToolIds.clear();
    return Boolean(assistantHeader);
  };

  const groupedMessages = withLiveAssistantSnapshot(messages, options.liveMessage);
  for (let messageIndex = 0; messageIndex < groupedMessages.length; messageIndex += 1) {
    const message = groupedMessages[messageIndex];
    if (message.role === LOCAL_COORDINATION_ROLE) {
      // An Intercom delivery is external input, not assistant work. Keep it as
      // an explicit read-only timeline boundary so the following answer never
      // appears "headless" or inherits the delivery inside its process card.
      flushProcess();
      items.push({ kind: "coordination", message, key: uniqueMessageKey(message) });
      precedingProcessAnchor = compactContentKey(message);
      continue;
    }
    const { entries, visibleMessage } = processFromMessage(message);
    if (entries.length) {
      if (message.role === "assistant") {
        processAssistantHeader = message;
        if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
          processAssistantTimestamp = processAssistantTimestamp === null ? message.timestamp : Math.min(processAssistantTimestamp, message.timestamp);
        }
      }
      if (entries.some((entry) => entry.kind === "thinking")) processHasThinking = true;
      for (const entry of entries) {
        if (entry.kind === "tool" && entry.id) processToolIds.add(entry.id);
      }
    }
    processEntries.push(...entries);
    if (visibleMessage) {
      const metadataRenderedWithProcess = flushProcess(visibleMessage);
      items.push({
        kind: "message",
        message: visibleMessage,
        key: uniqueMessageKey(visibleMessage),
        ...(metadataRenderedWithProcess && visibleMessage.role === "assistant"
          ? { hideAssistantMetadata: true }
          : null),
      });
      precedingProcessAnchor = compactContentKey(visibleMessage);
    } else if (
      options.preserveTrailingAssistantPlaceholder
      && messageIndex === groupedMessages.length - 1
      && message.role === "assistant"
      && entries.length === 0
    ) {
      const metadataRenderedWithProcess = flushProcess(message);
      items.push({
        kind: "message",
        message,
        key: uniqueMessageKey(message),
        ...(metadataRenderedWithProcess ? { hideAssistantMetadata: true } : null),
      });
    }
  }
  flushProcess();
  return items;
}
