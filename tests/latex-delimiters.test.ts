import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { MarkdownBody } from "../src/web/components/MarkdownBody";
import { normalizeDisplayMathWithSourceMap, sourceForSelection } from "../src/web/lib/markdown-source-copy";
import { advanceStreamingMarkdown, streamingMarkdownSegments } from "../src/web/lib/streaming-markdown";

function render(source: string, streaming = false) {
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, { streaming }, source));
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const root = dom.window.document.querySelector<HTMLElement>(".markdown-body")!;
  return { dom, root };
}

const example = String.raw`序参量 \(\psi\) 与空间 \(H^1\)。

\[
E_{\mathrm{GB}}(\psi)
=
\frac{\beta}{2}\int_\Sigma |\psi|^2\,ds.
\]

## 下一节

\[ \boxed{\varepsilon(1-\alpha)\longrightarrow\beta} \]`;

function copyNode(dom: JSDOM, root: HTMLElement, node: Node, source: string) {
  const saved = ["Node", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, { Node: dom.window.Node, document: dom.window.document });
  try {
    const range = dom.window.document.createRange();
    range.selectNodeContents(node);
    const selection = dom.window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    return sourceForSelection(root, selection, source);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("backslash math copies its exact delimiters and backslashes with CRLF and emoji offsets", () => {
  for (const formula of [String.raw`\(\widehat{\psi}+\alpha\)`, String.raw`\[ \frac{1}{2} \]`, "\\[\r\n\\begin{aligned}\r\nx &= 1 \\\\\r\ny &= 2\r\n\\end{aligned}\r\n\\]"]) {
    const source = `前缀 😀\r\n\r\n${formula}\r\n\r\n后缀 $x$`;
    const { dom, root } = render(source);
    try {
      const math = root.querySelector(".katex")!;
      assert.ok(math);
      assert.equal(copyNode(dom, root, math, source), formula);
      const mapped = normalizeDisplayMathWithSourceMap(source);
      assert.equal(mapped.source, source);
      let previous = 0;
      for (let i = 0; i <= mapped.markdown.length; i++) {
        const offset = mapped.mapOffset(i);
        assert.ok(offset >= previous && offset <= source.length);
        previous = offset;
      }
      assert.equal(previous, source.length);
    } finally { dom.window.close(); }
  }
});

test("LaTeX delimiter support leaves code, URLs, HTML attributes and escaped delimiters literal", () => {
  const fixtures = [
    "code `" + String.raw`\(x\)` + "`",
    ["````text", String.raw`\[ \frac{1}{2} \]`, "```", "````"].join("\n"),
    ["> ```text", String.raw`> \(x\)`, "> ```"].join("\n"),
    String.raw`    \[ x \]`,
    String.raw`[link](https://example.com/\(x\))`,
    String.raw`[ref]: https://example.com/\(x\)`,
    String.raw`https://example.com/\(x\)`,
    String.raw`C:\(folder\)`,
    String.raw`<img title="\(x\)" src="safe.png">`,
    String.raw`<code>\(x\)</code>`,
    String.raw`\\(literal\\) and \\[literal\\]`,
    String.raw`$\text{\(literal\)}$`,
  ];
  for (const source of fixtures) {
    const mapped = normalizeDisplayMathWithSourceMap(source);
    assert.equal(mapped.markdown, source, source);
  }
  for (const source of fixtures.slice(0, -1)) {
    const { dom, root } = render(source);
    try { assert.equal(root.querySelectorAll(".katex").length, 0, source); }
    finally { dom.window.close(); }
  }
});

test("inline backslash formulas with raw pipes keep table columns and original source-copy", () => {
  const source = String.raw`| formula | note |
|---|---|
| \(\min|\psi|\) | keep |
| \(\|\psi\|\) | norm |`;
  for (const streaming of [false, true]) {
    const { dom, root } = render(source, streaming);
    try {
      const table = root.querySelector("table")!;
      assert.equal(table.querySelectorAll("th").length, 2);
      assert.equal(table.querySelectorAll("td").length, 4);
      assert.deepEqual([...table.querySelectorAll("annotation")].map(node => node.textContent), [String.raw`\min|\psi|`, String.raw`\|\psi\|`]);
      if (!streaming) {
        assert.equal(copyNode(dom, root, table, source), source);
        assert.equal(copyNode(dom, root, table.querySelector(".katex")!, source), String.raw`\(\min|\psi|\)`);
      }
    } finally { dom.window.close(); }
  }
});

test("TeX currency, row breaks and ordinary dollar math keep distinct semantics", () => {
  const source = String.raw`\(\text{\$5}+x\)

$y$ and \(z\)

$$ \frac{1}{2} $$

\[
\begin{aligned}
a &= b \\
c &= d
\end{aligned}
\]`;
  for (const streaming of [false, true]) {
    const { dom, root } = render(source, streaming);
    try {
      assert.equal(root.querySelectorAll(".katex").length, 5);
      assert.equal(root.querySelectorAll(".katex-display").length, 2);
      assert.equal(root.querySelectorAll(".katex-error").length, 0);
      assert.equal(root.querySelector("annotation")?.textContent, String.raw`\text{\$5}+x`);
    } finally { dom.window.close(); }
  }
});

test("display backslash math supports quotes, lists and prose on the same line", () => {
  const fixtures = [
    String.raw`> \[ x^2 \]`,
    String.raw`- \[ x^2 \]`,
    String.raw`before \[ x^2 \] after`,
    "> \\[\n> x^2\n> \\]",
    "- \\[\n  x^2\n  \\]",
  ];
  for (const source of fixtures) {
    const { dom, root } = render(source);
    try {
      assert.equal(root.querySelectorAll(".katex-display").length, 1, source);
      assert.equal(root.querySelectorAll(".katex-error").length, 0, source);
    } finally { dom.window.close(); }
  }
});

test("adjacent inline formulas do not fuse dollar delimiters or change source copy", () => {
  for (const source of [String.raw`\(x\)\(y\)`, String.raw`$x$\(y\)`, String.raw`\(x\)$y$`]) {
    for (const streaming of [false, true]) {
      const { dom, root } = render(source, streaming);
      try {
        assert.deepEqual([...root.querySelectorAll("annotation")].map(node => node.textContent), ["x", "y"]);
        assert.equal(root.querySelectorAll(".katex-error").length, 0);
        if (!streaming) {
          const first = root.querySelectorAll(".katex")[0];
          const second = root.querySelectorAll(".katex")[1];
          assert.equal(copyNode(dom, root, first, source), source.startsWith("$") ? "$x$" : String.raw`\(x\)`);
          assert.equal(copyNode(dom, root, second, source), source.endsWith("$") ? "$y$" : String.raw`\(y\)`);
        }
      } finally { dom.window.close(); }
    }
  }
});

test("dollar display normalization and LaTeX conversion compose source maps", () => {
  const source = String.raw`$$   \frac{1}{2}   $$

😀 \(\psi\) after

\[\beta\]`;
  const { dom, root } = render(source);
  try {
    const math = root.querySelectorAll(".katex");
    assert.equal(math.length, 3);
    assert.equal(copyNode(dom, root, math[0], source), String.raw`$$   \frac{1}{2}   $$`);
    assert.equal(copyNode(dom, root, math[1], source), String.raw`\(\psi\)`);
    assert.equal(copyNode(dom, root, math[2], source), String.raw`\[\beta\]`);
  } finally { dom.window.close(); }
});

test("streaming retains blank lines inside backslash display math until the pair is complete", () => {
  const source = String.raw`before

\[
x^2

+ y^2
\]

after`;
  const segments = streamingMarkdownSegments(source);
  assert.deepEqual(segments.stable, ["before\n\n", "\\[\nx^2\n\n+ y^2\n\\]\n\n"]);
  assert.equal(segments.tail, "after");
  let previous: ReturnType<typeof advanceStreamingMarkdown> | undefined;
  for (let end = 1; end <= source.length; end++) {
    const prefix = source.slice(0, end);
    previous = advanceStreamingMarkdown(previous, prefix, { sequence: end, append: source[end - 1] });
    assert.deepEqual({ stable: previous.stable, tail: previous.tail }, streamingMarkdownSegments(prefix), `prefix ${end}`);
  }
  const { dom, root } = render(source, true);
  try { assert.equal(root.querySelectorAll(".katex-display").length, 1); }
  finally { dom.window.close(); }
});

test("the streaming tail size cap cannot split a long backslash formula", () => {
  for (const display of [false, true]) {
    const formula = (display ? "\\[" : "\\(") + "x + ".repeat(2500) + "0" + (display ? "\\]" : "\\)");
    const prefix = formula.slice(0, 9000);
    const pending = advanceStreamingMarkdown(undefined, prefix);
    assert.deepEqual(pending.stable, []);
    assert.equal(pending.tail, prefix);
    const completed = advanceStreamingMarkdown(pending, formula + "\n\nafter");
    assert.equal(completed.stable[0].slice(0, formula.length), formula, "the formula stays wholly within one segment");
    assert.equal(completed.stable.join(""), formula + "\n\n");
    assert.deepEqual({ stable: completed.stable, tail: completed.tail }, streamingMarkdownSegments(formula + "\n\nafter"));
    assert.equal(completed.tail, "after");
  }
});

test("unclosed or mismatched LaTeX delimiters do not swallow later headings or code", () => {
  const source = String.raw`\[
x^2

## Next

\(y\]

\(z\)

` + "```text\n\\[x\\]\n```";
  for (const streaming of [false, true]) {
    const { dom, root } = render(source, streaming);
    try {
      assert.equal(root.querySelector("h2")?.textContent, "Next");
      assert.equal(root.querySelectorAll(".katex").length, 1);
      assert.equal(root.querySelector("annotation")?.textContent, "z");
      assert.match(root.querySelector(".code-block")?.textContent || "", /\\\[x\\\]/);
    } finally { dom.window.close(); }
  }
});

test("backslash-delimited formulas render as KaTeX rather than Markdown headings", () => {
  for (const streaming of [false, true]) {
    const { dom, root } = render(example, streaming);
    try {
      assert.equal(root.querySelectorAll(".katex").length, 4);
      assert.equal(root.querySelectorAll(".katex-display").length, 2);
      assert.equal(root.querySelectorAll(".katex-error").length, 0);
      assert.deepEqual([...root.querySelectorAll("h1, h2")].map(node => node.textContent), ["下一节"]);
      assert.ok([...root.querySelectorAll("annotation")].some(node => node.textContent?.includes(String.raw`\frac{\beta}{2}`)));
    } finally { dom.window.close(); }
  }
});
