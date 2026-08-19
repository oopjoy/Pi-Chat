import type { PiContentBlock, PiMessage } from "./types.js";

export const PI_CHAT_RUNTIME_EVENT_SCHEMA = 1 as const;

export type CanonicalTerminalRole = "assistant" | "toolResult" | "user";
export type CanonicalTerminalKind = "assistant" | "tool-result" | "user-echo";
export type CanonicalTerminalMessage = Omit<PiMessage, "role"> & {
  role: CanonicalTerminalRole;
};

export interface CanonicalMessageEndPayload extends Record<string, unknown> {
  type: "message_end";
  piChatEventSchema: typeof PI_CHAT_RUNTIME_EVENT_SCHEMA;
  terminalKind: CanonicalTerminalKind;
  message: CanonicalTerminalMessage;
}

export interface CanonicalMessageEndEvent extends CanonicalMessageEndPayload {
  piChatSessionId: string;
  piChatRunEpoch: string;
  piChatRunGeneration: number;
}

const SESSION_ID_PATTERN = /^[a-f0-9]{20}$/;
const RUN_EPOCH_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LIVE_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length <= maximum ? value : undefined;
}

function requiredString(value: unknown, maximum: number): string | undefined {
  const result = boundedString(value, maximum);
  return result && result.length > 0 ? result : undefined;
}

function canonicalContentBlock(
  value: unknown,
  role: CanonicalTerminalRole,
): PiContentBlock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.type === "text" && (role === "assistant" || role === "user" || role === "toolResult")) {
    const text = boundedString(input.text, 1_000_000);
    return text === undefined ? null : { type: "text", text };
  }
  if (input.type === "thinking" && role === "assistant") {
    const thinking = boundedString(input.thinking, 1_000_000);
    return thinking === undefined ? null : { type: "thinking", thinking };
  }
  if (input.type === "image" && (role === "user" || role === "toolResult")) {
    const data = boundedString(input.data, 1_000_000);
    const mimeType = requiredString(input.mimeType, 200);
    return data === undefined || !mimeType
      ? null
      : { type: "image", data, mimeType };
  }
  if (input.type === "toolCall" && role === "assistant") {
    const id = requiredString(input.id, 400);
    const name = requiredString(input.name, 400);
    const args = input.arguments;
    if (!id || !name || !args || typeof args !== "object" || Array.isArray(args))
      return null;
    return { type: "toolCall", id, name, arguments: args };
  }
  return null;
}

/** Reconstruct only the documented Pi terminal-message roles and rendering fields. */
export function canonicalPiMessage(value: unknown): CanonicalTerminalMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const role = input.role;
  if (role !== "assistant" && role !== "toolResult" && role !== "user") return null;

  let content: PiMessage["content"];
  if (typeof input.content === "string") content = input.content;
  else if (Array.isArray(input.content)) {
    const blocks: PiContentBlock[] = [];
    for (const rawBlock of input.content) {
      const block = canonicalContentBlock(rawBlock, role);
      if (!block) return null;
      blocks.push(block);
    }
    content = blocks;
  } else return null;

  const stringFields = [
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
  if (input.isError !== undefined && typeof input.isError !== "boolean") return null;
  const liveMessageId = input.piChatLiveMessageId;
  if (
    liveMessageId !== undefined
    && (typeof liveMessageId !== "string" || !LIVE_MESSAGE_ID_PATTERN.test(liveMessageId))
  ) return null;
  const projectionIdentity = typeof liveMessageId === "string"
    ? { piChatLiveMessageId: liveMessageId }
    : {};

  if (role === "toolResult") {
    const toolCallId = requiredString(input.toolCallId, 400);
    const toolName = requiredString(input.toolName, 400);
    if (!toolCallId || !toolName) return null;
    return {
      role,
      content,
      ...projectionIdentity,
      toolCallId,
      toolName,
      ...(input.isError !== undefined ? { isError: input.isError as boolean } : null),
      ...(input.timestamp !== undefined ? { timestamp: input.timestamp as number } : null),
    };
  }
  if (role === "user") {
    return {
      role,
      content,
      ...projectionIdentity,
      ...(input.timestamp !== undefined ? { timestamp: input.timestamp as number } : null),
    };
  }
  return {
    role,
    content,
    ...projectionIdentity,
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp as number } : null),
    ...(input.stopReason !== undefined ? { stopReason: input.stopReason as string } : null),
    ...(input.provider !== undefined ? { provider: input.provider as string } : null),
    ...(input.model !== undefined ? { model: input.model as string } : null),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel as string } : null),
  };
}

export function terminalKindForMessage(message: CanonicalTerminalMessage): CanonicalTerminalKind {
  if (message.role === "assistant") return "assistant";
  if (message.role === "toolResult") return "tool-result";
  return "user-echo";
}

export function canonicalMessageEndPayload(message: unknown): CanonicalMessageEndPayload | null {
  const canonical = canonicalPiMessage(message);
  if (!canonical) return null;
  return {
    type: "message_end",
    piChatEventSchema: PI_CHAT_RUNTIME_EVENT_SCHEMA,
    terminalKind: terminalKindForMessage(canonical),
    message: canonical,
  };
}

/** Validate/reconstruct the terminal payload before the server attaches provenance. */
export function decodeCanonicalMessageEndPayload(
  event: Record<string, unknown>,
): CanonicalMessageEndPayload | null {
  if (event.type !== "message_end") return null;
  if (
    event.piChatEventSchema !== undefined
    && event.piChatEventSchema !== PI_CHAT_RUNTIME_EVENT_SCHEMA
  ) return null;
  const canonical = canonicalMessageEndPayload(event.message);
  if (!canonical) return null;
  if (
    event.piChatEventSchema === PI_CHAT_RUNTIME_EVENT_SCHEMA
    && event.terminalKind !== canonical.terminalKind
  ) return null;
  return canonical;
}

/**
 * Browser wire decoder. Versionless compatibility relaxes only the schema marker;
 * Session/run provenance remains mandatory and closed before any owner mutation.
 */
export function decodeCanonicalMessageEndEvent(
  event: Record<string, unknown>,
): CanonicalMessageEndEvent | null {
  const canonical = decodeCanonicalMessageEndPayload(event);
  if (!canonical) return null;
  const sessionId = event.piChatSessionId;
  const runEpoch = event.piChatRunEpoch;
  const runGeneration = event.piChatRunGeneration;
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return null;
  if (typeof runEpoch !== "string" || !RUN_EPOCH_PATTERN.test(runEpoch)) return null;
  if (
    typeof runGeneration !== "number"
    || !Number.isSafeInteger(runGeneration)
    || runGeneration < 0
  ) return null;
  return {
    ...canonical,
    piChatSessionId: sessionId,
    piChatRunEpoch: runEpoch,
    piChatRunGeneration: runGeneration,
  };
}
