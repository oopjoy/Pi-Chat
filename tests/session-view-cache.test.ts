import assert from "node:assert/strict";
import test from "node:test";
import type { SessionViewData } from "../src/shared/types";
import { SessionViewCache } from "../src/web/lib/session-view-cache";

function view(id: string): SessionViewData {
  return {
    session: { id, sessionId: id, name: id, preview: "", cwd: "C:/", updatedAt: 1, messageCount: 1, active: false },
    state: { model: null, isStreaming: false },
    messages: [],
    messageTotal: 0,
    messagesTruncated: false,
    isActive: false,
  };
}

test("SessionViewCache refreshes recency and evicts the oldest view", () => {
  let now = 0;
  const cache = new SessionViewCache(2, () => ++now);
  cache.remember(view("one"));
  cache.remember(view("two"));
  cache.remember(view("one"));
  cache.remember(view("three"));
  assert.equal(cache.get("one")?.cachedAt, 3);
  assert.equal(cache.get("two"), undefined);
  assert.equal(cache.get("three")?.session.id, "three");
  cache.forget("one");
  assert.equal(cache.get("one"), undefined);
});
