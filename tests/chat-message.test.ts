import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assistantCopyText, assistantModelLabel, assistantThinkingLabel, ChatMessage } from "../src/web/components/ChatMessage";

test("user messages stay literal instead of rendering incomplete Markdown or math", () => {
  const source = "**unfinished $x + [link](\\\\server\\share";
  const html = renderToStaticMarkup(React.createElement(ChatMessage, { message: { role: "user", content: source } }));

  assert.match(html, /class="user-plain-text"/);
  assert.match(html, /\*\*unfinished \$x \+ \[link\]\(\\\\server\\share/);
  assert.doesNotMatch(html, /markdown-body|katex|<strong>|<a /);
});

test("assistant messages continue to use Markdown rendering", () => {
  const html = renderToStaticMarkup(React.createElement(ChatMessage, { message: { role: "assistant", content: "**formatted**" } }));

  assert.match(html, /class="markdown-body markdown-source-copy"/);
  assert.match(html, /<strong[^>]*>formatted<\/strong>/);
  assert.match(html, /class="message-footer"/);
  assert.match(html, /aria-label="复制整个回答"/);
});

test("assistant footer uses the actual message model and copies only visible answer text", () => {
  const message = {
    role: "assistant",
    provider: "openai",
    model: "gpt-5",
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "First **paragraph**" },
      { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "secret" } },
      { type: "text", text: "```ts\nconst answer = 1;\n```" },
    ],
  };
  assert.equal(assistantModelLabel(message), "openai / gpt-5");
  assert.equal(assistantCopyText(message.content), "First **paragraph**\n\n```ts\nconst answer = 1;\n```");
  const html = renderToStaticMarkup(React.createElement(ChatMessage, { message }));
  assert.match(html, /openai \/ gpt-5/);
  assert.doesNotMatch(html, /private reasoning|secret/);
});

test("assistant footer displays only a persisted per-reply thinking strength", () => {
  const message = { role: "assistant", provider: "openai", model: "gpt-5", thinkingLevel: "medium", content: "Done" };
  assert.equal(assistantThinkingLabel(message), "med");
  assert.equal(assistantThinkingLabel({ ...message, thinkingLevel: "unexpected" }), "");
  const html = renderToStaticMarkup(React.createElement(ChatMessage, { message }));
  assert.match(html, /class="message-thinking"[^>]*>med/);
  assert.match(html, /title="思考强度：med"/);
  const unknown = renderToStaticMarkup(React.createElement(ChatMessage, { message: { ...message, thinkingLevel: "unexpected" } }));
  assert.doesNotMatch(unknown, /message-thinking/);
});

test("assistant content sanitized to empty is invisible only after streaming settles", () => {
  const leaked = "code**/analysis code**/analysis code**/analysis";
  const settled = renderToStaticMarkup(React.createElement(ChatMessage, { message: { role: "assistant", content: leaked } }));
  const streaming = renderToStaticMarkup(React.createElement(ChatMessage, { message: { role: "assistant", content: leaked }, streaming: true }));

  assert.equal(settled, "");
  assert.match(streaming, /Pi 正在工作/);
});
