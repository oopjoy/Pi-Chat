import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { LOCAL_COORDINATION_ROLE, type PiMessage } from "../src/shared/types";
import {
  COORDINATION_MESSAGE_FOLD_LINE_LIMIT,
  CoordinationMessage,
  shouldFoldCoordinationText,
} from "../src/web/components/CoordinationMessage";
import { ConversationProcess, toolLabel } from "../src/web/components/ConversationProcess";
import { EditDiffSidebar } from "../src/web/components/EditToolDiff";
import { groupConversation, messageItemKey } from "../src/web/lib/conversation-process";

test("unified edit Diff uses visible patch markers and wraps long lines", () => {
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.edit-tool-diff-line-content\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(css, /\.edit-tool-diff-line-content\s*\{[^}]*white-space:\s*pre-wrap;/s);
  assert.match(css, /\.edit-tool-diff-line\s*\{[^}]*grid-template-columns:\s*1\.5em minmax\(0, 1fr\);/s);
});

test("conversation item keys prefer projected message identities", () => {
  assert.equal(
    messageItemKey({ role: "assistant", content: "answer", piChatLiveMessageId: "live-1" }),
    "message:live:live-1:0",
  );
  assert.equal(
    messageItemKey({ role: "assistant", content: "answer", piChatPersistedMessageId: "entry-a:0" }),
    "message:persisted:entry-a:0:0",
  );
});

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
    completed: true,
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
    completed: true,
    isError: true,
  }]);
});

test("completed read, bash and subagent rows omit redundant completion text", () => {
  const items = groupConversation([
    { role: "assistant", content: [
      { type: "toolCall", id: "read-1", name: "read", arguments: {} },
      { type: "toolCall", id: "bash-1", name: "bash", arguments: {} },
      { type: "toolCall", id: "sub-1", name: "subagent", arguments: {} },
    ] },
    { role: "toolResult", toolCallId: "read-1", toolName: "read", content: "ok" },
    { role: "toolResult", toolCallId: "bash-1", toolName: "bash", content: "ok" },
    { role: "toolResult", toolCallId: "sub-1", toolName: "subagent", content: "ok" },
  ]);
  assert.equal(items.length, 1);
  if (items[0]?.kind !== "process") throw new Error("Expected process");
  for (const entry of items[0].entries) {
    if (entry.kind === "tool") assert.equal(toolLabel(entry), entry.name);
  }
});

test("compaction metadata without content is ignored without crashing key generation", () => {
  const summary: PiMessage = { role: "compactionSummary", summary: "compressed context", tokensBefore: 120_000, timestamp: 12 };
  assert.doesNotThrow(() => groupConversation([summary]));
  assert.deepEqual(groupConversation([summary]), []);
});

test("does not create a process for ordinary user and assistant messages", () => {
  const items = groupConversation([
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好，有什么可以帮你？" },
  ]);
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.kind === "message"));
});

test("a local coordination notice is a standalone input boundary before following tools", () => {
  const coordination: PiMessage = {
    role: LOCAL_COORDINATION_ROLE,
    localCoordination: { source: "chat333" },
    content: "Please review the next change",
    timestamp: 2,
  };
  const items = groupConversation([
    { role: "assistant", content: "Earlier result", timestamp: 1 },
    coordination,
    { role: "assistant", content: [{ type: "toolCall", id: "read-after-notice", name: "read", arguments: {} }], timestamp: 3 },
  ]);
  assert.deepEqual(items.map((item) => item.kind), ["message", "coordination", "process"]);
  assert.equal(items[1]?.kind, "coordination");
  if (items[1]?.kind === "coordination") assert.equal(items[1].message, coordination);
  if (items[2]?.kind !== "process") throw new Error("Expected following process");
  assert.equal(items[2].entries.some((entry) => entry.kind === "thinking"), false);
  assert.equal(items[2].entries.filter((entry) => entry.kind === "tool").length, 1);
});

test("coordination input is visibly headed instead of hiding inside process details", () => {
  const html = renderToStaticMarkup(createElement(CoordinationMessage, { message: {
    role: LOCAL_COORDINATION_ROLE,
    localCoordination: { source: "chat333" },
    content: "Please review the next change",
    timestamp: new Date("2026-08-15T07:12:48Z").getTime(),
  } }));
  assert.match(html, /^<article class="coordination-message"/);
  assert.match(html, /协调消息/);
  assert.match(html, /chat333/);
  assert.match(html, /Please review the next change/);
  assert.doesNotMatch(html, /conversation-process/);
  assert.doesNotMatch(html, /<details/);
});

test("long coordination messages fold by source line count", () => {
  const content = Array.from(
    { length: COORDINATION_MESSAGE_FOLD_LINE_LIMIT + 1 },
    (_, index) => `coordination line ${index + 1}`,
  ).join("\n");
  assert.equal(shouldFoldCoordinationText(content), true);
  const html = renderToStaticMarkup(createElement(CoordinationMessage, {
    message: { role: LOCAL_COORDINATION_ROLE, content },
  }));
  assert.match(html, /coordination-message-content"><div class="is-collapsed"/);
  assert.match(html, /class="coordination-message-fold-toggle"[^>]*aria-expanded="false"[^>]*>展开全部/);
});

test("short coordination messages do not show a fold toggle", () => {
  const content = "brief coordination";
  assert.equal(shouldFoldCoordinationText(content), false);
  const html = renderToStaticMarkup(createElement(CoordinationMessage, {
    message: { role: LOCAL_COORDINATION_ROLE, content },
  }));
  assert.doesNotMatch(html, /coordination-message-fold-toggle/);
});

test("coordination fold toggle expands and collapses the full message", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { pretendToBeVisual: true });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const content = Array.from(
    { length: COORDINATION_MESSAGE_FOLD_LINE_LIMIT + 1 },
    (_, index) => `coordination line ${index + 1}`,
  ).join("\n");
  try {
    await act(async () => root.render(createElement(CoordinationMessage, {
      message: { role: LOCAL_COORDINATION_ROLE, content },
    })));
    const body = dom.window.document.querySelector(".coordination-message-content > div")!;
    const toggle = dom.window.document.querySelector<HTMLButtonElement>(".coordination-message-fold-toggle")!;
    assert.equal(body.classList.contains("is-collapsed"), true);
    await act(async () => toggle.click());
    assert.equal(body.classList.contains("is-collapsed"), false);
    assert.equal(toggle.textContent, "收起");
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
  }
});

test("coordination splits assistant work so the following answer cannot appear headless", () => {
  const items = groupConversation([
    { role: "assistant", provider: "test", model: "model-a", timestamp: 1, content: [
      { type: "thinking", thinking: "before coordination" },
      { type: "toolCall", id: "before", name: "read", arguments: {} },
    ] },
    { role: LOCAL_COORDINATION_ROLE, localCoordination: { source: "chat333" }, content: "New instruction", timestamp: 2 },
    { role: "assistant", provider: "test", model: "model-a", content: "Acknowledged", timestamp: 3 },
  ]);
  assert.deepEqual(items.map((item) => item.kind), ["process", "coordination", "message"]);
  if (items[0]?.kind !== "process" || items[2]?.kind !== "message") throw new Error("Expected process, coordination, answer");
  assert.equal(items[0].assistantHeader?.timestamp, 1);
  assert.equal(items[2].hideAssistantMetadata, undefined);
});

test("native system messages do not become visible process boundaries", () => {
  assert.deepEqual(groupConversation([{ role: "system", content: "Runtime-only metadata" }]), []);
});

test("streaming thinking-only assistant turns fold into a process without a body message", () => {
  const items = groupConversation([{
    role: "assistant",
    content: [{ type: "thinking", thinking: "先规划再动手。" }],
  }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "process");
  if (items[0].kind !== "process") throw new Error("Expected process");
  assert.deepEqual(items[0].entries, [{ kind: "thinking", text: "先规划再动手。" }]);
});

test("streaming thinking plus final text places reply metadata above the process only once", () => {
  const source = {
    role: "assistant",
    provider: "cpa-proxy",
    model: "gpt-5.6-sol",
    thinkingLevel: "high",
    timestamp: 123,
    content: [
      { type: "thinking" as const, thinking: "内部推理" },
      { type: "text" as const, text: "这是给用户看的答案。" },
    ],
  };
  const items = groupConversation([source]);
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, "process");
  assert.equal(items[1].kind, "message");
  if (items[0].kind !== "process" || items[1].kind !== "message") throw new Error("Expected process then message");
  assert.equal(items[0].assistantHeader?.provider, "cpa-proxy");
  assert.equal(items[0].assistantHeader?.model, "gpt-5.6-sol");
  assert.equal(items[0].assistantHeader?.thinkingLevel, "high");
  assert.equal(items[1].hideAssistantMetadata, true);
  assert.deepEqual(items[1].message.content, [{ type: "text", text: "这是给用户看的答案。" }]);
});

test("a process reconstructed from a tool result uses the following reply as its metadata header", () => {
  const items = groupConversation([
    { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: "done" },
    { role: "assistant", provider: "cpa-proxy", model: "gpt-5.6-sol", thinkingLevel: "high", content: "最终答案" },
  ]);
  assert.equal(items.length, 2);
  if (items[0]?.kind !== "process" || items[1]?.kind !== "message") throw new Error("Expected process then message");
  assert.equal(items[0].assistantHeader?.model, "gpt-5.6-sol");
  assert.equal(items[1].hideAssistantMetadata, true);
});

test("contiguous persisted tools and a live thought combine into one process card", () => {
  const items = groupConversation([
    { role: "assistant", content: [{ type: "thinking", thinking: "先调用工具" }, { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "dir" } }] },
    { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "ok" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "继续分析" }] },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "process");
  if (items[0].kind !== "process") throw new Error("Expected process");
  assert.equal(items[0].entries.filter((entry) => entry.kind === "thinking").length, 2);
  assert.equal(items[0].entries.filter((entry) => entry.kind === "tool").length, 1);
});

test("settled assistant content that renders nothing does not split one process", () => {
  const leakOnly = Array.from({ length: 3 }, () => "code**/analysis").join(" ");
  for (const invisible of ["", leakOnly]) {
    const items = groupConversation([
      { role: "assistant", content: [{ type: "thinking", thinking: "first" }, { type: "toolCall", id: "one", name: "read", arguments: {} }] },
      { role: "toolResult", toolCallId: "one", toolName: "read", content: "done" },
      { role: "assistant", content: invisible },
      { role: "assistant", content: [{ type: "thinking", thinking: "second" }, { type: "toolCall", id: "two", name: "bash", arguments: {} }] },
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "process");
    if (items[0]?.kind !== "process") throw new Error("Expected process");
    assert.equal(items[0].entries.filter((entry) => entry.kind === "tool").length, 2);
  }
});

test("visible assistant commentary remains a real boundary between processes", () => {
  const items = groupConversation([
    { role: "assistant", content: [{ type: "thinking", thinking: "first" }] },
    { role: "assistant", content: "visible update" },
    { role: "assistant", content: [{ type: "thinking", thinking: "second" }] },
  ]);
  assert.deepEqual(items.map((item) => item.kind), ["process", "message", "process"]);
});

test("only an explicitly live trailing empty assistant keeps a metadata placeholder", () => {
  assert.deepEqual(groupConversation([{ role: "assistant", content: "" }]), []);
  const live = groupConversation([{ role: "assistant", content: "", timestamp: 10 }], { preserveTrailingAssistantPlaceholder: true });
  assert.equal(live.length, 1);
  assert.equal(live[0]?.kind, "message");
});

test("an explicit live snapshot replaces its earlier lifecycle form by server identity", () => {
  const items = groupConversation([
    { role: "assistant", content: "partial", piChatLiveMessageId: "live-1" },
  ], {
    liveMessage: { role: "assistant", content: "final", piChatLiveMessageId: "live-1" },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "message");
  if (items[0]?.kind !== "message") throw new Error("Expected one message");
  assert.equal(items[0].message.content, "final");
});

test("a cumulative live assistant snapshot replaces its persisted prefix", () => {
  const persisted: PiMessage[] = [
    { role: "assistant", timestamp: 100, content: [{ type: "thinking", thinking: "plan" }, { type: "toolCall", id: "one", name: "read", arguments: { path: "a" } }] },
    { role: "toolResult", toolCallId: "one", toolName: "read", content: "done", timestamp: 101 },
  ];
  const live: PiMessage = {
    role: "assistant",
    timestamp: 100,
    content: [{ type: "toolCall", id: "one", name: "read", arguments: { path: "a" } }, { type: "thinking", thinking: "plan further" }, { type: "toolCall", id: "two", name: "bash", arguments: { command: "test" } }],
  };
  const items = groupConversation(persisted, { liveMessage: live });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "process");
  if (items[0]?.kind !== "process") throw new Error("Expected process");
  assert.equal(items[0].entries.filter((entry) => entry.kind === "thinking").length, 1);
  const tools = items[0].entries.filter((entry) => entry.kind === "tool");
  assert.deepEqual(tools.map((entry) => entry.kind === "tool" ? entry.id : ""), ["one", "two"]);
});

test("a final live reply does not duplicate an already persisted active-turn answer without a timestamp", () => {
  const answer = "你的担心是对的，而且是关键问题。\n\n这是完整的长回答。";
  const items = groupConversation([
    { role: "user", content: "question", timestamp: 10 },
    { role: "assistant", content: answer, timestamp: 20 },
  ], { liveMessage: { role: "assistant", content: answer } });
  assert.equal(items.length, 2);
  assert.equal(items.filter((item) => item.kind === "message").length, 2);
});

test("an intentionally repeated persisted assistant turn remains visible", () => {
  const answer = "same response intentionally sent twice";
  const items = groupConversation([
    { role: "user", content: "question", timestamp: 10 },
    { role: "assistant", content: answer, timestamp: 20 },
    { role: "assistant", content: answer, timestamp: 30 },
  ]);
  assert.equal(items.filter((item) => item.kind === "message").length, 3);
});

test("only the explicit live snapshot is coalesced among same-timestamp messages", () => {
  const persisted: PiMessage[] = [
    { role: "assistant", timestamp: 100, content: [{ type: "thinking", thinking: "plan" }] },
    { role: "assistant", timestamp: 100, content: "Working" },
    { role: "assistant", timestamp: 100, content: "Working further" },
  ];
  const live: PiMessage = { role: "assistant", timestamp: 100, content: [{ type: "thinking", thinking: "plan complete" }, { type: "toolCall", id: "tool", name: "read", arguments: {} }] };
  const items = groupConversation(persisted, { liveMessage: live });
  assert.deepEqual(items.map((item) => item.kind), ["process", "message", "message"]);
  const texts = items.filter((item) => item.kind === "message").map((item) => item.kind === "message" ? item.message.content : "");
  assert.deepEqual(texts, ["Working", "Working further"]);
});

test("cumulative matching handles reordered overlapping thinking prefixes", () => {
  const persisted: PiMessage[] = [{ role: "assistant", timestamp: 100, content: [{ type: "thinking", thinking: "a" }, { type: "thinking", thinking: "ab" }] }];
  const live: PiMessage = { role: "assistant", timestamp: 100, content: [{ type: "thinking", thinking: "abc" }, { type: "thinking", thinking: "aX" }] };
  const items = groupConversation(persisted, { liveMessage: live });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "process");
  if (items[0]?.kind !== "process") throw new Error("Expected process");
  assert.deepEqual(items[0].entries.filter((entry) => entry.kind === "thinking").map((entry) => entry.kind === "thinking" ? entry.text : ""), ["abc", "aX"]);
});

test("all persisted cumulative prefixes collapse into one explicit live snapshot", () => {
  const persisted: PiMessage[] = [
    { role: "assistant", timestamp: 100, content: [{ type: "thinking", thinking: "p" }] },
    { role: "assistant", timestamp: 100, content: [{ type: "thinking", thinking: "pl" }] },
  ];
  const live: PiMessage = { role: "assistant", timestamp: 100, content: [{ type: "thinking", thinking: "plan" }, { type: "toolCall", id: "one", name: "read", arguments: {} }] };
  const items = groupConversation(persisted, { liveMessage: live });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "process");
  if (items[0]?.kind !== "process") throw new Error("Expected process");
  assert.equal(items[0].entries.filter((entry) => entry.kind === "thinking").length, 1);
});

test("same-name tool results never attach to a different explicit tool ID", () => {
  const items = groupConversation([
    { role: "assistant", content: [{ type: "toolCall", id: "read-a", name: "read", arguments: { path: "a" } }] },
    { role: "toolResult", toolCallId: "read-b", toolName: "read", content: "B result" },
    { role: "assistant", content: [{ type: "toolCall", id: "read-b", name: "read", arguments: { path: "b" } }] },
  ]);
  assert.equal(items[0]?.kind, "process");
  if (items[0]?.kind !== "process") throw new Error("Expected process");
  const tools = items[0].entries.filter((entry) => entry.kind === "tool");
  assert.deepEqual(tools.map((entry) => entry.kind === "tool" ? [entry.id, entry.result] : []), [["read-a", undefined], ["read-b", "B result"]]);
});

test("distinct same-timestamp messages always receive unique React keys", () => {
  const items = groupConversation([
    { role: "assistant", content: "first", timestamp: 100 },
    { role: "assistant", content: "second", timestamp: 100 },
    { role: "assistant", content: "first", timestamp: 100 },
  ]);
  const keys = items.map((item) => item.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("conversation item keys stay stable while streaming thinking text grows", () => {
  const early = groupConversation([{ role: "assistant", content: [{ type: "thinking", thinking: "先" }] }]);
  const later = groupConversation([{ role: "assistant", content: [{ type: "thinking", thinking: "先想清楚再调用工具" }] }]);
  assert.equal(early[0]?.kind, "process");
  assert.equal(later[0]?.kind, "process");
  if (early[0]?.kind !== "process" || later[0]?.kind !== "process") throw new Error("Expected process");
  assert.equal(early[0].key, later[0].key);

  const withTool = groupConversation([
    { role: "assistant", content: [{ type: "thinking", thinking: "计划" }, { type: "toolCall", id: "t1", name: "bash", arguments: {} }] },
    { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "ok" }] },
  ]);
  const withToolAndThought = groupConversation([
    { role: "assistant", content: [{ type: "thinking", thinking: "计划" }, { type: "toolCall", id: "t1", name: "bash", arguments: {} }] },
    { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "ok" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "继续" }] },
  ]);
  assert.equal(withTool[0]?.kind, "process");
  assert.equal(withToolAndThought[0]?.kind, "process");
  if (withTool[0]?.kind !== "process" || withToolAndThought[0]?.kind !== "process") throw new Error("Expected process");
  // Tool completion and additional thought must not remount the outer <details>.
  assert.equal(withTool[0].key, withToolAndThought[0].key);

  const userAnchoredEarly = groupConversation([
    { role: "user", content: "检查", timestamp: 40 },
    { role: "assistant", content: [{ type: "thinking", thinking: "计划" }] },
  ]);
  const userAnchoredLater = groupConversation([
    { role: "user", content: "检查", timestamp: 40 },
    { role: "assistant", content: [{ type: "thinking", thinking: "计划" }, { type: "toolCall", id: "t2", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "t2", toolName: "read", content: [{ type: "text", text: "done" }] },
  ]);
  assert.equal(userAnchoredEarly[1]?.key, userAnchoredLater[1]?.key);

  const user = groupConversation([{ role: "user", content: "hi", timestamp: 42 }]);
  assert.equal(user[0]?.kind, "message");
  if (user[0]?.kind !== "message") throw new Error("Expected message");
  assert.match(user[0].key, /^message:user:42:user:[a-z0-9]+:0$/);
});

test("a result preceding its delayed tool call still produces one complete detailed row", () => {
  const items = groupConversation([
    { role: "toolResult", toolCallId: "late-call", toolName: "read", content: "file contents" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "inspect the file" },
      { type: "toolCall", id: "late-call", name: "read", arguments: { path: "src/app.ts" } },
    ] },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "process");
  if (items[0]?.kind !== "process") throw new Error("Expected process");
  assert.equal(items[0].entries.filter((entry) => entry.kind === "thinking").length, 1);
  assert.equal(items[0].entries.filter((entry) => entry.kind === "tool").length, 1);
  const tool = items[0].entries.find((entry) => entry.kind === "tool");
  assert.deepEqual(tool, {
    kind: "tool",
    id: "late-call",
    name: "read",
    arguments: '{\n  "path": "src/app.ts"\n}',
    result: "file contents",
    completed: true,
    isError: false,
  });
});

test("result-before-call and corrected call-before-result orders keep one process key", () => {
  const result: PiMessage = { role: "toolResult", toolCallId: "read-1", toolName: "read", content: "done", timestamp: 20 };
  const call: PiMessage = { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }], timestamp: 10 };
  const resultFirst = groupConversation([result, call]);
  const callFirst = groupConversation([call, result]);
  assert.equal(resultFirst[0]?.kind, "process");
  assert.equal(callFirst[0]?.kind, "process");
  assert.equal(resultFirst[0]?.key, callFirst[0]?.key);
});

test("prepending older history keeps later process keys stable", () => {
  const tail = [
    { role: "user", content: "later", timestamp: 20 },
    { role: "assistant", content: [{ type: "thinking", thinking: "later thought" }] },
  ] satisfies PiMessage[];
  const expanded = [
    { role: "user", content: "earlier", timestamp: 10 },
    { role: "assistant", content: [{ type: "thinking", thinking: "earlier thought" }] },
    ...tail,
  ] satisfies PiMessage[];
  const tailProcess = groupConversation(tail).find((item) => item.kind === "process");
  const expandedLaterProcess = groupConversation(expanded).filter((item) => item.kind === "process").at(-1);

  assert.equal(tailProcess?.kind, "process");
  assert.equal(expandedLaterProcess?.kind, "process");
  assert.equal(tailProcess?.key, expandedLaterProcess?.key);
});

test("persisting an optimistic user message with a different timestamp keeps its process key", () => {
  const optimistic = groupConversation([
    { role: "user", content: "same submitted prompt", timestamp: 10 },
    { role: "assistant", content: [{ type: "thinking", thinking: "working" }] },
  ]);
  const persisted = groupConversation([
    { role: "user", content: "same submitted prompt", timestamp: 99 },
    { role: "assistant", content: [{ type: "thinking", thinking: "working" }] },
  ]);
  assert.equal(optimistic.find((item) => item.kind === "process")?.key, persisted.find((item) => item.kind === "process")?.key);
});

test("prepending an identical old prompt does not change a timestamped process key", () => {
  const tail = [
    { role: "user", content: "repeat", timestamp: 20 },
    { role: "assistant", content: [{ type: "thinking", thinking: "new run" }], timestamp: 21 },
  ] satisfies PiMessage[];
  const expanded = [
    { role: "user", content: "repeat", timestamp: 10 },
    { role: "assistant", content: [{ type: "thinking", thinking: "old run" }], timestamp: 11 },
    ...tail,
  ] satisfies PiMessage[];
  assert.equal(
    groupConversation(tail).find((item) => item.kind === "process")?.key,
    groupConversation(expanded).filter((item) => item.kind === "process").at(-1)?.key,
  );
});

test("an empty successful tool result completes its original row without duplication", () => {
  const items = groupConversation([
    { role: "assistant", content: [{ type: "toolCall", id: "empty-1", name: "bash", arguments: { command: "exit 0" } }] },
    { role: "toolResult", toolCallId: "empty-1", toolName: "bash", content: "" },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "process");
  if (items[0]?.kind !== "process") throw new Error("Expected process");
  assert.equal(items[0].entries.length, 1);
  const tool = items[0].entries[0];
  assert.deepEqual(tool, {
    kind: "tool",
    id: "empty-1",
    name: "bash",
    arguments: '{\n  "command": "exit 0"\n}',
    completed: true,
    isError: false,
  });
  if (tool.kind === "tool") assert.equal(toolLabel(tool), "bash");
});

test("a completed edit opens the diff sidebar while a failed edit does not", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "setPointerCapture", { value() {}, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "releasePointerCapture", { value() {}, configurable: true });
  const root = createRoot(dom.window.document.querySelector<HTMLElement>("#root")!);
  const messages: PiMessage[] = [
    { role: "assistant", content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] } }] },
    { role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: "done" },
  ];
  const item = groupConversation(messages)[0];
  assert.equal(item?.kind, "process");
  if (item?.kind !== "process") throw new Error("Expected process");
  await act(async () => root.render(createElement(ConversationProcess, { entries: item.entries })));
  await act(async () => root.render(createElement(ConversationProcess, { entries: item.entries })));
  const summary = dom.window.document.querySelector<HTMLButtonElement>(".process-edit-entry > button");
  assert.ok(summary);
  assert.equal(summary.title, "src/app.ts");
  assert.match(summary.textContent || "", /edit/);
  assert.match(summary.textContent || "", /app\.ts/);
  assert.match(summary.textContent || "", /\+1/);
  assert.equal(dom.window.document.querySelector(".process-tool-detail"), null);

  const sidebarRoot = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement("div")));
  let sidebarOpen = false;
  let sidebarWidth = 460;
  const renderSidebar = () => void sidebarRoot.render(createElement(EditDiffSidebar, { open: sidebarOpen, width: sidebarWidth, onWidthChange: (next: number) => { sidebarWidth = next; renderSidebar(); }, onOpenChange: (next: boolean) => { sidebarOpen = next; renderSidebar(); } }));
  await act(async () => renderSidebar());
  await act(async () => summary.click());
  assert.equal(sidebarOpen, true);
  assert.equal(dom.window.document.querySelectorAll(".edit-diff-sidebar").length, 1);
  assert.equal(dom.window.document.querySelector(".edit-diff-sidebar")?.classList.contains("is-open"), true);
  assert.equal(dom.window.document.querySelector(".edit-diff-sidebar")?.getAttribute("aria-hidden"), "false");
  assert.match(dom.window.document.querySelector(".edit-diff-sidebar-header")?.textContent || "", /app\.ts\+1-1/);
  const diffBody = dom.window.document.querySelector(".edit-diff-sidebar .edit-tool-diff-body")?.textContent || "";
  assert.match(diffBody, /-old/);
  assert.match(diffBody, /\+new/);
  assert.equal(
    dom.window.document.querySelector(".edit-tool-diff-unified")?.textContent,
    "-old\n+new\n",
    "copyable unified Diff keeps one patch line per source line",
  );
  assert.deepEqual(
    [...dom.window.document.querySelectorAll(".edit-tool-diff-line")].map((line) => line.className),
    ["edit-tool-diff-line is-delete", "edit-tool-diff-line is-add"],
  );
  const panel = dom.window.document.querySelector<HTMLElement>(".edit-diff-sidebar")!;
  const initialWidth = Number.parseFloat(panel.style.getPropertyValue("--edit-diff-width"));
  const resize = panel.querySelector<HTMLElement>(".edit-diff-sidebar-resize")!;
  const pointer = (type: string, x: number) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x });
    Object.defineProperty(event, "pointerId", { value: 1 });
    return event;
  };
  await act(async () => resize.dispatchEvent(pointer("pointerdown", 100)));
  await act(async () => resize.dispatchEvent(pointer("pointermove", 50)));
  await act(async () => resize.dispatchEvent(pointer("pointerup", 50)));
  assert.ok(Number.parseFloat(panel.style.getPropertyValue("--edit-diff-width")) > initialWidth);
  const close = dom.window.document.querySelector<HTMLButtonElement>(".edit-diff-sidebar-header > button");
  assert.ok(close);
  await act(async () => close.click());
  assert.equal(sidebarOpen, false);
  assert.equal(dom.window.document.querySelectorAll(".edit-diff-sidebar").length, 1);
  assert.equal(panel.classList.contains("is-open"), false);
  assert.equal(panel.getAttribute("aria-hidden"), "true");
  assert.equal(panel.hasAttribute("inert"), true);

  const failed = groupConversation([
    messages[0],
    { role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: "failed", isError: true },
  ])[0];
  if (failed?.kind !== "process") throw new Error("Expected process");
  await act(async () => root.render(createElement(ConversationProcess, { entries: failed.entries })));
  assert.ok(dom.window.document.querySelector(".process-edit-entry"));
  assert.match(dom.window.document.querySelector(".process-edit-entry")?.textContent || "", /失败/);
  await act(async () => sidebarRoot.unmount());
  await act(async () => root.unmount());
});

test("an opened process card stays open when a tool completes", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.querySelector<HTMLElement>("#root")!);
  const early = groupConversation([
    { role: "user", content: "检查", timestamp: 40 },
    { role: "assistant", content: [{ type: "thinking", thinking: "计划" }, { type: "toolCall", id: "read-1", name: "read", arguments: {} }] },
  ]);
  const later = groupConversation([
    { role: "user", content: "检查", timestamp: 40 },
    { role: "assistant", content: [{ type: "thinking", thinking: "计划" }, { type: "toolCall", id: "read-1", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "done" }] },
  ]);
  const earlyProcess = early.find((item) => item.kind === "process");
  const laterProcess = later.find((item) => item.kind === "process");
  assert.ok(earlyProcess?.kind === "process" && laterProcess?.kind === "process");
  assert.equal(earlyProcess.key, laterProcess.key);

  const disclosureKey = "opened-tool-completion";
  await act(async () => root.render(createElement(ConversationProcess, { key: earlyProcess.key, disclosureKey, entries: earlyProcess.entries, streaming: true })));
  const details = dom.window.document.querySelector<HTMLDetailsElement>(".conversation-process")!;
  await act(async () => details.querySelector("summary")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  assert.equal(details.open, true);

  await act(async () => root.render(createElement(ConversationProcess, { key: laterProcess.key, disclosureKey, entries: laterProcess.entries, streaming: true })));
  assert.equal(dom.window.document.querySelector<HTMLDetailsElement>(".conversation-process"), details);
  assert.equal(details.open, true);
  await act(async () => root.unmount());
});

test("the expanded process can be collapsed from its footer", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.querySelector<HTMLElement>("#root")!);
  const disclosureKey = "footer-collapse-process";
  await act(async () => root.render(createElement(ConversationProcess, { disclosureKey, entries: [{ kind: "thinking", text: "long thought" }] })));
  const details = dom.window.document.querySelector<HTMLDetailsElement>(".conversation-process")!;
  await act(async () => details.querySelector("summary")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  assert.equal(details.open, true);
  const collapse = dom.window.document.querySelector<HTMLButtonElement>(".conversation-process-footer button");
  assert.ok(collapse);
  await act(async () => collapse.click());
  assert.equal(details.open, false);
  await act(async () => root.render(createElement(ConversationProcess, { disclosureKey, entries: [{ kind: "thinking", text: "updated thought" }] })));
  assert.equal(dom.window.document.querySelector<HTMLDetailsElement>(".conversation-process")?.open, false);
  await act(async () => root.unmount());
});

test("switching sessions with the same process key loads each disclosure state", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.querySelector<HTMLElement>("#root")!);
  const entries = [{ kind: "thinking" as const, text: "same process" }];

  await act(async () => root.render(createElement(ConversationProcess, { key: "session-a:process", disclosureKey: "session-a:process", entries })));
  const first = dom.window.document.querySelector<HTMLDetailsElement>(".conversation-process")!;
  await act(async () => first.querySelector("summary")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  assert.equal(first.open, true);

  await act(async () => root.render(createElement(ConversationProcess, { key: "session-b:process", disclosureKey: "session-b:process", entries })));
  assert.equal(dom.window.document.querySelector<HTMLDetailsElement>(".conversation-process")?.open, false);

  await act(async () => root.render(createElement(ConversationProcess, { key: "session-a:process", disclosureKey: "session-a:process", entries })));
  assert.equal(dom.window.document.querySelector<HTMLDetailsElement>(".conversation-process")?.open, true);
  await act(async () => root.unmount());
});

test("streaming status never overrides the user's process disclosure choice", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.querySelector<HTMLElement>("#root")!);
  const early = groupConversation([{ role: "assistant", content: [{ type: "thinking", thinking: "visible live thought" }] }])[0];
  const later = groupConversation([{ role: "assistant", content: [{ type: "thinking", thinking: "visible live thought grows" }, { type: "toolCall", id: "read-live", name: "read", arguments: {} }] }])[0];
  assert.equal(early?.kind, "process");
  assert.equal(later?.kind, "process");
  if (early?.kind !== "process" || later?.kind !== "process") throw new Error("Expected process");
  const disclosureKey = "manual-streaming-choice";
  await act(async () => root.render(createElement(ConversationProcess, { disclosureKey, entries: early.entries, streaming: true })));
  const details = dom.window.document.querySelector<HTMLDetailsElement>(".conversation-process")!;
  assert.equal(details.open, false);
  await act(async () => details.querySelector("summary")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  assert.equal(details.open, true);
  await act(async () => details.querySelector("summary")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  assert.equal(details.open, false);
  await act(async () => root.render(createElement(ConversationProcess, { disclosureKey, entries: later.entries, streaming: true })));
  assert.equal(dom.window.document.querySelector<HTMLDetailsElement>(".conversation-process"), details);
  assert.equal(details.open, false);
  await act(async () => root.unmount());
});
