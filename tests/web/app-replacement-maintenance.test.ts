import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { act, createElement } from "react";
import type { BootstrapData, SessionViewData } from "../../src/shared/types";
import { activeSessionId as activeId, createBootstrapFixture, createSessionViewFixture } from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom as installDom } from "../helpers/app-dom";

let bootstrap: BootstrapData;
let draftView: SessionViewData;

beforeEach(() => {
  bootstrap = createBootstrapFixture();
  draftView = createSessionViewFixture();
});


test("a stale bootstrap rejection during replacement maintenance cannot surface an A error", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  let rejectOldBootstrap!: (cause: Error) => void;
  const oldBootstrap = new Promise<BootstrapData>((_resolve, reject) => {
    rejectOldBootstrap = reject;
  });
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) return bootstrap;
      if (bootstrapCalls === 2) return oldBootstrap;
      return { ...bootstrap, workspaceEpoch: "epoch-b" };
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    invalidateHandshake: () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => source.emitPi({ type: "pi_chat_sse_resync" }));
    assert.equal(bootstrapCalls, 2, "A resync starts a pending bootstrap");
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "workspace-changing",
            piChatRunEpoch: "epoch-b",
            workspaceEpoch: "epoch-b",
          }),
        }),
      ),
    );
    await act(async () => {
      rejectOldBootstrap(new Error("A stale bootstrap failure"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.doesNotMatch(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /A stale bootstrap failure/,
    );
    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-b",
            workspaceEpoch: "epoch-b",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      bootstrapCalls,
      3,
      "B idle still begins its independent bootstrap after the stale A rejection",
    );
    assert.doesNotMatch(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /A stale bootstrap failure/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a replacement maintenance ready detaches an old bootstrap before its later idle refresh", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  let resolveOldBootstrap!: (value: BootstrapData) => void;
  const oldBootstrap = new Promise<BootstrapData>((resolve) => {
    resolveOldBootstrap = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1)
        return {
          ...bootstrap,
          workspaceEpoch: "epoch-old",
          workspaceCwd: "C:/old-default",
        };
      if (bootstrapCalls === 2) return oldBootstrap;
      return {
        ...bootstrap,
        workspaceEpoch: "epoch-new",
        workspaceCwd: "D:/replacement-default",
      };
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    invalidateHandshake: () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.equal(bootstrapCalls, 1);
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({ type: "pi_chat_sse_resync" });
      await Promise.resolve();
    });
    assert.equal(
      bootstrapCalls,
      2,
      "resync leaves an old-process bootstrap pending",
    );
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "workspace-changing",
            piChatRunEpoch: "epoch-new",
            workspaceEpoch: "epoch-new",
          }),
        }),
      ),
    );
    assert.equal(
      bootstrapCalls,
      2,
      "maintenance ready defers bootstrap until idle",
    );
    await act(async () => {
      resolveOldBootstrap({
        ...bootstrap,
        workspaceEpoch: "epoch-old",
        workspaceCwd: "E:/stale-before-idle",
      });
      await Promise.resolve();
    });
    const newBeforeIdle = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "New")!;
    await act(async () => newBeforeIdle.click());
    assert.notEqual(
      dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent,
      "E:/stale-before-idle",
      "an old bootstrap resolving during maintenance cannot commit its metadata",
    );
    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-new",
            workspaceEpoch: "epoch-new",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      bootstrapCalls,
      3,
      "same-epoch idle must issue B bootstrap after the stale A response",
    );
    const newButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "New")!;
    await act(async () => newButton.click());
    assert.equal(
      dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent,
      "D:/replacement-default",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("replacement detaches a pending scheduled Session Index refresh before applying B inventory", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const oldSession = {
    ...bootstrap.sessions[0],
    id: "cccccccccccccccccccc",
    sessionId: "old-index",
    name: "A scheduled inventory",
    active: false,
    writable: false,
  };
  const replacementSession = {
    ...bootstrap.sessions[0],
    id: "dddddddddddddddddddd",
    sessionId: "replacement-index",
    name: "B scheduled inventory",
    active: false,
    writable: false,
  };
  let resolveOldInventory!: (value: {
    sessions: typeof bootstrap.sessions;
    total: number;
    directories: [];
  }) => void;
  let resolveReplacementInventory!: (value: {
    sessions: typeof bootstrap.sessions;
    total: number;
    directories: [];
  }) => void;
  const oldInventory = new Promise<{
    sessions: typeof bootstrap.sessions;
    total: number;
    directories: [];
  }>((resolve) => {
    resolveOldInventory = resolve;
  });
  const replacementInventory = new Promise<{
    sessions: typeof bootstrap.sessions;
    total: number;
    directories: [];
  }>((resolve) => {
    resolveReplacementInventory = resolve;
  });
  let bootstrapCalls = 0;
  let sessionReads = 0;
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1
        ? bootstrap
        : new Promise<BootstrapData>(() => undefined);
    },
    eventsUrl: () => "/api/events",
    sessions: async () => {
      sessionReads += 1;
      return sessionReads === 1 ? oldInventory : replacementInventory;
    },
    invalidateHandshake: () => undefined,
  });
  const browserSetTimeout = dom.window.setTimeout.bind(dom.window);
  const refreshTimers: Array<() => void> = [];
  Object.defineProperty(dom.window, "setTimeout", {
    configurable: true,
    value(callback: TimerHandler, delay?: number) {
      if (delay === 180 && typeof callback === "function") {
        refreshTimers.push(callback);
        return refreshTimers.length;
      }
      return browserSetTimeout(callback, delay);
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_active_session_changed",
        sessionId: activeId,
        activeSessionIds: [activeId],
      }),
    );
    await act(async () => refreshTimers[0]!());
    assert.equal(sessionReads, 1, "A starts its scheduled Session Index read");

    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "workspace-changing",
            piChatRunEpoch: "epoch-index-b",
            workspaceEpoch: "epoch-index-b",
          }),
        }),
      ),
    );
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-index-b",
            workspaceEpoch: "epoch-index-b",
          }),
        }),
      ),
    );
    await act(async () =>
      source.emitPi({
        type: "pi_chat_active_session_changed",
        sessionId: activeId,
        activeSessionIds: [activeId],
      }),
    );
    await act(async () => refreshTimers.at(-1)!());
    assert.equal(
      sessionReads,
      2,
      "B starts its own refresh instead of joining A",
    );

    await act(async () => {
      resolveReplacementInventory({
        sessions: [replacementSession],
        total: 1,
        directories: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /B scheduled inventory/,
    );
    await act(async () => {
      resolveOldInventory({
        sessions: [oldSession],
        total: 1,
        directories: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /B scheduled inventory/,
    );
    assert.doesNotMatch(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /A scheduled inventory/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("replacement pane authority rejects late A navigation success and failure while B history remains usable", async () => {
  for (const outcome of ["success", "failure"] as const) {
    const { dom, FakeEventSource } = installDom();
    const { createRoot } = await import("react-dom/client");
    const { api } = await import("../../src/web/api");
    const { App } = await import("../../src/web/App");
    const diagnostics = await import("../../src/web/lib/state-diagnostics");
    const diagnosticStartSequence = diagnostics.browserStateDiagnosticSnapshot().entries.at(-1)?.sequence || 0;
    const restoreApi = captureApiSnapshot(api);
    const oldId = `aaaaaaaaaaaaaaaaaaa${outcome === "success" ? "1" : "2"}`;
    const replacementId = `bbbbbbbbbbbbbbbbbbb${outcome === "success" ? "1" : "2"}`;
    const oldSession = {
      ...bootstrap.sessions[0],
      id: oldId,
      sessionId: `old-${outcome}`,
      name: `A pending ${outcome}`,
      active: false,
      writable: false,
    };
    const replacementSession = {
      ...bootstrap.sessions[0],
      id: replacementId,
      sessionId: `replacement-${outcome}`,
      name: `B JSONL ${outcome}`,
      active: false,
      writable: false,
    };
    const replacementView: SessionViewData = {
      ...draftView,
      session: replacementSession,
      state: { ...bootstrap.state, sessionId: replacementSession.sessionId },
      messages: [{ role: "user", content: `B JSONL ${outcome} history` }],
      isActive: false,
      runtimeStatus: "view-only",
    };
    let resolveOldView!: (value: SessionViewData) => void;
    let rejectOldView!: (cause: Error) => void;
    const oldView = new Promise<SessionViewData>((resolve, reject) => {
      resolveOldView = resolve;
      rejectOldView = reject;
    });
    const pendingReplacementBootstrap = new Promise<BootstrapData>(
      () => undefined,
    );
    let bootstrapCalls = 0;
    const sidebarTimers: Array<() => void> = [];
    const browserSetTimeout = dom.window.setTimeout.bind(dom.window);
    Object.defineProperty(dom.window, "setTimeout", {
      configurable: true,
      value(callback: TimerHandler, delay?: number) {
        if (delay === 250 && typeof callback === "function") {
          sidebarTimers.push(callback);
          return 1;
        }
        return browserSetTimeout(callback, delay);
      },
    });
    Object.assign(api, {
      bootstrap: async () => {
        bootstrapCalls += 1;
        return bootstrapCalls === 1
          ? {
              ...bootstrap,
              sessions: [...bootstrap.sessions, oldSession],
              sessionsTotal: 2,
            }
          : pendingReplacementBootstrap;
      },
      eventsUrl: () => "/api/events",
      sessions: async () => ({
        sessions: [replacementSession],
        total: 1,
        directories: [],
      }),
      viewSession: async (id: string) =>
        id === oldId ? oldView : replacementView,
      markSessionViewed: async () => ({ viewing: replacementId }),
      invalidateHandshake: () => undefined,
    });
    const root = createRoot(dom.window.document.querySelector("#root")!);
    try {
      await act(async () => root.render(createElement(App)));
      const oldButton = [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(oldSession.name))!;
      await act(async () => oldButton.click());
      const source = FakeEventSource.instances.at(-1)!;
      await act(async () =>
        source.dispatchEvent(
          new dom.window.MessageEvent("ready", {
            data: JSON.stringify({
              lifecycle: "workspace-changing",
              piChatRunEpoch: `epoch-b-${outcome}`,
              workspaceEpoch: `epoch-b-${outcome}`,
            }),
          }),
        ),
      );
      await act(async () =>
        source.dispatchEvent(
          new dom.window.MessageEvent("ready", {
            data: JSON.stringify({
              lifecycle: "idle",
              piChatRunEpoch: `epoch-b-${outcome}`,
              workspaceEpoch: `epoch-b-${outcome}`,
            }),
          }),
        ),
      );
      assert.equal(
        bootstrapCalls,
        2,
        "B starts an independent bootstrap after the handoff",
      );
      await act(async () => {
        sidebarTimers.at(-1)!();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (outcome === "success") {
        await act(async () => {
          resolveOldView({
            ...replacementView,
            session: oldSession,
            messages: [{ role: "assistant", content: "A stale success" }],
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        assert.doesNotMatch(
          dom.window.document.body.textContent || "",
          /A stale success/,
        );
        const rejection = diagnostics.browserStateDiagnosticSnapshot().entries
          .filter((entry) =>
            entry.sequence > diagnosticStartSequence &&
            entry.category === "projection" &&
            entry.name === "session-view-rejected" &&
            entry.sessionId === oldId,
          )
          .at(-1);
        assert.equal(rejection?.details.decisionReason, "stale-pane-authority");
      } else {
        await act(async () => {
          rejectOldView(new Error("A stale navigation failure"));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        assert.doesNotMatch(
          dom.window.document.body.textContent || "",
          /A stale navigation failure/,
        );
      }
      const replacementButton = [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) =>
        button.textContent?.includes(replacementSession.name),
      )!;
      assert.equal(replacementButton.disabled, false);
      await act(async () => replacementButton.click());
      assert.match(
        dom.window.document.body.textContent || "",
        new RegExp(`B JSONL ${outcome} history`),
      );
      assert.doesNotMatch(
        dom.window.document.body.textContent || "",
        /A stale success|A stale navigation failure/,
      );
    } finally {
      await act(async () => root.unmount());
      restoreApi();
    }
  }
});
