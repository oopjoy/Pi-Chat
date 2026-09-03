import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { MarkdownBody } from "../src/web/components/MarkdownBody";
import { createMarkdownRehypePlugins, markdownRemarkPlugins } from "../src/web/lib/markdown";
import { normalizeDisplayMathWithSourceMap, selectionInsideSingleCodeBlock, sourceForSelection } from "../src/web/lib/markdown-source-copy";

test("full Markdown keeps math plugins and source-range mapping", () => {
  assert.equal(markdownRemarkPlugins.length, 3);
  const finalPlugins = createMarkdownRehypePlugins((offset) => offset);
  assert.equal(finalPlugins.length, 4);
});

function renderDom(markdown: string) {
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, markdown));
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  Object.assign(globalThis, {
    Node: dom.window.Node,
    document: dom.window.document,
  });
  const root = dom.window.document.querySelector<HTMLElement>(".markdown-body");
  assert.ok(root);
  return { dom, root };
}

function selectContents(dom: JSDOM, node: Node) {
  const range = dom.window.document.createRange();
  range.selectNodeContents(node);
  const selection = dom.window.getSelection();
  assert.ok(selection);
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

test("adjacent CJK prose after strong text ending in punctuation still renders bold", () => {
  const markdown = "**理由：**在中间插入精确外推值 $x$。";
  const final = renderDom(markdown).root.querySelector("strong");
  assert.equal(final?.textContent, "理由：");
  const streamingHtml = renderToStaticMarkup(React.createElement(MarkdownBody, { streaming: true }, markdown));
  assert.match(streamingHtml, /<strong>理由：<\/strong>在中间/);
});

test("rendered inline KaTeX maps back to exact LaTeX", () => {
  const formula = String.raw`$\widehat{A_h^n}$`;
  const markdown = `before ${formula} after`;
  const { dom, root } = renderDom(markdown);
  const katex = root.querySelector(".katex");
  assert.ok(katex);
  assert.equal(sourceForSelection(root, selectContents(dom, katex), markdown), formula);
});

test("one-line display math keeps exact original source", () => {
  const formula = String.raw`$$ \frac{1}{2} $$`;
  const markdown = `before\n\n${formula}\n\nafter`;
  const { dom, root } = renderDom(markdown);
  const katex = root.querySelector(".katex-display");
  assert.ok(katex);
  assert.equal(sourceForSelection(root, selectContents(dom, katex), markdown), formula);
});

test("display normalization maps boundaries to untouched Markdown", () => {
  const source = String.raw`x

$$   \frac{1}{2}   $$

y`;
  const mapped = normalizeDisplayMathWithSourceMap(source);
  const start = mapped.markdown.indexOf("$$");
  const end = mapped.markdown.indexOf("$$", start + 2) + 2;
  assert.equal(source.slice(mapped.mapOffset(start), mapped.mapOffset(end)), String.raw`$$   \frac{1}{2}   $$`);
});

test("a mismatched display-math close is isolated without swallowing following Markdown", () => {
  const markdown = String.raw`intro

$$
\eta^2>4\mu\lambda,
\]

## 临界阻尼

后面的正文继续正常渲染。

$$
|r_{\mathrm{slow}}|
$$`;
  const { dom, root } = renderDom(markdown);
  assert.equal(root.querySelectorAll(".katex-display").length, 2);
  assert.equal(root.querySelector("h2")?.textContent, "临界阻尼");
  assert.match(root.textContent || "", /后面的正文继续正常渲染/);
  const math = root.querySelector(".katex-display");
  assert.ok(math);
  assert.equal(sourceForSelection(root, selectContents(dom, math), markdown), String.raw`$$
\eta^2>4\mu\lambda,
\]`);
});

test("display-math recovery ignores matching delimiters inside fenced code", () => {
  const markdown = [
    "```text",
    "$$",
    String.raw`\eta^2>4\mu\lambda,`,
    String.raw`\]`,
    "```",
    "",
    "## 后续标题",
  ].join("\n");
  const { root } = renderDom(markdown);
  assert.equal(root.querySelector("h2")?.textContent, "后续标题");
  assert.equal(root.querySelectorAll(".katex-display").length, 0);
  assert.match(root.textContent || "", /\\eta\^2>4\\mu\\lambda/);
});

test("an unclosed display-math block stops before a following code fence", () => {
  const markdown = [
    "$$",
    String.raw`\eta^2>4\mu\lambda,`,
    "```text",
    "$$",
    String.raw`\eta^2>4\mu\lambda,`,
    String.raw`\]`,
    "```",
    "",
    "## 后续标题",
  ].join("\n");
  const { root } = renderDom(markdown);
  assert.equal(root.querySelector("h2")?.textContent, "后续标题");
  assert.equal(root.querySelectorAll(".katex-display").length, 1);
  assert.match(root.textContent || "", /\\eta\^2>4\\mu\\lambda/);
});

test("an unclosed display-math block stops before a following Markdown heading", () => {
  const markdown = String.raw`$$
\eta^2>4\mu\lambda,

## 临界阻尼

正文不会被前面的公式吞掉。`;
  const { root } = renderDom(markdown);
  assert.equal(root.querySelector("h2")?.textContent, "临界阻尼");
  assert.match(root.textContent || "", /正文不会被前面的公式吞掉/);
});

test("streaming Markdown applies the same display-math isolation", () => {
  const markdown = String.raw`$$
\eta^2>4\mu\lambda,
\]

## 临界阻尼

流式后文仍然可见。`;
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, { streaming: true }, markdown));
  assert.match(html, /<h2>临界阻尼<\/h2>/);
  assert.match(html, /流式后文仍然可见/);
});

test("selecting a line inside a fenced code block does not expand to the whole fence", () => {
  const markdown = "intro\n\n```powershell\nWrite-Host one\nWrite-Host two\n```\n\noutro";
  const { dom, root } = renderDom(markdown);
  const code = root.querySelector(".code-block pre code");
  assert.ok(code);
  const text = code.firstChild;
  assert.ok(text && text.nodeType === dom.window.Node.TEXT_NODE);

  // Paint only the first command line (plain text), not the atomic ``` wrapper.
  const line = "Write-Host one";
  const full = text.textContent || "";
  const lineStart = full.indexOf(line);
  assert.ok(lineStart >= 0);
  const range = dom.window.document.createRange();
  range.setStart(text, lineStart);
  range.setEnd(text, lineStart + line.length);
  const selection = dom.window.getSelection();
  assert.ok(selection);
  selection.removeAllRanges();
  selection.addRange(range);

  assert.equal(selectionInsideSingleCodeBlock(root, range), true);
  assert.equal(sourceForSelection(root, selection, markdown), null);

  // Selecting the whole code pre still stays plain (corner button owns full-block copy).
  const pre = root.querySelector(".code-block pre");
  assert.ok(pre);
  assert.equal(sourceForSelection(root, selectContents(dom, pre), markdown), null);
});
