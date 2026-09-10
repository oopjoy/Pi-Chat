import assert from "node:assert/strict";
import test from "node:test";
import {
  applyStreamingDelta,
  decodeStreamingCheckpoint,
  projectStreamingWireEvent,
  streamingMessageAppends,
} from "../src/shared/streaming-wire";
import { canonicalPiMessage } from "../src/shared/runtime-events";
import type { PiMessage } from "../src/shared/types";
import { streamingAppendHint, withStreamingAppendHints } from "../src/web/lib/streaming-append";

const message = (content: PiMessage["content"]): PiMessage => ({
  role: "assistant",
  content,
  piChatLiveMessageId: "live-message-1",
});

const event = (type: "message_start" | "message_update", content: PiMessage["content"]) => ({
  type,
  piChatSessionId: "0123456789abcdefabcd",
  piChatRunEpoch: "epoch-a",
  piChatRunGeneration: 3,
  message: message(content),
});

test("streaming wire projects one checkpoint followed by append-only deltas", () => {
  const start = projectStreamingWireEvent(undefined, event("message_start", []));
  assert.ok(start?.event);
  assert.equal(start.event.type, "message_checkpoint");
  assert.equal(start.event.piChatSequence, 0);
  assert.equal(start.event.piChatStreamStart, true);

  const block = projectStreamingWireEvent(start.projection, event("message_update", [
    { type: "text", text: "" },
  ]));
  assert.equal(block?.event?.type, "message_checkpoint", "a structural block change uses a checkpoint");

  const first = projectStreamingWireEvent(block?.projection, event("message_update", [
    { type: "text", text: "hello" },
  ]));
  assert.deepEqual(first?.event && "operations" in first.event ? first.event.operations : null, [
    { contentIndex: 0, field: "text", append: "hello" },
  ]);

  const second = projectStreamingWireEvent(first?.projection, event("message_update", [
    { type: "text", text: "hello world" },
  ]));
  assert.deepEqual(second?.event && "operations" in second.event ? second.event.operations : null, [
    { contentIndex: 0, field: "text", append: " world" },
  ]);

  const decodedStart = decodeStreamingCheckpoint(start?.event || {});
  assert.ok(decodedStart);
  const decodedBlock = decodeStreamingCheckpoint(block?.event || {});
  assert.ok(decodedBlock);
  let browser = { message: decodedBlock.message, sequence: decodedBlock.piChatSequence };
  browser = applyStreamingDelta(browser, first?.event || {})!;
  browser = applyStreamingDelta(browser, second?.event || {})!;
  assert.deepEqual(browser.message.content, [{ type: "text", text: "hello world" }]);
});

test("checkpoint decoding reconstructs a closed assistant projection", () => {
  const decoded = decodeStreamingCheckpoint({
    type: "message_checkpoint",
    piChatStreamSchema: 1,
    piChatSequence: 2,
    unexpectedEventField: "drop",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "safe", privateField: "drop" }],
      piChatLiveMessageId: "live-message-1",
      provider: "provider-a",
      secret: "drop",
    },
  });
  assert.ok(decoded);
  assert.deepEqual(decoded.message, {
    role: "assistant",
    content: [{ type: "text", text: "safe" }],
    piChatLiveMessageId: "live-message-1",
    provider: "provider-a",
  });
  assert.equal(decodeStreamingCheckpoint({
    type: "message_checkpoint",
    piChatStreamSchema: 1,
    piChatSequence: 2,
    message: {
      role: "assistant",
      content: [{ type: "image", data: "x", mimeType: "image/png" }],
      piChatLiveMessageId: "live-message-1",
    },
  }), null);
});

test("browser-local append hints preserve source content indexes and cannot enter JSON", () => {
  const hinted = withStreamingAppendHints(
    message([
      { type: "thinking", thinking: "private" },
      { type: "text", text: "visible" },
    ]),
    7,
    [{ contentIndex: 1, field: "text", append: " suffix" }],
  );
  assert.deepEqual(streamingAppendHint(hinted, 1), { sequence: 7, append: " suffix" });
  assert.equal(streamingAppendHint(hinted, 0), undefined);
  assert.equal(JSON.stringify(hinted).includes("suffix"), false);
});

test("streaming wire falls back to checkpoints for corrections and structural changes", () => {
  assert.equal(
    streamingMessageAppends(message("complete"), message("corrected")),
    null,
  );
  assert.equal(
    streamingMessageAppends(
      message([{ type: "thinking", thinking: "plan" }]),
      message([
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "answer" },
      ]),
    ),
    null,
  );

  const initial = projectStreamingWireEvent(undefined, event("message_update", "complete"));
  const corrected = projectStreamingWireEvent(initial?.projection, event("message_update", "corrected"));
  assert.equal(corrected?.event?.type, "message_checkpoint");
});

test("append wire payload stays proportional to the suffix rather than the cumulative message", () => {
  const prefix = "x".repeat(100_000);
  const previous = { message: message(prefix), sequence: 8 };
  const projected = projectStreamingWireEvent(previous, event("message_update", `${prefix}y`));
  assert.equal(projected?.event?.type, "message_delta");
  assert.ok(JSON.stringify(projected?.event).length < 1_000);
});

test("browser delta application rejects missing, duplicate, and mismatched sequences", () => {
  const previous = { message: message("A"), sequence: 4 };
  const valid = {
    type: "message_delta",
    piChatStreamSchema: 1,
    piChatSequence: 5,
    piChatLiveMessageId: "live-message-1",
    operations: [{ contentIndex: 0, field: "text", append: "B" }],
  };
  assert.equal(applyStreamingDelta(previous, valid)?.message.content, "AB");
  assert.equal(applyStreamingDelta(previous, { ...valid, piChatSequence: 6 }), null);
  assert.equal(applyStreamingDelta(previous, { ...valid, piChatLiveMessageId: "other" }), null);
  assert.equal(applyStreamingDelta(undefined, valid), null);
});

test("a streamed failed attempt carries its complete provider reason to the transcript", () => {
  const failed = canonicalPiMessage({
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (503): auth_unavailable",
  });
  assert.equal(failed?.stopReason, "error");
  assert.equal(failed?.errorMessage, "OpenAI API error (503): auth_unavailable");

  // Error details are transcript data, not a preview: all received characters
  // and line breaks survive the canonical wire payload.
  const body = `line 1\n${"x".repeat(5_000)}\nline 3`;
  const oversized = canonicalPiMessage({
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: body,
  });
  assert.equal(oversized?.errorMessage, body);
  const malformed = canonicalPiMessage({
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: { nested: true },
  });
  assert.equal(malformed?.errorMessage, undefined);
  assert.equal(malformed?.stopReason, "error");
});

test("a growing error body uses the SSE append stream", () => {
  const initial = message([]);
  const first = projectStreamingWireEvent(undefined, {
    ...event("message_start", []),
    message: { ...initial, errorMessage: "upstream error:\n" },
  });
  assert.equal(first?.event?.type, "message_checkpoint");

  const second = projectStreamingWireEvent(first?.projection, {
    ...event("message_update", []),
    message: { ...initial, errorMessage: "upstream error:\n  retry 1 failed\n" },
  });
  assert.deepEqual(second?.event && "operations" in second.event ? second.event.operations : null, [
    { contentIndex: -1, field: "errorMessage", append: "  retry 1 failed\n" },
  ]);
  const browser = applyStreamingDelta(
    { message: first!.projection.message, sequence: first!.projection.sequence },
    second?.event || {},
  );
  assert.equal(browser?.message.errorMessage, "upstream error:\n  retry 1 failed\n");
});

test("an error append and answer append share one ordered stream delta", () => {
  const firstMessage = message([{ type: "text", text: "partial answer" }]);
  const first = projectStreamingWireEvent(undefined, {
    ...event("message_start", firstMessage.content),
    message: { ...firstMessage, errorMessage: "provider log:\n" },
  });
  const nextMessage = {
    ...firstMessage,
    content: [{ type: "text" as const, text: "partial answer continued" }],
    errorMessage: "provider log:\nretry failed",
  };
  const second = projectStreamingWireEvent(first?.projection, {
    ...event("message_update", nextMessage.content),
    message: nextMessage,
  });
  assert.deepEqual(second?.event && "operations" in second.event ? second.event.operations : null, [
    { contentIndex: -1, field: "errorMessage", append: "retry failed" },
    { contentIndex: 0, field: "text", append: " continued" },
  ]);
  const browser = applyStreamingDelta(first?.projection, second?.event || {});
  assert.equal(browser?.message.errorMessage, nextMessage.errorMessage);
  assert.deepEqual(browser?.message.content, nextMessage.content);
});
