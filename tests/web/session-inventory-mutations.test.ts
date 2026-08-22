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


test("Session menu clone opens the independently created cold conversation", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const copiedSession = {
    ...bootstrap.sessions[0],
    id: "11111111111111111111",
    sessionId: "copied",
    name: "Copied conversation",
    active: false,
  };
  let clones = 0;
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    sessions: async () => ({
      sessions: [copiedSession, ...bootstrap.sessions],
      total: bootstrap.sessions.length + 1,
    }),
    cloneSession: async () => {
      clones += 1;
      return { session: copiedSession };
    },
    viewSession: async () => ({
      ...draftView,
      session: copiedSession,
      state: { ...draftView.state, sessionId: "copied" },
      isActive: false,
      runtimeStatus: "view-only" as const,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>(".session-menu-trigger")!.click(),
    );
    await act(async () => {
      [...dom.window.document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
        .find((button) => button.textContent === "复制为新对话")!
        .click();
      await Promise.resolve();
    });
    assert.equal(clones, 0, "opening the confirmation must not clone immediately");
    assert.match(dom.window.document.querySelector(".session-dialog")?.textContent || "", /原对话不会被修改/);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".session-dialog footer button")!.click());
    assert.equal(dom.window.document.querySelector(".session-dialog"), null);
    assert.equal(clones, 0, "cancelling must leave the source unchanged");

    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".session-menu-trigger")!.click());
    await act(async () => {
      [...dom.window.document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
        .find((button) => button.textContent === "复制为新对话")!
        .click();
      await Promise.resolve();
    });
    await act(async () => {
      [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-dialog footer button")]
        .find((button) => button.textContent === "确认复制")!
        .click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(clones, 1);
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Copied conversation",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a delayed Clone success cannot steal a newer Session selection", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const second = {
    ...bootstrap.sessions[0],
    id: "33333333333333333333",
    sessionId: "second",
    name: "Second conversation",
    active: false,
  };
  const copied = {
    ...bootstrap.sessions[0],
    id: "44444444444444444444",
    sessionId: "copied-late",
    name: "Late copy",
    active: false,
  };
  bootstrap = { ...bootstrap, sessions: [...bootstrap.sessions, second] };
  let resolveClone!: (value: { session: typeof copied }) => void;
  const pendingClone = new Promise<{ session: typeof copied }>((resolve) => {
    resolveClone = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    sessions: async () => ({
      sessions: [copied, ...bootstrap.sessions],
      total: bootstrap.sessions.length + 1,
    }),
    cloneSession: async () => pendingClone,
    viewSession: async (id: string) => ({
      ...draftView,
      session: id === second.id ? second : copied,
      state: { ...draftView.state, sessionId: id },
      isActive: false,
      runtimeStatus: "view-only" as const,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>(".session-menu-trigger")!.click(),
    );
    await act(async () =>
      [...dom.window.document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
        .find((button) => button.textContent === "复制为新对话")!
        .click(),
    );
    await act(async () =>
      [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-dialog footer button")]
        .find((button) => button.textContent === "确认复制")!
        .click(),
    );
    const secondButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".session-item",
    )].find((button) => button.textContent?.includes("Second conversation"))!;
    await act(async () => {
      secondButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Second conversation",
    );

    await act(async () => {
      resolveClone({ session: copied });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Second conversation",
      "the older Clone intent may update inventory but never repaint the newer pane",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("persisted User fork opens the new Session with the selected text restored", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  bootstrap = {
    ...bootstrap,
    messages: [{
      role: "user",
      content: "revise this prompt",
      piChatPersistedMessageId: "user-1:0",
    }],
    messageTotal: 1,
    turnTotal: 1,
    visibleTurnCount: 1,
  };
  const forkedSession = {
    ...bootstrap.sessions[0],
    id: "22222222222222222222",
    sessionId: "forked",
    name: "Forked conversation",
    active: false,
  };
  const forkOrigin = {
    sourceSessionId: activeId,
    sourceName: bootstrap.sessions[0].name,
    sourcePersistedMessageId: "user-1:0",
    createdAt: 123,
    sourceAvailable: true,
  };
  let target = "";
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    sessions: async () => ({
      sessions: [forkedSession, ...bootstrap.sessions],
      total: bootstrap.sessions.length + 1,
    }),
    forkSession: async (_id: string, persistedMessageId: string) => {
      target = persistedMessageId;
      return { session: forkedSession, editorText: "revise this prompt", forkOrigin };
    },
    viewSession: async (id: string) => id === forkedSession.id ? ({
      ...draftView,
      session: forkedSession,
      state: { ...draftView.state, sessionId: "forked" },
      forkOrigin,
      isActive: false,
      runtimeStatus: "view-only" as const,
    }) : ({
      ...draftView,
      session: bootstrap.sessions[0],
      state: { ...bootstrap.state },
      isActive: true,
      runtimeStatus: "active" as const,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const fork = dom.window.document.querySelector<HTMLButtonElement>(
      "button[aria-label='在新对话中分叉']",
    )!;
    assert.equal(fork.disabled, false);
    await act(async () => {
      fork.click();
      await Promise.resolve();
    });
    assert.equal(target, "", "opening the Fork preview must not mutate immediately");
    assert.match(dom.window.document.querySelector(".session-dialog")?.textContent || "", /这条 User 消息之前的对话历史/);
    assert.match(dom.window.document.querySelector(".session-fork-preview")?.textContent || "", /revise this prompt/);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".session-dialog footer button")!.click());
    assert.equal(target, "", "cancelling the Fork preview must not create a Session");

    await act(async () => fork.click());
    await act(async () => {
      [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-dialog footer button")]
        .find((button) => button.textContent === "创建分叉")!
        .click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(target, "user-1:0");
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Forked conversation",
    );
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='消息输入']",
      )?.value,
      "revise this prompt",
    );
    assert.match(dom.window.document.querySelector(".session-fork-banner")?.textContent || "", new RegExp(bootstrap.sessions[0].name));
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".session-fork-banner button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(dom.window.document.querySelector(".topbar-title")?.textContent, bootstrap.sessions[0].name);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a committed-or-uncertain Fork keeps its duplicate guard until page refresh", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api, ApiRequestError } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  bootstrap = {
    ...bootstrap,
    messages: [{ role: "user", content: "fork me", piChatPersistedMessageId: "user-2:0" }],
    messageTotal: 1,
    turnTotal: 1,
    visibleTurnCount: 1,
  };
  let refreshes = 0;
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    sessions: async () => {
      refreshes += 1;
      return { sessions: bootstrap.sessions, total: bootstrap.sessions.length };
    },
    forkSession: async () => {
      throw new ApiRequestError("新对话已创建，但列表索引尚未确认；请刷新页面核对，不要重复操作", 409, "SESSION_COPY_COMMITTED");
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const fork = dom.window.document.querySelector<HTMLButtonElement>("button[aria-label='在新对话中分叉']")!;
    await act(async () => fork.click());
    await act(async () => {
      [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-dialog footer button")]
        .find((button) => button.textContent === "创建分叉")!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(dom.window.document.querySelector(".app-toast")?.textContent || "", /不要重复操作/);
    assert.doesNotMatch(dom.window.document.querySelector(".app-toast")?.textContent || "", /分叉新对话失败/);
    assert.equal(fork.disabled, true);
    assert.ok(refreshes > 0);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a definite rename rejection restores the authoritative name and unlocks management", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api, ApiRequestError } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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

    await act(async () =>
      rejectRename(
        new ApiRequestError(
          "另一个窗口正在控制该会话",
          409,
          "SESSION_CONTROL_CONFLICT",
        ),
      ),
    );
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
      /重命名失败，已恢复原名称：另一个窗口正在控制该会话/,
    );
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(
        ".session-menu-trigger",
      )?.disabled,
      false,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a replacement clears stale rename intent and ignores its old finalization", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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

test("a narrow rename acknowledgement retains the optimistic name and unlocks management", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    renameSession: async () => ({ id: activeId, name: "Narrow acknowledgement" }),
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
      [...dom.window.document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
        .find((button) => button.textContent === "重命名")!
        .click(),
    );
    const input = dom.window.document.querySelector<HTMLInputElement>("input[aria-label='对话名称']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")
        ?.set?.call(input, "Narrow acknowledgement");
      input.dispatchEvent(new dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "Narrow acknowledgement",
      }));
    });
    await act(async () =>
      [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-dialog button")]
        .find((button) => button.textContent === "确认")!
        .click(),
    );
    await act(async () => { await Promise.resolve(); });
    assert.equal(dom.window.document.querySelector(".session-name")?.textContent, "Narrow acknowledgement");
    assert.match(dom.window.document.querySelector(".app-toast")?.textContent || "", /对话已重命名/);
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>(".session-menu-trigger")?.disabled, false);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an uncertain delete keeps its row hidden without overriding the newer local draft", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
      dom.window.document.querySelector(".session-name"),
      null,
      "a pre-delete inventory snapshot cannot prove that the timed-out unlink failed",
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "新对话",
      "uncertain deletion must not override the newer draft selection",
    );
    assert.match(
      dom.window.document.querySelector(".app-toast.error")?.textContent || "",
      /删除结果尚未确认，请刷新页面后核对：文件仍被占用/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a definite delete rejection restores the row without overriding a newer draft", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api, ApiRequestError } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
    assert.equal(dom.window.document.querySelector(".session-name"), null);
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "新对话",
    );

    await act(async () =>
      rejectDelete(
        new ApiRequestError(
          "另一个窗口正在控制该会话",
          409,
          "SESSION_CONTROL_CONFLICT",
        ),
      ),
    );
    assert.equal(
      dom.window.document.querySelector(".session-name")?.textContent,
      "Active",
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "新对话",
      "rollback restores only the row and never overrides the newer draft",
    );
    assert.match(
      dom.window.document.querySelector(".app-toast.error")?.textContent || "",
      /删除失败，已恢复对话显示：另一个窗口正在控制该会话/,
    );
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(
        ".session-menu-trigger",
      )?.disabled,
      false,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("rename and delete keep their immediate changes when the backend confirms", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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

    const clearSearch = dom.window.document.querySelector<HTMLButtonElement>(
      ".session-search-clear",
    );
    assert.equal(clearSearch?.getAttribute("aria-label"), "清除对话搜索");
    await act(async () => clearSearch!.click());
    assert.equal(search.value, "");
    assert.equal(dom.window.document.activeElement, search);
    assert.equal(
      dom.window.document.querySelector(".session-search-clear"),
      null,
    );
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

test("a saved pin outside the base page is fetched and shown without searching", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const pinnedId = "abcdef0123456789abcd";
  const pinned = {
    ...bootstrap.sessions[0],
    id: pinnedId,
    sessionId: "older-pinned",
    name: "2阶能量下降格式设计",
    updatedAt: 1,
    lastUserPromptAt: 1,
    active: false,
    writable: false,
  };
  dom.window.localStorage.setItem(
    "pi-chat.session-navigation.v2",
    JSON.stringify({
      version: 2,
      pinnedSessionIds: [pinnedId],
      pinnedDirectoryKeys: [],
      collapsedDirectoryKeys: [],
      expandedDirectoryKeys: [],
    }),
  );
  const inventoryCalls: Array<{ all: boolean; includeIds: string[] }> = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessionsTotal: 2,
      sessionDirectories: [
        {
          cwd: bootstrap.sessions[0].cwd,
          count: 2,
          lastUserPromptAt: bootstrap.sessions[0].updatedAt,
        },
      ],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    sessions: async (all = false, includeIds: string[] = []) => {
      inventoryCalls.push({ all, includeIds });
      return {
        sessions: includeIds.includes(pinnedId)
          ? [bootstrap.sessions[0], pinned]
          : bootstrap.sessions,
        total: 2,
        directories: [
          {
            cwd: bootstrap.sessions[0].cwd,
            count: 2,
            lastUserPromptAt: bootstrap.sessions[0].updatedAt,
          },
        ],
      };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (dom.window.document.body.textContent?.includes(pinned.name)) break;
      await act(async () =>
        new Promise((resolve) => dom.window.setTimeout(resolve, 5)),
      );
    }
    const row = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((candidate) => candidate.textContent?.includes(pinned.name));
    assert.ok(row, "the saved pinned Session is materialized from the bounded inventory request");
    assert.ok(row.querySelector(".session-pin-indicator"));
    assert.equal(
      inventoryCalls.some(
        (call) => !call.all && call.includeIds.includes(pinnedId),
      ),
      true,
    );
    assert.equal(
      inventoryCalls.some((call) => call.all),
      false,
      "one old pin must not force an unbounded all-sessions request",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("directory prefixes survive base refreshes and recency reordering", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const cwd = bootstrap.sessions[0].cwd;
  const inventory = Array.from({ length: 45 }, (_, index) => ({
    ...bootstrap.sessions[0],
    id:
      index === 0
        ? activeId
        : (index + 100).toString(16).padStart(20, "0"),
    sessionId: `directory-${index}`,
    name: `Directory Session ${index + 1}`,
    updatedAt: 1_000 - index,
    lastUserPromptAt: 1_000 - index,
    active: index === 0,
    writable: index === 0,
  }));
  let directoryOrder = inventory;
  const directories = [{ cwd, count: 45, lastUserPromptAt: 1_000 }];
  const requestedLimits: number[] = [];
  let baseRefreshCalls = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: inventory.slice(0, 15),
      sessionsTotal: 45,
      sessionDirectories: directories,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    directorySessions: async (_cwd: string, limit = 15) => {
      requestedLimits.push(limit);
      return {
        sessions: directoryOrder.slice(0, limit),
        total: 45,
        directories,
      };
    },
    sessions: async () => {
      baseRefreshCalls += 1;
      return {
        sessions: inventory.slice(0, 15),
        total: 45,
        directories,
      };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const loadMore = dom.window.document.querySelector<HTMLButtonElement>(
      ".load-directory-sessions",
    );
    assert.match(loadMore?.textContent || "", /15\/45/);
    await act(async () => loadMore!.click());
    assert.deepEqual(requestedLimits, [30]);
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      30,
      "the first click expands the cumulative directory prefix",
    );

    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "pi_chat_sessions_changed",
        action: "updated",
        sessionId: activeId,
      });
      await new Promise((resolve) => dom.window.setTimeout(resolve, 240));
    });
    assert.ok(baseRefreshCalls >= 1);
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      30,
      "a later base refresh must not collapse already loaded directory rows",
    );

    directoryOrder = [inventory.at(-1)!, ...inventory.slice(0, -1)];
    const loadRemainder = dom.window.document.querySelector<HTMLButtonElement>(
      ".load-directory-sessions",
    );
    assert.match(loadRemainder?.textContent || "", /30\/45/);
    await act(async () => loadRemainder!.click());
    assert.deepEqual(requestedLimits, [30, 45]);
    const rowNames = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-name-text"),
    ].map((row) => row.textContent);
    assert.equal(rowNames.length, 45);
    assert.equal(new Set(rowNames).size, 45);
    assert.ok(rowNames.includes("Directory Session 45"));
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a newer fresh full inventory fences older full and directory responses", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const cwd = bootstrap.sessions[0].cwd;
  const authoritative = Array.from({ length: 30 }, (_, index) => ({
    ...bootstrap.sessions[0],
    id:
      index === 0
        ? activeId
        : (index + 600).toString(16).padStart(20, "0"),
    sessionId: `authority-${index}`,
    name:
      index === 20
        ? "Needle authoritative"
        : `Authority Session ${index + 1}`,
    updatedAt: 1_000 - index,
    lastUserPromptAt: 1_000 - index,
    active: index === 0,
    writable: index === 0,
  }));
  const staleFull = authoritative.map((session, index) =>
    index === 20 ? { ...session, name: "Needle stale full" } : session,
  );
  const directories = [{ cwd, count: 30, lastUserPromptAt: 1_000 }];
  let resolveOldFull!: (value: {
    sessions: typeof authoritative;
    total: number;
    directories: typeof directories;
  }) => void;
  const oldFull = new Promise<{
    sessions: typeof authoritative;
    total: number;
    directories: typeof directories;
  }>((resolve) => {
    resolveOldFull = resolve;
  });
  let resolveOldDirectory!: (value: {
    sessions: typeof authoritative;
    total: number;
    directories: typeof directories;
  }) => void;
  const oldDirectory = new Promise<{
    sessions: typeof authoritative;
    total: number;
    directories: typeof directories;
  }>((resolve) => {
    resolveOldDirectory = resolve;
  });
  let oldFullStarted = false;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: authoritative.slice(0, 15),
      sessionsTotal: 30,
      sessionDirectories: directories,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    directorySessions: async () => oldDirectory,
    sessions: async (
      all = false,
      _includeIds: string[] = [],
      fresh = false,
    ) => {
      if (all && fresh)
        return { sessions: authoritative, total: 30, directories };
      if (all) {
        oldFullStarted = true;
        return oldFull;
      }
      return {
        sessions: authoritative.slice(0, 15),
        total: 30,
        directories,
      };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".load-directory-sessions")!
        .click(),
    );
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
    });
    assert.equal(oldFullStarted, true);

    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".refresh-chat")!
        .click(),
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /Needle authoritative/,
    );

    await act(async () => {
      resolveOldFull({ sessions: staleFull, total: 30, directories });
      resolveOldDirectory({
        sessions: staleFull.slice(0, 30),
        total: 30,
        directories,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".session-search-clear")!
        .click(),
    );
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      30,
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /Needle authoritative/,
    );
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /Needle stale full/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("manual refresh requests one fresh full inventory and keeps it expanded", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const freshSession = {
    ...bootstrap.sessions[0],
    id: "fedcba9876543210abcd",
    sessionId: "fresh-sidebar",
    name: "Fresh on first refresh",
    active: false,
    writable: false,
  };
  const inventoryCalls: Array<{ all: boolean; fresh: boolean }> = [];
  let bootstrapCalls = 0;
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls > 1) throw new Error("Primary metadata unavailable");
      return { ...bootstrap, sessionsTotal: 2 };
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    sessions: async (
      all = false,
      _includeIds: string[] = [],
      fresh = false,
    ) => {
      inventoryCalls.push({ all, fresh });
      return {
        sessions: fresh
          ? [bootstrap.sessions[0], freshSession]
          : bootstrap.sessions,
        total: 2,
      };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".refresh-chat")!
        .click(),
    );
    assert.equal(
      inventoryCalls.some((call) => call.all && call.fresh),
      true,
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /Fresh on first refresh/,
      "the JSONL inventory refresh succeeds even when broader Bootstrap metadata fails",
    );
    assert.match(
      dom.window.document.querySelector(".app-toast.error")?.textContent || "",
      /Primary metadata unavailable/,
    );
    assert.match(
      dom.window.document.querySelector(".session-heading")?.textContent || "",
      /2/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("App collapses duplicate Session IDs from bootstrap to one latest sidebar row", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
