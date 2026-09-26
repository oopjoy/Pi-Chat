import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { MarkdownBody } from "../src/web/components/MarkdownBody";
import { createMarkdownRehypePlugins, createMarkdownRemarkPlugins } from "../src/web/lib/markdown";
import { prepareMarkdownMathPipes } from "../src/web/lib/markdown-math-pipes";
import { normalizeDisplayMathWithSourceMap, selectionInsideSingleCodeBlock, sourceForSelection } from "../src/web/lib/markdown-source-copy";

test("full Markdown keeps math plugins and source-range mapping", () => {
  assert.equal(createMarkdownRemarkPlugins().length, 3);
  assert.equal(createMarkdownRemarkPlugins("\uFDD0").length, 4);
  const finalPlugins = createMarkdownRehypePlugins((offset) => offset);
  assert.equal(finalPlugins.length, 5);
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

test("raw absolute-value pipes inside inline math do not break GFM tables", () => {
  const formula = String.raw`$\min|\psi|$`;
  const markdown = String.raw`| 状态 😀 $t$ | $\min|\psi|$ | raw winding |
|---:|---:|---:|
| 500 | 0.887799 | 0 |
| 1000 | $|0.862694|$ | 0 |`;
  const { dom, root } = renderDom(markdown);
  const table = root.querySelector("table");
  assert.ok(table);
  assert.equal(table.querySelectorAll("th").length, 3);
  assert.equal(table.querySelectorAll("tbody tr").length, 2);
  assert.deepEqual(
    [...table.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("td").length),
    [3, 3],
  );
  const formulaElement = table.querySelectorAll(".katex")[1];
  assert.ok(formulaElement);
  assert.equal(
    formulaElement.querySelector("annotation")?.textContent,
    String.raw`\min|\psi|`,
  );
  assert.equal(sourceForSelection(root, selectContents(dom, formulaElement), markdown), formula);
  assert.equal(sourceForSelection(root, selectContents(dom, table), markdown), markdown);
  assert.doesNotMatch(root.innerHTML, /\uFDD0/);

  const streaming = renderToStaticMarkup(
    React.createElement(MarkdownBody, { streaming: true }, markdown),
  );
  assert.match(streaming, /<table(?:\s|>)/);
  assert.match(streaming, /<annotation encoding="application\/x-tex">\\min\|\\psi\|<\/annotation>/);
  assert.doesNotMatch(streaming, /\uFDD0/);
});

test("escaped and raw math pipes retain distinct KaTeX semantics", () => {
  const markdown = String.raw`kind | formula | note
---|---|---
norm | $\|\psi\|$ | keep
absolute | $|\psi|$ | keep`.replace(/\n/g, "\r\n");
  const { dom, root } = renderDom(markdown);
  const table = root.querySelector("table");
  assert.ok(table);
  assert.equal(table.querySelectorAll("th").length, 3);
  assert.deepEqual(
    [...table.querySelectorAll("annotation")].map((node) => node.textContent),
    [String.raw`\|\psi\|`, String.raw`|\psi|`],
  );
  assert.equal(table.querySelectorAll(".katex-error").length, 0);
  assert.equal(sourceForSelection(root, selectContents(dom, table), markdown), markdown);
});

test("a table body row whose only pipes are math remains one logical cell", () => {
  const markdown = String.raw`left | right
---|---
$|x|$`;
  const { root } = renderDom(markdown);
  const table = root.querySelector("table");
  assert.ok(table);
  assert.equal(table.querySelectorAll("th").length, 2);
  assert.equal(table.querySelectorAll("tbody tr").length, 1);
  assert.equal(table.querySelectorAll("tbody td").length, 2);
  assert.equal(table.querySelector("annotation")?.textContent, "|x|");

  const streaming = renderToStaticMarkup(
    React.createElement(MarkdownBody, { streaming: true }, markdown),
  );
  assert.match(streaming, /<table(?:\s|>)/);
  assert.match(streaming, /<annotation encoding="application\/x-tex">\|x\|<\/annotation>/);
});

test("pipe protection follows remark-math delimiter and escape behavior", () => {
  const repeatedDelimiter = String.raw`a | formula | z
---|---|---
1 | $$x|y$$ | 3`;
  const repeatedRoot = renderDom(repeatedDelimiter).root;
  assert.equal(repeatedRoot.querySelectorAll("th").length, 3);
  assert.equal(repeatedRoot.querySelector("annotation")?.textContent, "x|y");

  const escapedClose = String.raw`a | formula | y | z
---|---|---|---
1 | $x\$ | y$ | 3`;
  const escapedRoot = renderDom(escapedClose).root;
  assert.equal(escapedRoot.querySelectorAll("th").length, 4);
  assert.equal(escapedRoot.querySelectorAll("tbody td").length, 4);
});

test("one render chooses a collision-free marker and never rewrites source text", () => {
  const originalMarker = "\uFDD0";
  const markdown = `symbol | formula\n---|---\n${originalMarker} | $|x|$`;
  const prepared = prepareMarkdownMathPipes(markdown);
  assert.notEqual(prepared.tableMathPipeMarker, originalMarker);
  assert.ok(prepared.markdown.includes(originalMarker));

  const { dom, root } = renderDom(markdown);
  const table = root.querySelector("table");
  assert.ok(table);
  assert.match(root.textContent || "", new RegExp(originalMarker));
  assert.equal(table.querySelector("annotation")?.textContent, "|x|");
  assert.equal(sourceForSelection(root, selectContents(dom, table), markdown), markdown);

  const exhaustedMarkers = Array.from(
    { length: 0xfdef - 0xfdd0 + 1 },
    (_, index) => String.fromCharCode(0xfdd0 + index),
  ).join("");
  const unsupported = `${exhaustedMarkers} $|x|$`;
  assert.deepEqual(prepareMarkdownMathPipes(unsupported), { markdown: unsupported });
});

test("a GFM bare URL restores protected pipes in both link text and href", () => {
  const markdown = "https://example.com/$x|y$";
  const { dom, root } = renderDom(markdown);
  const link = root.querySelector("a");
  assert.ok(link);
  assert.equal(link.textContent, markdown);
  assert.equal(decodeURIComponent(link.getAttribute("href") || ""), markdown);
  assert.equal(sourceForSelection(root, selectContents(dom, link), markdown), markdown);

  const streaming = renderToStaticMarkup(
    React.createElement(MarkdownBody, { streaming: true }, markdown),
  );
  assert.match(streaming, /href="https:\/\/example\.com\/\$x%7Cy\$"/);
  assert.doesNotMatch(streaming, /%EF%B7/);

  const tableMarkdown = `link | note\n---|---\n${markdown} | keep`;
  const tableLink = renderDom(tableMarkdown).root.querySelector("table a");
  assert.ok(tableLink);
  assert.equal(decodeURIComponent(tableLink.getAttribute("href") || ""), markdown);
});

test("table math protection leaves fenced and inline code literal", () => {
  const markdown = [
    "before `$x|y$` after",
    "",
    "```text",
    "| $x|y$ | 1 |",
    "```",
  ].join("\n");
  const { root } = renderDom(markdown);
  assert.equal(root.querySelector(".inline-code")?.textContent, "$x|y$");
  assert.match(root.querySelector(".code-block")?.textContent || "", /\| \$x\|y\$ \| 1 \|/);
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
