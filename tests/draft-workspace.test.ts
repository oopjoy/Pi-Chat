import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import type { BootstrapData, SessionViewData } from "../src/shared/types";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://127.0.0.1:30170/" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    InputEvent: dom.window.InputEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    sessionStorage: dom.window.sessionStorage,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
    cancelAnimationFrame: () => undefined,
  });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true });
  Object.defineProperty(dom.window.document, "hasFocus", { value: () => true, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollTo", { value() {}, configurable: true });
  class FakeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = 1;
    onerror: ((event: Event) => void) | null = null;
    constructor(readonly url: string | URL) {}
    addEventListener() {}
    removeEventListener() {}
    close() { this.readyState = 2; }
  }
  Object.assign(globalThis, { EventSource: FakeEventSource });
  return dom;
}

const activeId = "0123456789abcdefabcd";
const bootstrap: BootstrapData = {
  state: { model: null, isStreaming: false, sessionId: "active", sessionFile: "C:/sessions/active.jsonl" },
  messages: [],
  sessions: [{ id: activeId, sessionId: "active", name: "Busy", preview: "", cwd: "C:/work", updatedAt: 1, messageCount: 1, running: true, active: true, writable: true }],
  models: [], commands: [], queue: [], queuePaused: false, workspaceCwd: "C:/work", activeSessionId: activeId, activeSessionIds: [activeId], applicationLifecycle: "idle", primaryRuntime: { status: "ready", generation: 0, model: null, sessionId: activeId },
};

const draftView: SessionViewData = {
  session: { id: "fedcba9876543210abcd", sessionId: "draft", name: "新对话", preview: "", cwd: "D:/selected", updatedAt: 2, messageCount: 0, active: false, writable: true },
  state: { model: null, isStreaming: false, sessionId: "draft", sessionFile: "D:/sessions/draft.jsonl" },
  messages: [], sessions: [bootstrap.sessions[0]], models: [], commands: [], queue: [], queuePaused: false, workspaceCwd: "C:/work", activeSessionId: activeId, activeSessionIds: [activeId], applicationLifecycle: "idle", primaryRuntime: { status: "ready", generation: 0 },
};

test("a stale draft workspace picker cannot overwrite a later New draft", async () => {
  const dom = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const originals = { ...api };
  let resolvePicker!: (value: { cancelled: false; cwd: string }) => void;
  const pendingPicker = new Promise<{ cancelled: false; cwd: string }>((resolve) => {
    resolvePicker = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    clearSessionViewed: async () => ({ viewing: "" }),
    pickDraftWorkspace: async () => pendingPicker,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const newButton = () => [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "New")!;
    await act(async () => newButton().click());
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>("button[aria-label='浏览新对话工作路径']")!.click(),
    );
    await act(async () => newButton().click());
    assert.equal(
      dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent,
      "C:/work",
    );
    await act(async () => {
      resolvePicker({ cancelled: false, cwd: "D:/stale-picker" });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent,
      "C:/work",
      "the first draft's picker result must not alter the later draft cwd",
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(api, originals);
  }
});

test("an independent default workspace picker completes after New without changing that draft", async () => {
  const dom = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const originals = { ...api };
  let resolvePicker!: (value: { cancelled: false; workspaceName: string; cwd: string }) => void;
  const pendingPicker = new Promise<{ cancelled: false; workspaceName: string; cwd: string }>((resolve) => {
    resolvePicker = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    clearSessionViewed: async () => ({ viewing: "" }),
    pickWorkspace: async () => pendingPicker,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".topbar-settings")!.click());
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>("button[aria-label='选择默认工作路径']")!.click());
    const newButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "New")!;
    await act(async () => newButton.click());
    await act(async () => {
      resolvePicker({ cancelled: false, workspaceName: "later-default", cwd: "D:/later-default" });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent, "C:/work", "the already-created draft retains the default it captured");
    assert.equal(dom.window.document.querySelector(".workspace-setting-control code")?.textContent, "D:/later-default");
    await act(async () => newButton.click());
    assert.equal(dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent, "D:/later-default", "a later New inherits the committed global default");
  } finally {
    await act(async () => root.unmount());
    Object.assign(api, originals);
  }
});

test("settings changes the default workspace only for later New drafts", async () => {
  const dom = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const originals = { ...api };
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    clearSessionViewed: async () => ({ viewing: "" }),
    pickWorkspace: async () => ({ cancelled: false, workspaceName: "default-workspace", cwd: "D:/default-workspace" }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".topbar-settings")!.click());
    const picker = dom.window.document.querySelector<HTMLButtonElement>("button[aria-label='选择默认工作路径']")!;
    assert.equal(picker.disabled, false);
    await act(async () => {
      picker.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(dom.window.document.querySelector(".workspace-setting-control code")?.textContent, "D:/default-workspace");
    assert.equal(dom.window.document.querySelector(".topbar-title")?.textContent, "Busy", "changing the future default must not replace the active pane");

    const newButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "New")!;
    await act(async () => newButton.click());
    assert.equal(dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent, "D:/default-workspace");
  } finally {
    await act(async () => root.unmount());
    Object.assign(api, originals);
  }
});

test("a running Session never disables New or the independent draft workspace picker", async () => {
  const dom = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const originals = { ...api };
  const submittedCwds: Array<string | undefined> = [];
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    clearSessionViewed: async () => ({ viewing: "" }),
    pickDraftWorkspace: async () => ({ cancelled: false, cwd: "D:/selected" }),
    submitNewSession: async (input) => {
      submittedCwds.push(input.cwd);
      return {
        sessionId: draftView.session.id,
        session: draftView.session,
        state: draftView.state,
        gateMode: "strict" as const,
        accepted: true as const,
        queued: false as const,
      };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const newButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "New");
    assert.ok(newButton);
    assert.equal(newButton.disabled, false);
    await act(async () => newButton.click());
    const picker = dom.window.document.querySelector<HTMLButtonElement>("button[aria-label='浏览新对话工作路径']")!;
    assert.equal(picker.disabled, false);
    assert.ok(picker.querySelector("svg"));
    await act(async () => picker.click());
    assert.equal(dom.window.document.querySelector(".draft-workspace-select .compact-select-trigger span")?.textContent, "D:/selected");
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "hello");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "hello" }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(submittedCwds, ["D:/selected"]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(api, originals);
  }
});
