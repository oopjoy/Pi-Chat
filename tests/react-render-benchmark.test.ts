import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReactRenderBenchmarkStaging,
  parseReactRenderBenchmarkEnabled,
} from "../scripts/react-render-benchmark-config.mjs";
import {
  reactRenderBenchmarkEnabled,
  recordReactRenderBenchmarkCommit,
} from "../src/web/lib/benchmark-profiler";

test("React render benchmark configuration fails closed outside explicit staging", () => {
  assert.equal(parseReactRenderBenchmarkEnabled(undefined), false);
  assert.equal(parseReactRenderBenchmarkEnabled("0"), false);
  assert.equal(parseReactRenderBenchmarkEnabled("1"), true);
  assert.throws(() => parseReactRenderBenchmarkEnabled("true"), /must be 0 or 1/);
  assert.throws(
    () => assertReactRenderBenchmarkStaging(true, "dist", "dist", "win32"),
    /explicit non-live.*staging root/,
  );
  assert.doesNotThrow(() => assertReactRenderBenchmarkStaging(true, "stage", "dist", "win32"));
});

test("React render benchmark recorder keeps a structured browser sink", () => {
  const previousWindow = globalThis.window;
  const fakeWindow = {} as Window;
  Object.assign(globalThis, { window: fakeWindow });
  try {
    recordReactRenderBenchmarkCommit("conversation-item:message:test", "update", 1.25, 4.5, 10, 12);
    assert.deepEqual((fakeWindow as Window & {
      __piChatReactRenderBenchmark?: { commits: unknown[] };
    }).__piChatReactRenderBenchmark?.commits, [{
      id: "conversation-item:message:test",
      phase: "update",
      actualDuration: 1.25,
      baseDuration: 4.5,
      startTime: 10,
      commitTime: 12,
    }]);
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: Window }).window;
    else Object.assign(globalThis, { window: previousWindow });
  }
});

test("source tests keep the benchmark profiler disabled", () => {
  assert.equal(reactRenderBenchmarkEnabled, false);
});
