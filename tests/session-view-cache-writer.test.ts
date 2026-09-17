import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SessionViewCacheWriter } from "../src/web/application/session-view-cache-writer";
import { SessionViewCache } from "../src/web/lib/session-view-cache";
import { createSessionViewFixture } from "./fixtures/app-bootstrap";

const appSource = readFileSync(
  new URL("../src/web/App.tsx", import.meta.url),
  "utf8",
);

function writerFixture() {
  const cache = new SessionViewCache(6, () => 100);
  let generation = 4;
  const deleted = new Set<string>();
  const writer = new SessionViewCacheWriter(
    cache,
    () => generation,
    (sessionId) => deleted.has(sessionId),
  );
  return {
    cache,
    writer,
    deleted,
    authority: () => writer.captureAuthority(generation),
    replaceProcess: () => { generation += 1; },
  };
}

test("App routes every SessionView cache mutation through its writer", () => {
  const directMutation = /viewCacheRef\.current\.(?:remember|mergeNavigation|refresh|patch|updateLive|appendTerminal|forget|clear|setPinned)\s*\(/g;
  assert.deepEqual(appSource.match(directMutation), null);
  assert.equal(appSource.includes("rememberSessionView("), false);
});

test("SessionView cache writer accepts same-process authoritative views", () => {
  const { cache, writer, authority } = writerFixture();
  const view = createSessionViewFixture();

  const committed = writer.remember(view, authority());

  assert.equal(committed?.session.id, view.session.id);
  assert.equal(cache.get(view.session.id)?.cachedAt, 100);
});

test("SessionView cache writer rejects process replacement before preparation", () => {
  const { cache, writer, authority, replaceProcess } = writerFixture();
  const view = createSessionViewFixture();
  const oldAuthority = authority();
  let preparations = 0;
  replaceProcess();

  const committed = writer.remember(view, oldAuthority, (candidate) => {
    preparations += 1;
    return candidate;
  });

  assert.equal(committed, undefined);
  assert.equal(preparations, 0);
  assert.equal(cache.get(view.session.id), undefined);
});

test("SessionView cache writer rejects process replacement navigation merges", () => {
  const { cache, writer, authority, replaceProcess } = writerFixture();
  const view = createSessionViewFixture();
  const oldAuthority = authority();
  writer.remember(view, oldAuthority);
  replaceProcess();

  const committed = writer.mergeNavigation(
    { ...view, toolStatus: "old process" },
    cache.revisionFor(view.session.id),
    oldAuthority,
  );

  assert.equal(committed, undefined);
  assert.notEqual(cache.get(view.session.id)?.toolStatus, "old process");
});

test("SessionView cache writer rejects process replacement partial writes", () => {
  const { cache, writer, authority, replaceProcess } = writerFixture();
  const view = createSessionViewFixture();
  const oldAuthority = authority();
  writer.remember(view, oldAuthority);
  replaceProcess();

  assert.equal(
    writer.patch(view.session.id, { toolStatus: "old patch" }, oldAuthority),
    undefined,
  );
  assert.equal(
    writer.refresh(view.session.id, { runtimeStatus: "starting" }, oldAuthority),
    undefined,
  );
  assert.equal(writer.forget(view.session.id, oldAuthority), false);
  assert.notEqual(cache.get(view.session.id)?.toolStatus, "old patch");
  assert.notEqual(cache.get(view.session.id)?.runtimeStatus, "starting");
});

test("SessionView cache clear retires same-process Runtime authorities", () => {
  const { cache, writer, authority } = writerFixture();
  const view = createSessionViewFixture();
  const oldAuthority = authority();
  writer.remember(view, oldAuthority);

  writer.clearForReplacement();

  assert.equal(writer.remember(view, oldAuthority), undefined);
  assert.equal(
    writer.patch(view.session.id, { toolStatus: "old Runtime" }, oldAuthority),
    undefined,
  );
  assert.equal(writer.forget(view.session.id, oldAuthority), false);
  assert.equal(cache.get(view.session.id), undefined);
});

test("SessionView cache writer rejects deleted Session views and transient writes", () => {
  const { cache, writer, deleted, authority } = writerFixture();
  const view = createSessionViewFixture();
  deleted.add(view.session.id);

  assert.equal(writer.remember(view, authority()), undefined);
  assert.equal(writer.patchCurrent(view.session.id, { toolStatus: "late" }), undefined);
  assert.equal(cache.get(view.session.id), undefined);
});

test("SessionView cache writer preserves same-process navigation overlays", () => {
  const { cache, writer, authority } = writerFixture();
  const view = createSessionViewFixture();
  const currentAuthority = authority();
  writer.remember(view, currentAuthority);
  const requestRevision = cache.revisionFor(view.session.id);
  writer.patchCurrent(view.session.id, { toolStatus: "newer event" });

  const committed = writer.mergeNavigation(
    { ...view, toolStatus: "stale response" },
    requestRevision,
    currentAuthority,
  );

  assert.equal(committed?.toolStatus, "newer event");
});

test("SessionView cache writer owns structural cache invalidation", () => {
  const { cache, writer, authority } = writerFixture();
  const view = createSessionViewFixture();
  writer.remember(view, authority());

  writer.forgetCurrent(view.session.id);
  assert.equal(cache.get(view.session.id), undefined);

  writer.remember(view, authority());
  writer.clearForReplacement();
  assert.equal(cache.get(view.session.id), undefined);
});
