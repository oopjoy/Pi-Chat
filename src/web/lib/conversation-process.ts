import type { PiContentBlock, PiMessage } from "../../shared/types";
import { sanitizeAssistantText } from "./assistant-text";

export type ProcessEntry =
  | { kind: "thinking"; text: string }
  | { kind: "note"; text: string }
  | { kind: "tool"; id?: string; name: string; arguments?: string; result?: string; isError?: boolean };

export type ConversationItem =
  | { kind: "message"; message: PiMessage; key: string }
  | { kind: "process"; entries: ProcessEntry[]; key: string };

/**
 * Stable list keys for React. Intentionally ignore growing thinking/note text so
 * streaming updates do not remount process cards or open/close state.
 */
export function processItemKey(entries: ProcessEntry[], ordinal = 0): string {
  let thinkingIndex = 0;
  let noteIndex = 0;
  const parts = entries.map((entry) => {
    if (entry.kind === "tool") return `tool:${entry.id || entry.name}`;
    if (entry.kind === "thinking") return `think:${thinkingIndex++}`;
    return `note:${noteIndex++}`;
  });
  return `process:${ordinal}:${parts.join("+") || "empty"}`;
}

export function messageItemKey(message: PiMessage, ordinal = 0): string {
  if (message.role === "toolResult" && message.toolCallId) return `message:toolResult:${message.toolCallId}`;
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    return `message:${message.role}:${message.timestamp}`;
  }
  return `message:${message.role}:${ordinal}`;
}

function blocks(message: PiMessage): PiContentBlock[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content || [];
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
    return {
      entries: [{
        kind: "tool",
        id: message.toolCallId,
        name: message.toolName || "工具",
        result: toolResultText(message),
        isError: message.isError === true,
      }],
    };
  }
  if (message.role !== "assistant") return { entries: [], visibleMessage: message };

  const content = blocks(message);
  const hasToolCall = content.some((block) => block.type === "toolCall");
  const thinking = content.filter((block) => block.type === "thinking" && block.thinking)
    .map((block) => sanitizeAssistantText(block.thinking as string))
    .filter(Boolean)
    .map((text) => ({ kind: "thinking" as const, text }));
  if (!hasToolCall && thinking.length === 0) return { entries: [], visibleMessage: message };

  const entries: ProcessEntry[] = [...thinking];
  for (const block of content) {
    if (block.type === "toolCall") {
      entries.push({ kind: "tool", id: block.id, name: block.name || "工具", arguments: detail(block.arguments) });
    } else if (hasToolCall && block.type === "text" && block.text?.trim()) {
      const text = sanitizeAssistantText(block.text);
      if (text) entries.push({ kind: "note", text });
    }
  }

  if (hasToolCall) return { entries };
  const visible = content.filter((block) => block.type !== "thinking");
  return { entries, visibleMessage: visible.length ? { ...message, content: visible } : undefined };
}

function mergeProcessEntries(entries: ProcessEntry[]): ProcessEntry[] {
  const merged: ProcessEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "tool" || !entry.result) {
      merged.push(entry);
      continue;
    }
    const matchIndex = entry.id ? merged.map((candidate) => candidate.kind === "tool" ? candidate.id : undefined).lastIndexOf(entry.id) : -1;
    const targetIndex = matchIndex >= 0 ? matchIndex : merged.map((candidate) => candidate.kind === "tool" ? candidate.name : undefined).lastIndexOf(entry.name);
    const target = merged[targetIndex];
    if (target?.kind === "tool" && !target.result) {
      merged[targetIndex] = { ...target, result: entry.result, isError: entry.isError };
    } else {
      merged.push(entry);
    }
  }
  return merged;
}

export function groupConversation(messages: PiMessage[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  let processEntries: ProcessEntry[] = [];
  let processOrdinal = 0;
  let messageOrdinal = 0;
  const flushProcess = () => {
    if (!processEntries.length) return;
    const entries = mergeProcessEntries(processEntries);
    items.push({ kind: "process", entries, key: processItemKey(entries, processOrdinal++) });
    processEntries = [];
  };

  for (const message of messages) {
    const { entries, visibleMessage } = processFromMessage(message);
    processEntries.push(...entries);
    if (visibleMessage) {
      flushProcess();
      items.push({ kind: "message", message: visibleMessage, key: messageItemKey(visibleMessage, messageOrdinal++) });
    }
  }
  flushProcess();
  return items;
}
