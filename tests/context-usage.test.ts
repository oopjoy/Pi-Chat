import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cacheHitRatePercent, contextUsageTone } from "../src/web/lib/context-usage";
import { ComposerControls } from "../src/web/components/ComposerControls";

test("context usage colors are green below 60, yellow from 60, red from 90", () => {
  assert.equal(contextUsageTone(0), "normal");
  assert.equal(contextUsageTone(59.999), "normal");
  assert.equal(contextUsageTone(60), "warning");
  assert.equal(contextUsageTone(89.999), "warning");
  assert.equal(contextUsageTone(90), "critical");
  assert.equal(contextUsageTone(100), "critical");
});

test("active Pi compaction is always red and missing data is muted", () => {
  assert.equal(contextUsageTone(22, true), "critical");
  assert.equal(contextUsageTone(null), "unavailable");
  assert.equal(contextUsageTone(undefined), "unavailable");
});

test("cache hit rate is cacheRead over prompt-side tokens", () => {
  assert.equal(cacheHitRatePercent(undefined), null);
  assert.equal(cacheHitRatePercent({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(cacheHitRatePercent({ input: 100, cacheRead: 300, cacheWrite: 0 }), 75);
  assert.equal(cacheHitRatePercent({ input: 100, cacheRead: 300, cacheWrite: 100 }), 60);
  assert.equal(cacheHitRatePercent({ input: 0, cacheRead: 50, cacheWrite: 0 }), 100);
});

test("usage hover lists cache hit rate under cache read", () => {
  const html = renderToStaticMarkup(createElement(ComposerControls, {
    state: { model: null, isStreaming: false },
    models: [],
    disabled: false,
    gateAvailable: false,
    onGate: () => undefined,
    onModel: () => undefined,
    onThinking: () => undefined,
    stats: {
      tokens: { input: 100, output: 10, cacheRead: 300, cacheWrite: 0, total: 410 },
      contextUsage: { tokens: 400, contextWindow: 1_000, percent: 40 },
    },
  }));
  assert.match(html, /缓存读取<\/dt><dd>300<\/dd>/);
  assert.match(html, /缓存读取<\/dt><dd>300<\/dd><\/div><div><dt>缓存命中率<\/dt><dd>75%<\/dd>/);
});
