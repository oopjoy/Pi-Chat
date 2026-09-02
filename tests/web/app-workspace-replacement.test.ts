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


test("a bootstrap without a restored Session opens a local New draft with the default workspace", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
    const { api } = await import("../../src/web/api");
    const { App } = await import("../../src/web/App");
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
