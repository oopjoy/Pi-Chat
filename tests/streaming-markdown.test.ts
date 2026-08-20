import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBody } from "../src/web/components/MarkdownBody";
import { streamingMarkdownSegments } from "../src/web/lib/streaming-markdown";

test("streaming Markdown freezes completed regions and keeps only one growing tail", () => {
  const markdown = [
    "# Heading",
    "",
    "- first item",
    "- second item",
    "",
    "```ts",
    "const first = 1;",
    "",
    "const second = 2;",
    "```",
    "",
    "Tail **still growing**",
  ].join("\n");
  const segments = streamingMarkdownSegments(markdown);
  assert.deepEqual(segments.stable, [
    "# Heading\n\n",
    "- first item\n- second item\n\n",
    "```ts\nconst first = 1;\n\nconst second = 2;\n```\n\n",
  ]);
  assert.equal(segments.tail, "Tail **still growing**");

  const displayMath = streamingMarkdownSegments([
    "$$",
    String.raw`\frac{1}{2}`,
    "",
    "+ 1",
    "$$",
    "",
    "after",
  ].join("\n"));
  assert.equal(displayMath.stable.length, 1, "blank lines inside display math never split its Markdown region");
  assert.equal(displayMath.tail, "after");
});

test("streaming Markdown renders GFM and KaTeX before the terminal pass", () => {
  const markdown = [
    "# Heading",
    "",
    "| term | value |",
    "| --- | ---: |",
    "| $x$ | **one** |",
    "",
    "$$",
    String.raw`\frac{1}{2}`,
    "$$",
    "",
    "```ts",
    "const value = 1;",
    "```",
  ].join("\n");
  const streaming = renderToStaticMarkup(
    React.createElement(MarkdownBody, { streaming: true }, markdown),
  );
  assert.match(streaming, /class="markdown-body markdown-streaming"/);
  assert.doesNotMatch(streaming, /aria-live=/, "the cumulative body must not be re-announced on every update");
  assert.match(streaming, /<h1>Heading<\/h1>/);
  assert.match(streaming, /<table(?:\s|>)/);
  assert.match(streaming, /class="katex/);
  assert.match(streaming, /<strong>one<\/strong>/);
  assert.match(streaming, /const value = 1/);
  assert.doesNotMatch(streaming, /source-fragment/, "streaming skips only source-range mapping, not Markdown rendering");
});

test("streaming Markdown sanitizes raw HTML and bounds a long active tail", () => {
  const unsafe = renderToStaticMarkup(
    React.createElement(
      MarkdownBody,
      { streaming: true },
      '<script>alert("unsafe")</script>\n\n<img src="x" onerror="alert(1)">',
    ),
  );
  assert.doesNotMatch(unsafe, /<script|onerror=/i);

  const long = `${"word ".repeat(4_000)}\nfinal line`;
  const segments = streamingMarkdownSegments(long);
  assert.ok(segments.stable.length > 0, "a long no-blank response is incrementally committed at a completed line");
  assert.ok(segments.tail.length < 8_192);

  const terminal = renderToStaticMarkup(
    React.createElement(MarkdownBody, null, [
      "| a | b |",
      "| --- | --- |",
      "| $x$ | 1 |",
    ].join("\n")),
  );
  assert.match(terminal, /<table(?:\s|>)/);
  assert.match(terminal, /class="katex/);
  assert.match(terminal, /source-fragment/, "terminal rendering retains canonical source-copy mapping");
});
