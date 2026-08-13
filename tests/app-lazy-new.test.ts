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
