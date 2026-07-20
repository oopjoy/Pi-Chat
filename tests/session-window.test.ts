import assert from "node:assert/strict";
import test from "node:test";
import { messageWindow, RECENT_TURN_WINDOW_SIZE } from "../src/server/app";
import type { PiMessage } from "../src/shared/types";

function turn(index: number): PiMessage[] {
  return [
    { role: "user", content: `question ${index}`, timestamp: index * 10 },
    { role: "assistant", content: [{ type: "toolCall", id: `tool-${index}`, name: "read", arguments: { path: `file-${index}` } }], timestamp: index * 10 + 1 },
    { role: "toolResult", toolCallId: `tool-${index}`, toolName: "read", content: `result ${index}`, timestamp: index * 10 + 2 },
    { role: "assistant", content: `answer ${index}`, timestamp: index * 10 + 3 },
  ];
}

test("message window keeps the newest twenty complete user-initiated turns", () => {
  const messages = Array.from({ length: 25 }, (_, index) => turn(index)).flat();
  const windowed = messageWindow(messages);
  assert.equal(RECENT_TURN_WINDOW_SIZE, 20);
  assert.equal(windowed.total, 100);
  assert.equal(windowed.turns, 25);
  assert.equal(windowed.truncated, true);
  assert.equal(windowed.messages.length, 80);
  assert.equal(windowed.messages[0].role, "user");
  assert.equal(windowed.messages[0].content, "question 5");
  assert.equal(windowed.messages.at(-1)?.content, "answer 24");
  assert.equal(windowed.messages.some((message) => message.content === "question 4"), false);
  assert.equal(windowed.messages.some((message) => message.content === "result 5"), true);
});

test("message window leaves conversations with twenty or fewer user turns intact", () => {
  const messages = Array.from({ length: 20 }, (_, index) => turn(index)).flat();
  const windowed = messageWindow(messages);
  assert.equal(windowed.turns, 20);
  assert.equal(windowed.truncated, false);
  assert.deepEqual(windowed.messages, messages);
});

test("message window safely keeps leading non-user session entries with a short conversation", () => {
  const messages: PiMessage[] = [{ role: "system", content: "system" }, ...turn(1)];
  const windowed = messageWindow(messages);
  assert.equal(windowed.turns, 1);
  assert.equal(windowed.truncated, false);
  assert.deepEqual(windowed.messages, messages);
});
