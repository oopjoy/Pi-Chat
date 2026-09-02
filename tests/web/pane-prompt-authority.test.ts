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


test("a stale A prompt acknowledgement cannot modify a newer A revisit", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
    state: { ...bootstrap.state, isStreaming: true },
    runtimeStatus: "active",
    isActive: true,
    isStreaming: true,
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
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      1,
      "the accepted queued turn remains recoverable in the current A transcript",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a definite A prompt failure stays scoped across navigation and restores on return", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api, ApiRequestError } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
    await act(async () => {
      rejectPrompt(new ApiRequestError("old prompt rejected", 409, "PROMPT_REJECTED"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.doesNotMatch(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /old prompt rejected/,
      "A's rejection cannot paint an error into B",
    );
    assert.notEqual(
      dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")?.value,
      "old failed prompt",
      "A's rejected draft cannot overwrite B's composer",
    );
    await act(async () => {
      sessionButton("Active").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")?.value,
      "old failed prompt",
      "returning to A restores the exact rejected submission for retry",
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  let nextReconcileTimer = 0;
  const reconcileTimers = new Map<number, () => void>();
  const promptReconcileScheduler = {
    set(callback: () => void, delayMs: number) {
      assert.equal(delayMs, 4_000);
      const id = ++nextReconcileTimer;
      reconcileTimers.set(id, callback);
      return id;
    },
    clear(id: number) {
      reconcileTimers.delete(id);
    },
  };
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
    await act(async () => root.render(createElement(App, { promptReconcileScheduler })));
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
    const reconcile = reconcileTimers.values().next().value as (() => void) | undefined;
    assert.ok(reconcile, "the prompt reconciliation should be scheduled");
    await act(async () => {
      reconcileTimers.clear();
      reconcile();
      await Promise.resolve();
      await Promise.resolve();
    });
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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

test("late model and thinking responses from A do not overwrite the Session B composer", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
