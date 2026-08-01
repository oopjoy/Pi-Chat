import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { assistantCopyText, assistantModelLabel, assistantThinkingLabel, ChatMessage, shouldFoldUserText, USER_MESSAGE_FOLD_LINE_LIMIT } from "../src/web/components/ChatMessage";

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

test("image preview sizing stays within the padded dynamic viewport", async () => {
  const styles = await readFile(new URL("../src/web/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.image-preview-dialog\s*\{[^}]*max-height:\s*calc\(100dvh - 48px\)/);
  assert.match(styles, /\.image-preview-full\s*\{[^}]*max-width:\s*min\(calc\(96vw - 26px\), 1414px\)[^}]*max-height:\s*calc\(100dvh - 102px\)/);
});

test("system notices reserve flow space four pixels above the Composer and wrap within eighty percent of chat", async () => {
  const styles = await readFile(new URL("../src/web/styles.css", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/web/App.tsx", import.meta.url), "utf8");
  const input = await readFile(new URL("../src/web/components/ChatInput.tsx", import.meta.url), "utf8");
  assert.match(styles, /\.composer-wrap\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*align-items:\s*center[^}]*gap:\s*4px/);
  assert.match(styles, /\.system-notice-stack\s*\{[^}]*display:\s*flex[^}]*width:\s*max-content[^}]*max-width:\s*80%[^}]*align-items:\s*center/);
  assert.doesNotMatch(styles, /\.system-notice-stack\s*\{[^}]*position:\s*absolute/);
  assert.match(styles, /\.system-notice-stack:empty\s*\{\s*display:\s*none/);
  assert.match(styles, /\.system-notice-stack > \*\s*\{[^}]*width:\s*fit-content[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*pre-wrap/);
  assert.match(input, /notices\?: ReactNode/);
  assert.match(input, /className="system-notice-stack"[\s\S]*\{notices\}/);
  assert.match(app, /notices=\{[\s\S]*primary-runtime-status[\s\S]*app-toast/);
  assert.doesNotMatch(app, /<ChatInput[\s\S]*\/>\s*\{\(error \|\| notice\) && <div className=\{`app-toast/);
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

  const styles = await readFile(new URL("../src/web/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.message-image\s*\{[^}]*max-width:\s*min\(320px, 100%\)[^}]*max-height:\s*320px/);
  assert.match(styles, /\.message-user-attachments \.message-image\s*\{[^}]*max-width:\s*min\(160px, 100%\)[^}]*max-height:\s*120px/);
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
