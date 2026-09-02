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


test("replacement idle releases maintenance locks before a rejected bootstrap and bounds retry", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const historyId = "33333333333333333333";
  const replacementSession = {
    ...bootstrap.sessions[0],
    id: historyId,
    sessionId: "replacement-history",
    name: "Replacement history",
    cwd: "C:/work",
    active: false,
    writable: false,
  };
  const replacementView: SessionViewData = {
    ...draftView,
    session: replacementSession,
    state: { ...bootstrap.state, sessionId: "replacement-history" },
    messages: [{ role: "user", content: "replacement JSONL history" }],
    isActive: false,
    runtimeStatus: "view-only",
  };
  let bootstrapCalls = 0;
  let rejectReplacementBootstrap!: (cause: Error) => void;
  const rejectedReplacementBootstrap = new Promise<BootstrapData>(
    (_resolve, reject) => {
      rejectReplacementBootstrap = reject;
    },
  );
  const recoveryBootstrap = new Promise<BootstrapData>(() => undefined);
  let sessionReads = 0;
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) return bootstrap;
      if (bootstrapCalls === 2) return rejectedReplacementBootstrap;
      return recoveryBootstrap;
    },
    eventsUrl: () => "/api/events",
    sessions: async () => {
      sessionReads += 1;
      return { sessions: [replacementSession], total: 1, directories: [] };
    },
    viewSession: async (id: string) => {
      assert.equal(id, historyId);
      return replacementView;
    },
    markSessionViewed: async () => ({ viewing: historyId }),
    invalidateHandshake: () => undefined,
  });
  const browserSetTimeout = dom.window.setTimeout.bind(dom.window);
  const sidebarTimers: Array<() => void> = [];
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
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "workspace-changing",
            piChatRunEpoch: "epoch-replacement",
            workspaceEpoch: "epoch-replacement",
          }),
        }),
      ),
    );
    const newDuringMaintenance = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "New")!;
    assert.equal(newDuringMaintenance.disabled, true);

    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-replacement",
            workspaceEpoch: "epoch-replacement",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      bootstrapCalls,
      2,
      "replacement idle starts exactly one B bootstrap",
    );
    const newAfterIdle = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "New")!;
    assert.equal(
      newAfterIdle.disabled,
      false,
      "authoritative idle releases New before bootstrap recovers",
    );
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /正在切换工作目录/,
    );

    await act(async () => {
      sidebarTimers.at(-1)!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(
      sessionReads >= 1,
      "replacement idle starts an independent Session Index fallback",
    );
    const replacementButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((button) => button.textContent?.includes("Replacement history"))!;
    assert.equal(
      replacementButton.disabled,
      false,
      "idle releases sidebar history navigation before bootstrap recovers",
    );
    await act(async () => replacementButton.click());
    assert.match(
      dom.window.document.body.textContent || "",
      /replacement JSONL history/,
    );
    await act(async () => newAfterIdle.click());
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "新对话",
    );
    await act(async () => {
      rejectReplacementBootstrap(
        new Error("replacement bootstrap unavailable"),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-replacement",
            workspaceEpoch: "epoch-replacement",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      bootstrapCalls,
      3,
      "one healthy idle retries the rejected bootstrap once",
    );
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-replacement",
            workspaceEpoch: "epoch-replacement",
          }),
        }),
      ),
    );
    assert.equal(
      bootstrapCalls,
      3,
      "repeated idle frames cannot create a refresh loop",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a same-epoch ready joining a failed replacement bootstrap preserves its one retry", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  let rejectReplacementBootstrap!: (cause: Error) => void;
  const pendingReplacementBootstrap = new Promise<BootstrapData>(
    (_resolve, reject) => {
      rejectReplacementBootstrap = reject;
    },
  );
  const pendingRetryBootstrap = new Promise<BootstrapData>(() => undefined);
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1)
        return { ...bootstrap, workspaceEpoch: "epoch-a" };
      if (bootstrapCalls === 2) return pendingReplacementBootstrap;
      return pendingRetryBootstrap;
    },
    eventsUrl: () => "/api/events",
    invalidateHandshake: () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.equal(bootstrapCalls, 1);
    const source = FakeEventSource.instances.at(-1)!;
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
    await act(async () =>
      source.emitPi({
        type: "pi_chat_application_lifecycle",
        lifecycle: "idle",
      }),
    );
    assert.equal(
      bootstrapCalls,
      2,
      "lifecycle idle starts B's first bootstrap",
    );
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-b",
            workspaceEpoch: "epoch-b",
          }),
        }),
      ),
    );
    assert.equal(
      bootstrapCalls,
      2,
      "same-epoch ready joins B without consuming retry",
    );
    await act(async () => {
      rejectReplacementBootstrap(
        new Error("replacement bootstrap unavailable"),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-b",
            workspaceEpoch: "epoch-b",
          }),
        }),
      ),
    );
    assert.equal(
      bootstrapCalls,
      3,
      "the next idle starts the one preserved retry",
    );
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-b",
            workspaceEpoch: "epoch-b",
          }),
        }),
      ),
    );
    assert.equal(
      bootstrapCalls,
      3,
      "later idle frames cannot create a retry loop",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("maintenance replacement rejects an old Session Index response and still runs B's fallback", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  let rejectInitialBootstrap!: (cause: Error) => void;
  const initialBootstrap = new Promise<BootstrapData>((_resolve, reject) => {
    rejectInitialBootstrap = reject;
  });
  const pendingBootstrap = new Promise<BootstrapData>(() => undefined);
  let resolveOldInventory!: (value: {
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
  const oldSession = {
    ...bootstrap.sessions[0],
    id: "11111111111111111111",
    name: "Old inventory",
    cwd: "E:/old",
  };
  const replacementSession = {
    ...bootstrap.sessions[0],
    id: "22222222222222222222",
    name: "Replacement inventory",
    cwd: "D:/replacement",
  };
  let sessionReads = 0;
  let pendingAReads = 0;
  let replacementStarted = false;
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1 ? initialBootstrap : pendingBootstrap;
    },
    eventsUrl: () => "/api/events",
    sessions: async () => {
      sessionReads += 1;
      if (!replacementStarted) {
        pendingAReads += 1;
        return oldInventory;
      }
      return { sessions: [replacementSession], total: 1, directories: [] };
    },
    invalidateHandshake: () => undefined,
  });
  const browserSetTimeout = dom.window.setTimeout.bind(dom.window);
  const sidebarTimers: Array<() => void> = [];
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
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => {
      root.render(createElement(App));
      rejectInitialBootstrap(new Error("initial bootstrap unavailable"));
      await Promise.resolve();
    });
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-old",
            workspaceEpoch: "epoch-old",
          }),
        }),
      ),
    );
    assert.equal(bootstrapCalls, 2);
    await act(async () => {
      sidebarTimers.at(-1)!();
      await Promise.resolve();
    });
    assert.ok(
      pendingAReads >= 1,
      "A starts at least one pending Session Index read",
    );
    const sessionReadsBeforeReplacement = sessionReads;
    replacementStarted = true;
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
    await act(async () => {
      resolveOldInventory({
        sessions: [oldSession],
        total: 1,
        directories: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.doesNotMatch(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /Old inventory/,
    );
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-new",
            workspaceEpoch: "epoch-new",
          }),
        }),
      ),
    );
    assert.equal(bootstrapCalls, 3);
    await act(async () => {
      sidebarTimers.at(-1)!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(
      sessionReads > sessionReadsBeforeReplacement,
      "B starts an independent fallback after the old A inventory is detached",
    );
    assert.match(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /d:\/replacement1/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a replacement ready starts a new bootstrap instead of joining an old pending request", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const diagnostics = await import("../../src/web/lib/state-diagnostics");
  const diagnosticStartSequence = diagnostics.browserStateDiagnosticSnapshot().entries.at(-1)?.sequence || 0;
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
          workspaceCwd: "C:/old-default",
          workspaceEpoch: "epoch-old",
          workspaceRevision: 900,
        };
      if (bootstrapCalls === 2) return oldBootstrap;
      return {
        ...bootstrap,
        workspaceCwd: "D:/replacement-default",
        workspaceEpoch: "epoch-new",
        workspaceRevision: 0,
      };
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
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
      "resync leaves an old-process bootstrap in flight",
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
      "replacement ready must issue a bootstrap to the new service",
    );
    assert.equal(
      dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span"),
      null,
    );
    const newButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "New")!;
    await act(async () => newButton.click());
    assert.equal(
      dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent,
      "D:/replacement-default",
    );
    await act(async () => {
      resolveOldBootstrap({
        ...bootstrap,
        workspaceCwd: "C:/old-default",
        workspaceEpoch: "epoch-old",
        workspaceRevision: 900,
      });
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent,
      "D:/replacement-default",
      "the old bootstrap cannot overwrite the replacement epoch",
    );
    const rejection = diagnostics.browserStateDiagnosticSnapshot().entries
      .filter((entry) =>
        entry.sequence > diagnosticStartSequence &&
        entry.category === "projection" &&
        entry.name === "bootstrap-rejected",
      )
      .at(-1);
    assert.equal(rejection?.details.decisionReason, "stale-refresh-authority");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale old bootstrap cannot suppress replacement-ready recovery after its bootstrap fails", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  let resolveOldBootstrap!: (value: BootstrapData) => void;
  let rejectReplacementBootstrap!: (cause: Error) => void;
  const oldBootstrap = new Promise<BootstrapData>((resolve) => {
    resolveOldBootstrap = resolve;
  });
  const rejectedReplacementBootstrap = new Promise<BootstrapData>(
    (_resolve, reject) => {
      rejectReplacementBootstrap = reject;
    },
  );
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1)
        return {
          ...bootstrap,
          workspaceCwd: "C:/old-default",
          workspaceEpoch: "epoch-old",
          workspaceRevision: 900,
        };
      if (bootstrapCalls === 2) return oldBootstrap;
      if (bootstrapCalls === 3) return rejectedReplacementBootstrap;
      return {
        ...bootstrap,
        workspaceCwd: "D:/replacement-default",
        workspaceEpoch: "epoch-new",
        workspaceRevision: 0,
      };
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({ type: "pi_chat_sse_resync" });
      await Promise.resolve();
    });
    assert.equal(bootstrapCalls, 2);
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
      await Promise.resolve();
    });
    assert.equal(
      bootstrapCalls,
      3,
      "replacement ready starts its own bootstrap",
    );
    await act(async () => {
      rejectReplacementBootstrap(
        new Error("replacement bootstrap unavailable"),
      );
      await Promise.resolve();
    });
    await act(async () => {
      resolveOldBootstrap({
        ...bootstrap,
        workspaceCwd: "C:/old-default",
        workspaceEpoch: "epoch-old",
        workspaceRevision: 900,
      });
      await Promise.resolve();
    });
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
      4,
      "one same-epoch ready retries the failed replacement bootstrap",
    );
    const newButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "New")!;
    await act(async () => newButton.click());
    assert.equal(
      dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent,
      "D:/replacement-default",
    );
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-new",
            workspaceEpoch: "epoch-new",
          }),
        }),
      ),
    );
    assert.equal(
      bootstrapCalls,
      4,
      "the replacement epoch performs only one retry after its failed bootstrap",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
