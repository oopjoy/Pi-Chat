import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("compaction reuses the ordinary blue running status", () => {
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.agent-status\s*\{[^}]*display:\s*flex;/s);
  assert.match(css, /\.loader\s*\{[^}]*border-top-color:\s*var\(--accent\);/s);
  assert.doesNotMatch(
    css,
    /\.agent-status\.is-compacting\s*\{/,
    "compaction must not introduce a separate yellow panel",
  );
});
