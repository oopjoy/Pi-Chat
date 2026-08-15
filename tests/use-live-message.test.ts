import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useLiveMessageScheduler } from "../src/web/hooks/use-live-message";
import type { LiveMessageSchedulerOutcome } from "../src/web/lib/stream-observability";
import { installAppDom } from "./helpers/app-dom";

test("live message scheduler reports fixed outcomes without changing latest-payload timing", async () => {
  const { dom } = installAppDom();
  const callbacks = new Map<number, TimerHandler>();
  let timerId = 0;
  let now = 0;
  const originalSetTimeout = dom.window.setTimeout;
  const originalClearTimeout = dom.window.clearTimeout;
  const originalNow = globalThis.performance.now;
  dom.window.setTimeout = ((callback: TimerHandler) => {
    const id = ++timerId;
    callbacks.set(id, callback);
    return id;
  }) as typeof dom.window.setTimeout;
  dom.window.clearTimeout = ((id: number) => {
    callbacks.delete(id);
  }) as typeof dom.window.clearTimeout;
  Object.defineProperty(globalThis.performance, "now", {
    value: () => now,
    configurable: true,
  });
  const commits: string[] = [];
  const outcomes: Array<[LiveMessageSchedulerOutcome, string]> = [];
  let scheduler!: ReturnType<typeof useLiveMessageScheduler<string>>;
  function Harness() {
    scheduler = useLiveMessageScheduler(
      (message) => commits.push(message),
      50,
      (outcome, message) => outcomes.push([outcome, message]),
    );
    return null;
  }
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => {
      scheduler.scheduleLiveMessage("a");
      scheduler.scheduleLiveMessage("b");
    });
    assert.deepEqual(outcomes, [["scheduled", "a"], ["replaced", "b"]]);
    assert.equal(callbacks.size, 1);
    now = 50;
    await act(async () => {
      const callback = [...callbacks.values()][0];
      callbacks.clear();
      if (typeof callback === "function") callback();
    });
    assert.deepEqual(commits, ["b"]);
    assert.deepEqual(outcomes.at(-1), ["committed", "b"]);

    now = 60;
    await act(async () => scheduler.scheduleLiveMessage("c"));
    assert.equal(scheduler.drainPendingLiveMessage(), "c");
    assert.deepEqual(outcomes.at(-1), ["drained", "c"]);

    now = 70;
    await act(async () => scheduler.scheduleLiveMessage("d"));
    scheduler.clearPendingLiveMessage();
    assert.deepEqual(outcomes.at(-1), ["cleared", "d"]);
    assert.equal(callbacks.size, 0);
  } finally {
    await act(async () => root.unmount());
    dom.window.setTimeout = originalSetTimeout;
    dom.window.clearTimeout = originalClearTimeout;
    Object.defineProperty(globalThis.performance, "now", {
      value: originalNow,
      configurable: true,
    });
  }
});

test("live message scheduler observer failures are fail-open", async () => {
  const { dom } = installAppDom();
  const commits: string[] = [];
  let scheduler!: ReturnType<typeof useLiveMessageScheduler<string>>;
  function Harness() {
    scheduler = useLiveMessageScheduler(
      (message) => commits.push(message),
      0,
      () => { throw new Error("observer failed"); },
    );
    return null;
  }
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(Harness)));
    assert.doesNotThrow(() => scheduler.scheduleLiveMessage("latest"));
    assert.deepEqual(commits, ["latest"]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("live message scheduler does not report a pane-rejected commit", async () => {
  const { dom } = installAppDom();
  const outcomes: LiveMessageSchedulerOutcome[] = [];
  let scheduler!: ReturnType<typeof useLiveMessageScheduler<string>>;
  function Harness() {
    scheduler = useLiveMessageScheduler(
      () => false,
      0,
      (outcome) => outcomes.push(outcome),
    );
    return null;
  }
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(Harness)));
    assert.doesNotThrow(() => scheduler.scheduleLiveMessage("stale"));
    assert.deepEqual(outcomes, []);
  } finally {
    await act(async () => root.unmount());
  }
});
