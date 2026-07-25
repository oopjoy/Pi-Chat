import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { MarkdownBody } from "../src/web/components/MarkdownBody";
import { createMarkdownRehypePlugins, markdownRemarkPlugins } from "../src/web/lib/markdown";
import { normalizeDisplayMathForRender, normalizeDisplayMathWithSourceMap, selectionInsideSingleCodeBlock, sourceForSelection } from "../src/web/lib/markdown-source-copy";

test("streaming Markdown keeps math plugins while skipping source-range mapping", () => {
  assert.equal(markdownRemarkPlugins.length, 3);
  const streamingPlugins = createMarkdownRehypePlugins();
  const finalPlugins = createMarkdownRehypePlugins((offset) => offset);
  assert.equal(streamingPlugins.length, 3);
  assert.equal(finalPlugins.length, 4);
});

test("streaming display-math normalization matches the final mapped Markdown", () => {
  const source = "before\n$$x + y$$\nafter";
  assert.equal(normalizeDisplayMathForRender(source), normalizeDisplayMathWithSourceMap(source).markdown);
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
