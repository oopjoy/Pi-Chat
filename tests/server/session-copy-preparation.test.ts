import assert from "node:assert/strict";
import test from "node:test";
import { validateSessionCopyPreparation } from "../../src/server/services/session-copy-preparation";

test("copy preparation rejects unsafe source states", () => {
  assert.throws(() => validateSessionCopyPreparation({
    mode: "clone", sourcePath: "C:\\source.jsonl", summary: { name: "Source" },
    draft: true, primary: false, primaryBusy: false, secondaryBusy: false, forkTargetAvailable: false,
  }), /空白/);
  assert.throws(() => validateSessionCopyPreparation({
    mode: "fork", sourcePath: "C:\\source.jsonl", summary: { name: "Source" },
    draft: false, primary: false, primaryBusy: false, secondaryBusy: false, forkTargetAvailable: false,
  }), /当前分支/);
});

test("copy preparation accepts an idle verified source", () => {
  assert.doesNotThrow(() => validateSessionCopyPreparation({
    mode: "clone", sourcePath: "C:\\source.jsonl", summary: { name: "Source" },
    draft: false, primary: false, primaryBusy: false, secondaryBusy: false, forkTargetAvailable: false,
  }));
});
