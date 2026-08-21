import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBody } from "../src/web/components/MarkdownBody";
import { advanceStreamingMarkdown, streamingMarkdownSegments } from "../src/web/lib/streaming-markdown";

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

test("append-only streaming rescans only the mutable tail and resets on corrections", () => {
  let state = advanceStreamingMarkdown(undefined, "# Stable\n\nTail");
  assert.deepEqual(state.stable, ["# Stable\n\n"]);
  assert.equal(state.tail, "Tail");
  assert.equal(state.scannedCharacters, 14);

  state = advanceStreamingMarkdown(
    state,
    "# Stable\n\nTail grows",
    { sequence: 1, append: " grows" },
  );
  assert.deepEqual(state.stable, ["# Stable\n\n"]);
  assert.equal(state.tail, "Tail grows");
  assert.equal(state.scannedCharacters, "Tail grows".length, "the immutable prefix is not scanned again");
  assert.deepEqual(
    { stable: state.stable, tail: state.tail },
    streamingMarkdownSegments(state.source),
    "incremental append produces the same segmentation as a full scan",
  );

  const corrected = advanceStreamingMarkdown(
    state,
    "# Corrected\n\nReplacement",
    { sequence: 2, append: " impossible" },
  );
  assert.equal(corrected.scannedCharacters, corrected.source.length, "a non-prefix provider correction falls back to a full scan");
  assert.deepEqual(
    { stable: corrected.stable, tail: corrected.tail },
    streamingMarkdownSegments(corrected.source),
  );
});

test("incremental Markdown retains open fences and display math in the mutable tail", () => {
  let state = advanceStreamingMarkdown(undefined, "before\n\n```ts\nconst a = 1;");
  assert.deepEqual(state.stable, ["before\n\n"]);
  assert.match(state.tail, /^```ts/);

  state = advanceStreamingMarkdown(state, "before\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nafter");
  assert.deepEqual(state.stable, [
    "before\n\n",
    "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n",
  ]);
  assert.equal(state.tail, "after");

  let math = advanceStreamingMarkdown(undefined, "$$\n\\frac{1}{2}");
  math = advanceStreamingMarkdown(math, "$$\n\\frac{1}{2}\n\n+ 1\n$$\n\nafter");
  assert.deepEqual(math.stable, ["$$\n\\frac{1}{2}\n\n+ 1\n$$\n\n"]);
  assert.equal(math.tail, "after");
});

test("incremental segmentation matches a full scan at every chunk boundary", () => {
  const fixtures = [
    "# Heading\n\nparagraph\n\n> quote\n> continued\n\nend",
    "Setext heading\n---\n\n- one\n- two\n\n[id]: https://example.com\n",
    "```typescript\nconst value = `tick`;\n```\n\nafter",
    "$$\n\\frac{1}{2}\n$$\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
    "<div>\nhtml block\n</div>\n\nafter",
  ];
  for (const fixture of fixtures) {
    let state: ReturnType<typeof advanceStreamingMarkdown> | undefined;
    for (let length = 1; length <= fixture.length; length += 1) {
      const prefix = fixture.slice(0, length);
      state = advanceStreamingMarkdown(state, prefix);
      assert.deepEqual(
        { stable: state.stable, tail: state.tail },
        streamingMarkdownSegments(prefix),
        `segmentation diverged at prefix ${length} of ${JSON.stringify(fixture)}`,
      );
    }
  }

  const oversized = `${"word ".repeat(2_000)}tail`;
  let state = advanceStreamingMarkdown(undefined, oversized.slice(0, 8_100));
  state = advanceStreamingMarkdown(state, oversized);
  assert.deepEqual(
    { stable: state.stable, tail: state.tail },
    streamingMarkdownSegments(oversized),
  );
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
