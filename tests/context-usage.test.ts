import assert from "node:assert/strict";
import test from "node:test";
import { contextUsageTone } from "../src/web/lib/context-usage";

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
