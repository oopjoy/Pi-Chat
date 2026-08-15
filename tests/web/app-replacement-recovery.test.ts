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

test("a replacement clears the old Primary readiness generation before accepting its lower generation", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
    const { api } = await import("../../src/web/api");
    const { App } = await import("../../src/web/App");
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

test("a replacement invalidates an old early handshake and starts a fresh history request", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
