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


test("rename updates the sidebar and current title before confirmation, then rolls back with a clear error", async () => {
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

test("delete restores a rejected row without overriding the newer local draft", async () => {
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
