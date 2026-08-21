import type { PiMessage } from "../../shared/types";
import type { StreamingMessageAppend } from "../../shared/streaming-wire";

export const STREAMING_APPEND_HINT = Symbol("pi-chat-streaming-append-hint");

export interface StreamingAppendHint {
  sequence: number;
  append: string;
}

type StreamingHintedMessage = PiMessage & {
  [STREAMING_APPEND_HINT]?: ReadonlyMap<number, StreamingAppendHint>;
};

/** Attach browser-local append evidence that JSON/provider payloads cannot forge. */
export function withStreamingAppendHints(
  message: PiMessage,
  sequence: number,
  operations: readonly StreamingMessageAppend[],
): PiMessage {
  const hints = new Map<number, StreamingAppendHint>();
  for (const operation of operations) {
    if (operation.field !== "text" || !operation.append) continue;
    const previous = hints.get(operation.contentIndex);
    hints.set(operation.contentIndex, {
      sequence,
      append: (previous?.append || "") + operation.append,
    });
  }
  if (!hints.size) return message;
  return Object.defineProperty({ ...message }, STREAMING_APPEND_HINT, {
    value: hints,
    enumerable: false,
  }) as StreamingHintedMessage;
}

export function streamingAppendHint(
  message: PiMessage,
  contentIndex: number,
): StreamingAppendHint | undefined {
  return (message as StreamingHintedMessage)[STREAMING_APPEND_HINT]?.get(contentIndex);
}
