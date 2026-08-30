import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { openEditDiffSidebar, OPEN_DIFF_EVENT } from "../src/web/lib/edit-diff-events";

test("edit diff opener publishes the browser-local Changes event", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:30170/" });
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: dom.window });
  try {
    const diff = {
      path: "src/app.ts",
      additions: 2,
      deletions: 1,
      hunks: [{ lines: [{ kind: "add" as const, text: "new line" }] }],
      sensitive: false,
      truncated: false,
    };
    let received: unknown;
    dom.window.addEventListener(OPEN_DIFF_EVENT, (event) => {
      received = (event as CustomEvent).detail;
    });
    openEditDiffSidebar(diff);
    assert.deepEqual(received, diff);
  } finally {
    Object.assign(globalThis, { window: previousWindow });
    dom.window.close();
  }
});
