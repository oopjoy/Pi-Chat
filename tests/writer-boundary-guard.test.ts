import assert from "node:assert/strict";
import test from "node:test";
import { collectWriterBoundarySources, writerBoundaryViolations } from "../scripts/check-writer-boundaries.mjs";

const violations = (source: string, path = "src/web/application/nested/fixture.ts") => writerBoundaryViolations([{ path, source }]);

test("writer guard scans the actual Web tree including extracted application modules", async () => {
  const files = await collectWriterBoundarySources();
  assert.ok(files.some(file => file.path === "src/web/App.tsx"));
  assert.ok(files.some(file => file.path === "src/web/application/session-view-applicator.ts"));
  assert.ok(files.some(file => file.path === "src/web/application/pi-event-message-streaming.ts"));
  assert.deepEqual(writerBoundaryViolations(files), []);
});

test("writer guard detects direct, computed, assigned and destructured cache bypasses", () => {
  for (const source of [
    "viewCacheRef.current.patch('id', {});",
    "host.viewCacheRef.current['clear']();",
    "const method = 'patch'; viewCacheRef.current[method]('id', {});",
    "const c = host.viewCacheRef.current; c.appendTerminal('id', {});",
    "const {current: c} = host.viewCacheRef; const {patch: update} = c; update('id', {});",
    "const mutate = viewCacheRef.current.patch.bind(viewCacheRef.current); mutate('id', {});",
    "class SessionViewCache { patch() {} }; const c = new SessionViewCache(); c.patch();",
  ]) assert.ok(violations(source).some(item => item.kind === "cache-write"), source);
});

test("writer guard detects aliased Runtime and active-set setter calls outside their sinks", () => {
  for (const source of [
    "host['setPrimaryRuntime']({status:'ready'});",
    "const write = host.setApplicationLifecycle; const again = write; again('idle');",
    "const {setActiveSessionIds: publish} = host; publish([]);",
    "publishPrimaryCapabilitySnapshot.call(null, {});",
  ]) assert.ok(violations(source).length > 0, source);
  assert.ok(violations("setActiveSessionIds([]);", "src/web/application/session-projection-state.tsx").length > 0,
    "the sink's whole file is not an unrestricted allowlist");
});

test("writer guard permits approved wiring, read-only access, shadowed unrelated locals and comments", () => {
  assert.deepEqual(violations("const c = viewCacheRef.current; c.get('id'); // setPrimaryRuntime()\nconst text = 'viewCacheRef.current.clear()';"), []);
  assert.deepEqual(violations("function a() { const c = viewCacheRef.current; c.get('id'); } function b() { const c = { patch() {} }; c.patch(); }"), []);
  assert.deepEqual(violations("new RuntimeProjectionWriter({ readiness: next => setPrimaryRuntime(next) });", "src/web/App.tsx"), []);
  assert.deepEqual(violations("new ActiveSessionProjectionWriter(ids => setActiveSessionIds(ids));", "src/web/application/session-projection-state.tsx"), []);
  assert.deepEqual(violations("viewCacheRef.current.patch('id', {});", "src/web/application/session-view-cache-writer.ts"), []);
});

test("writer alias analysis terminates on reassignment and remains conservative", () => {
  assert.ok(violations("let target = viewCacheRef; target = viewCacheRef.current; target = target.patch; target();").length > 0);
});
