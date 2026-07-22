import type { PiContentBlock, PiMessage } from "./types.js";

interface AssistantStreamEvent {
  type?: unknown;
  contentIndex?: unknown;
  delta?: unknown;
  content?: unknown;
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
  if (typeof contentIndex !== "number" || !Number.isInteger(contentIndex) || contentIndex < 0) return message;

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
