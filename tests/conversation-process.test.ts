import assert from "node:assert/strict";
import test from "node:test";
import type { PiMessage } from "../src/shared/types";
import { groupConversation } from "../src/web/lib/conversation-process";

test("groups thinking, tool calls and matching tool results into one collapsed process", () => {
  const messages: PiMessage[] = [
    { role: "user", content: "检查项目" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先检查目录。" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git status" } },
      ],
    },
    { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "On branch main" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "检查完成。" }, { type: "text", text: "项目状态正常。" }] },
  ];

  const items = groupConversation(messages);
  assert.equal(items.length, 3);
  assert.equal(items[0].kind, "message");
  assert.equal(items[1].kind, "process");
  assert.equal(items[2].kind, "message");
  if (items[1].kind !== "process") throw new Error("Expected process");
  assert.equal(items[1].entries.filter((entry) => entry.kind === "thinking").length, 2);
  const tool = items[1].entries.find((entry) => entry.kind === "tool");
  assert.deepEqual(tool, {
    kind: "tool",
    id: "call-1",
    name: "bash",
    arguments: '{\n  "command": "git status"\n}',
    result: "On branch main",
    isError: false,
  });
  if (items[2].kind !== "message") throw new Error("Expected final message");
  assert.deepEqual(items[2].message.content, [{ type: "text", text: "项目状态正常。" }]);
});

test("removes leaked analysis markers from tool-process notes", () => {
  const items = groupConversation([{
    role: "assistant",
    content: [
      { type: "text", text: "code**/analysis code**/analysis code**/analysis\n code**/analysis" },
      { type: "toolCall", id: "call-leak", name: "bash", arguments: { command: "dir" } },
    ],
  }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "process");
  if (items[0].kind !== "process") throw new Error("Expected process");
  assert.equal(items[0].entries.some((entry) => entry.kind === "note"), false);
});

test("keeps a failed tool result visible inside the process", () => {
  const items = groupConversation([
    { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "npm test" } }] },
    { role: "toolResult", toolCallId: "call-2", toolName: "bash", isError: true, content: [{ type: "text", text: "tests failed" }] },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "process");
  if (items[0].kind !== "process") throw new Error("Expected process");
  assert.deepEqual(items[0].entries, [{
    kind: "tool",
    id: "call-2",
    name: "bash",
    arguments: '{\n  "command": "npm test"\n}',
    result: "tests failed",
    isError: true,
  }]);
});

test("does not create a process for ordinary user and assistant messages", () => {
  const items = groupConversation([
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好，有什么可以帮你？" },
  ]);
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.kind === "message"));
});
