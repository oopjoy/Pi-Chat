import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBody } from "../src/web/components/MarkdownBody";
import { streamingMarkdownBlocks } from "../src/web/lib/streaming-markdown";

test("streaming Markdown keeps stable line-oriented blocks without full Markdown transforms", () => {
  const markdown = [
    "# Heading",
    "",
    "- first **bold** item",
    "- second item",
    "",
    "> quoted **text**",
    "",
    "| table | waits |",
    "| --- | --- |",
    "| $x$ | final pass |",
    "",
    "```ts",
    "const value = $x$;",
  ].join("\n");
  const blocks = streamingMarkdownBlocks(markdown);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["heading", "list", "quote", "paragraph", "code"],
  );
  assert.equal(blocks.at(-1)?.kind, "code");
  if (blocks.at(-1)?.kind === "code")
    assert.equal(blocks.at(-1)?.text, "const value = $x$;", "an unfinished fence remains readable code");

  const html = renderToStaticMarkup(
    React.createElement(MarkdownBody, { streaming: true }, markdown),
  );
  assert.match(html, /class="markdown-body markdown-streaming"/);
  assert.doesNotMatch(html, /aria-live=/, "the streaming body must not repeat the full cumulative reply to assistive technology");
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<blockquote>quoted <strong>text<\/strong><\/blockquote>/);
  assert.match(html, /\| table \| waits \|/);
  assert.match(html, /\$x\$/, "unsettled math stays literal during streaming");
  assert.doesNotMatch(html, /katex|<table|source-fragment/);

  const unsafeLanguage = streamingMarkdownBlocks("```<img src=x onerror=alert(1)>\ntext");
  assert.equal(unsafeLanguage.at(0)?.kind, "code");
  if (unsafeLanguage.at(0)?.kind === "code")
    assert.equal(unsafeLanguage.at(0)?.language, "text", "untrusted fence info never becomes an HTML/CSS selector");
});

test("terminal Markdown restores full table, KaTeX, and source-copy rendering", () => {
  const markdown = [
    "# Heading",
    "",
    "| term | value |",
    "| --- | ---: |",
    "| $x$ | 1 |",
    "",
    "$$",
    String.raw`\frac{1}{2}`,
    "$$",
  ].join("\n");
  const streaming = renderToStaticMarkup(
    React.createElement(MarkdownBody, { streaming: true }, markdown),
  );
  const terminal = renderToStaticMarkup(
    React.createElement(MarkdownBody, null, markdown),
  );
  assert.doesNotMatch(streaming, /<table|katex|source-fragment/);
  assert.match(terminal, /<table(?:\s|>)/);
  assert.match(terminal, /class="katex/);
  assert.match(terminal, /source-fragment/);
});

test("long cumulative streaming Markdown stays on the lightweight path until terminal rendering", () => {
  const chunks = Array.from({ length: 120 }, (_, index) => [
    `## Snapshot ${index + 1}`,
    "",
    `- item **${index + 1}**`,
    "",
    "| a | b |",
    "| --- | --- |",
    `| $x_${index + 1}$ | ${index + 1} |`,
    "",
    "```ts",
    `const value${index + 1} = ${index + 1};`,
    "```",
  ].join("\n"));
  let cumulative = "";
  for (const chunk of chunks) {
    cumulative += `\n\n${chunk}`;
    const html = renderToStaticMarkup(
      React.createElement(MarkdownBody, { streaming: true }, cumulative),
    );
    assert.doesNotMatch(html, /katex|<table|source-fragment/);
  }
  const terminal = renderToStaticMarkup(
    React.createElement(MarkdownBody, null, cumulative),
  );
  assert.match(terminal, /<table(?:\s|>)/);
  assert.match(terminal, /class="katex/);
  assert.match(terminal, /const value120 = 120/);
});
