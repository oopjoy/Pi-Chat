import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import {
  createBootstrapFixture,
  createSessionViewFixture,
  activeSessionId,
} from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom } from "../helpers/app-dom";

const OFFSCREEN_SESSION_ID = "fedcba9876543210abcd";

async function flushAnimationFrames(callbacks: Map<number, FrameRequestCallback>): Promise<void> {
  const pending = [...callbacks.entries()];
  callbacks.clear();
  await act(async () => {
    for (const [, callback] of pending) callback(0);
    await Promise.resolve();
  });
}

test("App records one double-rAF visible paint and omits offscreen or stale paints", async () => {
  const { dom, FakeEventSource } = installAppDom();
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  const callbacks = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++frameId;
      callbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => { callbacks.delete(id); },
  });
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const { browserStateDiagnosticSnapshot } = await import("../../src/web/lib/state-diagnostics");
  const restoreApi = captureApiSnapshot(api);
  const offscreenView = createSessionViewFixture();
  offscreenView.session = {
    ...offscreenView.session,
    id: OFFSCREEN_SESSION_ID,
    name: "Offscreen",
  };
  Object.assign(api, {
    bootstrap: async () => {
      const value = createBootstrapFixture();
      return { ...value, sessions: [...value.sessions, offscreenView.session] };
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async (sessionId: string) => ({ viewing: sessionId }),
    viewSession: async () => offscreenView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await flushAnimationFrames(callbacks);
    await flushAnimationFrames(callbacks);
    const before = browserStateDiagnosticSnapshot().entries.at(-1)?.sequence || 0;
    const source = FakeEventSource.instances.at(-1)!;

    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 11,
      });
      source.emitPi({
        type: "message_update",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 11,
        message: { role: "assistant", content: [{ type: "text", text: "visible" }] },
      });
      source.emitPi({
        type: "message_end",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 11,
        message: { role: "assistant", content: [{ type: "text", text: "visible" }] },
      });
      await Promise.resolve();
    });
    assert.ok(callbacks.size > 0, "React commit schedules the first paint opportunity frame");
    await flushAnimationFrames(callbacks);
    assert.ok(callbacks.size > 0, "the observer requires a second animation frame");
    await flushAnimationFrames(callbacks);

    await act(async () => {
      source.emitPi({
        type: "message_update",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 11,
        message: { role: "assistant", content: [{ type: "text", text: "visible newer" }] },
      });
      source.emitPi({
        type: "agent_settled",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 11,
      });
      source.emitPi({
        type: "message_update",
        piChatSessionId: OFFSCREEN_SESSION_ID,
        piChatRunGeneration: 12,
        message: { role: "assistant", content: [{ type: "text", text: "offscreen" }] },
      });
      source.emitPi({
        type: "agent_settled",
        piChatSessionId: OFFSCREEN_SESSION_ID,
        piChatRunGeneration: 12,
      });
      await Promise.resolve();
    });
    await flushAnimationFrames(callbacks);
    await flushAnimationFrames(callbacks);

    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 20,
      });
      source.emitPi({
        type: "message_update",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 20,
        message: { role: "assistant", content: [{ type: "text", text: "stale" }] },
      });
      await Promise.resolve();
      source.emitPi({
        type: "agent_start",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 21,
      });
      await Promise.resolve();
    });
    await flushAnimationFrames(callbacks);
    await flushAnimationFrames(callbacks);

    await act(async () => {
      source.emitPi({
        type: "message_update",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 30,
        message: { role: "assistant", content: [{ type: "text", text: "navigate stale" }] },
      });
      source.emitPi({
        type: "message_end",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 30,
        message: { role: "assistant", content: [{ type: "text", text: "navigate stale" }] },
      });
      await Promise.resolve();
    });
    const offscreenButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".session-item",
    )].find((button) => button.textContent?.includes("Offscreen"))!;
    await act(async () => {
      offscreenButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushAnimationFrames(callbacks);
    await flushAnimationFrames(callbacks);

    const entries = browserStateDiagnosticSnapshot().entries.filter((entry) => entry.sequence > before);
    const paints = entries.filter((entry) =>
      entry.category === "render" && entry.name === "first-assistant-paint-opportunity"
    );
    assert.deepEqual(
      paints.map((entry) => [entry.sessionId, entry.runGeneration]),
      [[activeSessionId, 11]],
    );
    assert.equal(paints.some((entry) => entry.runGeneration === 20), false);
    assert.equal(paints.some((entry) => entry.runGeneration === 30), false);
    const summaries = entries.filter((entry) =>
      entry.category === "render" && entry.name === "stream-summary"
    );
    assert.deepEqual(
      summaries.map((entry) => [
        entry.sessionId,
        entry.runGeneration,
        entry.details.snapshotsOffscreen,
      ]),
      [
        [activeSessionId, 11, 0],
        [OFFSCREEN_SESSION_ID, 12, 1],
      ],
    );
    assert.equal(JSON.stringify(entries).includes("visible newer"), false);
    assert.equal(JSON.stringify(entries).includes("offscreen"), false);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("terminal session-status summaries include visible scheduler clearing", async () => {
  const { dom, FakeEventSource } = installAppDom();
  const originalNow = globalThis.performance.now;
  Object.defineProperty(globalThis.performance, "now", {
    value: () => 0,
    configurable: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const { browserStateDiagnosticSnapshot } = await import("../../src/web/lib/state-diagnostics");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => createBootstrapFixture(),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (sessionId: string) => ({ viewing: sessionId }),
    viewSession: async () => createSessionViewFixture(),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const before = browserStateDiagnosticSnapshot().entries.at(-1)?.sequence || 0;
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 41,
      });
      source.emitPi({
        type: "message_update",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 41,
        message: { role: "assistant", content: [{ type: "text", text: "pending modern" }] },
      });
      source.emitPi({
        type: "pi_chat_session_status",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 41,
        activity: { execution: "idle", awaitingConfirmation: false },
      });
      await Promise.resolve();
    });
    const summaries = browserStateDiagnosticSnapshot().entries.filter((entry) =>
      entry.sequence > before
      && entry.category === "render"
      && entry.name === "stream-summary"
      && entry.runGeneration === 41
    );
    assert.deepEqual(
      summaries.map((entry) => [
        entry.runGeneration,
        entry.details.snapshotsScheduled,
        entry.details.snapshotsCleared,
        entry.details.terminal,
      ]),
      [[41, 1, 1, true]],
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
    Object.defineProperty(globalThis.performance, "now", {
      value: originalNow,
      configurable: true,
    });
  }
});

test("navigation drain and restored cache never manufacture a paint candidate", async () => {
  const { dom, FakeEventSource } = installAppDom();
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  Object.defineProperty(dom.window.document, "hasFocus", {
    value: () => true,
    configurable: true,
  });
  const callbacks = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalNow = globalThis.performance.now;
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++frameId;
      callbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => { callbacks.delete(id); },
  });
  Object.defineProperty(globalThis.performance, "now", {
    value: () => 0,
    configurable: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const { browserStateDiagnosticSnapshot } = await import("../../src/web/lib/state-diagnostics");
  const restoreApi = captureApiSnapshot(api);
  const activeView = createSessionViewFixture();
  const activeBootstrap = createBootstrapFixture();
  activeView.session = { ...activeBootstrap.sessions[0] };
  activeView.state = { ...activeBootstrap.state };
  const offscreenView = createSessionViewFixture();
  offscreenView.session = {
    ...offscreenView.session,
    id: OFFSCREEN_SESSION_ID,
    name: "Offscreen",
  };
  Object.assign(api, {
    bootstrap: async () => {
      const value = createBootstrapFixture();
      return { ...value, sessions: [...value.sessions, offscreenView.session] };
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async (sessionId: string) => ({ viewing: sessionId }),
    viewSession: async (sessionId: string) =>
      sessionId === OFFSCREEN_SESSION_ID ? offscreenView : activeView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await flushAnimationFrames(callbacks);
    await flushAnimationFrames(callbacks);
    const before = browserStateDiagnosticSnapshot().entries.at(-1)?.sequence || 0;
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 43,
      });
      source.emitPi({
        type: "message_update",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 43,
        message: { role: "assistant", content: [{ type: "text", text: "drained cache" }] },
      });
      await Promise.resolve();
    });
    const sessionButtons = () => [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item"),
    ];
    const offscreenButton = sessionButtons().find((button) =>
      button.textContent?.includes("Offscreen")
    )!;
    await act(async () => {
      offscreenButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const activeButton = sessionButtons().find((button) =>
      button.textContent?.includes(activeView.session.name)
    )!;
    await act(async () => {
      activeButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushAnimationFrames(callbacks);
    await flushAnimationFrames(callbacks);
    await act(async () => {
      source.emitPi({
        type: "agent_settled",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 43,
      });
      await Promise.resolve();
    });
    await flushAnimationFrames(callbacks);
    await flushAnimationFrames(callbacks);
    const entries = browserStateDiagnosticSnapshot().entries.filter((entry) =>
      entry.sequence > before && entry.runGeneration === 43
    );
    assert.equal(
      entries.some((entry) =>
        entry.category === "render"
        && entry.name === "first-assistant-paint-opportunity"
      ),
      false,
    );
    const summary = entries.find((entry) =>
      entry.category === "render" && entry.name === "stream-summary"
    );
    assert.ok(summary);
    assert.equal(summary.details.snapshotsDrained, 1);
    assert.equal(summary.details.snapshotsCommitted, 0);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
    Object.assign(globalThis, {
      requestAnimationFrame: originalRequestAnimationFrame,
      cancelAnimationFrame: originalCancelAnimationFrame,
    });
    Object.defineProperty(globalThis.performance, "now", {
      value: originalNow,
      configurable: true,
    });
  }
});

test("legacy terminal session status clears before its stream summary", async () => {
  const { dom, FakeEventSource } = installAppDom();
  const originalNow = globalThis.performance.now;
  Object.defineProperty(globalThis.performance, "now", {
    value: () => 0,
    configurable: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const { browserStateDiagnosticSnapshot } = await import("../../src/web/lib/state-diagnostics");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => createBootstrapFixture(),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (sessionId: string) => ({ viewing: sessionId }),
    viewSession: async () => createSessionViewFixture(),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const before = browserStateDiagnosticSnapshot().entries.at(-1)?.sequence || 0;
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 42,
      });
      source.emitPi({
        type: "message_update",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 42,
        message: { role: "assistant", content: [{ type: "text", text: "pending legacy" }] },
      });
      source.emitPi({
        type: "pi_chat_session_status",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 42,
        running: false,
      });
      await Promise.resolve();
    });
    const summary = browserStateDiagnosticSnapshot().entries.find((entry) =>
      entry.sequence > before
      && entry.category === "render"
      && entry.name === "stream-summary"
      && entry.runGeneration === 42
    );
    assert.ok(summary);
    assert.equal(summary.details.snapshotsScheduled, 1);
    assert.equal(summary.details.snapshotsCleared, 1);
    assert.equal(summary.details.terminal, true);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
    Object.defineProperty(globalThis.performance, "now", {
      value: originalNow,
      configurable: true,
    });
  }
});

test("diagnostic export checkpoints an active browser stream only once per counter segment", async () => {
  const { dom, FakeEventSource } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const { browserStateDiagnosticSnapshot } = await import("../../src/web/lib/state-diagnostics");
  const restoreApi = captureApiSnapshot(api);
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = () => "blob:diagnostic";
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  Object.assign(api, {
    bootstrap: async () => createBootstrapFixture(),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (sessionId: string) => ({ viewing: sessionId }),
    viewSession: async () => createSessionViewFixture(),
    stateDiagnosticSnapshot: async () => ({
      schemaVersion: 3 as const,
      generatedAt: new Date().toISOString(),
      runEpoch: "run",
      buildFingerprint: "a".repeat(64),
      status: {
        entryCount: 0,
        windowMs: 300_000,
        maximumEntries: 2_000,
        approximateBytes: 0,
        maximumBytes: 1024 * 1024,
      },
      entries: [],
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const before = browserStateDiagnosticSnapshot().entries.at(-1)?.sequence || 0;
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 44,
      });
      source.emitPi({
        type: "message_update",
        piChatSessionId: activeSessionId,
        piChatRunGeneration: 44,
        message: { role: "assistant", content: [{ type: "text", text: "active export" }] },
      });
      await Promise.resolve();
    });
    const button = (label: string) => [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === label);
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>('[aria-label="打开设置"]')?.click();
      await Promise.resolve();
    });
    await act(async () => button("诊断")?.click());
    await act(async () => {
      button("导出最近五分钟诊断")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      button("导出最近五分钟诊断")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const summaries = browserStateDiagnosticSnapshot().entries.filter((entry) =>
      entry.sequence > before
      && entry.category === "render"
      && entry.name === "stream-summary"
      && entry.runGeneration === 44
    );
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].details.terminal, false);
    assert.equal(summaries[0].details.snapshotsReceived, 1);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
  }
});
