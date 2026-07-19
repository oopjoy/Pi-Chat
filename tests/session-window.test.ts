import assert from "node:assert/strict";
import test from "node:test";
import { messageWindow } from "../src/server/app";
import type { PiMessage } from "../src/shared/types";

function message(index: number): PiMessage {
  return { role: "assistant", content: `message ${index}`, timestamp: index };
}

test("message window keeps only the newest 400 messages", () => {
  const windowed = messageWindow(Array.from({ length: 450 }, (_, index) => message(index)));
  assert.equal(windowed.total, 450);
  assert.equal(windowed.truncated, true);
  assert.equal(windowed.messages.length, 400);
  assert.equal(windowed.messages[0].timestamp, 50);
  assert.equal(windowed.messages.at(-1)?.timestamp, 449);
});

test("message window leaves short conversations intact", () => {
  const messages = Array.from({ length: 400 }, (_, index) => message(index));
  const windowed = messageWindow(messages);
  assert.equal(windowed.total, 400);
  assert.equal(windowed.truncated, false);
  assert.deepEqual(windowed.messages, messages);
});
