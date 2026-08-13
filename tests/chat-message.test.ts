import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { assistantCopyText, assistantGeneratedAt, assistantModelLabel, assistantThinkingLabel, ChatMessage, shouldFoldUserText, USER_MESSAGE_FOLD_LINE_LIMIT } from "../src/web/components/ChatMessage";

test("user messages stay literal instead of rendering incomplete Markdown or math", () => {
  const source = "**unfinished $x + [link](\\\\server\\share";
  const html = renderToStaticMarkup(React.createElement(ChatMessage, { message: { role: "user", content: source } }));

  assert.match(html, /class="user-plain-text"/);
  assert.match(html, /\*\*unfinished \$x \+ \[link\]\(\\\\server\\share/);
  assert.doesNotMatch(html, /markdown-body|katex|<strong>|<a /);
});

test("long user text folds only after the explicit source-line threshold", () => {
  assert.equal(shouldFoldUserText("a".repeat(20_000)), false);
  assert.equal(shouldFoldUserText(Array.from({ length: USER_MESSAGE_FOLD_LINE_LIMIT }, (_, index) => String(index)).join("\n")), false);
  assert.equal(shouldFoldUserText(Array.from({ length: USER_MESSAGE_FOLD_LINE_LIMIT + 1 }, (_, index) => String(index)).join("\n")), true);

  const foldedText = Array.from({ length: USER_MESSAGE_FOLD_LINE_LIMIT + 1 }, (_, index) => String(index)).join("\n");
  const html = renderToStaticMarkup(React.createElement(ChatMessage, { message: { role: "user", content: foldedText } }));
  assert.match(html, /class="message message-user is-foldable"/);
  assert.match(html, /user-plain-text is-collapsed/);
  assert.match(html, /class="user-message-fold-toggle"[^>]*aria-expanded="false"[^>]*>展开全部/);
});

test("user text folding leaves attached images fully visible", () => {
  const html = renderToStaticMarkup(React.createElement(ChatMessage, { message: {
    role: "user",
    content: [{ type: "text", text: Array.from({ length: USER_MESSAGE_FOLD_LINE_LIMIT + 1 }, (_, index) => String(index)).join("\n") }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
  } }));
  assert.match(html, /class="message-user-attachments"[^>]*aria-label="用户附加图片"/);
  assert.match(html, /class="message-image-thumbnail"[\s\S]*class="message-image"[^>]*src="data:image\/png;base64,aGVsbG8="/);
  assert.ok(html.indexOf('class="message-user-attachments"') < html.indexOf('class="message-content"'));
});

test("user image thumbnails open a closable accessible preview", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(ChatMessage, { message: {
      role: "user",
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }, { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" }],
    } })));
    const thumbnails = dom.window.document.querySelectorAll<HTMLButtonElement>(".message-image-thumbnail");
    assert.equal(thumbnails.length, 2);
    assert.equal(thumbnails[1].getAttribute("aria-label"), "查看用户附加图片的大图");
    await act(async () => thumbnails[1].click());
    const dialog = dom.window.document.querySelector<HTMLElement>(".image-preview-dialog")!;
    const preview = dialog.querySelector<HTMLImageElement>(".image-preview-full")!;
    assert.equal(dialog.getAttribute("role"), "dialog");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.match(preview.src, /data:image\/jpeg;base64,d29ybGQ=/);
    const close = dialog.querySelector<HTMLButtonElement>(".image-preview-close")!;
    assert.equal(dom.window.document.activeElement, close);
    await act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    assert.equal(dom.window.document.activeElement, close);
    await act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })));
    assert.equal(dom.window.document.activeElement, close);
    await act(async () => close.click());
    assert.equal(dom.window.document.querySelector(".image-preview-dialog"), null);
    assert.equal(dom.window.document.activeElement, thumbnails[1]);
    await act(async () => thumbnails[0].click());
    await act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(dom.window.document.querySelector(".image-preview-dialog"), null);
    assert.equal(dom.window.document.activeElement, thumbnails[0]);
    await act(async () => thumbnails[0].click());
    const backdrop = dom.window.document.querySelector<HTMLElement>(".image-preview-backdrop")!;
    await act(async () => backdrop.click());
    assert.equal(dom.window.document.querySelector(".image-preview-dialog"), null);
    assert.equal(dom.window.document.activeElement, thumbnails[0]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});


test("user folding toggle expands and restores the collapsed text", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(ChatMessage, { message: { role: "user", content: Array.from({ length: USER_MESSAGE_FOLD_LINE_LIMIT + 1 }, (_, index) => String(index)).join("\n") } })));
    const text = dom.window.document.querySelector(".user-plain-text")!;
    const toggle = dom.window.document.querySelector<HTMLButtonElement>(".user-message-fold-toggle")!;
    assert.equal(text.classList.contains("is-collapsed"), true);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.textContent, "展开全部");
    await act(async () => toggle.click());
    assert.equal(text.classList.contains("is-collapsed"), false);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.textContent, "收起");
    await act(async () => toggle.click());
    assert.equal(text.classList.contains("is-collapsed"), true);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("assistant images retain their full non-previewable rendering", async () => {
  const html = renderToStaticMarkup(React.createElement(ChatMessage, { message: {
    role: "assistant",
    content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
  } }));
  assert.match(html, /class="message-image"[^>]*src="data:image\/png;base64,aGVsbG8="/);
  assert.doesNotMatch(html, /message-image-thumbnail|image-preview/);
});

test("local coordination and native system messages stay out of the chat body", () => {
  for (const role of ["localCoordination", "system"]) {
    const html = renderToStaticMarkup(React.createElement(ChatMessage, { message: {
      role,
      content: "Runtime-only metadata",
    } }));
    assert.equal(html, "");
  }
});

test("assistant messages continue to use Markdown rendering", () => {
  const html = renderToStaticMarkup(React.createElement(ChatMessage, { message: { role: "assistant", content: "**formatted**" } }));

  assert.match(html, /class="markdown-body markdown-source-copy"/);
  assert.match(html, /<strong[^>]*>formatted<\/strong>/);
  assert.match(html, /class="message-footer"/);
  assert.match(html, /aria-label="复制整个回答"/);
});

test("assistant header uses the actual message model and copies only visible answer text", () => {
  const message = {
    role: "assistant",
    provider: "openai",
    model: "gpt-5",
    timestamp: new Date(2026, 7, 11, 20, 32, 17).getTime(),
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
  const headerAt = html.indexOf('class="message-assistant-header"');
  const contentAt = html.indexOf('class="message-content"');
  const footerAt = html.indexOf('class="message-footer"');
  assert.ok(headerAt >= 0 && headerAt < contentAt, "model metadata renders above the answer");
  assert.ok(footerAt > contentAt, "generated time and copy action remain below the answer");
  assert.doesNotMatch(html.slice(footerAt), /openai \/ gpt-5/);
  assert.match(html.slice(footerAt), /class="message-generated-at"/);
  assert.ok(html.indexOf('class="message-generated-at"') < html.indexOf('aria-label="复制整个回答"'));

  const processOwnedHeader = renderToStaticMarkup(React.createElement(ChatMessage, { message, showAssistantMetadata: false }));
  assert.doesNotMatch(processOwnedHeader, /message-assistant-header|openai \/ gpt-5/);
  assert.match(processOwnedHeader, /message-generated-at/);
  assert.match(processOwnedHeader, /aria-label="复制整个回答"/);
});

test("assistant header displays only a persisted per-reply thinking strength", () => {
  const message = { role: "assistant", provider: "openai", model: "gpt-5", thinkingLevel: "medium", content: "Done" };
  assert.equal(assistantThinkingLabel(message), "med");
  assert.equal(assistantThinkingLabel({ ...message, thinkingLevel: "unexpected" }), "");
  const html = renderToStaticMarkup(React.createElement(ChatMessage, { message }));
  assert.match(html, /class="message-thinking"[^>]*>med/);
  assert.match(html, /title="思考强度：med"/);
  const unknown = renderToStaticMarkup(React.createElement(ChatMessage, { message: { ...message, thinkingLevel: "unexpected" } }));
  assert.doesNotMatch(unknown, /message-thinking/);
});

test("assistant generated time is compact for today and expands for older replies", () => {
  const timestamp = new Date(2026, 7, 11, 20, 32, 17).getTime();
  const today = assistantGeneratedAt(timestamp, new Date(2026, 7, 11, 23, 0).getTime());
  assert.ok(today);
  assert.match(today.label, /^生成于 \d{2}:\d{2}$/);
  assert.equal(today.dateTime, new Date(timestamp).toISOString());
  assert.match(today.title, /^回复生成时间：/);

  const older = assistantGeneratedAt(timestamp, new Date(2026, 7, 13, 12, 0).getTime());
  assert.ok(older);
  assert.match(older.label, /^生成于 \d{2}\/\d{2} \d{2}:\d{2}$/);
  assert.equal(assistantGeneratedAt(undefined), null);
  assert.equal(assistantGeneratedAt(Number.NaN), null);
});

test("an empty streaming reply shows stable model metadata without redundant work text or completion time", () => {
  const leaked = "code**/analysis code**/analysis code**/analysis";
  const timestamp = new Date(2026, 7, 11, 21, 17).getTime();
  const settled = renderToStaticMarkup(React.createElement(ChatMessage, { message: { role: "assistant", content: leaked, timestamp } }));
  const streaming = renderToStaticMarkup(React.createElement(ChatMessage, {
    message: { role: "assistant", content: leaked, timestamp },
    streaming: true,
    assistantMetadataFallback: {
      provider: "cpa-proxy",
      model: "gpt-5.6-sol",
      thinkingLevel: "high",
    },
  }));

  assert.equal(settled, "");
  assert.match(streaming, /cpa-proxy \/ gpt-5\.6-sol/);
  assert.match(streaming, /class="message-thinking"[^>]*>high/);
  assert.doesNotMatch(streaming, /streaming-dot|aria-label="正在生成"/);
  assert.doesNotMatch(streaming, /Pi 正在工作|message-generated-at|生成于/);
});

test("a running turn can suppress completion time without removing its copy action", () => {
  const html = renderToStaticMarkup(React.createElement(ChatMessage, {
    message: { role: "assistant", content: "partial answer", timestamp: Date.now() },
    showGeneratedAt: false,
  }));
  assert.doesNotMatch(html, /message-generated-at|生成于/);
  assert.match(html, /aria-label="复制整个回答"/);
});
