import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { act, createElement } from "react";
import type { BootstrapData, SessionViewData } from "../src/shared/types";
import {
  activeSessionId as activeId,
  createBootstrapFixture,
  createSessionViewFixture,
} from "./fixtures/app-bootstrap";
import { captureApiSnapshot } from "./helpers/api-stub";
import { installAppDom as installDom } from "./helpers/app-dom";

let bootstrap: BootstrapData;
let draftView: SessionViewData;

beforeEach(() => {
  bootstrap = createBootstrapFixture();
  draftView = createSessionViewFixture();
});

test("foreground presence renews on ready, visible lifecycle events, stays quiet while hidden, and cleans up on unmount", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let renewals = 0;
  let relinquishments = 0;
  let closeSignals = 0;
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    renewPresence: async () => {
      renewals += 1;
      return { present: true as const };
    },
    relinquishPresence: async () => {
      relinquishments += 1;
      return { present: false as const };
    },
    signalWindowClose: () => {
      closeSignals += 1;
      return true;
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(renewals >= 1, "visible initial lifecycle renews presence");
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({ lifecycle: "idle" }),
        }),
      ),
    );
    assert.ok(renewals >= 2, "ready renews presence");
    const beforeFocus = renewals;
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("focus")),
    );
    assert.ok(renewals > beforeFocus, "focus renews presence");
    Object.defineProperty(dom.window.document, "hasFocus", {
      value: () => false,
      configurable: true,
    });
    const beforeBlur = renewals;
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("blur")),
    );
    assert.equal(
      relinquishments,
      0,
      "ordinary blur pauses renewal without immediately releasing foreground control",
    );
    assert.equal(
      closeSignals,
      0,
      "blur must not declare the browser window closed",
    );
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("focus")),
    );
    assert.equal(
      renewals,
      beforeBlur,
      "focus without document focus cannot renew foreground presence",
    );
    Object.defineProperty(dom.window.document, "hasFocus", {
      value: () => true,
      configurable: true,
    });
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("focus")),
    );
    assert.ok(
      renewals > beforeBlur,
      "a genuinely focused renderer renews presence",
    );
    const sourcesBeforeFailedRenewal = FakeEventSource.instances.length;
    Object.assign(api, {
      renewPresence: async () => {
        throw new Error("temporary presence failure");
      },
    });
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      dom.window.document.querySelector(".app-toast.error"),
      null,
      "best-effort presence failure must not become a visible error",
    );
    assert.equal(
      FakeEventSource.instances.length,
      sourcesBeforeFailedRenewal,
      "presence failure must not create a reconnect storm",
    );
    Object.assign(api, {
      renewPresence: async () => {
        renewals += 1;
        return { present: true as const };
      },
    });
    Object.defineProperty(dom.window.document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    const beforeHidden = renewals;
    await act(async () =>
      dom.window.document.dispatchEvent(
        new dom.window.Event("visibilitychange"),
      ),
    );
    assert.equal(renewals, beforeHidden, "hidden pages do not renew presence");
    Object.defineProperty(dom.window.document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("pageshow")),
    );
    assert.ok(renewals > beforeHidden, "pageshow renews presence");
    await act(async () =>
      dom.window.dispatchEvent(
        new dom.window.PageTransitionEvent("pagehide", { persisted: false }),
      ),
    );
    assert.equal(
      closeSignals,
      0,
      "pagehide can mean PWA backgrounding and must not declare a window closed",
    );
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("unload")),
    );
    assert.equal(
      closeSignals,
      1,
      "a real renderer unload declares the window closed",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a build mismatch blocks ordinary mutations but preserves server-guarded lifecycle recovery", async () => {
  assert.equal(
    process.env.NODE_ENV,
    "test",
    "此测试依赖受限的 Web identity override；请使用 `npm test` 或 `node scripts/run-tests.mjs` 运行。",
  );
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const testGlobal = globalThis as typeof globalThis & {
    __PI_CHAT_TEST_WEB_BUILD_IDENTITY__?: BootstrapData["buildIdentity"];
  };
  testGlobal.__PI_CHAT_TEST_WEB_BUILD_IDENTITY__ = {
    schemaVersion: 1,
    packageVersion: "test",
    revision: "test",
    fingerprint: "0".repeat(64),
    builtAt: "test",
  };
  let restartCalls = 0;
  let shutdownCalls = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      buildIdentity: {
        schemaVersion: 1,
        packageVersion: "test",
        revision: "test",
        fingerprint: "1".repeat(64),
        builtAt: "test",
      },
    }),
    eventsUrl: () => "/api/events",
    restart: async () => {
      restartCalls += 1;
      return { restarting: true as const };
    },
    shutdown: async () => {
      shutdownCalls += 1;
      return { shuttingDown: true as const };
    },
    waitForApplicationHandoff: async () => {
      throw new Error("test handoff unavailable");
    },
    markSessionViewed: async () => ({ viewing: activeId }),
    renewPresence: async () => ({ present: true as const }),
    signalWindowClose: () => true,
  });
  Object.defineProperty(dom.window, "confirm", {
    value: () => true,
    configurable: true,
  });
  Object.defineProperty(dom.window, "close", {
    value: () => undefined,
    configurable: true,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => {
      root.render(createElement(App));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(
      dom.window.document.body.textContent || "",
      /网页与服务版本不一致/,
    );
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>("textarea")
        ?.disabled,
      true,
      "ordinary prompt writes remain blocked",
    );
    const restart =
      dom.window.document.querySelector<HTMLButtonElement>(".restart-pi")!;
    assert.equal(
      restart.disabled,
      false,
      "the guarded restart recovery remains available",
    );
    await act(async () => {
      restart.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(restartCalls, 1);
    const settings =
      dom.window.document.querySelector<HTMLButtonElement>(".topbar-settings")!;
    await act(async () => settings.click());
    const workspacePicker =
      dom.window.document.querySelector<HTMLButtonElement>(
        "button[aria-label='选择默认工作路径']",
      )!;
    assert.equal(
      workspacePicker.disabled,
      true,
      "ordinary workspace changes remain blocked",
    );
    const shutdown =
      dom.window.document.querySelector<HTMLButtonElement>(
        ".settings-shutdown",
      )!;
    assert.equal(
      shutdown.disabled,
      false,
      "the guarded shutdown recovery remains available",
    );
    await act(async () => {
      shutdown.click();
      await Promise.resolve();
    });
    assert.equal(shutdownCalls, 1);
  } finally {
    await act(async () => root.unmount());
    delete testGlobal.__PI_CHAT_TEST_WEB_BUILD_IDENTITY__;
    restoreApi();
  }
});

test("a bootstrap without a restored Session opens a local New draft with the default workspace", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let createdSessions = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      activeSessionId: "",
      activeSessionIds: [],
      sessions: bootstrap.sessions.map((session) => ({
        ...session,
        active: false,
      })),
    }),
    eventsUrl: () => "/api/events",
    newSession: async () => {
      createdSessions += 1;
      return draftView;
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "新对话",
    );
    assert.equal(
      dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent,
      "C:/work",
    );
    assert.equal(
      createdSessions,
      0,
      "startup must not create an empty persisted Session",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a New draft can choose a recently used Session workspace from the path dropdown", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let createdSessions = 0;
  let pickerCalls = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      activeSessionId: "",
      activeSessionIds: [],
      sessions: [
        { ...bootstrap.sessions[0], id: "11111111111111111111", active: false, cwd: "C:/work", updatedAt: 10 },
        { ...bootstrap.sessions[0], id: "22222222222222222222", active: false, cwd: "D:/research", updatedAt: 40 },
        { ...bootstrap.sessions[0], id: "33333333333333333333", active: false, cwd: "d:\\RESEARCH\\", updatedAt: 20 },
      ],
      sessionDirectories: [
        { cwd: "E:/archived", count: 8, lastUserPromptAt: 60 },
        { cwd: "D:/research", count: 2, lastUserPromptAt: 40 },
        { cwd: "C:/work", count: 1, lastUserPromptAt: 10 },
      ],
    }),
    eventsUrl: () => "/api/events",
    newSession: async () => {
      createdSessions += 1;
      return draftView;
    },
    pickDraftWorkspace: async () => {
      pickerCalls += 1;
      return { cancelled: true };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".draft-workspace-select .compact-select-trigger",
    )!;
    assert.equal(trigger.disabled, false);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    await act(async () => trigger.click());
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    const options = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        ".draft-workspace-select .compact-select-option",
      ),
    ];
    assert.deepEqual(
      options.map((option) => option.textContent?.trim()),
      ["E:/archived", "D:/research", "C:/work"],
      "complete directory inventory is ordered and case-insensitive duplicates collapse",
    );
    await act(async () => options[1].click());
    assert.equal(
      trigger.querySelector("span")?.textContent,
      "D:/research",
    );
    assert.equal(createdSessions, 0, "quick selection remains a local draft mutation");
    assert.equal(pickerCalls, 0, "quick selection does not open the native folder picker");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a workspace SSE updates the default only for a later New draft", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    clearSessionViewed: async () => ({ viewing: "" }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const newButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "New")!;
    await act(async () => newButton.click());
    assert.equal(
      dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent,
      "C:/work",
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_workspace_changed",
        cwd: "D:/shared-default",
        workspaceEpoch: "epoch-a",
        workspaceRevision: 1,
      }),
    );
    assert.equal(
      dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent,
      "C:/work",
      "an existing draft retains its captured cwd",
    );
    await act(async () => newButton.click());
    assert.equal(
      dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent,
      "D:/shared-default",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale bootstrap cannot undo a newer workspace SSE default", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  let resolveStaleBootstrap!: (value: BootstrapData) => void;
  const staleBootstrap = new Promise<BootstrapData>((resolve) => {
    resolveStaleBootstrap = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1
        ? { ...bootstrap, workspaceEpoch: "workspace-a", workspaceRevision: 10 }
        : staleBootstrap;
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    clearSessionViewed: async () => ({ viewing: "" }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => source.emitPi({ type: "pi_chat_sse_resync" }));
    assert.equal(
      bootstrapCalls,
      2,
      "resync starts a refresh with stale global metadata",
    );
    await act(async () =>
      source.emitPi({
        type: "pi_chat_workspace_changed",
        cwd: "D:/newer-default",
        workspaceEpoch: "workspace-a",
        workspaceRevision: 11,
      }),
    );
    await act(async () => {
      resolveStaleBootstrap({
        ...bootstrap,
        workspaceCwd: "C:/work",
        workspaceEpoch: "workspace-a",
        workspaceRevision: 10,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    const newButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "New")!;
    await act(async () => newButton.click());
    assert.equal(
      dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent,
      "D:/newer-default",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

for (const terminal of ["ready", "failed"] as const) {
  test(`a same-generation stale bootstrap cannot overwrite Primary ${terminal} SSE`, async () => {
    const { dom, FakeEventSource } = installDom();
    const { createRoot } = await import("react-dom/client");
    const { api } = await import("../src/web/api");
    const { App } = await import("../src/web/App");
    const restoreApi = captureApiSnapshot(api);
    let bootstrapCalls = 0;
    let resolveStaleBootstrap!: (value: BootstrapData) => void;
    const staleBootstrap = new Promise<BootstrapData>((resolve) => {
      resolveStaleBootstrap = resolve;
    });
    Object.assign(api, {
      bootstrap: async () => {
        bootstrapCalls += 1;
        return bootstrapCalls === 1
          ? {
              ...bootstrap,
              primaryRuntime: { status: "starting" as const, generation: 7 },
            }
          : staleBootstrap;
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
      assert.equal(
        bootstrapCalls,
        2,
        "resync leaves an older bootstrap request in flight",
      );
      await act(async () => {
        source.emitPi({
          type: "pi_chat_primary_runtime_status",
          primaryRuntime:
            terminal === "ready"
              ? { status: "ready", generation: 7 }
              : { status: "failed", generation: 7, error: "worker exited" },
        });
        resolveStaleBootstrap({
          ...bootstrap,
          primaryRuntime: { status: "starting" as const, generation: 7 },
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      if (terminal === "ready") {
        const model = dom.window.document.querySelector<HTMLButtonElement>(
          ".composer-model-select .compact-select-trigger",
        )!;
        assert.equal(
          model.disabled,
          false,
          "same-generation starting must not relock ready controls",
        );
      } else {
        const status = dom.window.document.querySelector<HTMLElement>(
          ".primary-runtime-status",
        )!;
        assert.equal(
          status.classList.contains("is-failed"),
          true,
          "same-generation starting must not hide failure",
        );
        assert.match(status.textContent || "", /worker exited/);
      }
    } finally {
      await act(async () => root.unmount());
      restoreApi();
    }
  });
}

test("a replacement clears the old Primary readiness generation before accepting its lower generation", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  let resolveReplacementBootstrap!: (value: BootstrapData) => void;
  const pendingReplacementBootstrap = new Promise<BootstrapData>((resolve) => {
    resolveReplacementBootstrap = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1
        ? {
            ...bootstrap,
            workspaceEpoch: "epoch-a",
            primaryRuntime: { status: "ready" as const, generation: 7 },
          }
        : pendingReplacementBootstrap;
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    invalidateHandshake: () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const model = () =>
      dom.window.document.querySelector<HTMLButtonElement>(
        ".composer-model-select .compact-select-trigger",
      )!;
    assert.equal(
      model().disabled,
      false,
      "A's confirmed ready generation enables model settings",
    );
    const source = FakeEventSource.instances.at(-1)!;
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
    assert.equal(bootstrapCalls, 2);
    assert.equal(
      model().disabled,
      true,
      "B starts with no inherited ready capability",
    );
    assert.equal(
      dom.window.document
        .querySelector(".primary-runtime-status")
        ?.classList.contains("is-starting"),
      true,
    );
    await act(async () => {
      resolveReplacementBootstrap({
        ...bootstrap,
        workspaceEpoch: "epoch-b",
        primaryRuntime: { status: "starting", generation: 1 },
      });
      await Promise.resolve();
    });
    assert.equal(
      model().disabled,
      true,
      "B starting generation 1 remains blocked",
    );
    await act(async () =>
      source.emitPi({
        type: "pi_chat_primary_runtime_status",
        primaryRuntime: { status: "ready", generation: 1 },
      }),
    );
    assert.equal(
      model().disabled,
      false,
      "B ready generation 1 is accepted after the replacement reset",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a replacement process workspace epoch accepts its fresh default after an older high revision", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1
        ? {
            ...bootstrap,
            workspaceCwd: "C:/old-default",
            workspaceEpoch: "workspace-old",
            workspaceRevision: 900,
          }
        : {
            ...bootstrap,
            workspaceCwd: "D:/replacement-default",
            workspaceEpoch: "workspace-new",
            workspaceRevision: 0,
          };
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    clearSessionViewed: async () => ({ viewing: "" }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "workspace-new",
            workspaceEpoch: "workspace-new",
          }),
        }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
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

test("lifecycle idle consumes replacement bootstrap accounting before a later ready", async () => {
  for (const outcome of ["success", "failure"] as const) {
    const { dom, FakeEventSource } = installDom();
    const { createRoot } = await import("react-dom/client");
    const { api } = await import("../src/web/api");
    const { App } = await import("../src/web/App");
    const restoreApi = captureApiSnapshot(api);
    let bootstrapCalls = 0;
    let rejectReplacementBootstrap!: (cause: Error) => void;
    const rejectedReplacementBootstrap = new Promise<BootstrapData>(
      (_resolve, reject) => {
        rejectReplacementBootstrap = reject;
      },
    );
    Object.assign(api, {
      bootstrap: async () => {
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) return bootstrap;
        if (bootstrapCalls === 2 && outcome === "failure")
          return rejectedReplacementBootstrap;
        return { ...bootstrap, workspaceEpoch: `epoch-lifecycle-${outcome}` };
      },
      eventsUrl: () => "/api/events",
      markSessionViewed: async () => ({ viewing: activeId }),
      invalidateHandshake: () => undefined,
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
              piChatRunEpoch: `epoch-lifecycle-${outcome}`,
              workspaceEpoch: `epoch-lifecycle-${outcome}`,
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
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      assert.equal(
        bootstrapCalls,
        2,
        "lifecycle idle starts B's first bootstrap exactly once",
      );
      const newButton = [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.trim() === "New")!;
      assert.equal(
        newButton.disabled,
        false,
        "lifecycle idle immediately releases maintenance locks",
      );
      if (outcome === "failure") {
        await act(async () => {
          rejectReplacementBootstrap(
            new Error("B lifecycle bootstrap unavailable"),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      await act(async () => {
        source.dispatchEvent(
          new dom.window.MessageEvent("ready", {
            data: JSON.stringify({
              lifecycle: "idle",
              piChatRunEpoch: `epoch-lifecycle-${outcome}`,
              workspaceEpoch: `epoch-lifecycle-${outcome}`,
            }),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        bootstrapCalls,
        outcome === "failure" ? 3 : 2,
        "ready does not duplicate a successful lifecycle bootstrap and retries one failed B bootstrap",
      );
      await act(async () =>
        source.dispatchEvent(
          new dom.window.MessageEvent("ready", {
            data: JSON.stringify({
              lifecycle: "idle",
              piChatRunEpoch: `epoch-lifecycle-${outcome}`,
              workspaceEpoch: `epoch-lifecycle-${outcome}`,
            }),
          }),
        ),
      );
      assert.equal(
        bootstrapCalls,
        outcome === "failure" ? 3 : 2,
        "repeated ready remains bounded",
      );
    } finally {
      await act(async () => root.unmount());
      restoreApi();
    }
  }
});

test("a stale bootstrap rejection during replacement maintenance cannot surface an A error", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
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
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
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
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
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
    const { api } = await import("../src/web/api");
    const { App } = await import("../src/web/App");
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

test("replacement idle releases maintenance locks before a rejected bootstrap and bounds retry", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
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
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
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
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
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
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
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
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale old bootstrap cannot suppress replacement-ready recovery after its bootstrap fails", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
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

test("a replacement invalidates an old early handshake and starts a fresh history request", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "abcdef0123456789abcd";
  dom.window.history.replaceState(null, "", `/?session=${coldId}`);
  let bootstrapCalls = 0;
  let resolveOldHandshake!: (
    value: Awaited<ReturnType<typeof api.handshake>>,
  ) => void;
  let resolveNewHandshake!: (
    value: Awaited<ReturnType<typeof api.handshake>>,
  ) => void;
  const oldHandshake = new Promise<Awaited<ReturnType<typeof api.handshake>>>(
    (resolve) => {
      resolveOldHandshake = resolve;
    },
  );
  const newHandshake = new Promise<Awaited<ReturnType<typeof api.handshake>>>(
    (resolve) => {
      resolveNewHandshake = resolve;
    },
  );
  let rejectInitialBootstrap!: (cause: Error) => void;
  const rejectedInitialBootstrap = new Promise<BootstrapData>(
    (_resolve, reject) => {
      rejectInitialBootstrap = reject;
    },
  );
  const pendingBootstrap = new Promise<BootstrapData>(() => undefined);
  const acceptedTokens: string[] = [];
  let handshakeCalls = 0;
  let viewCalls = 0;
  const view = (content: string): SessionViewData => ({
    ...draftView,
    session: {
      ...draftView.session,
      id: coldId,
      sessionId: "remembered",
      name: "Replacement history",
      messageCount: 2,
      active: false,
      writable: false,
    },
    state: { ...draftView.state, sessionId: coldId },
    messages: [{ role: "assistant", content }],
    messageTotal: 2,
    runtimeStatus: "view-only",
    isActive: false,
  });
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1 ? rejectedInitialBootstrap : pendingBootstrap;
    },
    handshake: async () => {
      handshakeCalls += 1;
      return handshakeCalls === 1 ? oldHandshake : newHandshake;
    },
    acceptHandshake: (handshake: Awaited<ReturnType<typeof api.handshake>>) => {
      acceptedTokens.push(handshake.requestToken);
    },
    invalidateHandshake: () => undefined,
    eventsUrl: () => "/api/events",
    viewSession: async () => {
      viewCalls += 1;
      return view("replacement history");
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
    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-old",
            workspaceEpoch: "epoch-old",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    assert.equal(
      bootstrapCalls,
      2,
      "A ready begins its pending recovery bootstrap",
    );
    assert.equal(
      handshakeCalls,
      1,
      "the old refresh begins its delayed handshake",
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
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    assert.equal(bootstrapCalls, 3, "replacement starts a distinct bootstrap");
    assert.equal(
      handshakeCalls,
      2,
      "replacement starts a fresh handshake instead of joining A",
    );
    await act(async () => {
      resolveNewHandshake({
        requestToken: "token-new",
        buildIdentity: {
          schemaVersion: 1,
          packageVersion: "test",
          revision: "new",
          fingerprint: "0".repeat(64),
          builtAt: "new",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      viewCalls,
      1,
      "the replacement performs its own early history view",
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /replacement history/,
    );
    assert.deepEqual(acceptedTokens, ["token-new"]);
    await act(async () => {
      resolveOldHandshake({
        requestToken: "token-old",
        buildIdentity: {
          schemaVersion: 1,
          packageVersion: "test",
          revision: "old",
          fingerprint: "1".repeat(64),
          builtAt: "old",
        },
      });
      await Promise.resolve();
    });
    assert.equal(
      viewCalls,
      1,
      "an old handshake cannot send an old-token history request",
    );
    assert.deepEqual(
      acceptedTokens,
      ["token-new"],
      "an old handshake cannot restore its token",
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /replacement history/,
    );
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /网页与服务版本不一致/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a replacement clears old sidebar inventory so its slow bootstrap still uses Session Index", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  let sessionReads = 0;
  const pendingReplacementBootstrap = new Promise<BootstrapData>(
    () => undefined,
  );
  const replacementSession = {
    ...bootstrap.sessions[0],
    id: "22222222222222222222",
    sessionId: "replacement",
    name: "Replacement row",
    cwd: "D:/replacement",
    active: false,
  };
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1 ? bootstrap : pendingReplacementBootstrap;
    },
    eventsUrl: () => "/api/events",
    sessions: async () => {
      sessionReads += 1;
      return { sessions: [replacementSession], total: 1, directories: [] };
    },
    markSessionViewed: async () => ({ viewing: activeId }),
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
    assert.match(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /Active/,
    );
    const source = FakeEventSource.instances.at(-1)!;
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
    assert.equal(bootstrapCalls, 2);
    assert.ok(
      sidebarTimers.length >= 2,
      "the replacement schedules a fresh Session Index fallback after the cleared A timer",
    );
    const readsBeforeReplacementFallback = sessionReads;
    await act(async () => {
      sidebarTimers.at(-1)!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(
      sessionReads > readsBeforeReplacementFallback,
      "A's completed inventory cannot suppress B's fallback",
    );
    assert.match(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /d:\/replacement1/,
    );
    assert.doesNotMatch(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /c:\/work1/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a same-epoch recovery refresh detaches an older early handshake and paints cold history", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "abcdef0123456789abcd";
  dom.window.history.replaceState(null, "", `/?session=${coldId}`);
  let bootstrapCalls = 0;
  let rejectInitialBootstrap!: (cause: Error) => void;
  const initialBootstrap = new Promise<BootstrapData>((_resolve, reject) => {
    rejectInitialBootstrap = reject;
  });
  const pendingRecoveryBootstrap = new Promise<BootstrapData>(() => undefined);
  let resolveFirstHandshake!: (
    value: Awaited<ReturnType<typeof api.handshake>>,
  ) => void;
  let resolveSecondHandshake!: (
    value: Awaited<ReturnType<typeof api.handshake>>,
  ) => void;
  const firstHandshake = new Promise<Awaited<ReturnType<typeof api.handshake>>>(
    (resolve) => {
      resolveFirstHandshake = resolve;
    },
  );
  const secondHandshake = new Promise<
    Awaited<ReturnType<typeof api.handshake>>
  >((resolve) => {
    resolveSecondHandshake = resolve;
  });
  let handshakeCalls = 0;
  let viewCalls = 0;
  const coldView: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: coldId,
      sessionId: "remembered",
      name: "Recovered cold",
      messageCount: 2,
      active: false,
      writable: false,
    },
    state: { ...draftView.state, sessionId: coldId },
    messages: [{ role: "assistant", content: "recovered cold history" }],
    messageTotal: 2,
    runtimeStatus: "view-only",
    isActive: false,
  };
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1 ? initialBootstrap : pendingRecoveryBootstrap;
    },
    handshake: async () => {
      handshakeCalls += 1;
      return handshakeCalls === 1 ? firstHandshake : secondHandshake;
    },
    acceptHandshake: () => undefined,
    eventsUrl: () => "/api/events",
    viewSession: async () => {
      viewCalls += 1;
      return coldView;
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    assert.equal(
      handshakeCalls,
      1,
      "R1 starts its early handshake before bootstrap fails",
    );
    await act(async () => {
      rejectInitialBootstrap(new Error("initial bootstrap unavailable"));
      await Promise.resolve();
    });
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-a",
            workspaceEpoch: "epoch-a",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    assert.equal(
      bootstrapCalls,
      2,
      "ready starts the slow same-epoch recovery bootstrap",
    );
    assert.equal(
      handshakeCalls,
      2,
      "R2 must detach from R1 and begin its own handshake",
    );
    await act(async () => {
      resolveFirstHandshake({
        requestToken: "token-r1",
        buildIdentity: {
          schemaVersion: 1,
          packageVersion: "test",
          revision: "r1",
          fingerprint: "1".repeat(64),
          builtAt: "r1",
        },
      });
      await Promise.resolve();
    });
    assert.equal(
      viewCalls,
      0,
      "the old handshake cannot produce an old early view",
    );
    await act(async () => {
      resolveSecondHandshake({
        requestToken: "token-r2",
        buildIdentity: {
          schemaVersion: 1,
          packageVersion: "test",
          revision: "r2",
          fingerprint: "0".repeat(64),
          builtAt: "r2",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      viewCalls,
      1,
      "R2's fresh handshake reads the remembered JSONL history",
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /recovered cold history/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("ChatInput keeps an unsent draft and image attachment across Session navigation", async () => {
  const { dom } = installDom();
  Object.assign(globalThis, {
    FileReader: dom.window.FileReader,
    File: dom.window.File,
  });
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "draft-preservation-123";
  const imageModel = {
    ...bootstrap.state.model!,
    input: ["text", "image"],
  };
  const secondView: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: secondId,
      sessionId: "draft-preservation",
      name: "Draft preservation",
      active: false,
      writable: false,
    },
    state: {
      ...draftView.state,
      model: imageModel,
      sessionId: "draft-preservation",
    },
    runtimeStatus: "view-only",
    isActive: false,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, model: imageModel },
      models: [imageModel],
      sessions: [...bootstrap.sessions, secondView.session],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) =>
      id === secondId ? secondView : draftView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "keep this unsent draft");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "keep this unsent draft",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".attachment-button")!
        .click();
    });
    await act(async () => {
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".attachment-menu [role='menuitem']",
        ),
      ]
        .find((button) => button.textContent?.includes("图片"))!
        .click();
      const fileInput =
        dom.window.document.querySelector<HTMLInputElement>(
          "input[type='file']",
        )!;
      Object.defineProperty(fileInput, "files", {
        configurable: true,
        value: [
          new dom.window.File(["image"], "keep.png", { type: "image/png" }),
        ],
      });
      fileInput.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
      const deadline = Date.now() + 250;
      while (
        !dom.window.document.querySelector(
          ".image-preview img[alt='keep.png']",
        ) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
    });
    assert.equal(textarea.value, "keep this unsent draft");
    assert.ok(
      dom.window.document.querySelector(".image-preview img[alt='keep.png']"),
    );
    const sessionButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((button) => button.textContent?.includes("Draft preservation"))!;
    await act(async () => sessionButton.click());
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ]
        .find((button) => button.textContent?.includes("Active"))!
        .click(),
    );
    const afterNavigation =
      dom.window.document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='消息输入']",
      )!;
    assert.equal(
      afterNavigation,
      textarea,
      "the unkeyed ChatInput must not remount",
    );
    assert.equal(afterNavigation.value, "keep this unsent draft");
    assert.ok(
      dom.window.document.querySelector(".image-preview img[alt='keep.png']"),
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("loading earlier history is isolated per Session across a pane switch", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "11111111111111111111";
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "second",
    name: "History B",
    active: false,
  };
  const recent = (label: string): SessionViewData => ({
    ...draftView,
    session: label === "A" ? bootstrap.sessions[0] : summaryB,
    state: { ...bootstrap.state, sessionId: label.toLowerCase() },
    messages: [{ role: "user", content: `${label} recent` }],
    messageTotal: 40,
    turnTotal: 20,
    visibleTurnCount: 10,
    messagesTruncated: true,
    isActive: label === "A",
    runtimeStatus: label === "A" ? "active" : "view-only",
  });
  const expanded = (label: string): SessionViewData => ({
    ...recent(label),
    messages: [
      { role: "user", content: `${label} older` },
      { role: "user", content: `${label} recent` },
    ],
    visibleTurnCount: 20,
    messagesTruncated: false,
  });
  let resolveA!: (view: SessionViewData) => void;
  let resolveB!: (view: SessionViewData) => void;
  const earlierA = new Promise<SessionViewData>((resolve) => {
    resolveA = resolve;
  });
  const earlierB = new Promise<SessionViewData>((resolve) => {
    resolveB = resolve;
  });
  const earlierCalls: string[] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      messages: recent("A").messages,
      messageTotal: 40,
      turnTotal: 20,
      visibleTurnCount: 10,
      messagesTruncated: true,
      sessions: [bootstrap.sessions[0], summaryB],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string, turns?: number) => {
      if (!turns) return id === secondId ? recent("B") : recent("A");
      earlierCalls.push(id);
      return id === secondId ? earlierB : earlierA;
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const loadButton = () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => /加载更早|正在加载/.test(button.textContent || ""))!;
    await act(async () => {
      loadButton().click();
      await Promise.resolve();
    });
    assert.deepEqual(earlierCalls, [activeId]);

    const secondButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((button) => button.textContent?.includes("History B"))!;
    await act(async () => secondButton.click());
    assert.match(dom.window.document.body.textContent || "", /B recent/);
    await act(async () => {
      loadButton().click();
      await Promise.resolve();
    });
    assert.deepEqual(
      earlierCalls,
      [activeId, secondId],
      "B starts its own history request while A is still pending",
    );

    await act(async () => {
      resolveA(expanded("A"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      loadButton().textContent,
      "正在加载…",
      "A completion cannot clear B's loading lease",
    );
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /A older/,
      "A's late page cannot replace B",
    );

    await act(async () => {
      resolveB(expanded("B"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(dom.window.document.body.textContent || "", /B older/);
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /正在加载…/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an old history request cannot affect a later visit to the same Session", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "22222222222222222222";
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "second",
    name: "History B",
    active: false,
  };
  const view = (
    id: string,
    content: string,
    truncated = true,
  ): SessionViewData => ({
    ...draftView,
    session: id === activeId ? bootstrap.sessions[0] : summaryB,
    state: { ...bootstrap.state, sessionId: id },
    messages: [{ role: "user", content }],
    messageTotal: 40,
    turnTotal: 20,
    visibleTurnCount: truncated ? 10 : 20,
    messagesTruncated: truncated,
    isActive: id === activeId,
    runtimeStatus: id === activeId ? "active" : "view-only",
  });
  let resolveOldA!: (value: SessionViewData) => void;
  let resolveNewA!: (value: SessionViewData) => void;
  const oldA = new Promise<SessionViewData>((resolve) => {
    resolveOldA = resolve;
  });
  const newA = new Promise<SessionViewData>((resolve) => {
    resolveNewA = resolve;
  });
  let aEarlierCalls = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      messages: view(activeId, "A recent").messages,
      messageTotal: 40,
      turnTotal: 20,
      visibleTurnCount: 10,
      messagesTruncated: true,
      sessions: [bootstrap.sessions[0], summaryB],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string, turns?: number) => {
      if (id === activeId && turns === 20) {
        aEarlierCalls += 1;
        return aEarlierCalls === 1 ? oldA : newA;
      }
      return id === activeId
        ? view(activeId, "A recent")
        : view(secondId, "B recent");
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const loadButton = () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => /加载更早|正在加载/.test(button.textContent || ""))!;
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => {
      loadButton().click();
      await Promise.resolve();
    });
    await act(async () => sessionButton("History B").click());
    await act(async () => sessionButton("Active").click());
    await act(async () => {
      loadButton().click();
      await Promise.resolve();
    });
    assert.equal(
      aEarlierCalls,
      2,
      "the later visit starts a fresh A history request",
    );

    await act(async () => {
      resolveOldA(view(activeId, "A stale older", false));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      loadButton().textContent,
      "正在加载…",
      "the old visit cannot clear the new visit's lease",
    );
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /A stale older/,
    );

    await act(async () => {
      resolveNewA(view(activeId, "A current older", false));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(dom.window.document.body.textContent || "", /A current older/);
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /正在加载…/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a fast bootstrap restores its remembered active Session without a competing view request", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  dom.window.history.replaceState(null, "", `/?session=${activeId}`);
  let viewCalls = 0;
  let bootstrapCalls = 0;
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrap;
    },
    eventsUrl: () => "/api/events",
    viewSession: async () => {
      viewCalls += 1;
      return draftView;
    },
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => {
      root.render(createElement(App));
      await new Promise((resolve) => setTimeout(resolve, 140));
    });
    assert.equal(
      viewCalls,
      0,
      "the bootstrap-selected Primary must not race a redundant /view request",
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-a",
          }),
        }),
      ),
    );
    assert.equal(
      bootstrapCalls,
      1,
      "initial ready after a successful bootstrap must not repeat it",
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Active",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("remembered cold history paints before global bootstrap finishes while mutations stay disabled", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "abcdef0123456789abcd";
  dom.window.history.replaceState(null, "", `/?session=${coldId}`);
  const cold: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: coldId,
      sessionId: "remembered-cold",
      name: "Remembered cold",
      messageCount: 2,
      active: false,
      writable: false,
    },
    messages: [
      { role: "user", content: "remembered question" },
      { role: "assistant", content: "remembered answer" },
    ],
    messageTotal: 2,
    runtimeStatus: "view-only",
    isActive: false,
    viewSource: "cold-jsonl",
  };
  let resolveBootstrap!: (value: BootstrapData) => void;
  const pendingBootstrap = new Promise<BootstrapData>((resolve) => {
    resolveBootstrap = resolve;
  });
  let coldViews = 0;
  Object.assign(api, {
    handshake: async () => ({
      requestToken: "test-token",
      buildIdentity: {
        schemaVersion: 1,
        packageVersion: "test",
        revision: "test",
        fingerprint: "0".repeat(64),
        builtAt: "test",
      },
    }),
    bootstrap: async () => pendingBootstrap,
    eventsUrl: () => "/api/events",
    viewSession: async (id: string) => {
      assert.equal(id, coldId);
      coldViews += 1;
      return cold;
    },
    markSessionViewed: async () => ({ viewing: coldId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 140));
    });
    assert.match(
      dom.window.document.body.textContent || "",
      /remembered answer/,
    );
    assert.equal(coldViews, 1);
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='消息输入']",
      )?.disabled,
      true,
      "history may paint early but mutations wait for bootstrap identity/readiness",
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Remembered cold",
      "an early committed JSONL pane owns its title before sidebar inventory arrives",
    );
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      0,
      "a remembered pane cannot become a fake one-row sidebar before bootstrap inventory arrives",
    );
    assert.match(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /正在加载对话…/,
      "an unconfirmed inventory must not claim that history is empty",
    );

    await act(async () => {
      resolveBootstrap({
        ...bootstrap,
        sessions: [...bootstrap.sessions, cold.session],
        sessionsTotal: 2,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(
      dom.window.document.body.textContent || "",
      /remembered answer/,
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Remembered cold",
    );
    assert.equal(
      coldViews,
      1,
      "bootstrap reuses the in-flight remembered view instead of reading it twice",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("initial idle ready retries one rejected bootstrap and restores the page projection", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) throw new Error("bootstrap unavailable");
      return bootstrap;
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
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-a",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      bootstrapCalls,
      2,
      "the first healthy ready retries a failed initial bootstrap once",
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Active",
    );
    const model = dom.window.document.querySelector<HTMLButtonElement>(
      ".composer-model-select .compact-select-trigger",
    )!;
    assert.equal(
      model.disabled,
      false,
      "the successful retry restores Primary capability metadata",
    );
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-a",
          }),
        }),
      ),
    );
    assert.equal(
      bootstrapCalls,
      2,
      "repeated initial ready frames cannot create a retry loop",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an initial ready consumes its only retry even when that retry fails", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      throw new Error("bootstrap unavailable");
    },
    eventsUrl: () => "/api/events",
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.equal(bootstrapCalls, 1);
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-a",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(bootstrapCalls, 2, "first ready uses the one initial retry");
    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-a",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      bootstrapCalls,
      2,
      "a failed initial retry cannot loop on later ready frames",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a slow bootstrap still completes the sidebar inventory through its independent Session Index read", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const pendingBootstrap = new Promise<BootstrapData>(() => undefined);
  let sessionReads = 0;
  Object.assign(api, {
    bootstrap: async () => pendingBootstrap,
    eventsUrl: () => "/api/events",
    sessions: async () => {
      sessionReads += 1;
      return {
        sessions: bootstrap.sessions,
        total: 1,
        directories: [],
      };
    },
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
    assert.equal(
      sidebarTimers.length,
      1,
      "slow bootstrap schedules its independent sidebar read",
    );
    await act(async () => {
      sidebarTimers[0]!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      sessionReads,
      1,
      "the fallback performs one JSONL-only inventory read",
    );
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      1,
    );
    assert.doesNotMatch(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /正在加载对话…/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a rejected bootstrap does not discard an already-started sidebar inventory fallback", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let rejectBootstrap!: (cause: Error) => void;
  let resolveSessions!: (value: {
    sessions: typeof bootstrap.sessions;
    total: number;
    directories: [];
  }) => void;
  const pendingBootstrap = new Promise<BootstrapData>((_resolve, reject) => {
    rejectBootstrap = reject;
  });
  const pendingSessions = new Promise<{
    sessions: typeof bootstrap.sessions;
    total: number;
    directories: [];
  }>((resolve) => {
    resolveSessions = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => pendingBootstrap,
    eventsUrl: () => "/api/events",
    sessions: async () => pendingSessions,
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
    assert.equal(sidebarTimers.length, 1);
    await act(async () => {
      sidebarTimers[0]!();
      await Promise.resolve();
    });
    await act(async () => {
      rejectBootstrap(new Error("bootstrap unavailable"));
      await Promise.resolve();
    });
    await act(async () => {
      resolveSessions({
        sessions: bootstrap.sessions,
        total: 1,
        directories: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      1,
    );
    assert.doesNotMatch(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /正在加载对话…/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a bootstrap rejected before the sidebar delay leaves its independent inventory timer active", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let rejectBootstrap!: (cause: Error) => void;
  const pendingBootstrap = new Promise<BootstrapData>((_resolve, reject) => {
    rejectBootstrap = reject;
  });
  let sessionReads = 0;
  Object.assign(api, {
    bootstrap: async () => pendingBootstrap,
    eventsUrl: () => "/api/events",
    sessions: async () => {
      sessionReads += 1;
      return { sessions: bootstrap.sessions, total: 1, directories: [] };
    },
  });
  const browserSetTimeout = dom.window.setTimeout.bind(dom.window);
  const browserClearTimeout = dom.window.clearTimeout.bind(dom.window);
  const sidebarTimers: Array<() => void> = [];
  const clearedSidebarTimers: number[] = [];
  Object.defineProperty(dom.window, "setTimeout", {
    configurable: true,
    value(callback: TimerHandler, delay?: number) {
      if (delay === 250 && typeof callback === "function") {
        sidebarTimers.push(callback);
        return 91;
      }
      return browserSetTimeout(callback, delay);
    },
  });
  Object.defineProperty(dom.window, "clearTimeout", {
    configurable: true,
    value(id?: number) {
      if (id === 91) clearedSidebarTimers.push(id);
      else browserClearTimeout(id);
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.equal(sidebarTimers.length, 1);
    await act(async () => {
      rejectBootstrap(
        new Error("bootstrap unavailable before sidebar fallback"),
      );
      await Promise.resolve();
    });
    assert.deepEqual(
      clearedSidebarTimers,
      [],
      "a bootstrap failure must not cancel the pending Session Index fallback",
    );
    await act(async () => {
      sidebarTimers[0]!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(
      sessionReads >= 1,
      "the original independent fallback still reads Session Index after rejection",
    );
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      1,
    );
    assert.doesNotMatch(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /正在加载对话…/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("opening a cold conversation paints JSONL without starting a dedicated Runtime", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "abcdef0123456789abcd";
  const cold: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: coldId,
      sessionId: "cold",
      name: "Cold",
      messageCount: 1,
      active: false,
      writable: false,
    },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let activations = 0;
  let coldViews = 0;
  let resolveActivation!: (view: SessionViewData) => void;
  const activation = new Promise<SessionViewData>((resolve) => {
    resolveActivation = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [...bootstrap.sessions, cold.session],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => {
      if (id === coldId) {
        coldViews += 1;
        return cold;
      }
      return {
        ...draftView,
        session: bootstrap.sessions[0],
        state: bootstrap.state,
        isActive: true,
        runtimeStatus: "active" as const,
      };
    },
    warmSession: async () => {
      activations += 1;
      await activation;
      return {
        sessionId: coldId,
        state: cold.state,
        gateMode: "strict" as const,
      };
    },
    prompt: async () => ({ accepted: true, queued: false }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const coldRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((row) => row.textContent?.includes("Cold"));
    assert.ok(coldRow);
    await act(async () =>
      coldRow.querySelector<HTMLButtonElement>(".session-item")?.click(),
    );
    assert.equal(coldViews, 1);
    const activeRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((row) => row.textContent?.includes("Active"));
    assert.ok(activeRow);
    await act(async () =>
      activeRow.querySelector<HTMLButtonElement>(".session-item")?.click(),
    );
    await act(async () =>
      coldRow.querySelector<HTMLButtonElement>(".session-item")?.click(),
    );
    assert.equal(
      coldViews,
      1,
      "a fresh stable cold pane reopens from data cache without another JSONL request",
    );
    const input = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => input.focus());
    assert.equal(
      activations,
      0,
      "passive JSONL browsing and focus must not warm a dedicated Runtime",
    );

    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(input, "first cold message");
      input.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "first cold message",
        }),
      );
    });
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")
        ?.click(),
    );
    assert.equal(activations, 1);
    assert.match(
      dom.window.document.body.textContent || "",
      /first cold message/,
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /正在准备 Pi，消息会自动发送/,
    );
    assert.equal(
      coldRow
        .querySelector(".session-status")
        ?.classList.contains("is-running"),
      false,
    );

    await act(async () =>
      resolveActivation({ ...cold, isActive: true, runtimeStatus: "active" }),
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a cold image prompt prepares its Runtime before validating model support", async () => {
  const { dom } = installDom();
  Object.assign(globalThis, { FileReader: dom.window.FileReader });
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "cold-image-1234567890";
  const imageModel = {
    provider: "archive",
    id: "cold-image-model",
    name: "Cold image model",
    input: ["text", "image"],
    reasoning: true,
  };
  const cold: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: coldId,
      sessionId: "cold-image",
      name: "Cold image",
      messageCount: 2,
      active: false,
      writable: false,
    },
    state: { ...draftView.state, sessionId: "cold-image", model: imageModel },
    isActive: false,
    runtimeStatus: "view-only",
  };
  let warmCalls = 0;
  const promptCalls: unknown[][] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      models: [...bootstrap.models, imageModel],
      sessions: [...bootstrap.sessions, cold.session],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => (id === coldId ? cold : draftView),
    warmSession: async () => {
      warmCalls += 1;
      return {
        sessionId: coldId,
        state: { ...cold.state, isStreaming: false },
        gateMode: "strict" as const,
      };
    },
    prompt: async (...args: unknown[]) => {
      promptCalls.push(args);
      return { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const row = [...dom.window.document.querySelectorAll<HTMLElement>(".session-row")]
      .find((candidate) => candidate.textContent?.includes("Cold image"));
    assert.ok(row);
    await act(async () =>
      row.querySelector<HTMLButtonElement>(".session-item")?.click(),
    );
    const fileInput = dom.window.document.querySelector<HTMLInputElement>(
      "input[type='file']",
    )!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new dom.window.File(["image"], "cold.png", { type: "image/png" })],
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      const deadline = Date.now() + 250;
      while (!dom.window.document.querySelector(".image-preview") && Date.now() < deadline)
        await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
    });
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "cold image prompt");
      textarea.dispatchEvent(new dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "cold image prompt",
      }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(warmCalls, 1);
    assert.equal(promptCalls.length, 1);
    assert.equal((promptCalls[0]?.[1] as unknown[])?.length, 1);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a background completed reply becomes green until this browser opens the conversation", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const backgroundId = "abcdef0123456789abcd";
  const background: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: backgroundId,
      sessionId: "background",
      name: "Background",
      messageCount: 2,
      active: true,
      writable: true,
    },
    messages: [
      { role: "user", content: "question" },
      { role: "assistant", content: "completed reply" },
    ],
    messageTotal: 2,
    turnTotal: 1,
  };
  let resolveBackgroundView!: (view: SessionViewData) => void;
  const pendingBackgroundView = new Promise<SessionViewData>((resolve) => {
    resolveBackgroundView = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [
        ...bootstrap.sessions,
        { ...background.session, active: true },
      ],
      sessionsTotal: 2,
      activeSessionIds: [activeId, backgroundId],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) =>
      id === backgroundId ? pendingBackgroundView : draftView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "message_end",
        piChatSessionId: backgroundId,
        message: { role: "assistant", content: "completed reply" },
      }),
    );
    await act(async () =>
      source.emitPi({ type: "agent_settled", piChatSessionId: backgroundId }),
    );
    const backgroundRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((row) => row.textContent?.includes("Background"));
    assert.ok(backgroundRow);
    assert.equal(
      backgroundRow
        .querySelector(".session-status")
        ?.classList.contains("is-unread"),
      true,
    );

    await act(async () =>
      backgroundRow.querySelector<HTMLButtonElement>(".session-item")?.click(),
    );
    assert.equal(
      backgroundRow
        .querySelector(".session-status")
        ?.classList.contains("is-unread"),
      false,
      "selection consumes the green marker immediately",
    );
    assert.equal(
      backgroundRow
        .querySelector(".session-status")
        ?.classList.contains("is-running"),
      false,
      "a delayed stale view must not replace green with a blue running ring",
    );
    await act(async () =>
      resolveBackgroundView({
        ...background,
        session: { ...background.session, running: true },
        state: { ...background.state, isStreaming: true },
        isStreaming: true,
      }),
    );
    const openedRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((row) => row.textContent?.includes("Background"));
    assert.ok(openedRow);
    assert.equal(
      openedRow
        .querySelector(".session-status")
        ?.classList.contains("is-running"),
      false,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("opening an unread conversation preserves a newer running state", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const backgroundId = "unread-running-123456";
  const background: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: backgroundId,
      sessionId: "unread-running",
      name: "Unread then running",
      messageCount: 2,
      active: true,
      writable: true,
    },
    messages: [
      { role: "user", content: "question" },
      { role: "assistant", content: "completed reply" },
    ],
    messageTotal: 2,
    turnTotal: 1,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [...bootstrap.sessions, background.session],
      sessionsTotal: 2,
      activeSessionIds: [activeId, backgroundId],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) =>
      id === backgroundId ? background : draftView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "message_end",
        piChatSessionId: backgroundId,
        message: { role: "assistant", content: "completed reply" },
      });
      source.emitPi({ type: "agent_settled", piChatSessionId: backgroundId });
      source.emitPi({ type: "agent_start", piChatSessionId: backgroundId });
    });
    const row = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((candidate) =>
      candidate.textContent?.includes("Unread then running"),
    );
    assert.ok(row);
    assert.equal(
      row.querySelector(".session-status")?.classList.contains("is-running"),
      true,
    );

    await act(async () =>
      row.querySelector<HTMLButtonElement>(".session-item")?.click(),
    );
    assert.equal(
      row.querySelector(".session-status")?.classList.contains("is-unread"),
      false,
    );
    assert.equal(
      row.querySelector(".session-status")?.classList.contains("is-running"),
      true,
      "selection must not overwrite a newer agent_start with settled=false",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a reply viewed before settlement does not become unread after leaving", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const backgroundId = "viewed-before-settle";
  const background: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: backgroundId,
      sessionId: "viewed-before-settle",
      name: "Viewed before settle",
      messageCount: 2,
      active: true,
      writable: true,
    },
    messages: [
      { role: "user", content: "question" },
      { role: "assistant", content: "reply already inspected" },
    ],
    messageTotal: 2,
    turnTotal: 1,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [...bootstrap.sessions, background.session],
      sessionsTotal: 2,
      activeSessionIds: [activeId, backgroundId],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) =>
      id === backgroundId ? background : draftView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "message_end",
        piChatSessionId: backgroundId,
        message: { role: "assistant", content: "reply already inspected" },
      }),
    );
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name));
    await act(async () => sessionButton("Viewed before settle")?.click());
    await act(async () => sessionButton("Active")?.click());
    await act(async () =>
      source.emitPi({ type: "agent_settled", piChatSessionId: backgroundId }),
    );

    const backgroundRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((row) => row.textContent?.includes("Viewed before settle"));
    assert.ok(backgroundRow);
    assert.equal(
      backgroundRow
        .querySelector(".session-status")
        ?.classList.contains("is-unread"),
      false,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale sidebar snapshot cannot restore the running spinner after settlement", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const backgroundId = "running-stale-012345";
  const background = {
    ...draftView.session,
    id: backgroundId,
    sessionId: "running-stale",
    name: "Previously running",
    messageCount: 2,
    active: true,
    writable: true,
  };
  let staleExecution: "running" | "dispatching" = "running";
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [
        ...bootstrap.sessions,
        {
          ...background,
          running: true,
          activity: {
            execution: staleExecution,
            awaitingConfirmation: false,
          },
        },
      ],
      sessionsTotal: 2,
      activeSessionIds: [activeId, backgroundId],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({ type: "agent_settled", piChatSessionId: backgroundId }),
    );
    const statusIsRunning = () => {
      const row = [
        ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
      ].find((candidate) =>
        candidate.textContent?.includes("Previously running"),
      );
      assert.ok(row);
      return row
        .querySelector(".session-status")
        ?.classList.contains("is-running");
    };
    await act(async () => {
      source.emitPi({ type: "pi_chat_sse_resync" });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      statusIsRunning(),
      false,
      "stale running activity cannot override settlement",
    );
    staleExecution = "dispatching";
    await act(async () => {
      source.emitPi({ type: "pi_chat_sse_resync" });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      statusIsRunning(),
      false,
      "stale dispatching activity cannot override settlement",
    );
    await act(async () =>
      source.emitPi({ type: "agent_start", piChatSessionId: backgroundId }),
    );
    assert.equal(
      statusIsRunning(),
      true,
      "a later authoritative agent_start must restore the spinner for the new turn",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("failed Primary keeps historical navigation while disabling the composer", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      primaryRuntime: {
        status: "failed" as const,
        generation: 2,
        error: "protocol mismatch",
      },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const status = dom.window.document.querySelector<HTMLElement>(
      ".primary-runtime-status",
    )!;
    assert.match(status.textContent || "", /仍可阅读历史/);
    assert.match(status.textContent || "", /protocol mismatch/);
    assert.equal(status.parentElement?.className, "system-notice-stack");
    assert.equal(
      status.parentElement?.parentElement?.className,
      "composer-wrap",
    );
    const input = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    assert.equal(input.disabled, true);
    assert.match(input.placeholder, /Pi Runtime 当前不可用；恢复 ready 后才能输入/);
    // The server's ready SSE triggers a guarded background metadata refresh;
    // the status transition itself is covered by server contract tests. Keep
    // this JSDOM test focused on the failed-readiness capability boundary.
    assert.ok(FakeEventSource.instances.length > 0);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("changing Gate on cold history stages the next prompt without activating its Runtime", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "gate-cold-1234567890";
  const coldSummary = {
    ...bootstrap.sessions[0],
    id: coldId,
    sessionId: "gate-cold",
    name: "Cold Gate",
    active: false,
    writable: false,
  };
  const coldView: SessionViewData = {
    ...draftView,
    session: coldSummary,
    state: { ...bootstrap.state, sessionId: "gate-cold" },
    runtimeStatus: "view-only",
    isActive: false,
    gateMode: "strict",
  };
  const promptCalls: unknown[][] = [];
  let warmCalls = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], coldSummary],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === coldId ? coldView : draftView),
    warmSession: async (id: string) => {
      warmCalls += 1;
      return {
        sessionId: id,
        state: coldView.state,
        gateMode: "strict" as const,
      };
    },
    prompt: async (...args: unknown[]) => {
      promptCalls.push(args);
      return { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const sessionButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((button) => button.textContent?.includes("Cold Gate"))!;
    await act(async () => sessionButton.click());
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".gate-control .compact-select-trigger",
    )!;
    assert.equal(trigger.textContent?.trim(), "严格");
    await act(async () => trigger.click());
    const openOption = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        ".gate-control .compact-select-option",
      ),
    ].find((option) => option.textContent?.trim() === "放行");
    assert.ok(openOption);
    await act(async () => openOption.click());
    assert.equal(trigger.textContent?.trim(), "放行");
    assert.equal(
      warmCalls,
      0,
      "changing Gate alone must not activate cold history",
    );
    assert.deepEqual(
      promptCalls,
      [],
      "changing Gate alone must not send an extension command",
    );

    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "first message");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "first message",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      warmCalls,
      1,
      "the first actual prompt may activate the Session",
    );
    assert.deepEqual(promptCalls, [["first message", [], coldId, "open"]]);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an explicit active Gate choice supersedes an older cold staged mode", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "gate-active-choice-123";
  const coldSummary = {
    ...bootstrap.sessions[0],
    id: coldId,
    sessionId: "gate-active-choice",
    name: "Gate active choice",
    active: false,
    writable: true,
  };
  const coldView: SessionViewData = {
    ...draftView,
    session: coldSummary,
    state: { ...bootstrap.state, sessionId: "gate-active-choice" },
    runtimeStatus: "view-only",
    isActive: false,
    gateMode: "strict",
  };
  const promptCalls: unknown[][] = [];
  const autoAllowResponses: unknown[] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], coldSummary],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === coldId ? coldView : draftView),
    warmSession: async (id: string) => ({
      sessionId: id,
      state: coldView.state,
      gateMode: "strict" as const,
    }),
    takeSessionControl: async () => ({
      controlOwner: "this-window",
      controlledByThisWindow: true as const,
    }),
    respondToExtension: async (body: unknown) => {
      autoAllowResponses.push(body);
    },
    prompt: async (...args: unknown[]) => {
      promptCalls.push(args);
      const message = args[0];
      return typeof message === "string" && message.startsWith("/gate ")
        ? {
            accepted: true,
            queued: false,
            extension: true,
            command: "gate",
            isStreaming: false,
          }
        : { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ]
        .find((button) => button.textContent?.includes("Gate active choice"))!
        .click(),
    );
    const trigger = () =>
      dom.window.document.querySelector<HTMLButtonElement>(
        ".gate-control .compact-select-trigger",
      )!;
    const chooseGate = async (label: string) => {
      await act(async () => trigger().click());
      const option = [
        ...dom.window.document.querySelectorAll<HTMLElement>(
          ".gate-control .compact-select-option",
        ),
      ].find((candidate) => candidate.textContent?.trim() === label);
      assert.ok(option);
      await act(async () => option.click());
    };
    await chooseGate("放行");
    assert.equal(trigger().textContent?.trim(), "放行");

    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_session_control_changed",
        sessionId: coldId,
        controlOwner: "other-window",
        controlledByThisWindow: false,
      }),
    );
    await act(
      async () => new Promise((resolve) => dom.window.setTimeout(resolve, 450)),
    );
    const takeover = dom.window.document.querySelector<HTMLButtonElement>(
      ".session-control-banner button",
    );
    assert.ok(takeover);
    await act(async () => {
      takeover.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      trigger().textContent?.trim(),
      "放行",
      "cold staging survives a pure activation",
    );
    await chooseGate("严格");
    assert.equal(
      trigger().textContent?.trim(),
      "严格",
      "the explicit active choice drops the stale cold preference",
    );
    assert.deepEqual(promptCalls, [["/gate strict", [], coldId, "strict"]]);
    await act(async () =>
      source.emitPi({
        type: "extension_ui_request",
        piChatSessionId: coldId,
        id: "strict-must-not-auto-allow",
        method: "select",
        title: "Pi Chat Gate: bash\necho strict",
        options: ["allow", "block"],
      }),
    );
    assert.deepEqual(
      autoAllowResponses,
      [],
      "the discarded cold open cannot revive auto-allow",
    );

    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "continue strictly");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "continue strictly",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(promptCalls.at(-1), [
      "continue strictly",
      [],
      coldId,
      "strict",
    ]);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a staged cold Gate mode cannot auto-allow before Runtime confirmation", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "gate-confirmation-123";
  const coldSummary = {
    ...bootstrap.sessions[0],
    id: coldId,
    sessionId: "gate-confirmation",
    name: "Gate confirmation",
    active: false,
    writable: false,
  };
  const coldView: SessionViewData = {
    ...draftView,
    session: coldSummary,
    state: { ...bootstrap.state, sessionId: "gate-confirmation" },
    runtimeStatus: "view-only",
    isActive: false,
    gateMode: "strict",
  };
  const responses: unknown[] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], coldSummary],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === coldId ? coldView : draftView),
    respondToExtension: async (body: unknown) => {
      responses.push(body);
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ]
        .find((button) => button.textContent?.includes("Gate confirmation"))!
        .click(),
    );
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".gate-control .compact-select-trigger",
    )!;
    await act(async () => trigger.click());
    const openOption = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        ".gate-control .compact-select-option",
      ),
    ].find((option) => option.textContent?.trim() === "放行");
    assert.ok(openOption);
    await act(async () => openOption.click());
    assert.equal(
      trigger.textContent?.trim(),
      "放行",
      "the staged preference remains visible",
    );

    const source = FakeEventSource.instances.at(-1)!;
    // Another browser action may warm this Runtime, but its ready state remains
    // strict until the staged value is synchronized by a real prompt.
    await act(async () =>
      source.emitPi({
        type: "pi_chat_gate_mode_changed",
        piChatSessionId: coldId,
        mode: "strict",
      }),
    );
    await act(async () =>
      source.emitPi({
        type: "extension_ui_request",
        piChatSessionId: coldId,
        id: "must-not-auto-allow",
        method: "select",
        title: "Pi Chat Gate: bash\necho strict",
        options: ["allow", "block"],
      }),
    );
    assert.deepEqual(
      responses,
      [],
      "an unconfirmed staged open value cannot auto-allow",
    );
    assert.ok(dom.window.document.querySelector(".extension-dialog"));

    await act(async () =>
      source.emitPi({
        type: "pi_chat_gate_mode_changed",
        piChatSessionId: coldId,
        mode: "open",
      }),
    );
    await act(async () =>
      source.emitPi({
        type: "extension_ui_request",
        piChatSessionId: coldId,
        id: "confirmed-auto-allow",
        method: "select",
        title: "Pi Chat Gate: bash\necho open",
        options: ["allow", "block"],
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    assert.deepEqual(responses, [
      {
        id: "confirmed-auto-allow",
        value: "allow",
        sessionId: coldId,
      },
    ]);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("Gate mode changes only after the Runtime confirms the command", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let resolveGate!: (value: {
    accepted: boolean;
    queued: boolean;
    extension: true;
    command: string;
    isStreaming: false;
  }) => void;
  const pendingGate = new Promise<{
    accepted: boolean;
    queued: boolean;
    extension: true;
    command: string;
    isStreaming: false;
  }>((resolve) => {
    resolveGate = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      gateMode: "strict",
      commands: [{ name: "gate", description: "Gate", source: "extension" }],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => pendingGate,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".gate-control .compact-select-trigger",
    )!;
    assert.equal(trigger.textContent?.trim(), "严格");
    await act(async () => trigger.click());
    const openOption = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        ".gate-control .compact-select-option",
      ),
    ].find((option) => option.textContent?.trim() === "放行");
    assert.ok(openOption);
    await act(async () => openOption.click());
    assert.equal(
      trigger.textContent?.trim(),
      "严格",
      "pending HTTP must not optimistically enable auto-allow",
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_gate_mode_changed",
        piChatSessionId: activeId,
        mode: "open",
      }),
    );
    assert.equal(
      trigger.textContent?.trim(),
      "放行",
      "Runtime confirmation SSE must update every window before HTTP post-processing ends",
    );
    await act(async () =>
      resolveGate({
        accepted: true,
        queued: false,
        extension: true,
        command: "gate",
        isStreaming: false,
      }),
    );
    assert.equal(trigger.textContent?.trim(), "放行");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("the next turn carries the Gate mode shown after refresh", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const promptCalls: unknown[][] = [];
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, gateMode: "strict" }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async (...args: unknown[]) => {
      promptCalls.push(args);
      return { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea =
      dom.window.document.querySelector<HTMLTextAreaElement>(
        ".composer textarea",
      )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "next turn");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "next turn",
        }),
      );
    });
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click(),
    );
    assert.deepEqual(promptCalls, [["next turn", [], activeId, "strict"]]);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an accepted prompt advances the sidebar turn count before stale metadata catches up", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const existingMessages = [
    { role: "user" as const, content: "first" },
    { role: "assistant" as const, content: "reply" },
    { role: "user" as const, content: "second" },
  ];
  const staleSession = { ...bootstrap.sessions[0], turnCount: 2 };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [staleSession],
      messages: existingMessages,
      messageTotal: existingMessages.length,
      turnTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => ({ accepted: true, queued: false }),
    sessions: async () => ({ sessions: [staleSession], total: 1 }),
    viewSession: async () => ({
      ...draftView,
      session: staleSession,
      state: { ...bootstrap.state, isStreaming: false },
      messages: existingMessages,
      messageTotal: existingMessages.length,
      turnTotal: 2,
      isActive: true,
      runtimeStatus: "active",
      isStreaming: false,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "third");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "third",
        }),
      );
    });
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click(),
    );
    assert.match(
      dom.window.document.querySelector<HTMLButtonElement>(".session-item")
        ?.title || "",
      /3 turns/,
      "the accepted local turn is already known before SessionIndex rescans JSONL",
    );

    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "pi_chat_sessions_changed",
        action: "prompted",
        sessionId: activeId,
      });
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    assert.match(
      dom.window.document.querySelector<HTMLButtonElement>(".session-item")
        ?.title || "",
      /3 turns/,
      "an older sidebar snapshot must not roll the local turn count back",
    );

    await act(async () => {
      source.emitPi({ type: "agent_settled", piChatSessionId: activeId });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(
      dom.window.document.querySelector<HTMLButtonElement>(".session-item")
        ?.title || "",
      /3 turns/,
      "an older Session view must not bypass the local turn-count watermark",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("cancelling an admitted queued prompt restores its text over the current Composer draft and rolls the turn count back", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const queuedItem = {
    id: "00000000-0000-4000-8000-000000000002",
    message: "cancel this turn",
    imageCount: 0,
    createdAt: 3,
  };
  const existingMessages = [
    { role: "user" as const, content: "first" },
    { role: "assistant" as const, content: "reply" },
    { role: "user" as const, content: "second" },
  ];
  const session = { ...bootstrap.sessions[0], turnCount: 2 };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [session],
      messages: existingMessages,
      messageTotal: existingMessages.length,
      turnTotal: 2,
      queuePaused: true,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => ({
      accepted: true,
      queued: true,
      id: queuedItem.id,
      queue: [queuedItem],
    }),
    cancelQueued: async () => ({ queue: [], paused: false }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, queuedItem.message);
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: queuedItem.message,
        }),
      );
    });
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".queue-submit-button")!
        .click(),
    );
    assert.match(
      dom.window.document.querySelector<HTMLButtonElement>(".session-item")
        ?.title || "",
      /3 turns/,
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "replace this draft");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "replace this draft",
        }),
      );
    });

    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".prompt-queue article button")!
        .click(),
    );
    assert.equal(
      textarea.value,
      queuedItem.message,
      "undo restores the cancelled prompt and replaces the current draft",
    );
    assert.match(
      dom.window.document.querySelector<HTMLButtonElement>(".session-item")
        ?.title || "",
      /2 turns/,
      "a cancelled queue item is no longer an accepted user turn",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("cancelling a locally queued image prompt restores its attachment", async () => {
  const { dom } = installDom();
  Object.assign(globalThis, {
    FileReader: dom.window.FileReader,
    File: dom.window.File,
  });
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const imageModel = {
    ...bootstrap.state.model!,
    input: ["text", "image"],
  };
  const queuedItem = {
    id: "00000000-0000-4000-8000-000000000010",
    message: "restore image too",
    imageCount: 1,
    createdAt: 3,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, model: imageModel, isStreaming: true },
      models: [imageModel],
      queuePaused: true,
      primaryRuntime: { ...bootstrap.primaryRuntime, model: imageModel },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => ({
      accepted: true,
      queued: true,
      id: queuedItem.id,
      queue: [queuedItem],
    }),
    cancelQueued: async () => ({ queue: [], paused: true }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    const fileInput = dom.window.document.querySelector<HTMLInputElement>(
      "input[type='file']",
    )!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [
        new dom.window.File(["image"], "restore.png", { type: "image/png" }),
      ],
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      const deadline = Date.now() + 250;
      while (!dom.window.document.querySelector(".image-preview") && Date.now() < deadline)
        await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, queuedItem.message);
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: queuedItem.message,
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".queue-submit-button")!
        .click();
    });
    assert.equal(dom.window.document.querySelector(".image-preview"), null);
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".prompt-queue article button")!
        .click(),
    );
    assert.equal(textarea.value, queuedItem.message);
    assert.ok(
      dom.window.document.querySelector(".image-preview img"),
      "locally retained image bytes are restored with the cancelled prompt",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("successive queue cancellations keep only the latest restored message", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const first = {
    id: "00000000-0000-4000-8000-000000000011",
    message: "first cancelled prompt",
    imageCount: 0,
    createdAt: 3,
  };
  const second = {
    id: "00000000-0000-4000-8000-000000000012",
    message: "second cancelled prompt",
    imageCount: 0,
    createdAt: 4,
  };
  let promptCalls = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      queuePaused: true,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async (_message: string) => {
      promptCalls += 1;
      return {
        accepted: true,
        queued: true,
        id: promptCalls === 1 ? first.id : second.id,
        queue: promptCalls === 1 ? [first] : [first, second],
      };
    },
    cancelQueued: async (id: string) => ({
      queue: id === first.id ? [second] : [],
      paused: true,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    const submit = async (message: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLTextAreaElement.prototype,
          "value",
        )?.set?.call(textarea, message);
        textarea.dispatchEvent(
          new dom.window.InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: message,
          }),
        );
        dom.window.document
          .querySelector<HTMLButtonElement>(".queue-submit-button")!
          .click();
      });
    };
    await submit(first.message);
    await submit(second.message);
    const cancelButtons = () => [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".prompt-queue article button",
      ),
    ];
    await act(async () => cancelButtons()[0]!.click());
    assert.equal(textarea.value, first.message);
    await act(async () => cancelButtons()[0]!.click());
    assert.equal(
      textarea.value,
      second.message,
      "the later undo replaces, rather than appends to, the prior restored draft",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a delayed queue cancellation does not overwrite draft edits made after the click", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const queued = {
    id: "00000000-0000-4000-8000-000000000020",
    message: "restore only if draft unchanged",
    imageCount: 0,
    createdAt: 3,
  };
  let resolveCancel!: (value: { queue: []; paused: true }) => void;
  const pendingCancel = new Promise<{ queue: []; paused: true }>((resolve) => {
    resolveCancel = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      queue: [queued],
      queuePaused: true,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    cancelQueued: async () => pendingCancel,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>(".prompt-queue article button")!.click(),
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "newer user draft");
      textarea.dispatchEvent(new dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "newer user draft",
      }));
    });
    await act(async () => resolveCancel({ queue: [], paused: true }));
    assert.equal(textarea.value, "newer user draft");
    assert.equal(dom.window.document.querySelector(".prompt-queue"), null);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("opening the image picker prevents a delayed cancellation from replacing the draft", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const queued = {
    id: "00000000-0000-4000-8000-000000000028",
    message: "do not restore over image intent",
    imageCount: 0,
    createdAt: 3,
  };
  let resolveCancel!: (value: { queue: []; paused: true }) => void;
  const pendingCancel = new Promise<{ queue: []; paused: true }>((resolve) => {
    resolveCancel = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      queue: [queued],
      queuePaused: true,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    cancelQueued: async () => pendingCancel,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "keep this draft");
      textarea.dispatchEvent(new dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "keep this draft",
      }));
      dom.window.document.querySelector<HTMLButtonElement>(".prompt-queue article button")!.click();
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!.click();
    });
    const imageItem = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".attachment-menu [role='menuitem']",
    )].find((item) => item.textContent?.includes("图片"));
    assert.ok(imageItem);
    await act(async () => imageItem.click());
    await act(async () => resolveCancel({ queue: [], paused: true }));
    assert.equal(textarea.value, "keep this draft");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a cancellation response cannot erase a newer queue admission", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const cancelled = {
    id: "00000000-0000-4000-8000-000000000026",
    message: "cancel old item",
    imageCount: 0,
    createdAt: 3,
  };
  const admitted = {
    id: "00000000-0000-4000-8000-000000000027",
    message: "newer admitted item",
    imageCount: 0,
    createdAt: 4,
  };
  let resolveCancel!: (value: { queue: []; paused: true }) => void;
  const pendingCancel = new Promise<{ queue: []; paused: true }>((resolve) => {
    resolveCancel = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      queue: [cancelled],
      queuePaused: true,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    cancelQueued: async () => pendingCancel,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>(".prompt-queue article button")!.click(),
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        queue: [cancelled, admitted],
        admittedId: admitted.id,
        paused: true,
      }),
    );
    await act(async () => resolveCancel({ queue: [], paused: true }));
    const queueText = dom.window.document.querySelector(".prompt-queue")?.textContent || "";
    assert.doesNotMatch(queueText, /cancel old item/);
    assert.match(queueText, /newer admitted item/);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale resume response cannot erase a newer same-session admission", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const existing = {
    id: "00000000-0000-4000-8000-000000000029",
    message: "existing resume item",
    imageCount: 0,
    createdAt: 3,
  };
  const admitted = {
    id: "00000000-0000-4000-8000-000000000030",
    message: "admitted while resume waits",
    imageCount: 0,
    createdAt: 4,
  };
  let resolveResume!: (value: { queue: typeof existing[]; paused: false }) => void;
  const pendingResume = new Promise<{ queue: typeof existing[]; paused: false }>(
    (resolve) => { resolveResume = resolve; },
  );
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      queue: [existing],
      queuePaused: true,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    resumeQueue: async () => pendingResume,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>(
        ".prompt-queue header button",
      )!.click(),
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        queue: [existing, admitted],
        admittedId: admitted.id,
        paused: true,
      }),
    );
    await act(async () => resolveResume({ queue: [existing], paused: false }));
    const queueText = dom.window.document.querySelector(".prompt-queue")?.textContent || "";
    assert.match(queueText, /existing resume item/);
    assert.match(queueText, /admitted while resume waits/);
    assert.equal(
      dom.window.document.querySelector(".prompt-queue header button"),
      null,
      "the newer successful Resume owns pause state while preserving newer SSE admissions",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("reverse queue cancellation response order still restores the last-clicked message", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const first = {
    id: "00000000-0000-4000-8000-000000000023",
    message: "first click first response",
    imageCount: 0,
    createdAt: 3,
  };
  const second = {
    id: "00000000-0000-4000-8000-000000000024",
    message: "second click second response",
    imageCount: 0,
    createdAt: 4,
  };
  let resolveFirst!: (value: { queue: typeof second[]; paused: true }) => void;
  let resolveSecond!: (value: { queue: []; paused: true }) => void;
  const firstPending = new Promise<{ queue: typeof second[]; paused: true }>((resolve) => {
    resolveFirst = resolve;
  });
  const secondPending = new Promise<{ queue: []; paused: true }>((resolve) => {
    resolveSecond = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      queue: [first, second],
      queuePaused: true,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    cancelQueued: async (id: string) => id === first.id ? firstPending : secondPending,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    const buttons = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".prompt-queue article button",
      ),
    ];
    await act(async () => {
      buttons[0]!.click();
      buttons[1]!.click();
    });
    await act(async () => resolveFirst({ queue: [second], paused: true }));
    assert.equal(textarea.value, first.message);
    await act(async () => resolveSecond({ queue: [], paused: true }));
    assert.equal(textarea.value, second.message);
    assert.equal(dom.window.document.querySelector(".prompt-queue"), null);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale queue SSE cannot resurrect a successfully cancelled item", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const queued = {
    id: "00000000-0000-4000-8000-000000000025",
    message: "stay cancelled",
    imageCount: 0,
    createdAt: 3,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      queue: [queued],
      queuePaused: true,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    cancelQueued: async () => ({ queue: [], paused: true }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>(".prompt-queue article button")!.click(),
    );
    assert.equal(dom.window.document.querySelector(".prompt-queue"), null);
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        queue: [queued],
        paused: true,
      }),
    );
    assert.equal(
      dom.window.document.querySelector(".prompt-queue"),
      null,
      "a delayed queue snapshot cannot restore a cancelled identity",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("out-of-order queue cancellation responses keep the last-clicked message in the Composer", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const first = {
    id: "00000000-0000-4000-8000-000000000021",
    message: "slow first undo",
    imageCount: 0,
    createdAt: 3,
  };
  const second = {
    id: "00000000-0000-4000-8000-000000000022",
    message: "fast second undo",
    imageCount: 0,
    createdAt: 4,
  };
  let resolveFirst!: (value: { queue: typeof second[]; paused: true }) => void;
  let resolveSecond!: (value: { queue: []; paused: true }) => void;
  const firstPending = new Promise<{ queue: typeof second[]; paused: true }>(
    (resolve) => { resolveFirst = resolve; },
  );
  const secondPending = new Promise<{ queue: []; paused: true }>(
    (resolve) => { resolveSecond = resolve; },
  );
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      queue: [first, second],
      queuePaused: true,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    cancelQueued: async (id: string) => id === first.id ? firstPending : secondPending,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    const buttons = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".prompt-queue article button",
      ),
    ];
    await act(async () => {
      buttons[0]!.click();
      buttons[1]!.click();
    });
    await act(async () => resolveSecond({ queue: [], paused: true }));
    assert.equal(textarea.value, second.message);
    await act(async () => resolveFirst({ queue: [second], paused: true }));
    assert.equal(
      textarea.value,
      second.message,
      "a slower earlier response cannot overwrite the later cancellation",
    );
    assert.equal(
      dom.window.document.querySelector(".prompt-queue"),
      null,
      "an older response cannot resurrect an item cancelled by a newer response",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("queued prompt moves exclusively between queue and transcript across dispatch failure", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const queuedId = "00000000-0000-4000-8000-000000000001";
  const queuedItem = {
    id: queuedId,
    message: "queued only once",
    imageCount: 0,
    createdAt: 2,
  };
  let resolvePrompt!: (value: {
    accepted: boolean;
    queued: boolean;
    id: string;
    queue: (typeof queuedItem)[];
  }) => void;
  const pendingPrompt = new Promise<{
    accepted: boolean;
    queued: boolean;
    id: string;
    queue: (typeof queuedItem)[];
  }>((resolve) => {
    resolvePrompt = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, queue: [], queuePaused: true }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => pendingPrompt,
    sessions: async () => ({
      sessions: bootstrap.sessions,
      total: bootstrap.sessions.length,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea =
      dom.window.document.querySelector<HTMLTextAreaElement>(
        ".composer textarea",
      )!;
    const queueSubmit = dom.window.document.querySelector<HTMLButtonElement>(
      ".queue-submit-button",
    )!;
    assert.equal(queueSubmit.textContent, "排队");
    assert.equal(dom.window.document.querySelector(".send-button"), null);
    assert.equal(dom.window.document.querySelector(".stop-button"), null);
    assert.equal(
      queueSubmit.nextElementSibling?.className,
      "attachment-control",
    );
    await act(async () => {
      textarea.focus();
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, queuedItem.message);
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: queuedItem.message,
        }),
      );
    });
    await act(async () => queueSubmit.click());
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      0,
    );

    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        admittedId: queuedId,
        queue: [queuedItem],
        paused: true,
      }),
    );
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      0,
    );
    assert.equal(
      dom.window.document.querySelectorAll(".prompt-queue article").length,
      1,
    );

    await act(async () =>
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        queue: [],
        paused: false,
      }),
    );
    await act(async () =>
      source.emitPi({
        type: "pi_chat_queue_dispatch",
        piChatSessionId: activeId,
        id: queuedId,
        message: queuedItem.message,
        imageCount: 0,
      }),
    );
    assert.equal(
      dom.window.document.querySelectorAll(".prompt-queue article").length,
      0,
    );
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      1,
    );
    const stopAfterDispatch =
      dom.window.document.querySelector<HTMLButtonElement>(".stop-button")!;
    assert.ok(stopAfterDispatch.querySelector("span"));
    assert.equal(
      stopAfterDispatch.parentElement?.lastElementChild,
      stopAfterDispatch,
    );

    await act(async () =>
      source.emitPi({
        type: "pi_chat_queue_error",
        piChatSessionId: activeId,
        id: queuedId,
        queue: [queuedItem],
        paused: true,
        error: "rejected",
      }),
    );
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      0,
    );
    assert.equal(
      dom.window.document.querySelectorAll(".prompt-queue article").length,
      1,
    );
    assert.equal(dom.window.document.querySelector(".stop-button"), null);

    await act(async () =>
      resolvePrompt({
        accepted: true,
        queued: true,
        id: queuedId,
        queue: [queuedItem],
      }),
    );
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      0,
    );
    assert.equal(
      dom.window.document.querySelectorAll(".prompt-queue article").length,
      1,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("dispatch before HTTP acknowledgement cannot resurrect an executing queue item", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const queuedItem = {
    id: "00000000-0000-4000-8000-000000000031",
    message: "dispatch wins over ack",
    imageCount: 0,
    createdAt: 2,
  };
  let resolvePrompt!: (value: {
    accepted: true;
    queued: true;
    id: string;
    queue: typeof queuedItem[];
  }) => void;
  const pendingPrompt = new Promise<{
    accepted: true;
    queued: true;
    id: string;
    queue: typeof queuedItem[];
  }>((resolve) => { resolvePrompt = resolve; });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      queue: [],
      queuePaused: true,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => pendingPrompt,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, queuedItem.message);
      textarea.dispatchEvent(new dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: queuedItem.message,
      }));
      dom.window.document.querySelector<HTMLButtonElement>(
        ".queue-submit-button",
      )!.click();
      await Promise.resolve();
    });
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        admittedId: queuedItem.id,
        queue: [queuedItem],
        paused: true,
      });
      source.emitPi({
        type: "pi_chat_queue_dispatch",
        piChatSessionId: activeId,
        id: queuedItem.id,
        message: queuedItem.message,
        imageCount: 0,
      });
    });
    assert.equal(dom.window.document.querySelector(".prompt-queue"), null);
    await act(async () =>
      resolvePrompt({
        accepted: true,
        queued: true,
        id: queuedItem.id,
        queue: [queuedItem],
      }),
    );
    assert.equal(
      dom.window.document.querySelector(".prompt-queue"),
      null,
      "the stale acknowledgement cannot restore a dispatched queue row",
    );
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      1,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("queue SSE invalidates an older Session view before it can erase queue state", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const queuedItem = {
    id: "00000000-0000-4000-8000-000000000099",
    message: "SSE queue state wins",
    imageCount: 0,
    createdAt: 9,
  };
  let resolveView!: (view: SessionViewData) => void;
  const staleView = new Promise<SessionViewData>((resolve) => {
    resolveView = resolve;
  });
  const oldView: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: activeId,
      sessionId: "active",
      name: "Active",
      active: true,
      writable: true,
    },
    state: { ...bootstrap.state, isStreaming: false },
    queue: [],
    queuePaused: false,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async () => staleView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({ type: "agent_settled", piChatSessionId: activeId }),
    );
    await act(async () =>
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        admittedId: queuedItem.id,
        queue: [queuedItem],
        paused: true,
      }),
    );
    assert.equal(
      dom.window.document.querySelectorAll(".prompt-queue article").length,
      1,
    );

    await act(async () => resolveView(oldView));
    assert.equal(
      dom.window.document.querySelectorAll(".prompt-queue article").length,
      1,
      "the earlier view must not overwrite newer queue SSE state",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("agent settlement clears a completed tool status left after compaction", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const settledView: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: activeId,
      sessionId: "active",
      name: "Active",
      active: true,
      writable: true,
    },
    state: { ...bootstrap.state, isStreaming: false, isCompacting: false },
    isStreaming: false,
    toolStatus: "",
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true, isCompacting: true },
      messages: [
        {
          role: "assistant" as const,
          content: [
            {
              type: "toolCall" as const,
              id: "bash-1",
              name: "bash",
              arguments: { command: "dir" },
            },
          ],
        },
        {
          role: "toolResult" as const,
          toolCallId: "bash-1",
          toolName: "bash",
          content: "done",
        },
      ],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async () => settledView,
    sessions: async () => ({
      sessions: bootstrap.sessions,
      total: bootstrap.sessions.length,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "tool_execution_end",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        toolName: "bash",
        isError: false,
      }),
    );
    assert.match(
      dom.window.document.querySelector(".agent-status")?.textContent || "",
      /bash 已完成，Pi 正在继续…/,
    );
    assert.ok(
      dom.window.document.querySelector(".agent-status .loader.small"),
    );
    assert.equal(
      dom.window.document.querySelector(".agent-status.is-compacting"),
      null,
      "a completed tool frame proves Pi has resumed work after compaction",
    );

    await act(async () =>
      source.emitPi({
        type: "agent_settled",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
      }),
    );
    assert.equal(
      dom.window.document.querySelector(".agent-status"),
      null,
      "settled conversations must not retain a status spinner",
    );
    assert.equal(
      dom.window.document.querySelector(
        ".conversation-process .process-status-icon.is-running",
      ),
      null,
    );
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='消息输入']",
      )?.disabled,
      false,
    );
    await act(async () => {
      source.emitPi({
        type: "tool_execution_end",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        toolName: "bash",
        isError: false,
      });
      source.emitPi({
        type: "pi_chat_session_status",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        activity: { execution: "running", awaitingConfirmation: false },
      });
    });
    assert.equal(
      dom.window.document.querySelector(".agent-status"),
      null,
      "late tool/status events from a settled generation must not restore a spinner",
    );
    assert.equal(
      dom.window.document.querySelector(".session-status.is-running"),
      null,
      "late running activity must not restore the sidebar spinner",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("extension resolution invalidates an older Session view before it can reopen confirmation", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const request = {
    type: "extension_ui_request",
    id: "pending-confirm",
    method: "confirm",
    title: "Allow?",
    piChatSessionId: activeId,
  } as const;
  let resolveView!: (view: SessionViewData) => void;
  const staleView = new Promise<SessionViewData>((resolve) => {
    resolveView = resolve;
  });
  const oldView: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: activeId,
      sessionId: "active",
      name: "Active",
      active: true,
      writable: true,
    },
    state: { ...bootstrap.state, isStreaming: false },
    pendingExtensionRequest: request,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      pendingExtensionRequest: request,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async () => staleView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(dom.window.document.querySelector(".extension-dialog"));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({ type: "agent_settled", piChatSessionId: activeId }),
    );
    await act(async () =>
      source.emitPi({
        type: "pi_chat_extension_request_resolved",
        piChatSessionId: activeId,
        id: request.id,
      }),
    );
    assert.equal(dom.window.document.querySelector(".extension-dialog"), null);

    await act(async () => resolveView(oldView));
    assert.equal(
      dom.window.document.querySelector(".extension-dialog"),
      null,
      "the older view must not restore a resolved confirmation",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a late cold activation from A cannot overwrite the Session B composer", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "aaaaaaaaaaaaaaaaaaaa";
  const secondId = "bbbbbbbbbbbbbbbbbbbb";
  const modelA = {
    id: "model-a",
    name: "Model A",
    provider: "test",
    input: ["text"],
    reasoning: true,
  };
  const modelB = {
    id: "model-b",
    name: "Model B",
    provider: "test",
    input: ["text"],
    reasoning: true,
  };
  const summaryA = {
    ...bootstrap.sessions[0],
    id: coldId,
    sessionId: "cold-a",
    name: "Cold A",
    active: false,
    writable: false,
  };
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "session-b",
    name: "Session B",
    active: false,
  };
  const viewA: SessionViewData = {
    ...draftView,
    session: summaryA,
    state: {
      ...bootstrap.state,
      model: modelA,
      thinkingLevel: "high",
      sessionId: "cold-a",
    },
    runtimeStatus: "view-only",
    isActive: false,
  };
  const activatedA: SessionViewData = {
    ...viewA,
    session: { ...summaryA, active: true, writable: true },
    runtimeStatus: "active",
    isActive: true,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: {
      ...bootstrap.state,
      model: modelB,
      thinkingLevel: "low",
      sessionId: "session-b",
    },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let resolveActivation!: (view: SessionViewData) => void;
  const pendingActivation = new Promise<SessionViewData>((resolve) => {
    resolveActivation = resolve;
  });
  const promptTargets: string[] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      models: [modelA, modelB],
      sessions: [bootstrap.sessions[0], summaryA, summaryB],
      sessionsTotal: 3,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) =>
      id === coldId ? viewA : id === secondId ? viewB : draftView,
    warmSession: async (id: string) => {
      if (id === secondId)
        return {
          sessionId: id,
          state: viewB.state,
          gateMode: "strict" as const,
        };
      const view = await pendingActivation;
      return {
        sessionId: view.session.id,
        state: view.state,
        gateMode: "strict" as const,
      };
    },
    prompt: async (_message: string, _images: unknown[], sessionId: string) => {
      promptTargets.push(sessionId);
      return { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => sessionButton("Cold A").click());
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "send to cold A");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "send to cold A",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    await act(async () => sessionButton("Session B").click());
    assert.match(
      dom.window.document.querySelector(
        ".composer-model-select .compact-select-trigger",
      )?.textContent || "",
      /Model B/,
    );
    assert.match(
      dom.window.document.querySelector(
        ".thinking-control .compact-select-trigger",
      )?.textContent || "",
      /low/,
    );

    await act(async () => {
      resolveActivation(activatedA);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(
      promptTargets,
      [coldId],
      "the background send still targets A",
    );
    assert.match(
      dom.window.document.querySelector(
        ".composer-model-select .compact-select-trigger",
      )?.textContent || "",
      /Model B/,
    );
    assert.match(
      dom.window.document.querySelector(
        ".thinking-control .compact-select-trigger",
      )?.textContent || "",
      /low/,
    );
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /Pi 已就绪，正在发送消息/,
    );
    assert.equal(
      textarea.disabled,
      false,
      "A activation cannot lock B's composer",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale A Runtime warm cannot overwrite a newer A revisit", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "warm-a-12345678901234";
  const secondId = "warm-b-12345678901234";
  const modelA = {
    id: "warm-model-a",
    name: "Warm Model A",
    provider: "test",
    input: ["text"],
    reasoning: true,
  };
  const modelB = {
    id: "warm-model-b",
    name: "Warm Model B",
    provider: "test",
    input: ["text"],
    reasoning: true,
  };
  const summaryA = {
    ...bootstrap.sessions[0],
    id: coldId,
    sessionId: "warm-a",
    name: "Warm A",
    active: false,
    writable: false,
  };
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "warm-b",
    name: "Warm B",
    active: false,
    writable: false,
  };
  const viewA = {
    ...draftView,
    session: summaryA,
    state: {
      ...bootstrap.state,
      model: modelA,
      thinkingLevel: "low",
      sessionId: "warm-a",
    },
    runtimeStatus: "view-only" as const,
    isActive: false,
    historyPending: true,
  };
  const revisitA = {
    ...viewA,
    historyPending: false,
    state: { ...viewA.state, model: modelB, thinkingLevel: "high" },
  };
  const viewB = {
    ...draftView,
    session: summaryB,
    state: {
      ...bootstrap.state,
      model: modelB,
      thinkingLevel: "medium",
      sessionId: "warm-b",
    },
    runtimeStatus: "view-only" as const,
    isActive: false,
  };
  let resolveWarm!: (ready: {
    sessionId: string;
    state: typeof viewA.state;
    gateMode: "strict";
  }) => void;
  const pendingWarm = new Promise<{
    sessionId: string;
    state: typeof viewA.state;
    gateMode: "strict";
  }>((resolve) => {
    resolveWarm = resolve;
  });
  let viewsOfA = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      models: [modelA, modelB],
      sessions: [bootstrap.sessions[0], summaryA, summaryB],
      sessionsTotal: 3,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => {
      if (id === coldId) return ++viewsOfA === 1 ? viewA : revisitA;
      if (id === secondId) return viewB;
      return draftView;
    },
    warmSession: async () => pendingWarm,
    prompt: async () => ({ accepted: true, queued: false }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => sessionButton("Warm A").click());
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "start stale warm");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "start stale warm",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    await act(async () => sessionButton("Warm B").click());
    await act(async () => sessionButton("Warm A").click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(
      dom.window.document.querySelector(
        ".composer-model-select .compact-select-trigger",
      )?.textContent || "",
      /Warm Model B/,
    );
    assert.match(
      dom.window.document.querySelector(
        ".thinking-control .compact-select-trigger",
      )?.textContent || "",
      /high/,
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Warm A",
      "the newer A revisit owns the title before an earlier A warm completes",
    );
    await act(async () => {
      resolveWarm({
        sessionId: coldId,
        state: { ...viewA.state, model: modelA, thinkingLevel: "low" },
        gateMode: "strict",
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(
      dom.window.document.querySelector(
        ".composer-model-select .compact-select-trigger",
      )?.textContent || "",
      /Warm Model B/,
    );
    assert.match(
      dom.window.document.querySelector(
        ".thinking-control .compact-select-trigger",
      )?.textContent || "",
      /high/,
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Warm A",
      "the stale A warm result cannot replace the current A pane title",
    );
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='消息输入']",
      )?.placeholder,
      "输入消息，或粘贴、拖入附件",
      "the returned A pane joins the existing warm and becomes active",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a replacement ignores stale A warm cache writes", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "replacement-warm-12345";
  let promptCalls = 0;
  const coldSession = {
    ...bootstrap.sessions[0],
    id: coldId,
    sessionId: "replacement-warm",
    name: "Replacement warm",
    active: false,
    writable: false,
  };
  const coldView: SessionViewData = {
    ...draftView,
    session: coldSession,
    state: { ...draftView.state, sessionId: "replacement-warm" },
    isActive: false,
    runtimeStatus: "view-only",
  };
  let resolveWarm!: (value: {
    sessionId: string;
    state: typeof coldView.state;
    gateMode: "strict";
  }) => void;
  const pendingWarm = new Promise<{
    sessionId: string;
    state: typeof coldView.state;
    gateMode: "strict";
  }>((resolve) => {
    resolveWarm = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], coldSession],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => (id === coldId ? coldView : draftView),
    warmSession: async () => pendingWarm,
    prompt: async () => {
      promptCalls += 1;
      return { accepted: true, queued: false };
    },
    invalidateHandshake: () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const coldButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((button) => button.textContent?.includes("Replacement warm"))!;
    await act(async () => coldButton.click());
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "warm");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "warm",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "workspace-changing",
            piChatRunEpoch: "epoch-warm-b",
            workspaceEpoch: "epoch-warm-b",
          }),
        }),
      ),
    );
    await act(async () => {
      resolveWarm({
        sessionId: coldId,
        state: coldView.state,
        gateMode: "strict",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Replacement warm",
      "the old warm completion cannot replace process-B UI state",
    );
    assert.equal(
      promptCalls,
      0,
      "the old send chain cannot use process B's transport after its warm settles",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale A prompt acknowledgement cannot modify a newer A revisit", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "prompt-b-123456789012";
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "prompt-b",
    name: "Prompt B",
    active: false,
    writable: false,
  };
  const viewA: SessionViewData = {
    ...draftView,
    session: { ...bootstrap.sessions[0], active: true, writable: true },
    state: { ...bootstrap.state, isStreaming: false },
    runtimeStatus: "active",
    isActive: true,
    queue: [],
    queuePaused: false,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: { ...bootstrap.state, sessionId: "prompt-b" },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let resolvePrompt!: (result: {
    accepted: true;
    queued: true;
    id: string;
    queue: Array<{
      id: string;
      message: string;
      imageCount: number;
      createdAt: number;
    }>;
  }) => void;
  const pendingPrompt = new Promise<{
    accepted: true;
    queued: true;
    id: string;
    queue: Array<{
      id: string;
      message: string;
      imageCount: number;
      createdAt: number;
    }>;
  }>((resolve) => {
    resolvePrompt = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], summaryB],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === secondId ? viewB : viewA),
    prompt: async () => pendingPrompt,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "old prompt");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "old prompt",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => sessionButton("Prompt B").click());
    await act(async () => sessionButton("Active").click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(dom.window.document.querySelector(".prompt-queue"), null);
    await act(async () => {
      resolvePrompt({
        accepted: true,
        queued: true,
        id: "old-queue",
        queue: [
          {
            id: "old-queue",
            message: "old prompt",
            imageCount: 0,
            createdAt: 1,
          },
        ],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelector(".prompt-queue"),
      null,
      "a pre-navigation A acknowledgement cannot install its queue in later A",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale A prompt failure cannot modify a newer A revisit", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "prompt-failure-b-12345";
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "prompt-failure-b",
    name: "Prompt failure B",
    active: false,
    writable: false,
  };
  const viewA: SessionViewData = {
    ...draftView,
    session: { ...bootstrap.sessions[0], active: true, writable: true },
    state: { ...bootstrap.state, isStreaming: false },
    runtimeStatus: "active",
    isActive: true,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: { ...bootstrap.state, sessionId: "prompt-failure-b" },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let rejectPrompt!: (cause: Error) => void;
  const pendingPrompt = new Promise<never>((_resolve, reject) => {
    rejectPrompt = reject;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], summaryB],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === secondId ? viewB : viewA),
    prompt: async () => pendingPrompt,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "old failed prompt");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "old failed prompt",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => sessionButton("Prompt failure B").click());
    await act(async () => sessionButton("Active").click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      rejectPrompt(new Error("old prompt failed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.doesNotMatch(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /old prompt failed/,
      "an old A failure cannot show an error on a newer A pane",
    );
    assert.equal(dom.window.document.querySelector(".prompt-queue"), null);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale A extension failure cannot reopen a newer A pane", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldAId = "extension-a-123456789";
  const secondId = "extension-b-123456789";
  const summaryA = {
    ...bootstrap.sessions[0],
    id: coldAId,
    sessionId: "extension-a",
    name: "Extension A",
    active: false,
    writable: false,
  };
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "extension-b",
    name: "Extension B",
    active: false,
    writable: false,
  };
  const request = {
    type: "extension_ui_request",
    id: "stale-extension",
    method: "confirm",
    title: "Old confirmation",
    piChatSessionId: coldAId,
  } as const;
  const viewA: SessionViewData = {
    ...draftView,
    session: summaryA,
    state: { ...bootstrap.state, sessionId: "extension-a" },
    runtimeStatus: "view-only",
    isActive: false,
    pendingExtensionRequest: request,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: { ...bootstrap.state, sessionId: "extension-b" },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let rejectResponse!: (cause: Error) => void;
  const pendingResponse = new Promise<never>((_resolve, reject) => {
    rejectResponse = reject;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], summaryA, summaryB],
      sessionsTotal: 3,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) =>
      id === coldAId ? viewA : id === secondId ? viewB : draftView,
    respondToExtension: async () => pendingResponse,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => sessionButton("Extension A").click());
    assert.ok(dom.window.document.querySelector(".extension-dialog"));
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".extension-dialog button",
        ),
      ]
        .find((button) => button.textContent === "确定")!
        .click(),
    );
    await act(async () => sessionButton("Extension B").click());
    await act(async () => sessionButton("Extension A").click());
    assert.equal(
      dom.window.document.querySelector(".extension-dialog"),
      null,
      "the newer A cache projection has no pending confirmation",
    );
    await act(async () => {
      rejectResponse(new Error("response lost"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelector(".extension-dialog"),
      null,
      "the old A response cannot restore its confirmation after A → B → A",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale A reconcile rejection cannot retry or show an error on a newer A pane", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "reconcile-b-123456789";
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "reconcile-b",
    name: "Reconcile B",
    active: false,
    writable: false,
  };
  const streamingA: SessionViewData = {
    ...draftView,
    session: { ...bootstrap.sessions[0], active: true, writable: true },
    state: { ...bootstrap.state, isStreaming: true },
    runtimeStatus: "active",
    isActive: true,
    isStreaming: true,
    reconcilePending: true,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: { ...bootstrap.state, sessionId: "reconcile-b" },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let rejectOldReconcile!: (cause: Error) => void;
  const pendingOldReconcile = new Promise<SessionViewData>(
    (_resolve, reject) => {
      rejectOldReconcile = reject;
    },
  );
  let activeReads = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], summaryB],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => {
      if (id === secondId) return viewB;
      activeReads += 1;
      return activeReads === 2 ? pendingOldReconcile : streamingA;
    },
    prompt: async () => ({ accepted: true, queued: false, isStreaming: true }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "start reconcile");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "start reconcile",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => sessionButton("Reconcile B").click());
    await act(async () => sessionButton("Active").click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 4_100)));
    assert.equal(
      activeReads,
      2,
      "the acknowledged A prompt starts one reconcile request after the initial read",
    );
    await act(async () => sessionButton("Reconcile B").click());
    await act(async () => sessionButton("Active").click());
    await act(async () => {
      rejectOldReconcile(new Error("stale reconcile failed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.doesNotMatch(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /stale reconcile failed/,
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
    assert.equal(
      activeReads,
      3,
      "the stale rejection must not schedule another reconcile retry",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale Gate auto-allow result cannot show feedback after A → B → A", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "gate-feedback-b-12345";
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "gate-feedback-b",
    name: "Gate feedback B",
    active: false,
    writable: false,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: { ...bootstrap.state, sessionId: "gate-feedback-b" },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let resolveResponse!: () => void;
  const pendingResponse = new Promise<void>((resolve) => {
    resolveResponse = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], summaryB],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === secondId ? viewB : draftView),
    respondToExtension: async () => pendingResponse,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_gate_mode_changed",
        piChatSessionId: activeId,
        mode: "open",
      }),
    );
    await act(async () =>
      source.emitPi({
        type: "extension_ui_request",
        piChatSessionId: activeId,
        id: "auto-allow-stale",
        method: "select",
        title: "Pi Chat Gate: bash\necho stale",
        options: ["allow", "block"],
      }),
    );
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => sessionButton("Gate feedback B").click());
    await act(async () => sessionButton("Active").click());
    await act(async () => {
      resolveResponse();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.doesNotMatch(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /已按放行模式自动允许/,
      "the old A success toast cannot appear on a newer A pane",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale Gate auto-allow failure cannot show an error after A → B", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "gate-feedback-failure-b";
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "gate-feedback-failure-b",
    name: "Gate failure B",
    active: false,
    writable: false,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: { ...bootstrap.state, sessionId: "gate-feedback-failure-b" },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let rejectResponse!: (cause: Error) => void;
  const pendingResponse = new Promise<never>((_resolve, reject) => {
    rejectResponse = reject;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], summaryB],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === secondId ? viewB : draftView),
    respondToExtension: async () => pendingResponse,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_gate_mode_changed",
        piChatSessionId: activeId,
        mode: "open",
      }),
    );
    await act(async () =>
      source.emitPi({
        type: "extension_ui_request",
        piChatSessionId: activeId,
        id: "auto-allow-stale-failure",
        method: "select",
        title: "Pi Chat Gate: bash\necho stale",
        options: ["allow", "block"],
      }),
    );
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ]
        .find((button) => button.textContent?.includes("Gate failure B"))!
        .click(),
    );
    await act(async () => {
      rejectResponse(new Error("stale auto-allow failed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.doesNotMatch(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /stale auto-allow failed/,
      "the old A failure toast cannot appear on B",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale A takeover cannot overwrite a newer A revisit or control SSE", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "takeover-b-1234567890";
  const summaryA = {
    ...bootstrap.sessions[0],
    controlOwner: "old-owner",
    controlledByThisWindow: false,
  };
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "takeover-b",
    name: "Takeover B",
    active: false,
    writable: false,
  };
  const revisitedA: SessionViewData = {
    ...draftView,
    session: {
      ...summaryA,
      controlOwner: "new-owner",
      controlledByThisWindow: false,
    },
    state: { ...bootstrap.state, isStreaming: false },
    isActive: true,
    runtimeStatus: "active",
    controlOwner: "new-owner",
    controlledByThisWindow: false,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: { ...bootstrap.state, sessionId: "takeover-b" },
    isActive: false,
    runtimeStatus: "view-only",
  };
  let resolveTakeover!: (value: {
    controlOwner: string;
    controlledByThisWindow: true;
  }) => void;
  const pendingTakeover = new Promise<{
    controlOwner: string;
    controlledByThisWindow: true;
  }>((resolve) => {
    resolveTakeover = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [summaryA, summaryB],
      sessionsTotal: 2,
      controlOwner: "old-owner",
      controlledByThisWindow: false,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === secondId ? viewB : revisitedA),
    takeSessionControl: async () => pendingTakeover,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(
      async () => new Promise((resolve) => dom.window.setTimeout(resolve, 450)),
    );
    const takeover = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-control-banner button",
      ),
    ].find((button) => button.textContent?.includes("接管控制"));
    assert.ok(takeover, "the initially foreign A pane exposes takeover");
    await act(async () => {
      takeover.click();
      await Promise.resolve();
    });
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => sessionButton("Takeover B").click());
    await act(async () => sessionButton("Active").click());
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "pi_chat_session_control_changed",
        sessionId: activeId,
        controlOwner: "newer-sse-owner",
        controlledByThisWindow: false,
      });
      await Promise.resolve();
    });
    await act(async () => {
      resolveTakeover({
        controlOwner: "stale-takeover",
        controlledByThisWindow: true,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(
      async () => new Promise((resolve) => dom.window.setTimeout(resolve, 450)),
    );
    assert.ok(
      dom.window.document.querySelector(".session-control-banner"),
      "a stale pre-navigation takeover cannot claim the revisited A pane",
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /另一窗口中控制/,
      "the newer same-Session control SSE remains authoritative",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("late model and thinking responses from A do not overwrite the Session B composer", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "11111111111111111111";
  const modelA = {
    id: "model",
    name: "Model A",
    provider: "test",
    input: ["text"],
    reasoning: true,
  };
  const modelB = {
    id: "model-b",
    name: "Model B",
    provider: "test",
    input: ["text"],
    reasoning: true,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: secondId,
      sessionId: "second",
      name: "Session B",
      active: false,
      messageCount: 1,
    },
    state: {
      ...draftView.state,
      model: modelB,
      thinkingLevel: "low",
      sessionId: "second",
    },
  };
  let resolveModel!: (value: { model: typeof modelA; pending: false }) => void;
  let resolveThinking!: (value: { level: "high"; pending: false }) => void;
  const pendingModel = new Promise<{ model: typeof modelA; pending: false }>(
    (resolve) => {
      resolveModel = resolve;
    },
  );
  const pendingThinking = new Promise<{ level: "high"; pending: false }>(
    (resolve) => {
      resolveThinking = resolve;
    },
  );
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, model: modelA },
      models: [modelA, modelB],
      sessions: [
        ...bootstrap.sessions,
        {
          ...bootstrap.sessions[0],
          id: secondId,
          sessionId: "second",
          name: "Session B",
          active: false,
          updatedAt: 2,
        },
      ],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) =>
      id === secondId
        ? viewB
        : {
            ...draftView,
            session: { ...draftView.session, id: activeId, name: "Active" },
            state: {
              ...draftView.state,
              model: modelA,
              thinkingLevel: "medium",
            },
          },
    setModel: async () => pendingModel,
    setThinking: async () => pendingThinking,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const visitB = async () => {
    const button = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((candidate) => candidate.textContent?.includes("Session B"));
    assert.ok(button);
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(
      dom.window.document.querySelector(
        ".composer-model-select .compact-select-trigger",
      )?.textContent || "",
      /Model B/,
    );
  };
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(
          ".composer-model-select .compact-select-trigger",
        )!
        .click(),
    );
    const modelOption = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        ".composer-model-select .compact-select-option",
      ),
    ].find((option) => option.textContent?.includes("Model B"));
    assert.ok(modelOption);
    await act(async () => modelOption.click());
    await visitB();
    await act(async () => resolveModel({ model: modelA, pending: false }));
    assert.match(
      dom.window.document.querySelector(
        ".composer-model-select .compact-select-trigger",
      )?.textContent || "",
      /Model B/,
    );

    // Switch back to A only long enough to initiate the request, then B again.
    const activeButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((candidate) => candidate.textContent?.includes("Active"));
    assert.ok(activeButton);
    await act(async () => {
      activeButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(
          ".thinking-control .compact-select-trigger",
        )!
        .click(),
    );
    const highOnA = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        ".thinking-control .compact-select-option",
      ),
    ].find((option) => option.textContent?.trim() === "high");
    assert.ok(highOnA);
    await act(async () => highOnA.click());
    await visitB();
    await act(async () => resolveThinking({ level: "high", pending: false }));
    assert.match(
      dom.window.document.querySelector(
        ".thinking-control .compact-select-trigger",
      )?.textContent || "",
      /low/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an abort result confirming settlement clears Stop without waiting for SSE", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      sessions: [{ ...bootstrap.sessions[0], running: true }],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    abort: async () => ({
      ok: true,
      abortPending: false,
      isStreaming: false,
      queuePaused: false,
    }),
    viewSession: async () => ({
      ...draftView,
      session: bootstrap.sessions[0],
      state: { ...draftView.state, isStreaming: false },
      isStreaming: false,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".stop-button")!
        .click(),
    );
    assert.equal(
      dom.window.document.querySelector(".stop-button"),
      null,
      "an authoritative non-streaming abort result must remove Stop immediately",
    );
    assert.ok(dom.window.document.querySelector(".send-button"));
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a pending abort stays in stopping state until agent settlement", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      sessions: [
        {
          ...bootstrap.sessions[0],
          running: true,
          activity: {
            execution: "running" as const,
            awaitingConfirmation: false,
          },
        },
      ],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    abort: async () => ({
      ok: true,
      abortPending: true,
      isStreaming: true,
      queuePaused: false,
    }),
    viewSession: async () => ({ ...draftView, session: bootstrap.sessions[0] }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(dom.window.document.querySelector(".session-status.is-running"));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".stop-button")!
        .click(),
    );
    assert.match(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /正在结束当前操作/,
    );
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(".stop-button")
        ?.disabled,
      true,
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({ type: "agent_settled", piChatSessionId: activeId }),
    );
    assert.equal(
      dom.window.document.querySelector(".session-status.is-running"),
      null,
    );
    assert.doesNotMatch(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /正在结束当前操作/,
    );
    assert.equal(
      dom.window.document.querySelector(".stop-button"),
      null,
      "a terminal SSE must remove Stop rather than leave a stale abort control",
    );
    assert.ok(
      dom.window.document.querySelector(".send-button"),
      "the settled composer returns to its normal Send action",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("late stop and queue actions from A do not overwrite Session B", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "22222222222222222222";
  const queuedA = {
    id: "queue-a",
    message: "queued A",
    imageCount: 0,
    createdAt: 1,
  };
  const queuedB = {
    id: "queue-b",
    message: "queued B",
    imageCount: 0,
    createdAt: 2,
  };
  const sessionB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "second",
    name: "Session B",
    active: false,
    updatedAt: 2,
  };
  const viewA: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: activeId,
      name: "Active",
      active: true,
      messageCount: 1,
    },
    state: { ...draftView.state, isStreaming: true, sessionId: "active" },
    queue: [queuedA],
    queuePaused: true,
    isStreaming: true,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: { ...draftView.session, ...sessionB },
    state: { ...draftView.state, isStreaming: true, sessionId: "second" },
    queue: [queuedB],
    queuePaused: true,
    isStreaming: true,
  };
  let resolveAbort!: (value: {
    ok: boolean;
    isStreaming: false;
    queuePaused: true;
  }) => void;
  let resolveCancel!: (value: {
    queue: (typeof queuedA)[];
    paused: true;
  }) => void;
  let resolveResume!: (value: {
    queue: typeof viewA.queue;
    paused: false;
  }) => void;
  const pendingAbort = new Promise<{
    ok: boolean;
    isStreaming: false;
    queuePaused: true;
  }>((resolve) => {
    resolveAbort = resolve;
  });
  const pendingCancel = new Promise<{
    queue: (typeof queuedA)[];
    paused: true;
  }>((resolve) => {
    resolveCancel = resolve;
  });
  const pendingResume = new Promise<{
    queue: typeof viewA.queue;
    paused: false;
  }>((resolve) => {
    resolveResume = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      queue: [queuedA],
      queuePaused: true,
      sessions: [...bootstrap.sessions, sessionB],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => (id === secondId ? viewB : viewA),
    abort: async () => pendingAbort,
    cancelQueued: async () => pendingCancel,
    resumeQueue: async () => pendingResume,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const visitB = async () => {
    const button = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((candidate) => candidate.textContent?.includes("Session B"));
    assert.ok(button);
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(
      dom.window.document.querySelector(".prompt-queue")?.textContent || "",
      /queued B/,
    );
  };
  const visitA = async () => {
    const button = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((candidate) => candidate.textContent?.includes("Active"));
    assert.ok(button);
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".stop-button")!
        .click(),
    );
    await visitB();
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(".stop-button")
        ?.disabled,
      false,
      "A pending abort must not disable Session B's independent Stop control",
    );
    await act(async () =>
      resolveAbort({ ok: true, isStreaming: false, queuePaused: true }),
    );
    assert.ok(
      dom.window.document.querySelector(".stop-button"),
      "B remains streaming after A abort resolves",
    );

    await visitA();
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".prompt-queue article button")!
        .click(),
    );
    await visitB();
    await act(async () => resolveCancel({ queue: [], paused: true }));
    assert.match(
      dom.window.document.querySelector(".prompt-queue")?.textContent || "",
      /queued B/,
    );

    await visitA();
    assert.equal(
      dom.window.document.querySelector(".prompt-queue"),
      null,
      "the completed A cancellation remains projected while its response is stale to B",
    );
    await act(async () => {
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        queue: [queuedA],
        paused: true,
      });
    });
    assert.equal(
      dom.window.document.querySelector(".prompt-queue"),
      null,
      "a stale queue frame cannot resurrect A's cancelled identity",
    );
    // Resume remains Session-scoped; start it before navigation using a distinct
    // surviving item rather than the already-cancelled tombstoned identity.
    const resumedA = { ...queuedA, id: `${queuedA.id}-resume`, message: "queued A resume" };
    await act(async () => {
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        queue: [resumedA],
        paused: true,
      });
    });
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".prompt-queue header button")!
        .click(),
    );
    await visitB();
    await act(async () => resolveResume({ queue: [resumedA], paused: false }));
    assert.match(
      dom.window.document.querySelector(".prompt-queue")?.textContent || "",
      /queued B/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("EventSource reconnect refreshes an authoritative terminal without duplicating it", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const terminal = {
    role: "assistant",
    content: "terminal recovered after reconnect",
    timestamp: 2,
  } as const;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      messages: [{ role: "user", content: "question", timestamp: 1 }, terminal],
      messageTotal: 2,
      turnTotal: 1,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    recoverConnection: async () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "message_end",
        piChatSessionId: activeId,
        message: terminal,
      }),
    );
    assert.equal(
      (dom.window.document.body.textContent || "").match(
        /terminal recovered after reconnect/g,
      )?.length,
      1,
    );
    await act(async () => {
      source.onerror?.(new dom.window.Event("error"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      (dom.window.document.body.textContent || "").match(
        /terminal recovered after reconnect/g,
      )?.length,
      1,
    );
    assert.ok(FakeEventSource.instances.length >= 2);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("New is instant and the first send shows Pi startup before materializing a Runtime", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let newSessionCalls = 0;
  let clearViewedCalls = 0;
  let promptCalls = 0;
  let viewSessionCalls = 0;
  let resolveClear!: () => void;
  let resolveNew!: (view: SessionViewData) => void;
  const pendingClear = new Promise<void>((resolve) => {
    resolveClear = resolve;
  });
  const pendingNew = new Promise<SessionViewData>((resolve) => {
    resolveNew = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    clearSessionViewed: async (sessionId: string) => {
      assert.equal(sessionId, activeId);
      clearViewedCalls += 1;
      await pendingClear;
      return { viewing: "" };
    },
    submitNewSession: async () => {
      newSessionCalls += 1;
      const view = await pendingNew;
      promptCalls += 1;
      return {
        sessionId: view.session.id,
        session: view.session,
        state: view.state,
        gateMode: "strict" as const,
        accepted: true as const,
        queued: false as const,
      };
    },
    viewSession: async () => {
      viewSessionCalls += 1;
      return {
        ...draftView,
        state: { ...draftView.state, isStreaming: false, messageCount: 2 },
        messages: [
          { role: "user", content: "hello from a cold draft" },
          { role: "assistant", content: "completed while SSE was stale" },
        ],
        messageTotal: 2,
        isStreaming: false,
      } satisfies SessionViewData;
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const newButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "New");
    assert.ok(newButton);
    await act(async () => newButton.click());
    assert.equal(newSessionCalls, 0);
    assert.equal(clearViewedCalls, 1);
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "新对话",
    );

    const textarea =
      dom.window.document.querySelector<HTMLTextAreaElement>(
        ".composer textarea",
      )!;
    await act(async () => {
      textarea.focus();
      const valueSetter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(textarea, "hello from a cold draft");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "hello from a cold draft",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(textarea.value, "hello from a cold draft");
    const send =
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!;
    assert.ok(send.querySelector("[data-icon='send']"));
    assert.equal(send.getAttribute("aria-label"), "发送消息");
    assert.equal(send.disabled, false);
    await act(async () => send.click());
    assert.equal(
      newSessionCalls,
      0,
      "Runtime creation must wait for the old viewed-Session pin to clear",
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /hello from a cold draft/,
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /正在准备 Pi，消息会自动发送/,
    );
    assert.equal(dom.window.document.querySelector(".stop-button"), null);

    await act(async () => {
      resolveClear();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(newSessionCalls, 1);
    await act(async () => {
      resolveNew(draftView);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(promptCalls, 1);
    assert.ok(dom.window.document.querySelector(".stop-button"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 4_100)));
    assert.equal(viewSessionCalls, 1);
    assert.match(
      dom.window.document.body.textContent || "",
      /completed while SSE was stale/,
    );
    assert.equal(dom.window.document.querySelector(".stop-button"), null);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("draft startup races keep the composer usable, preserve newer control, and show one user turn", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let resolveNew!: (view: SessionViewData) => void;
  let resolvePrompt!: (value: { accepted: boolean; queued: boolean }) => void;
  let resolveSecondPrompt!: (value: {
    accepted: boolean;
    queued: boolean;
  }) => void;
  let resolveThirdPrompt!: (value: {
    accepted: boolean;
    queued: boolean;
  }) => void;
  const pendingNew = new Promise<SessionViewData>((resolve) => {
    resolveNew = resolve;
  });
  const pendingPrompt = new Promise<{ accepted: boolean; queued: boolean }>(
    (resolve) => {
      resolvePrompt = resolve;
    },
  );
  const pendingSecondPrompt = new Promise<{
    accepted: boolean;
    queued: boolean;
  }>((resolve) => {
    resolveSecondPrompt = resolve;
  });
  const pendingThirdPrompt = new Promise<{
    accepted: boolean;
    queued: boolean;
  }>((resolve) => {
    resolveThirdPrompt = resolve;
  });
  let promptCalls = 0;
  const foreignDraft: SessionViewData = {
    ...draftView,
    controlOwner: "another-window",
    controlledByThisWindow: false,
    session: {
      ...draftView.session,
      controlOwner: "another-window",
      controlledByThisWindow: false,
    },
  };
  const authoritative: SessionViewData = {
    ...draftView,
    state: { ...draftView.state, isStreaming: false, messageCount: 1 },
    session: {
      ...draftView.session,
      messageCount: 1,
      controlOwner: "this-window",
      controlledByThisWindow: true,
    },
    messages: [{ role: "user", content: "draft race", timestamp: 200 }],
    messageTotal: 1,
    turnTotal: 1,
    controlOwner: "this-window",
    controlledByThisWindow: true,
  };
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    clearSessionViewed: async () => ({ viewing: "" }),
    submitNewSession: async () => {
      const view = await pendingNew;
      return {
        sessionId: view.session.id,
        session: view.session,
        state: view.state,
        gateMode: "strict" as const,
        accepted: true as const,
        queued: false as const,
      };
    },
    prompt: async () => {
      promptCalls += 1;
      return promptCalls === 1
        ? pendingPrompt
        : promptCalls === 2
          ? pendingSecondPrompt
          : pendingThirdPrompt;
    },
    viewSession: async () => authoritative,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-a",
          }),
        }),
      );
      await Promise.resolve();
    });
    const newButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "New")!;
    await act(async () => newButton.click());
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "draft race");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "draft race",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });

    await act(async () => {
      source.emitPi({
        type: "pi_chat_session_control_changed",
        sessionId: draftView.session.id,
        controlOwner: "this-window",
        controlledByThisWindow: true,
      });
      resolveNew(foreignDraft);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      textarea.disabled,
      false,
      "the combined first-prompt request owns the startup transaction without requiring a full draft view",
    );
    assert.notEqual(
      textarea.placeholder,
      "正在切换会话…",
      "prompt preparation must not masquerade as navigation",
    );

    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: draftView.session.id,
        piChatRunEpoch: "epoch-a",
        piChatRunGeneration: 1,
      });
      await Promise.resolve();
    });
    assert.notEqual(
      textarea.placeholder,
      "正在切换会话…",
      `unexpected navigation lock: ${textarea.placeholder}`,
    );
    assert.equal(
      textarea.disabled,
      false,
      `agent_start releases the late prompt acknowledgement lock (${textarea.placeholder})`,
    );
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      1,
    );

    await act(async () => {
      source.emitPi({
        type: "message_end",
        piChatSessionId: draftView.session.id,
        piChatRunEpoch: "epoch-a",
        piChatRunGeneration: 1,
        message: { role: "user", content: "draft race", timestamp: 220 },
      });
      source.emitPi({
        type: "message_end",
        piChatSessionId: draftView.session.id,
        piChatRunEpoch: "epoch-a",
        piChatRunGeneration: 1,
        message: {
          role: "assistant",
          content: "answer finished before prompt ack",
          timestamp: 230,
        },
      });
      source.emitPi({
        type: "agent_settled",
        piChatSessionId: draftView.session.id,
        piChatRunEpoch: "epoch-a",
        piChatRunGeneration: 1,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelector(".composer-preparing-status"),
      null,
      "a completed answer clears preparation even while prompt HTTP is pending",
    );
    assert.equal(
      textarea.disabled,
      false,
      "settlement must not re-lock the composer behind the pending HTTP request",
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /answer finished before prompt ack/,
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "second turn");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "second turn",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    assert.equal(
      promptCalls,
      1,
      "the first combined submission already owns its prompt acknowledgement; no second mocked prompt dispatch is needed before it resolves",
    );
    assert.equal(
      textarea.disabled,
      true,
      "the combined first-submit acknowledgement retains its own prompt lease until Pi confirms the next generation",
    );
    await act(async () => {
      source.emitPi({
        type: "agent_settled",
        piChatSessionId: draftView.session.id,
        piChatRunEpoch: "epoch-a",
        piChatRunGeneration: 1,
      });
      await Promise.resolve();
    });
    assert.equal(
      textarea.disabled,
      true,
      "a delayed first-turn event cannot release the active combined-submit lease",
    );
    await act(async () => {
      resolvePrompt({ accepted: true, queued: false });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      textarea.disabled,
      false,
      "the first combined acknowledgement settles its only pending submission lease",
    );
    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: draftView.session.id,
        piChatRunEpoch: "epoch-a",
        piChatRunGeneration: 2,
      });
      await Promise.resolve();
    });
    assert.equal(
      textarea.disabled,
      false,
      "the matching later run generation releases the active prompt lease",
    );
    assert.equal(
      dom.window.document.querySelector(".composer-preparing-status"),
      null,
      "the late first acknowledgement cannot restore the stale preparation bubble",
    );
    await act(async () => {
      resolveSecondPrompt({ accepted: true, queued: false });
      await Promise.resolve();
      source.emitPi({
        type: "agent_settled",
        piChatSessionId: draftView.session.id,
        piChatRunEpoch: "epoch-a",
        piChatRunGeneration: 2,
      });
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      2,
      "each of the two submitted turns appears exactly once",
    );

    const restartedBootstrap: BootstrapData = {
      ...bootstrap,
      state: { ...authoritative.state, isStreaming: false },
      messages: authoritative.messages,
      sessions: [authoritative.session],
      activeSessionId: draftView.session.id,
      activeSessionIds: [draftView.session.id],
      controlOwner: "this-window",
      controlledByThisWindow: true,
    };
    Object.assign(api, { bootstrap: async () => restartedBootstrap });
    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-b",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "third turn after restart");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "third turn after restart",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    assert.equal(
      promptCalls,
      2,
      "the combined first submit replaces the old separate first prompt dispatch",
    );
    assert.equal(
      textarea.disabled,
      false,
      "the combined first submission leaves the restarted prompt path free once prior work has settled",
    );
    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: draftView.session.id,
        piChatRunEpoch: "epoch-a",
        piChatRunGeneration: 3,
      });
      await Promise.resolve();
    });
    assert.equal(
      textarea.disabled,
      false,
      "a stale event from the previous service epoch is ignored",
    );
    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: draftView.session.id,
        piChatRunEpoch: "epoch-b",
        piChatRunGeneration: 1,
      });
      await Promise.resolve();
    });
    assert.equal(
      textarea.disabled,
      false,
      "generation one from the replacement service releases the new lease",
    );
    await act(async () => {
      resolveThirdPrompt({ accepted: true, queued: false });
      await Promise.resolve();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    assert.equal(
      dom.window.document.querySelector(".session-control-banner"),
      null,
      "a stale draft view must not overwrite newer control SSE",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("rename updates the sidebar and current title before confirmation, then rolls back with a clear error", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let rejectRename!: (reason?: unknown) => void;
  const pendingRename = new Promise<BootstrapData>((_resolve, reject) => {
    rejectRename = reject;
  });
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    sessions: async () => ({
      sessions: bootstrap.sessions,
      total: bootstrap.sessions.length,
    }),
    renameSession: async () => pendingRename,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".session-menu-trigger")!
        .click(),
    );
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          "[role='menuitem']",
        ),
      ]
        .find((button) => button.textContent === "重命名")!
        .click(),
    );
    const input = dom.window.document.querySelector<HTMLInputElement>(
      "input[aria-label='对话名称']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "即时名称");
      input.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "即时名称",
        }),
      );
    });
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-dialog button",
        ),
      ]
        .find((button) => button.textContent === "确认")!
        .click(),
    );
    assert.equal(
      dom.window.document.querySelector(".session-dialog"),
      null,
      "rename confirmation must close immediately",
    );
    assert.equal(
      dom.window.document.querySelector(".session-name")?.textContent,
      "即时名称",
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "即时名称",
    );

    await act(async () => rejectRename(new Error("后端拒绝")));
    assert.equal(
      dom.window.document.querySelector(".session-name")?.textContent,
      "Active",
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Active",
    );
    assert.match(
      dom.window.document.querySelector(".app-toast.error")?.textContent || "",
      /重命名失败，已恢复原名称：后端拒绝/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a replacement clears stale rename intent and ignores its old finalization", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let resolveRename!: (value: BootstrapData) => void;
  const pendingRename = new Promise<BootstrapData>((resolve) => {
    resolveRename = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    renameSession: async () => pendingRename,
    invalidateHandshake: () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".session-menu-trigger")!
        .click(),
    );
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          "[role='menuitem']",
        ),
      ]
        .find((button) => button.textContent === "重命名")!
        .click(),
    );
    const input = dom.window.document.querySelector<HTMLInputElement>(
      "input[aria-label='对话名称']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "A stale rename");
      input.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "A stale rename",
        }),
      );
    });
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-dialog button",
        ),
      ]
        .find((button) => button.textContent === "确认")!
        .click(),
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "workspace-changing",
            piChatRunEpoch: "epoch-rename-b",
            workspaceEpoch: "epoch-rename-b",
          }),
        }),
      ),
    );
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-rename-b",
            workspaceEpoch: "epoch-rename-b",
          }),
        }),
      ),
    );
    assert.equal(
      dom.window.document.querySelector(".session-name")?.textContent,
      "Active",
      "B inventory replaces the stale optimistic rename before A settles",
    );
    await act(async () => {
      resolveRename({
        ...bootstrap,
        sessions: [{ ...bootstrap.sessions[0], name: "A stale server rename" }],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      dom.window.document.querySelector(".session-name")?.textContent,
      "Active",
      "A cannot apply its stale bootstrap projection after B inventory replaces the optimistic row",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("delete restores a rejected row without overriding the newer local draft", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let rejectDelete!: (reason?: unknown) => void;
  const pendingDelete = new Promise<BootstrapData>((_resolve, reject) => {
    rejectDelete = reject;
  });
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    sessions: async () => ({
      sessions: bootstrap.sessions,
      total: bootstrap.sessions.length,
    }),
    deleteSession: async () => pendingDelete,
    viewSession: async () => ({
      ...draftView,
      session: { ...bootstrap.sessions[0], active: true },
      state: { ...bootstrap.state },
      isActive: true,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".session-menu-trigger")!
        .click(),
    );
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          "[role='menuitem']",
        ),
      ]
        .find((button) => button.textContent === "删除")!
        .click(),
    );
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-dialog button",
        ),
      ]
        .find((button) => button.textContent === "确认删除")!
        .click(),
    );
    assert.equal(
      dom.window.document.querySelector(".session-dialog"),
      null,
      "delete confirmation must close immediately",
    );
    assert.equal(
      dom.window.document.querySelector(".session-name"),
      null,
      "deleted Session must disappear before HTTP confirmation",
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "新对话",
      "viewed deletion must immediately select the local draft",
    );

    await act(async () => {
      rejectDelete(new Error("文件仍被占用"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelector(".session-name")?.textContent,
      "Active",
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "新对话",
      "rollback must not override newer draft selection",
    );
    assert.match(
      dom.window.document.querySelector(".app-toast.error")?.textContent || "",
      /删除失败，已恢复对话显示：文件仍被占用/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("rename and delete keep their immediate changes when the backend confirms", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let resolveRename!: (value: BootstrapData) => void;
  const pendingRename = new Promise<BootstrapData>((resolve) => {
    resolveRename = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    renameSession: async () => pendingRename,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".session-menu-trigger")!
        .click(),
    );
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          "[role='menuitem']",
        ),
      ]
        .find((button) => button.textContent === "重命名")!
        .click(),
    );
    const input = dom.window.document.querySelector<HTMLInputElement>(
      "input[aria-label='对话名称']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "确认名称");
      input.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "确认名称",
        }),
      );
    });
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-dialog button",
        ),
      ]
        .find((button) => button.textContent === "确认")!
        .click(),
    );
    assert.equal(
      dom.window.document.querySelector(".session-name")?.textContent,
      "确认名称",
    );
    await act(async () =>
      resolveRename({
        ...bootstrap,
        sessions: [{ ...bootstrap.sessions[0], name: "确认名称" }],
      }),
    );
    assert.equal(
      dom.window.document.querySelector(".session-name")?.textContent,
      "确认名称",
    );
    assert.match(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /对话已重命名/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("viewed delete immediately selects an existing replacement and success keeps it selected", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const replacement = {
    ...bootstrap.sessions[0],
    id: "abcdef0123456789abcd",
    sessionId: "replacement",
    name: "Replacement",
    active: false,
    writable: false,
  };
  let resolveDelete!: (value: BootstrapData) => void;
  const pendingDelete = new Promise<BootstrapData>((resolve) => {
    resolveDelete = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], replacement],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    deleteSession: async () => pendingDelete,
    viewSession: async (id: string) => ({
      ...draftView,
      session: id === replacement.id ? replacement : bootstrap.sessions[0],
      isActive: false,
      runtimeStatus: "view-only",
    }),
    warmSession: async (id: string) => ({
      sessionId: id,
      state: draftView.state,
      gateMode: "strict" as const,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".session-menu-trigger")!
        .click(),
    );
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          "[role='menuitem']",
        ),
      ]
        .find((button) => button.textContent === "删除")!
        .click(),
    );
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-dialog button",
        ),
      ]
        .find((button) => button.textContent === "确认删除")!
        .click(),
    );
    await act(async () => Promise.resolve());
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Replacement",
    );
    assert.equal(
      dom.window.document.querySelector(".session-name")?.textContent,
      "Replacement",
    );
    await act(async () =>
      resolveDelete({
        ...bootstrap,
        sessions: [replacement],
        sessionsTotal: 1,
        activeSessionId: replacement.id,
      }),
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Replacement",
    );
    assert.match(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /对话已删除/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("local delete keeps its deferred replacement navigation after success settles", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const replacement = {
    ...bootstrap.sessions[0],
    id: "abcdef0123456789abcd",
    sessionId: "replacement",
    name: "Deferred replacement",
    active: false,
    writable: false,
  };
  let resolveDelete!: (value: BootstrapData) => void;
  const pendingDelete = new Promise<BootstrapData>((resolve) => {
    resolveDelete = resolve;
  });
  let resolveReplacement!: (value: SessionViewData) => void;
  const deferredReplacement = new Promise<SessionViewData>((resolve) => {
    resolveReplacement = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], replacement],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    deleteSession: async () => pendingDelete,
    viewSession: async (id: string) =>
      id === replacement.id
        ? deferredReplacement
        : { ...draftView, session: bootstrap.sessions[0] },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".session-menu-trigger")!
        .click(),
    );
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          "[role='menuitem']",
        ),
      ]
        .find((button) => button.textContent === "删除")!
        .click(),
    );
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-dialog button",
        ),
      ]
        .find((button) => button.textContent === "确认删除")!
        .click(),
    );
    await act(async () => Promise.resolve());
    assert.match(
      dom.window.document.querySelector(".pane-loading")?.textContent || "",
      /Deferred replacement/,
    );

    await act(async () =>
      resolveDelete({
        ...bootstrap,
        sessions: [replacement],
        sessionsTotal: 1,
        activeSessionId: replacement.id,
      }),
    );
    assert.match(
      dom.window.document.querySelector(".pane-loading")?.textContent || "",
      /Deferred replacement/,
    );

    await act(async () =>
      resolveReplacement({
        ...draftView,
        session: replacement,
        isActive: false,
        runtimeStatus: "view-only",
      }),
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Deferred replacement",
    );
    assert.equal(
      dom.window.document.querySelector(".session-name")?.textContent,
      "Deferred replacement",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a deleted session cannot return from a deferred activation response", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const target = {
    ...bootstrap.sessions[0],
    id: "abcdef0123456789abcd",
    sessionId: "activation-target",
    name: "Activation target",
    active: false,
    writable: false,
    messageCount: 1,
  };
  const targetView: SessionViewData = {
    ...draftView,
    session: target,
    isActive: false,
    runtimeStatus: "view-only",
  };
  let resolveActivation!: (value: SessionViewData) => void;
  const deferredActivation = new Promise<SessionViewData>((resolve) => {
    resolveActivation = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], target],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    sessions: async () => ({ sessions: [bootstrap.sessions[0]], total: 1 }),
    viewSession: async (id: string) =>
      id === target.id
        ? targetView
        : { ...draftView, session: bootstrap.sessions[0] },
    activateSession: async () => deferredActivation,
    prompt: async () => ({ accepted: true, queued: false }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const targetButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((button) => button.textContent?.includes("Activation target"))!;
    await act(async () => targetButton.click());
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "activate then delete");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "activate then delete",
        }),
      );
    });
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click(),
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_sessions_changed",
        action: "deleted",
        sessionId: target.id,
      }),
    );
    await act(async () =>
      resolveActivation({
        ...targetView,
        isActive: true,
        runtimeStatus: "active",
        messages: [{ role: "user", content: "deleted activation transcript" }],
        messageTotal: 1,
        turnTotal: 1,
      }),
    );
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      1,
    );
    assert.match(
      dom.window.document.querySelector(".topbar-title")?.textContent || "",
      /Active/,
    );
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /Activation target|deleted activation transcript/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a structural delete cancels a deferred target view before it can resurrect the pane", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const target = {
    ...bootstrap.sessions[0],
    id: "abcdef0123456789abcd",
    sessionId: "target",
    name: "Deleted target",
    active: false,
    writable: false,
  };
  let resolveTargetView!: (view: SessionViewData) => void;
  const deferredTargetView = new Promise<SessionViewData>((resolve) => {
    resolveTargetView = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], target],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    sessions: async () => ({ sessions: [bootstrap.sessions[0]], total: 1 }),
    viewSession: async (id: string) =>
      id === target.id
        ? deferredTargetView
        : { ...draftView, session: bootstrap.sessions[0] },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const targetButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((button) => button.textContent?.includes("Deleted target"))!;
    await act(async () => targetButton.click());
    await act(async () => Promise.resolve());
    assert.equal(
      dom.window.document.querySelector(".pane-loading strong")?.textContent,
      "正在打开 Deleted target",
    );

    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_sessions_changed",
        action: "deleted",
        sessionId: target.id,
      }),
    );
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      1,
    );
    assert.match(
      dom.window.document.querySelector(".topbar-title")?.textContent || "",
      /Active/,
    );
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /Deleted target/,
    );

    await act(async () =>
      resolveTargetView({
        ...draftView,
        session: target,
        messages: [{ role: "user", content: "deleted transcript" }],
        messageTotal: 1,
        turnTotal: 1,
      }),
    );
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      1,
      "a delayed deleted view must not restore a sidebar row",
    );
    assert.match(
      dom.window.document.querySelector(".topbar-title")?.textContent || "",
      /Active/,
    );
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /deleted transcript/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("pending rename survives a stale refresh and an indeterminate response retains the local intent", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let rejectRename!: (reason?: unknown) => void;
  const pendingRename = new Promise<BootstrapData>((_resolve, reject) => {
    rejectRename = reject;
  });
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    renameSession: async () => pendingRename,
    sessions: async () => {
      throw new Error("网络仍不可用");
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".session-menu-trigger")!
        .click(),
    );
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          "[role='menuitem']",
        ),
      ]
        .find((button) => button.textContent === "重命名")!
        .click(),
    );
    const input = dom.window.document.querySelector<HTMLInputElement>(
      "input[aria-label='对话名称']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "网络中的名称");
      input.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "网络中的名称",
        }),
      );
    });
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-dialog button",
        ),
      ]
        .find((button) => button.textContent === "确认")!
        .click(),
    );
    assert.equal(
      dom.window.document.querySelector(".session-name")?.textContent,
      "网络中的名称",
    );
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".refresh-chat")!
        .click(),
    );
    assert.equal(
      dom.window.document.querySelector(".session-name")?.textContent,
      "网络中的名称",
      "stale refresh cannot erase pending rename",
    );
    await act(async () => rejectRename(new Error("连接中断")));
    assert.equal(
      dom.window.document.querySelector(".session-name")?.textContent,
      "网络中的名称",
    );
    assert.match(
      dom.window.document.querySelector(".app-toast.error")?.textContent || "",
      /重命名结果尚未确认，请刷新页面后核对：连接中断/,
    );
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(
        ".session-menu-trigger",
      )?.disabled,
      true,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a full inventory absent rename installs a tombstone against an older sidebar response", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let rejectRename!: (reason?: unknown) => void;
  let resolveStaleSidebar!: (value: {
    sessions: typeof bootstrap.sessions;
    total: number;
  }) => void;
  const pendingRename = new Promise<BootstrapData>((_resolve, reject) => {
    rejectRename = reject;
  });
  const staleSidebar = new Promise<{
    sessions: typeof bootstrap.sessions;
    total: number;
  }>((resolve) => {
    resolveStaleSidebar = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    renameSession: async () => pendingRename,
    sessions: async (all?: boolean) =>
      all ? { sessions: [], total: 0 } : staleSidebar,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".session-menu-trigger")!
        .click(),
    );
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          "[role='menuitem']",
        ),
      ]
        .find((button) => button.textContent === "重命名")!
        .click(),
    );
    const input = dom.window.document.querySelector<HTMLInputElement>(
      "input[aria-label='对话名称']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "即将消失");
      input.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "即将消失",
        }),
      );
    });
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-dialog button",
        ),
      ]
        .find((button) => button.textContent === "确认")!
        .click(),
    );

    // Start an ordinary sidebar request carrying the old row, but leave it in
    // flight until the full inventory proves the renamed Session was deleted.
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_sessions_changed",
        action: "renamed",
        sessionId: activeId,
      }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
    await act(async () => rejectRename(new Error("response lost")));
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      0,
    );
    assert.match(
      dom.window.document.querySelector(".app-toast.error")?.textContent || "",
      /对话已不存在或已被删除/,
    );

    await act(async () =>
      resolveStaleSidebar({ sessions: bootstrap.sessions, total: 1 }),
    );
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      0,
      "a response issued before terminal deletion cannot resurrect the row",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("session search loads the full inventory and pinning persists across remounts", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "pin-search-123456789";
  const second = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "pin-search",
    name: "Archived research",
    preview: "Needle preview",
    cwd: "D:/Research/Needle",
    updatedAt: 0,
    active: false,
    writable: false,
  };
  let fullInventoryCalls = 0;
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, sessionsTotal: 2 }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    sessions: async (all = false) => {
      if (all) fullInventoryCalls += 1;
      return all
        ? { sessions: [bootstrap.sessions[0], second], total: 2 }
        : { sessions: bootstrap.sessions, total: 2 };
    },
  });
  const render = async () => {
    const root = createRoot(dom.window.document.querySelector("#root")!);
    await act(async () => root.render(createElement(App)));
    return root;
  };
  let root = await render();
  try {
    const search = dom.window.document.querySelector<HTMLInputElement>(
      "input[aria-label='搜索对话']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "needle");
      search.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "needle",
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(fullInventoryCalls, 1);
    const resultRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((row) => row.textContent?.includes("Archived research"));
    assert.ok(resultRow);
    await act(async () =>
      resultRow
        .querySelector<HTMLButtonElement>(".session-menu-trigger")!
        .click(),
    );
    const pin = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem']",
      ),
    ].find((button) => button.textContent === "置顶");
    assert.ok(pin);
    await act(async () => pin.click());
    assert.ok(resultRow.querySelector(".session-pin-indicator"));

    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "");
      search.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "deleteContentBackward",
        }),
      );
    });
    assert.equal(
      [
        ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
      ].some((row) => row.textContent?.includes("Archived research")),
      false,
      "clearing search restores the collapsed, lazily loaded non-current directory",
    );

    await act(async () => root.unmount());
    dom.window.document.querySelector("#root")!.replaceChildren();
    root = await render();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const remountedSearch = dom.window.document.querySelector<HTMLInputElement>(
      "input[aria-label='搜索对话']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set?.call(remountedSearch, "needle");
      remountedSearch.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "needle",
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      fullInventoryCalls,
      2,
      "search is the explicit global-inventory path after remount",
    );
    const pinnedRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((row) => row.textContent?.includes("Archived research"));
    assert.ok(pinnedRow?.querySelector(".session-pin-indicator"));
    await act(async () =>
      pinnedRow!
        .querySelector<HTMLButtonElement>(".session-menu-trigger")!
        .click(),
    );
    assert.ok(
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          "[role='menuitem']",
        ),
      ].some((button) => button.textContent === "取消置顶"),
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("App collapses duplicate Session IDs from bootstrap to one latest sidebar row", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const stale = {
    ...bootstrap.sessions[0],
    name: "stale duplicate",
    preview: "old",
    updatedAt: 1,
  };
  const authoritative = {
    ...bootstrap.sessions[0],
    name: "latest duplicate",
    preview: "new",
    updatedAt: 2,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [stale, authoritative],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const rows =
      dom.window.document.querySelectorAll<HTMLElement>(".session-row");
    assert.equal(
      rows.length,
      1,
      "one stable Session ID must produce one navigable sidebar row",
    );
    assert.match(rows[0].textContent || "", /latest duplicate/);
    assert.equal(
      dom.window.document.querySelectorAll(".session-item").length,
      1,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a lost prompt acknowledgement cannot remove a user turn after SSE proves acceptance", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let rejectPrompt!: (cause: Error) => void;
  const pendingPrompt = new Promise<never>((_resolve, reject) => {
    rejectPrompt = reject;
  });
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => pendingPrompt,
    viewSession: async () => ({
      ...draftView,
      session: { ...bootstrap.sessions[0], running: true },
      state: { ...bootstrap.state, isStreaming: true },
      isStreaming: true,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "must remain visible");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "must remain visible",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({ type: "agent_start", piChatSessionId: activeId });
      await Promise.resolve();
      rejectPrompt(new Error("network response lost"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      1,
      "the accepted prompt keeps exactly one protected user row",
    );
    assert.equal(
      dom.window.document.querySelector(".message-user")?.textContent,
      "must remain visible",
    );
    assert.equal(
      textarea.value,
      "",
      "an uncertain acknowledgement must not restore text that Pi is already processing",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a lost prompt acknowledgement after a same-session refresh keeps its user turn visible", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let rejectPrompt!: (cause: Error) => void;
  const pendingPrompt = new Promise<never>((_resolve, reject) => {
    rejectPrompt = reject;
  });
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => pendingPrompt,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "survive refresh and lost ack");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "survive refresh and lost ack",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    // A user refresh commits a newer revision of the same Session while the
    // browser still waits for the prompt HTTP acknowledgement.
    await act(async () => {
      dom.window.document
        .querySelector<HTMLButtonElement>(".refresh-chat")!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      rejectPrompt(new Error("network response lost after refresh"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      1,
      "a same-session refresh must not strand an unknown accepted turn",
    );
    assert.equal(
      dom.window.document.querySelector(".message-user")?.textContent,
      "survive refresh and lost ack",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an explicit prompt rejection rolls back the local user turn", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { ApiRequestError, api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => {
      throw new ApiRequestError(
        "rejected",
        409,
        "APPLICATION_BUSY",
        "PC-UIERR001",
      );
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "restore rejected text");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "restore rejected text",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      0,
    );
    assert.equal(
      textarea.value,
      "restore rejected text",
      "a definite rejection restores the composer for correction or retry",
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /rejected（事件 ID：PC-UIERR001）/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a late queued acknowledgement survives a newer same-session view commit", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const queued = {
    id: "00000000-0000-4000-8000-000000000099",
    message: "late queued turn",
    imageCount: 0,
    createdAt: 1,
  };
  let resolvePrompt!: (value: {
    accepted: boolean;
    queued: true;
    id: string;
    queue: typeof queued[];
  }) => void;
  const pendingPrompt = new Promise<{
    accepted: boolean;
    queued: true;
    id: string;
    queue: typeof queued[];
  }>((resolve) => {
    resolvePrompt = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      sessions: [{ ...bootstrap.sessions[0], running: true }],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => pendingPrompt,
    // This read starts before the queue acknowledgement and therefore contains
    // the old empty queue, invalidating the original pane authority.
    viewSession: async () => ({
      ...draftView,
      session: { ...bootstrap.sessions[0], running: false },
      state: { ...draftView.state, isStreaming: false },
      isStreaming: false,
      queue: [],
      queuePaused: false,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, queued.message);
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: queued.message,
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".queue-submit-button")!
        .click();
      await Promise.resolve();
    });
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({ type: "agent_settled", piChatSessionId: activeId });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () =>
      resolvePrompt({
        accepted: true,
        queued: true,
        id: queued.id,
        queue: [queued],
      }),
    );
    assert.match(
      dom.window.document.querySelector(".prompt-queue")?.textContent || "",
      /late queued turn/,
      "a late queue acknowledgement must recover its stable queue entry",
    );
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      0,
      "a waiting queued turn belongs in Queue, not an invisible orphan bubble",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a queued dispatch timeout surfaces an asynchronous delivery uncertainty notice", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_prompt_delivery_uncertain",
        piChatSessionId: activeId,
        id: "queued-timeout",
      }),
    );
    assert.match(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /请勿重复发送/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an uncertain prompt delivery remains visible and tells the user not to retry", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => ({
      accepted: true,
      queued: false,
      deliveryUncertain: true,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "possibly delivered");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "possibly delivered",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
    });
    assert.equal(dom.window.document.querySelectorAll(".message-user").length, 1);
    assert.match(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /请勿重复发送/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a view that confirms a pending prompt before its acknowledgement leaves one user bubble", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let resolvePrompt!: (value: { accepted: boolean; queued: boolean }) => void;
  const pendingPrompt = new Promise<{ accepted: boolean; queued: boolean }>(
    (resolve) => {
      resolvePrompt = resolve;
    },
  );
  const authoritativeView: SessionViewData = {
    ...draftView,
    session: { ...bootstrap.sessions[0] },
    state: { ...bootstrap.state, isStreaming: false, messageCount: 2 },
    messages: [{ role: "user", content: "acknowledgement race" }],
    messageTotal: 1,
    turnTotal: 1,
    isActive: true,
    runtimeStatus: "active",
    isStreaming: false,
  };
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => pendingPrompt,
    viewSession: async () => authoritativeView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "acknowledgement race");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "acknowledgement race",
        }),
      );
    });
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click(),
    );

    // Settlement causes App's authoritative view reconciliation while the
    // prompt HTTP acknowledgement is still unresolved.
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({ type: "agent_settled", piChatSessionId: activeId });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      1,
    );

    await act(async () => resolvePrompt({ accepted: true, queued: false }));
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      1,
      "late acknowledgement must not append an already confirmed local turn",
    );
    assert.equal(
      dom.window.document.querySelector(".message-user")?.textContent,
      "acknowledgement race",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale hot view cannot restore the composer compaction lock after compaction_end", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const staleHotView: SessionViewData = {
    ...draftView,
    session: { ...bootstrap.sessions[0], active: true, writable: true },
    state: { ...bootstrap.state, isStreaming: true, isCompacting: true },
    isStreaming: true,
    runtimeStatus: "active",
    toolStatus: "Pi 正在思考…",
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true, isCompacting: false },
      sessions: [{ ...bootstrap.sessions[0], running: true }],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async () => staleHotView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const input = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({ type: "compaction_start", piChatSessionId: activeId }),
    );
    assert.equal(input.disabled, true, "compaction owns the composer while active");

    await act(async () => {
      source.emitPi({
        type: "compaction_end",
        piChatSessionId: activeId,
        aborted: false,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      input.disabled,
      false,
      "a stale hot-memory view must not relock input after compaction completed",
    );
    assert.doesNotMatch(input.placeholder, /正在压缩上下文/);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a recovered Runtime clears the sidebar's retained failure reason before its status refresh", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const status = () =>
    dom.window.document.querySelector<HTMLElement>(
      ".session-row.is-active .session-status",
    );
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_process_error",
        piChatSessionId: activeId,
        piChatRunGeneration: 7,
        error: "worker crashed while syncing state",
        incidentId: "PC-SSEERR01",
      }),
    );
    assert.ok(status()?.classList.contains("is-error"));
    assert.match(status()?.getAttribute("title") || "", /worker crashed while syncing state/);
    assert.match(status()?.getAttribute("title") || "", /事件 ID：PC-SSEERR01/);

    await act(async () =>
      source.emitPi({
        type: "pi_chat_process_recovered",
        piChatSessionId: activeId,
        piChatRunGeneration: 8,
      }),
    );
    assert.equal(status()?.classList.contains("is-error"), false);
    assert.doesNotMatch(status()?.getAttribute("title") || "", /worker crashed/);

    await act(async () =>
      source.emitPi({
        type: "pi_chat_process_error",
        piChatSessionId: activeId,
        piChatRunGeneration: 7,
        error: "late old worker crash",
        incidentId: "PC-STALE001",
      }),
    );
    assert.equal(
      status()?.classList.contains("is-error"),
      false,
      "an old worker generation cannot re-red a recovered Session",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
