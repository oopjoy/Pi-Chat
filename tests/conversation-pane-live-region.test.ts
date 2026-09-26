import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/web/components/ConversationPane.tsx", import.meta.url),
  "utf8",
);

test("meaningful waiting, compaction, and tool states use polite atomic live regions", () => {
  assert.match(
    source,
    /className="agent-status is-waiting" role="status" aria-live="polite" aria-atomic="true"/,
  );
  assert.match(
    source,
    /className="agent-status is-compacting" role="status" aria-live="polite" aria-atomic="true"/,
  );
  assert.match(
    source,
    /state\.isStreaming && !state\.isCompacting && toolStatus && <div className="agent-status" role="status" aria-live="polite" aria-atomic="true">/,
  );
  assert.equal(
    (source.match(/aria-live="polite"/g) || []).length >= 4,
    true,
    "existing pane-loading announcement remains intact",
  );
});
