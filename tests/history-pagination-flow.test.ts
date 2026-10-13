import assert from "node:assert/strict";
import test from "node:test";
import { SessionViewCacheWriter } from "../src/web/application/session-view-cache-writer";
import { SessionViewCache } from "../src/web/lib/session-view-cache";
import type { SessionHistoryPage, SessionViewData } from "../src/shared/types";
import { createSessionViewFixture } from "./fixtures/app-bootstrap";
import { installAppDom } from "./helpers/app-dom";

function fixture() {
  installAppDom();
  const view: SessionViewData = { ...createSessionViewFixture(), messages: Array.from({ length: 21 }, (_, i) => ({ role: "user", content: `turn ${i + 21}`, piChatPersistedMessageId: `u${i + 21}:0` })), turnTotal: 88, messageTotal: 176, visibleTurnCount: 21, messagesTruncated: true };
  const cache = new SessionViewCache();
  cache.remember(view);
  const writer = new SessionViewCacheWriter(cache, () => 1, () => false);
  const authority = writer.captureAuthority(1);
  const applied: SessionViewData[] = [];
  const requested: number[] = [];
  const errors: string[] = [];
  const page: SessionHistoryPage = { sessionId: view.session.id, beforeMessageId: "u21:0", messages: [{ role: "user", content: "older", piChatPersistedMessageId: "u20:0" }], turnTotal: 88, messageTotal: 176, messagesTruncated: true };
  const host = {
    viewedSessionId: () => view.session.id, navigationEpoch: () => 1,
    capturePaneAuthority: () => authority, loadingRequest: () => undefined,
    messagesTruncated: () => true, visibleTurnCount: () => 21, turnTotal: () => 88,
    scrollElement: () => null, setLoadingRequest: () => {}, bumpLoadingRevision: () => {},
    setError: (message: string) => errors.push(message), setStickToBottom: () => {},
    sessionEventVersion: () => 0, queueProjectionRevision: () => 0, viewCacheRevision: () => 0,
    fetchSessionView: async (_id: string, turns: number) => { requested.push(turns); return view; },
    paneAuthorityCanCommit: () => true, recordRejected: () => {},
    currentView: () => cache.get(view.session.id), fetchHistoryPage: async () => page,
    prependHistoryPage: (incoming: SessionHistoryPage) => writer.prependHistory(incoming, authority),
    mergeNavigationView: (incoming: SessionViewData) => incoming,
    applySessionView: (incoming: SessionViewData) => applied.push(incoming), deleteLoadingRequest: () => {},
  };
  return { host, cache, view, page, applied, requested, errors };
}

test("history expansion rounds partial turn counts and pages beyond a non-growing tail", async () => {
  const f = fixture();
  const { createHistoryPaginationFlow } = await import("../src/web/application/history-pagination-flow");
  await createHistoryPaginationFlow(f.host)();
  assert.deepEqual(f.requested, [40, 40], "a 21-turn window must not request invalid turns=31");
  assert.equal(f.applied.length, 1);
  assert.equal(f.applied[0].messages.length, 22);
  assert.equal(f.cache.get(f.view.session.id)?.messages[0].piChatPersistedMessageId, "u20:0");
  assert.equal(f.applied[0].state, f.view.state, "older history cannot replace the live Runtime state");
  assert.deepEqual(f.errors, [""]);
});

test("a stale older-history page cannot change cache or the selected pane", async () => {
  const f = fixture();
  f.host.fetchHistoryPage = async () => { f.host.paneAuthorityCanCommit = () => false; return f.page; };
  const { createHistoryPaginationFlow } = await import("../src/web/application/history-pagination-flow");
  await createHistoryPaginationFlow(f.host)();
  assert.equal(f.applied.length, 0);
  assert.equal(f.cache.get(f.view.session.id)?.messages.length, 21);
});

test("prepending history keeps pending SSE tails unconfirmed and refuses duplicate or changed boundaries", () => {
  const f = fixture();
  f.cache.appendTerminal(f.view.session.id, { role: "assistant", content: "unpersisted terminal", timestamp: 999, piChatLiveMessageId: "live" });
  assert.ok(f.cache.prependHistory(f.page));
  assert.equal(f.cache.prependHistory(f.page), undefined, "the same page cannot be applied twice");
  const after = f.cache.remember({ ...f.view, messages: [], messageTotal: 0, turnTotal: 0, messagesTruncated: false });
  assert.equal(after.messages.at(-1)?.piChatLiveMessageId, "live", "history pagination must not promote its own cached terminal to persistence");
});
