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
    history: dom.window.history,
    location: dom.window.location,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
    cancelAnimationFrame: () => undefined,
  });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollTo", { value() {}, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", { value() {}, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", { value() {}, configurable: true });
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
    dispatchEvent() { return true; }
  }
  Object.assign(globalThis, { EventSource: FakeEventSource });
  return dom;
}

const activeId = "0123456789abcdefabcd";
const bootstrap: BootstrapData = {
  state: { model: { id: "model", name: "Model", provider: "test", input: ["text"] }, thinkingLevel: "medium", isStreaming: false, sessionId: "active", sessionFile: "C:/sessions/active.jsonl" },
  messages: [],
  sessions: [{ id: activeId, sessionId: "active", name: "Active", preview: "", cwd: "C:/work", updatedAt: 1, messageCount: 1, active: true, writable: true }],
  models: [{ id: "model", name: "Model", provider: "test", input: ["text"] }],
  commands: [],
  queue: [],
  queuePaused: false,
  workspaceCwd: "C:/work",
  activeSessionId: activeId,
  activeSessionIds: [activeId],
  applicationLifecycle: "idle",
};

const draftView: SessionViewData = {
  session: { id: "fedcba9876543210abcd", sessionId: "draft", name: "新对话", preview: "尚未发送消息", cwd: "C:/work", updatedAt: 2, messageCount: 0, active: false, writable: true },
  state: { ...bootstrap.state, sessionId: "draft", sessionFile: "C:/sessions/draft.jsonl", messageCount: 0 },
  messages: [],
  messageTotal: 0,
  messagesTruncated: false,
  isActive: true,
  runtimeStatus: "active",
  isStreaming: false,
  queue: [],
  queuePaused: false,
};

test("New is instant and the first send shows Pi startup before materializing a Runtime", async () => {
  const dom = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const originals = { ...api };
  let newSessionCalls = 0;
  let clearViewedCalls = 0;
  let promptCalls = 0;
  let viewSessionCalls = 0;
  let resolveClear!: () => void;
  let resolveNew!: (view: SessionViewData) => void;
  const pendingClear = new Promise<void>((resolve) => { resolveClear = resolve; });
  const pendingNew = new Promise<SessionViewData>((resolve) => { resolveNew = resolve; });
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    clearSessionViewed: async (sessionId: string) => { assert.equal(sessionId, activeId); clearViewedCalls += 1; await pendingClear; return { viewing: "" }; },
    newSession: async () => { newSessionCalls += 1; return pendingNew; },
    prompt: async () => { promptCalls += 1; return { accepted: true, queued: false }; },
    viewSession: async () => {
      viewSessionCalls += 1;
      return {
        ...draftView,
        state: { ...draftView.state, isStreaming: false, messageCount: 2 },
        messages: [{ role: "user", content: "hello from a cold draft" }, { role: "assistant", content: "completed while SSE was stale" }],
        messageTotal: 2,
        isStreaming: false,
      } satisfies SessionViewData;
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const newButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "New");
    assert.ok(newButton);
    await act(async () => newButton.click());
    assert.equal(newSessionCalls, 0);
    assert.equal(clearViewedCalls, 1);
    assert.equal(dom.window.document.querySelector(".topbar-title")?.textContent, "新对话");

    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    await act(async () => {
      textarea.focus();
      const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set;
      valueSetter?.call(textarea, "hello from a cold draft");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "hello from a cold draft" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(textarea.value, "hello from a cold draft");
    const send = dom.window.document.querySelector<HTMLButtonElement>(".send-button")!;
    assert.equal(send.disabled, false);
    await act(async () => send.click());
    assert.equal(newSessionCalls, 0, "Runtime creation must wait for the old viewed-Session pin to clear");
    assert.match(dom.window.document.body.textContent || "", /hello from a cold draft/);
    assert.match(dom.window.document.body.textContent || "", /正在启动 Pi 内核/);
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
    assert.match(dom.window.document.body.textContent || "", /completed while SSE was stale/);
    assert.equal(dom.window.document.querySelector(".stop-button"), null);
  } finally {
    await act(async () => root.unmount());
    Object.assign(api, originals);
  }
});
