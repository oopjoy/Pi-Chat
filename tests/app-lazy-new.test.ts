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
    static instances: FakeEventSource[] = [];
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = 1;
    onerror: ((event: Event) => void) | null = null;
    private listeners = new Map<string, Set<(event: Event) => void>>();
    constructor(readonly url: string | URL) { FakeEventSource.instances.push(this); }
    addEventListener(type: string, listener: (event: Event) => void) {
      const listeners = this.listeners.get(type) || new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: (event: Event) => void) { this.listeners.get(type)?.delete(listener); }
    close() { this.readyState = 2; }
    dispatchEvent(event: Event) {
      for (const listener of this.listeners.get(event.type) || []) listener(event);
      return true;
    }
    emitPi(payload: Record<string, unknown>) {
      this.dispatchEvent(new dom.window.MessageEvent("pi", { data: JSON.stringify(payload) }));
    }
  }
  Object.assign(globalThis, { EventSource: FakeEventSource });
  return { dom, FakeEventSource };
}

const activeId = "0123456789abcdefabcd";
const bootstrap: BootstrapData = {
  state: { model: { id: "model", name: "Model", provider: "test", input: ["text"], reasoning: true }, thinkingLevel: "medium", isStreaming: false, sessionId: "active", sessionFile: "C:/sessions/active.jsonl" },
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

test("conversation controls live in the composer while settings moves to the top bar", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const originals = { ...api };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      commands: [{ name: "gate", description: "Gate", source: "extension" }],
      stats: { tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 }, contextUsage: { tokens: 100, contextWindow: 1_000, percent: 10 } },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(dom.window.document.querySelector(".topbar-settings"));
    assert.ok(dom.window.document.querySelector(".diff-sidebar-toggle"));
    assert.equal(dom.window.document.querySelector(".topbar .model-menu"), null);
    assert.equal(dom.window.document.querySelector(".topbar .usage-pill"), null);
    assert.equal(dom.window.document.querySelector(".management-nav"), null);
    assert.ok(dom.window.document.querySelector(".composer .composer-model-select"));
    assert.ok(dom.window.document.querySelector(".composer .thinking-control"));
    const gateTrigger = dom.window.document.querySelector<HTMLButtonElement>(".composer .gate-control .compact-select-trigger")!;
    assert.equal(gateTrigger.textContent?.trim(), "未同步");
    await act(async () => gateTrigger.click());
    assert.deepEqual([...dom.window.document.querySelectorAll(".gate-control .compact-select-option > span:last-of-type")].map((node) => node.textContent), ["未同步", "严格", "放行"]);
    assert.ok(dom.window.document.querySelector(".composer .composer-usage"));
    assert.ok(dom.window.document.querySelector(".attachment-button [data-icon='paperclip']"));
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".thinking-control .compact-select-trigger")?.click());
    const thinkingLabels = [...dom.window.document.querySelectorAll(".thinking-control .compact-select-option > span:last-of-type")].map((node) => node.textContent);
    assert.deepEqual(thinkingLabels, ["off", "min", "low", "med", "high", "xhigh", "max"]);
    assert.ok(dom.window.document.querySelector(".thinking-control .compact-select-option.has-leading-check"));
    const settings = dom.window.document.querySelector<HTMLButtonElement>(".topbar-settings")!;
    assert.equal(settings.getAttribute("aria-expanded"), "false");
    assert.equal(settings.getAttribute("aria-controls"), "pi-chat-settings-dialog");
    await act(async () => settings.click());
    assert.ok(dom.window.document.querySelector("#pi-chat-settings-dialog"));
    assert.equal(settings.getAttribute("aria-expanded"), "true");
    assert.equal(settings.getAttribute("aria-label"), "关闭设置");
  } finally {
    await act(async () => root.unmount());
    Object.assign(api, originals);
  }
});

test("Gate mode changes only after the Runtime confirms the command", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const originals = { ...api };
  let resolveGate!: (value: { accepted: boolean; queued: boolean; extension: true; command: string; isStreaming: false }) => void;
  const pendingGate = new Promise<{ accepted: boolean; queued: boolean; extension: true; command: string; isStreaming: false }>((resolve) => { resolveGate = resolve; });
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
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".gate-control .compact-select-trigger")!;
    assert.equal(trigger.textContent?.trim(), "严格");
    await act(async () => trigger.click());
    const openOption = [...dom.window.document.querySelectorAll<HTMLElement>(".gate-control .compact-select-option")].find((option) => option.textContent?.trim() === "放行");
    assert.ok(openOption);
    await act(async () => openOption.click());
    assert.equal(trigger.textContent?.trim(), "严格", "pending HTTP must not optimistically enable auto-allow");
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => source.emitPi({ type: "pi_chat_gate_mode_changed", piChatSessionId: activeId, mode: "open" }));
    assert.equal(trigger.textContent?.trim(), "放行", "Runtime confirmation SSE must update every window before HTTP post-processing ends");
    await act(async () => resolveGate({ accepted: true, queued: false, extension: true, command: "gate", isStreaming: false }));
    assert.equal(trigger.textContent?.trim(), "放行");
  } finally {
    await act(async () => root.unmount());
    Object.assign(api, originals);
  }
});

test("the next turn carries the Gate mode shown after refresh", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const originals = { ...api };
  const promptCalls: unknown[][] = [];
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, gateMode: "strict" }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async (...args: unknown[]) => { promptCalls.push(args); return { accepted: true, queued: false }; },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "next turn");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "next turn" }));
    });
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click());
    assert.deepEqual(promptCalls, [["next turn", [], activeId, "strict"]]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(api, originals);
  }
});

test("queued prompt moves exclusively between queue and transcript across dispatch failure", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const originals = { ...api };
  const queuedId = "00000000-0000-4000-8000-000000000001";
  const queuedItem = { id: queuedId, message: "queued only once", imageCount: 0, createdAt: 2 };
  let resolvePrompt!: (value: { accepted: boolean; queued: boolean; id: string; queue: typeof queuedItem[] }) => void;
  const pendingPrompt = new Promise<{ accepted: boolean; queued: boolean; id: string; queue: typeof queuedItem[] }>((resolve) => { resolvePrompt = resolve; });
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, queue: [], queuePaused: true }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => pendingPrompt,
    sessions: async () => ({ sessions: bootstrap.sessions, total: bootstrap.sessions.length }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    const queueSubmit = dom.window.document.querySelector<HTMLButtonElement>(".queue-submit-button")!;
    assert.equal(queueSubmit.textContent, "排队");
    assert.equal(dom.window.document.querySelector(".send-button"), null);
    assert.equal(dom.window.document.querySelector(".stop-button"), null);
    assert.equal(queueSubmit.nextElementSibling?.className, "attachment-control");
    await act(async () => {
      textarea.focus();
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, queuedItem.message);
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: queuedItem.message }));
    });
    await act(async () => queueSubmit.click());
    assert.equal(dom.window.document.querySelectorAll(".message-user").length, 0);

    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => source.emitPi({ type: "pi_chat_queue_update", piChatSessionId: activeId, admittedId: queuedId, queue: [queuedItem], paused: true }));
    assert.equal(dom.window.document.querySelectorAll(".message-user").length, 0);
    assert.equal(dom.window.document.querySelectorAll(".prompt-queue article").length, 1);

    await act(async () => source.emitPi({ type: "pi_chat_queue_update", piChatSessionId: activeId, queue: [], paused: false }));
    await act(async () => source.emitPi({ type: "pi_chat_queue_dispatch", piChatSessionId: activeId, id: queuedId, message: queuedItem.message, imageCount: 0 }));
    assert.equal(dom.window.document.querySelectorAll(".prompt-queue article").length, 0);
    assert.equal(dom.window.document.querySelectorAll(".message-user").length, 1);
    const stopAfterDispatch = dom.window.document.querySelector<HTMLButtonElement>(".stop-button")!;
    assert.ok(stopAfterDispatch.querySelector("span"));
    assert.equal(stopAfterDispatch.parentElement?.lastElementChild, stopAfterDispatch);

    await act(async () => source.emitPi({ type: "pi_chat_queue_error", piChatSessionId: activeId, id: queuedId, queue: [queuedItem], paused: true, error: "rejected" }));
    assert.equal(dom.window.document.querySelectorAll(".message-user").length, 0);
    assert.equal(dom.window.document.querySelectorAll(".prompt-queue article").length, 1);
    assert.equal(dom.window.document.querySelector(".stop-button"), null);

    await act(async () => resolvePrompt({ accepted: true, queued: true, id: queuedId, queue: [queuedItem] }));
    assert.equal(dom.window.document.querySelectorAll(".message-user").length, 0);
    assert.equal(dom.window.document.querySelectorAll(".prompt-queue article").length, 1);
  } finally {
    await act(async () => root.unmount());
    Object.assign(api, originals);
  }
});

test("queue SSE invalidates an older Session view before it can erase queue state", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const originals = { ...api };
  const queuedItem = { id: "00000000-0000-4000-8000-000000000099", message: "SSE queue state wins", imageCount: 0, createdAt: 9 };
  let resolveView!: (view: SessionViewData) => void;
  const staleView = new Promise<SessionViewData>((resolve) => { resolveView = resolve; });
  const oldView: SessionViewData = {
    ...draftView,
    session: { ...draftView.session, id: activeId, sessionId: "active", name: "Active", active: true, writable: true },
    state: { ...bootstrap.state, isStreaming: false },
    queue: [],
    queuePaused: false,
  };
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, state: { ...bootstrap.state, isStreaming: true } }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async () => staleView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => source.emitPi({ type: "agent_settled", piChatSessionId: activeId }));
    await act(async () => source.emitPi({ type: "pi_chat_queue_update", piChatSessionId: activeId, admittedId: queuedItem.id, queue: [queuedItem], paused: true }));
    assert.equal(dom.window.document.querySelectorAll(".prompt-queue article").length, 1);

    await act(async () => resolveView(oldView));
    assert.equal(dom.window.document.querySelectorAll(".prompt-queue article").length, 1, "the earlier view must not overwrite newer queue SSE state");
  } finally {
    await act(async () => root.unmount());
    Object.assign(api, originals);
  }
});

test("extension resolution invalidates an older Session view before it can reopen confirmation", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const originals = { ...api };
  const request = { type: "extension_ui_request", id: "pending-confirm", method: "confirm", title: "Allow?", piChatSessionId: activeId } as const;
  let resolveView!: (view: SessionViewData) => void;
  const staleView = new Promise<SessionViewData>((resolve) => { resolveView = resolve; });
  const oldView: SessionViewData = {
    ...draftView,
    session: { ...draftView.session, id: activeId, sessionId: "active", name: "Active", active: true, writable: true },
    state: { ...bootstrap.state, isStreaming: false },
    pendingExtensionRequest: request,
  };
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, state: { ...bootstrap.state, isStreaming: true }, pendingExtensionRequest: request }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async () => staleView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(dom.window.document.querySelector(".extension-dialog"));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => source.emitPi({ type: "agent_settled", piChatSessionId: activeId }));
    await act(async () => source.emitPi({ type: "pi_chat_extension_request_resolved", piChatSessionId: activeId, id: request.id }));
    assert.equal(dom.window.document.querySelector(".extension-dialog"), null);

    await act(async () => resolveView(oldView));
    assert.equal(dom.window.document.querySelector(".extension-dialog"), null, "the older view must not restore a resolved confirmation");
  } finally {
    await act(async () => root.unmount());
    Object.assign(api, originals);
  }
});

test("late model and thinking responses from A do not overwrite the Session B composer", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const originals = { ...api };
  const secondId = "11111111111111111111";
  const modelA = { id: "model", name: "Model A", provider: "test", input: ["text"], reasoning: true };
  const modelB = { id: "model-b", name: "Model B", provider: "test", input: ["text"], reasoning: true };
  const viewB: SessionViewData = {
    ...draftView,
    session: { ...draftView.session, id: secondId, sessionId: "second", name: "Session B", active: false, messageCount: 1 },
    state: { ...draftView.state, model: modelB, thinkingLevel: "low", sessionId: "second" },
  };
  let resolveModel!: (value: { model: typeof modelA; pending: false }) => void;
  let resolveThinking!: (value: { level: "high"; pending: false }) => void;
  const pendingModel = new Promise<{ model: typeof modelA; pending: false }>((resolve) => { resolveModel = resolve; });
  const pendingThinking = new Promise<{ level: "high"; pending: false }>((resolve) => { resolveThinking = resolve; });
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, state: { ...bootstrap.state, model: modelA }, models: [modelA, modelB], sessions: [...bootstrap.sessions, { ...bootstrap.sessions[0], id: secondId, sessionId: "second", name: "Session B", active: false, updatedAt: 2 }] }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => id === secondId ? viewB : { ...draftView, session: { ...draftView.session, id: activeId, name: "Active" }, state: { ...draftView.state, model: modelA, thinkingLevel: "medium" } },
    setModel: async () => pendingModel,
    setThinking: async () => pendingThinking,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const visitB = async () => {
    const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")].find((candidate) => candidate.textContent?.includes("Session B"));
    assert.ok(button);
    await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.match(dom.window.document.querySelector(".composer-model-select .compact-select-trigger")?.textContent || "", /Model B/);
  };
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".composer-model-select .compact-select-trigger")!.click());
    const modelOption = [...dom.window.document.querySelectorAll<HTMLElement>(".composer-model-select .compact-select-option")].find((option) => option.textContent?.includes("Model B"));
    assert.ok(modelOption);
    await act(async () => modelOption.click());
    await visitB();
    await act(async () => resolveModel({ model: modelA, pending: false }));
    assert.match(dom.window.document.querySelector(".composer-model-select .compact-select-trigger")?.textContent || "", /Model B/);

    // Switch back to A only long enough to initiate the request, then B again.
    const activeButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")].find((candidate) => candidate.textContent?.includes("Active"));
    assert.ok(activeButton);
    await act(async () => { activeButton.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".thinking-control .compact-select-trigger")!.click());
    const highOnA = [...dom.window.document.querySelectorAll<HTMLElement>(".thinking-control .compact-select-option")].find((option) => option.textContent?.trim() === "high");
    assert.ok(highOnA);
    await act(async () => highOnA.click());
    await visitB();
    await act(async () => resolveThinking({ level: "high", pending: false }));
    assert.match(dom.window.document.querySelector(".thinking-control .compact-select-trigger")?.textContent || "", /low/);
  } finally {
    await act(async () => root.unmount());
    Object.assign(api, originals);
  }
});

test("late stop and queue actions from A do not overwrite Session B", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../src/web/api");
  const { App } = await import("../src/web/App");
  const originals = { ...api };
  const secondId = "22222222222222222222";
  const queuedA = { id: "queue-a", message: "queued A", imageCount: 0, createdAt: 1 };
  const queuedB = { id: "queue-b", message: "queued B", imageCount: 0, createdAt: 2 };
  const sessionB = { ...bootstrap.sessions[0], id: secondId, sessionId: "second", name: "Session B", active: false, updatedAt: 2 };
  const viewA: SessionViewData = { ...draftView, session: { ...draftView.session, id: activeId, name: "Active", active: true, messageCount: 1 }, state: { ...draftView.state, isStreaming: true, sessionId: "active" }, queue: [queuedA], queuePaused: true, isStreaming: true };
  const viewB: SessionViewData = { ...draftView, session: { ...draftView.session, ...sessionB }, state: { ...draftView.state, isStreaming: true, sessionId: "second" }, queue: [queuedB], queuePaused: true, isStreaming: true };
  let resolveAbort!: (value: { ok: boolean; isStreaming: false; queuePaused: true }) => void;
  let resolveCancel!: (value: { queue: typeof queuedA[]; paused: true }) => void;
  let resolveResume!: (value: { queue: typeof queuedA[]; paused: false }) => void;
  const pendingAbort = new Promise<{ ok: boolean; isStreaming: false; queuePaused: true }>((resolve) => { resolveAbort = resolve; });
  const pendingCancel = new Promise<{ queue: typeof queuedA[]; paused: true }>((resolve) => { resolveCancel = resolve; });
  const pendingResume = new Promise<{ queue: typeof queuedA[]; paused: false }>((resolve) => { resolveResume = resolve; });
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, state: { ...bootstrap.state, isStreaming: true }, queue: [queuedA], queuePaused: true, sessions: [...bootstrap.sessions, sessionB] }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => id === secondId ? viewB : viewA,
    abort: async () => pendingAbort,
    cancelQueued: async () => pendingCancel,
    resumeQueue: async () => pendingResume,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const visitB = async () => {
    const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")].find((candidate) => candidate.textContent?.includes("Session B"));
    assert.ok(button);
    await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.match(dom.window.document.querySelector(".prompt-queue")?.textContent || "", /queued B/);
  };
  const visitA = async () => {
    const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")].find((candidate) => candidate.textContent?.includes("Active"));
    assert.ok(button);
    await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".stop-button")!.click());
    await visitB();
    await act(async () => resolveAbort({ ok: true, isStreaming: false, queuePaused: true }));
    assert.ok(dom.window.document.querySelector(".stop-button"), "B remains streaming after A abort resolves");

    await visitA();
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".prompt-queue article button")!.click());
    await visitB();
    await act(async () => resolveCancel({ queue: [], paused: true }));
    assert.match(dom.window.document.querySelector(".prompt-queue")?.textContent || "", /queued B/);

    await visitA();
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".prompt-queue header button")!.click());
    await visitB();
    await act(async () => resolveResume({ queue: [queuedA], paused: false }));
    assert.match(dom.window.document.querySelector(".prompt-queue")?.textContent || "", /queued B/);
  } finally {
    await act(async () => root.unmount());
    Object.assign(api, originals);
  }
});

test("New is instant and the first send shows Pi startup before materializing a Runtime", async () => {
  const { dom } = installDom();
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
    assert.ok(send.querySelector("[data-icon='send']"));
    assert.equal(send.getAttribute("aria-label"), "发送消息");
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
