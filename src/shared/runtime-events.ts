import type { PiContentBlock, PiMessage } from "./types.js";

export const PI_CHAT_RUNTIME_EVENT_SCHEMA = 1 as const;

export type CanonicalTerminalKind = "assistant" | "tool-result" | "user-echo" | "other";

export interface CanonicalMessageEndEvent extends Record<string, unknown> {
  type: "message_end";
  piChatEventSchema: typeof PI_CHAT_RUNTIME_EVENT_SCHEMA;
  terminalKind: CanonicalTerminalKind;
  message: PiMessage;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length <= maximum ? value : undefined;
}

function canonicalContentBlock(value: unknown): PiContentBlock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const type = boundedString(input.type, 64);
  if (!type) return null;
  const stringFields = [
    ["text", 1_000_000],
    ["thinking", 1_000_000],
    ["name", 400],
    ["id", 400],
    ["data", 1_000_000],
    ["mimeType", 200],
  ] as const;
  for (const [key, maximum] of stringFields)
    if (input[key] !== undefined && boundedString(input[key], maximum) === undefined)
      return null;
  return {
    type,
    ...(input.text !== undefined ? { text: input.text as string } : null),
    ...(input.thinking !== undefined ? { thinking: input.thinking as string } : null),
    ...(input.name !== undefined ? { name: input.name as string } : null),
    ...(input.id !== undefined ? { id: input.id as string } : null),
    ...(input.arguments !== undefined ? { arguments: input.arguments } : null),
    ...(input.data !== undefined ? { data: input.data as string } : null),
    ...(input.mimeType !== undefined ? { mimeType: input.mimeType as string } : null),
  };
}

/** Reconstruct only the documented PiMessage fields used by terminal rendering. */
export function canonicalPiMessage(value: unknown): PiMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const role = boundedString(input.role, 64);
  if (!role) return null;
  let content: PiMessage["content"];
  if (typeof input.content === "string") content = input.content;
  else if (Array.isArray(input.content)) {
    const blocks: PiContentBlock[] = [];
    for (const rawBlock of input.content) {
      const block = canonicalContentBlock(rawBlock);
      if (!block) return null;
      blocks.push(block);
    }
    content = blocks;
  } else if (input.content !== undefined) return null;
  const stringFields = [
    ["summary", 1_000_000],
    ["stopReason", 200],
    ["provider", 200],
    ["model", 400],
    ["thinkingLevel", 40],
    ["toolCallId", 400],
    ["toolName", 400],
  ] as const;
  for (const [key, maximum] of stringFields)
    if (input[key] !== undefined && boundedString(input[key], maximum) === undefined)
      return null;
  if (input.timestamp !== undefined && (typeof input.timestamp !== "number" || !Number.isFinite(input.timestamp)))
    return null;
  if (input.tokensBefore !== undefined && (typeof input.tokensBefore !== "number" || !Number.isFinite(input.tokensBefore)))
    return null;
  if (input.isError !== undefined && typeof input.isError !== "boolean") return null;
  return {
    role,
    ...(content !== undefined ? { content } : null),
    ...(input.summary !== undefined ? { summary: input.summary as string } : null),
    ...(input.tokensBefore !== undefined ? { tokensBefore: input.tokensBefore as number } : null),
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp as number } : null),
    ...(input.stopReason !== undefined ? { stopReason: input.stopReason as string } : null),
    ...(input.provider !== undefined ? { provider: input.provider as string } : null),
    ...(input.model !== undefined ? { model: input.model as string } : null),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel as string } : null),
    ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId as string } : null),
    ...(input.toolName !== undefined ? { toolName: input.toolName as string } : null),
    ...(input.isError !== undefined ? { isError: input.isError as boolean } : null),
  };
}

export function terminalKindForMessage(message: PiMessage): CanonicalTerminalKind {
  if (message.role === "assistant") return "assistant";
  if (message.role === "toolResult") return "tool-result";
  if (message.role === "user") return "user-echo";
  return "other";
}

export function canonicalMessageEndEvent(message: unknown): CanonicalMessageEndEvent | null {
  const canonical = canonicalPiMessage(message);
  if (!canonical) return null;
  return {
    type: "message_end",
    piChatEventSchema: PI_CHAT_RUNTIME_EVENT_SCHEMA,
    terminalKind: terminalKindForMessage(canonical),
    message: canonical,
  };
}

/**
 * Browser/server wire decoder. Versionless events are accepted only through
 * this isolated compatibility adapter and are immediately reconstructed.
 */
export function decodeCanonicalMessageEndEvent(
  event: Record<string, unknown>,
): CanonicalMessageEndEvent | null {
  if (event.type !== "message_end") return null;
  if (
    event.piChatEventSchema !== undefined
    && event.piChatEventSchema !== PI_CHAT_RUNTIME_EVENT_SCHEMA
  ) return null;
  const canonical = canonicalMessageEndEvent(event.message);
  if (!canonical) return null;
  if (
    event.piChatEventSchema === PI_CHAT_RUNTIME_EVENT_SCHEMA
    && event.terminalKind !== canonical.terminalKind
  ) return null;
  return canonical;
}
