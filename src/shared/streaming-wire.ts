import { canonicalPiMessage } from "./runtime-events.js";
import type { PiContentBlock, PiMessage } from "./types.js";

export const PI_CHAT_STREAM_EVENT_SCHEMA = 1 as const;
export const MESSAGE_CHECKPOINT_EVENT = "message_checkpoint" as const;
export const MESSAGE_DELTA_EVENT = "message_delta" as const;

export interface StreamingMessageAppend {
  /** -1 targets the assistant error body; non-negative values target content. */
  contentIndex: number;
  field: "text" | "thinking" | "errorMessage";
  append: string;
}

export interface StreamingMessageCheckpointEvent extends Record<string, unknown> {
  type: typeof MESSAGE_CHECKPOINT_EVENT;
  piChatStreamSchema: typeof PI_CHAT_STREAM_EVENT_SCHEMA;
  piChatSequence: number;
  piChatStreamStart?: true;
  message: PiMessage;
}

export interface StreamingMessageDeltaEvent extends Record<string, unknown> {
  type: typeof MESSAGE_DELTA_EVENT;
  piChatStreamSchema: typeof PI_CHAT_STREAM_EVENT_SCHEMA;
  piChatSequence: number;
  piChatLiveMessageId: string;
  operations: StreamingMessageAppend[];
}

export interface StreamingWireProjection {
  message: PiMessage;
  sequence: number;
}

function jsonIdentity(value: unknown): string | null {
  try { return JSON.stringify(value) ?? null; }
  catch { return null; }
}

function messageMetadata(message: PiMessage): Record<string, unknown> {
  // `errorMessage` is a streamed append target, like a text block. Keeping it
  // out of static metadata lets a growing Runtime error use the delta wire
  // instead of forcing a complete checkpoint every time it gains a line.
  const { content: _content, errorMessage: _errorMessage, ...metadata } = message;
  return metadata;
}

function blockMetadata(block: PiContentBlock, field: "text" | "thinking"): Record<string, unknown> {
  if (field === "text") {
    const { text: _text, ...metadata } = block;
    return metadata;
  }
  const { thinking: _thinking, ...metadata } = block;
  return metadata;
}

function appendOperation(
  previous: string,
  next: string,
  contentIndex: number,
  field: StreamingMessageAppend["field"],
): StreamingMessageAppend | null | false {
  if (!next.startsWith(previous)) return false;
  const append = next.slice(previous.length);
  return append ? { contentIndex, field, append } : null;
}

/** Return append-only operations, or null when a full checkpoint is required. */
export function streamingMessageAppends(
  previous: PiMessage,
  next: PiMessage,
): StreamingMessageAppend[] | null {
  if (
    previous.role !== "assistant"
    || next.role !== "assistant"
    || !previous.piChatLiveMessageId
    || previous.piChatLiveMessageId !== next.piChatLiveMessageId
    || jsonIdentity(messageMetadata(previous)) !== jsonIdentity(messageMetadata(next))
  ) return null;

  const operations: StreamingMessageAppend[] = [];
  const errorOperation = appendOperation(previous.errorMessage || "", next.errorMessage || "", -1, "errorMessage");
  if (errorOperation === false) return null;
  if (errorOperation) operations.push(errorOperation);

  if (typeof previous.content === "string" || typeof next.content === "string") {
    if (typeof previous.content !== "string" || typeof next.content !== "string") return null;
    const operation = appendOperation(previous.content, next.content, 0, "text");
    if (operation === false) return null;
    if (operation) operations.push(operation);
    return operations;
  }
  if (!Array.isArray(previous.content) || !Array.isArray(next.content)) return null;
  if (previous.content.length !== next.content.length) return null;

  for (let index = 0; index < previous.content.length; index += 1) {
    const before = previous.content[index];
    const after = next.content[index];
    if (!before || !after || before.type !== after.type) return null;
    if (before.type === "text") {
      if (jsonIdentity(blockMetadata(before, "text")) !== jsonIdentity(blockMetadata(after, "text"))) return null;
      const operation = appendOperation(before.text || "", after.text || "", index, "text");
      if (operation === false) return null;
      if (operation) operations.push(operation);
      continue;
    }
    if (before.type === "thinking") {
      if (jsonIdentity(blockMetadata(before, "thinking")) !== jsonIdentity(blockMetadata(after, "thinking"))) return null;
      const operation = appendOperation(before.thinking || "", after.thinking || "", index, "thinking");
      if (operation === false) return null;
      if (operation) operations.push(operation);
      continue;
    }
    if (jsonIdentity(before) !== jsonIdentity(after)) return null;
  }
  return operations;
}

function provenance(event: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof event.piChatSessionId === "string" ? { piChatSessionId: event.piChatSessionId } : null),
    ...(typeof event.piChatRunEpoch === "string" ? { piChatRunEpoch: event.piChatRunEpoch } : null),
    ...(typeof event.piChatRunGeneration === "number" ? { piChatRunGeneration: event.piChatRunGeneration } : null),
  };
}

/** Build the next per-client wire projection from one authoritative cumulative snapshot. */
export function projectStreamingWireEvent(
  previous: StreamingWireProjection | undefined,
  cumulativeEvent: Record<string, unknown>,
): { event: StreamingMessageCheckpointEvent | StreamingMessageDeltaEvent | null; projection: StreamingWireProjection } | null {
  const message = cumulativeEvent.message;
  if (!message || typeof message !== "object" || (message as PiMessage).role !== "assistant") return null;
  const next = message as PiMessage;
  const sequence = previous ? previous.sequence + 1 : 0;
  if (cumulativeEvent.type === "message_update" && previous) {
    const operations = streamingMessageAppends(previous.message, next);
    if (operations) {
      return {
        event: operations.length ? {
          type: MESSAGE_DELTA_EVENT,
          piChatStreamSchema: PI_CHAT_STREAM_EVENT_SCHEMA,
          ...provenance(cumulativeEvent),
          piChatSequence: sequence,
          piChatLiveMessageId: next.piChatLiveMessageId || "",
          operations,
        } : null,
        projection: { message: next, sequence: operations.length ? sequence : previous.sequence },
      };
    }
  }
  return {
    event: {
      type: MESSAGE_CHECKPOINT_EVENT,
      piChatStreamSchema: PI_CHAT_STREAM_EVENT_SCHEMA,
      ...provenance(cumulativeEvent),
      piChatSequence: sequence,
      ...(cumulativeEvent.type === "message_start" ? { piChatStreamStart: true as const } : null),
      message: next,
    },
    projection: { message: next, sequence },
  };
}

function validSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validLiveMessageId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function decodeStreamingCheckpoint(event: Record<string, unknown>): StreamingMessageCheckpointEvent | null {
  const message = canonicalPiMessage(event.message);
  if (
    event.type !== MESSAGE_CHECKPOINT_EVENT
    || event.piChatStreamSchema !== PI_CHAT_STREAM_EVENT_SCHEMA
    || !validSequence(event.piChatSequence)
    || !message
    || message.role !== "assistant"
    || !validLiveMessageId(message.piChatLiveMessageId)
    || (Array.isArray(message.content) && message.content.length > 256)
    || (event.piChatStreamStart !== undefined && event.piChatStreamStart !== true)
  ) return null;
  return {
    type: MESSAGE_CHECKPOINT_EVENT,
    piChatStreamSchema: PI_CHAT_STREAM_EVENT_SCHEMA,
    piChatSequence: event.piChatSequence,
    ...(event.piChatStreamStart === true ? { piChatStreamStart: true } : null),
    ...(typeof event.piChatSessionId === "string" ? { piChatSessionId: event.piChatSessionId } : null),
    ...(typeof event.piChatRunEpoch === "string" ? { piChatRunEpoch: event.piChatRunEpoch } : null),
    ...(typeof event.piChatRunGeneration === "number" ? { piChatRunGeneration: event.piChatRunGeneration } : null),
    message,
  };
}

export function applyStreamingDelta(
  previous: StreamingWireProjection | undefined,
  event: Record<string, unknown>,
): StreamingWireProjection | null {
  if (
    !previous
    || event.type !== MESSAGE_DELTA_EVENT
    || event.piChatStreamSchema !== PI_CHAT_STREAM_EVENT_SCHEMA
    || !validSequence(event.piChatSequence)
    || event.piChatSequence !== previous.sequence + 1
    || !validLiveMessageId(event.piChatLiveMessageId)
    || event.piChatLiveMessageId !== previous.message.piChatLiveMessageId
    || !Array.isArray(event.operations)
    || event.operations.length > 256
  ) return null;

  let content = typeof previous.message.content === "string"
    ? previous.message.content
    : Array.isArray(previous.message.content)
      ? previous.message.content.map((block) => ({ ...block }))
      : undefined;
  let errorMessage = previous.message.errorMessage;
  for (const raw of event.operations) {
    if (!raw || typeof raw !== "object") return null;
    const operation = raw as unknown as StreamingMessageAppend;
    if (
      !Number.isInteger(operation.contentIndex)
      || (operation.field === "errorMessage"
        ? operation.contentIndex !== -1
        : operation.contentIndex < 0 || operation.contentIndex >= 256)
      || (operation.field !== "text" && operation.field !== "thinking" && operation.field !== "errorMessage")
      || typeof operation.append !== "string"
      || operation.append.length > 1_000_000
    ) return null;
    if (operation.field === "errorMessage") {
      errorMessage = (errorMessage || "") + operation.append;
      continue;
    }
    if (typeof content === "string") {
      if (operation.contentIndex !== 0 || operation.field !== "text") return null;
      content += operation.append;
      continue;
    }
    if (!Array.isArray(content)) return null;
    const block = content[operation.contentIndex];
    if (!block || block.type !== operation.field) return null;
    if (operation.field === "text") block.text = (block.text || "") + operation.append;
    else block.thinking = (block.thinking || "") + operation.append;
  }
  return {
    message: {
      ...previous.message,
      content,
      ...(errorMessage !== undefined ? { errorMessage } : null),
    },
    sequence: event.piChatSequence,
  };
}
