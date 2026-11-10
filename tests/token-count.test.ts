import assert from "node:assert/strict";
import test from "node:test";
import { parseTokenCount } from "../src/shared/token-count";

test("token counts accept k/m suffixes in either case", () => {
  assert.deepEqual(parseTokenCount("128000"), { ok: true, value: 128_000 });
  assert.deepEqual(parseTokenCount("500k"), { ok: true, value: 500_000 });
  assert.deepEqual(parseTokenCount("500K"), { ok: true, value: 500_000 });
  assert.deepEqual(parseTokenCount("1m"), { ok: true, value: 1_000_000 });
  assert.deepEqual(parseTokenCount("1M"), { ok: true, value: 1_000_000 });
  assert.deepEqual(parseTokenCount(" 1.5m "), { ok: true, value: 1_500_000 });
  assert.deepEqual(parseTokenCount("0.5k"), { ok: true, value: 500 });
});

test("an empty token count clears the optional limit", () => {
  assert.deepEqual(parseTokenCount(""), { ok: true, value: undefined });
  assert.deepEqual(parseTokenCount("   "), { ok: true, value: undefined });
});

test("decimal shorthand rounds instead of tripping on floating point", () => {
  for (const [text, value] of [
    ["4.1m", 4_100_000],
    ["8.3m", 8_300_000],
    ["16.1k", 16_100],
    ["32.3m", 32_300_000],
  ] as const) assert.deepEqual(parseTokenCount(text), { ok: true, value }, text);
});

test("invalid token counts are rejected instead of guessed", () => {
  for (const text of ["1e6", "abc", "500kb", "-1", "0", "0k", "1.2.3", "k", "1 000", "NaN", "+5", "1.5", "0.5"]) {
    assert.deepEqual(parseTokenCount(text), { ok: false }, text);
  }
});

test("the editor hint formats round token counts", () => {
  assert.equal(parseTokenCount("1M").value, 1_000_000);
  assert.equal(parseTokenCount("128k").value, 128_000);
});
