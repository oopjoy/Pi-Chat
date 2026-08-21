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

test("a fresh idle view repairs a missed settlement spinner without F5", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const nativeSetTimeout = dom.window.setTimeout.bind(dom.window);
  const originalSetTimeout = dom.window.setTimeout;
  dom.window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
    nativeSetTimeout(handler, timeout === 4_000 ? 100 : timeout, ...args)) as typeof dom.window.setTimeout;
  const idleView: SessionViewData = {
    ...draftView,
    session: {
      ...bootstrap.sessions[0],
      running: false,
      queued: false,
      activity: { execution: "idle", awaitingConfirmation: false },
    },
    state: { ...bootstrap.state, isStreaming: false, isCompacting: false },
    messages: [
      { role: "user", content: "run bash" },
      { role: "assistant", content: "completed" },
    ],
    messageTotal: 2,
    turnTotal: 1,
    isActive: true,
    runtimeStatus: "active",
    isStreaming: false,
    liveMessage: undefined,
    toolStatus: "",
  };
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => ({ accepted: true, queued: false }),
    viewSession: async () => idleView,
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
      )?.set?.call(textarea, "run bash");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
    });
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
      });
      source.emitPi({
        type: "tool_execution_end",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        toolName: "bash",
        isError: false,
      });
      source.emitPi({
        type: "message_end",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        message: { role: "assistant", content: "completed" },
      });
    });
    assert.ok(
      dom.window.document.querySelector(".session-status.is-running"),
      "without settlement evidence the active turn remains blue",
    );

    await act(async () => {
      await new Promise((resolve) => nativeSetTimeout(resolve, 180));
    });
    assert.equal(
      dom.window.document.querySelector(".session-status.is-running"),
      null,
      "the version-guarded idle view must release the stale running override",
    );
    assert.equal(dom.window.document.querySelector(".agent-status"), null);
    assert.equal(textarea.disabled, false);
  } finally {
    dom.window.setTimeout = originalSetTimeout;
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("idle activity clears a stale tool-completion wait even without agent_settled", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      sessions: bootstrap.sessions.map((session) => ({
        ...session,
        running: true,
        activity: { execution: "running" as const, awaitingConfirmation: false },
      })),
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "tool_execution_end",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        toolName: "bash",
        isError: false,
      });
    });
    assert.match(
      dom.window.document.querySelector(".agent-status")?.textContent || "",
      /bash 已完成，Pi 正在继续…/,
    );

    await act(async () => {
      source.emitPi({
        type: "pi_chat_session_status",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        activity: { execution: "idle", awaitingConfirmation: false },
      });
    });
    assert.equal(
      dom.window.document.querySelector(".agent-status"),
      null,
      "authoritative idle activity must clear a stale tool wait when settlement SSE was missed",
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
        type: "tool_execution_start",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        toolName: "read",
      });
      source.emitPi({
        type: "message_update",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        message: { role: "assistant", content: "late live revival" },
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
      "late same-generation tool/activity frames cannot resurrect the cleared wait",
    );
    assert.doesNotMatch(
      dom.window.document.querySelector(".timeline")?.textContent || "",
      /late live revival/,
    );
    assert.equal(dom.window.document.querySelector(".stop-button"), null);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("authoritative checkpoints and append deltas stream through the existing browser throttle", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
      });
      source.emitPi({
        type: "message_checkpoint",
        piChatStreamSchema: 1,
        piChatSequence: 0,
        piChatStreamStart: true,
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        message: {
          role: "assistant",
          content: "Hello",
          piChatLiveMessageId: "live-browser-1",
        },
      });
      source.emitPi({
        type: "message_delta",
        piChatStreamSchema: 1,
        piChatSequence: 1,
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        piChatLiveMessageId: "live-browser-1",
        operations: [{ contentIndex: 0, field: "text", append: " world" }],
      });
      await new Promise((resolve) => dom.window.setTimeout(resolve, 80));
    });
    assert.match(
      dom.window.document.querySelector(".timeline")?.textContent || "",
      /Hello world/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a missing stream sequence closes the lease and reconnects for a fresh checkpoint", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async () => draftView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    const countBeforeGap = FakeEventSource.instances.length;
    await act(async () => {
      source.emitPi({
        type: "message_checkpoint",
        piChatStreamSchema: 1,
        piChatSequence: 0,
        piChatStreamStart: true,
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        message: {
          role: "assistant",
          content: "A",
          piChatLiveMessageId: "live-gap-1",
        },
      });
      source.emitPi({
        type: "message_delta",
        piChatStreamSchema: 1,
        piChatSequence: 2,
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        piChatLiveMessageId: "live-gap-1",
        operations: [{ contentIndex: 0, field: "text", append: "missing" }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(source.readyState, FakeEventSource.CLOSED);
    assert.ok(FakeEventSource.instances.length > countBeforeGap);
    assert.doesNotMatch(
      dom.window.document.querySelector(".timeline")?.textContent || "",
      /missing/,
    );

    const replacement = FakeEventSource.instances.at(-1)!;
    const countBeforeRepeatedGap = FakeEventSource.instances.length;
    await act(async () => {
      replacement.emitPi({
        type: "message_checkpoint",
        piChatStreamSchema: 1,
        piChatSequence: 0,
        piChatStreamStart: true,
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        message: {
          role: "assistant",
          content: "B",
          piChatLiveMessageId: "live-gap-1",
        },
      });
      replacement.emitPi({
        type: "message_delta",
        piChatStreamSchema: 1,
        piChatSequence: 2,
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        piChatLiveMessageId: "live-gap-1",
        operations: [{ contentIndex: 0, field: "text", append: "repeat" }],
      });
      await Promise.resolve();
    });
    assert.equal(replacement.readyState, FakeEventSource.CLOSED);
    assert.equal(
      FakeEventSource.instances.length,
      countBeforeRepeatedGap,
      "a repeated deterministic gap is rate-limited instead of reconnecting in a tight loop",
    );
    await act(async () => {
      await new Promise((resolve) => dom.window.setTimeout(resolve, 1_100));
    });
    assert.ok(FakeEventSource.instances.length > countBeforeRepeatedGap);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("idle activity cancels a throttled live update before it can repaint the settled pane", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const persistedAnswer = "persisted fallback answer";
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      sessions: bootstrap.sessions.map((session) => ({
        ...session,
        running: true,
        activity: { execution: "running" as const, awaitingConfirmation: false },
      })),
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async () => ({
      ...draftView,
      session: { ...draftView.session, ...bootstrap.sessions[0] },
      state: { ...bootstrap.state, isStreaming: false },
      messages: [{ role: "assistant", content: persistedAnswer }],
      messageTotal: 1,
      isActive: true,
      runtimeStatus: "active",
      isStreaming: false,
      toolStatus: "",
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "message_update",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        message: { role: "assistant", content: "first live" },
      });
      source.emitPi({
        type: "message_update",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        message: { role: "assistant", content: "late pending" },
      });
      source.emitPi({
        type: "pi_chat_session_status",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        activity: { execution: "idle", awaitingConfirmation: false },
      });
      await new Promise((resolve) => dom.window.setTimeout(resolve, 80));
    });
    const timelineText =
      dom.window.document.querySelector(".timeline")?.textContent || "";
    assert.doesNotMatch(
      timelineText,
      /late pending/,
      "the render throttle cannot restore a live draft after terminal activity",
    );
    assert.match(
      timelineText,
      new RegExp(persistedAnswer),
      "terminal activity reconciles the persisted answer when terminal SSE frames were missed",
    );
    assert.equal(
      timelineText.match(new RegExp(persistedAnswer, "g"))?.length,
      1,
    );
    assert.equal(dom.window.document.querySelector(".stop-button"), null);
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='消息输入']",
      )?.disabled,
      false,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale idle reconciliation cannot overwrite a newer same-session run cache", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "idle-reconcile-second";
  const secondSession = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "second",
    name: "Second",
    active: false,
  };
  let resolveIdleView!: (view: SessionViewData) => void;
  const idleView = new Promise<SessionViewData>((resolve) => {
    resolveIdleView = resolve;
  });
  const staleIdleView: SessionViewData = {
    ...draftView,
    session: { ...draftView.session, ...bootstrap.sessions[0], running: false },
    state: { ...bootstrap.state, isStreaming: false },
    messages: [{ role: "assistant", content: "old idle answer" }],
    messageTotal: 1,
    isActive: true,
    runtimeStatus: "active",
    isStreaming: false,
    toolStatus: "",
  };
  const secondView: SessionViewData = {
    ...draftView,
    session: secondSession,
    state: { ...bootstrap.state, sessionId: "second", isStreaming: false },
    isActive: false,
    runtimeStatus: "view-only",
    isStreaming: false,
  };
  let activeViewCalls = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      sessions: [
        {
          ...bootstrap.sessions[0],
          running: true,
          activity: { execution: "running" as const, awaitingConfirmation: false },
        },
        secondSession,
      ],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => {
      if (id === secondId) return secondView;
      activeViewCalls += 1;
      return activeViewCalls === 1 ? idleView : {
        ...staleIdleView,
        state: { ...bootstrap.state, isStreaming: true },
        isStreaming: true,
        liveMessage: { role: "assistant", content: "new live answer" },
        toolStatus: "Pi 正在思考…",
      };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "pi_chat_session_status",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        activity: { execution: "idle", awaitingConfirmation: false },
      });
      source.emitPi({
        type: "agent_start",
        piChatSessionId: activeId,
        piChatRunGeneration: 2,
      });
      source.emitPi({
        type: "message_update",
        piChatSessionId: activeId,
        piChatRunGeneration: 2,
        message: { role: "assistant", content: "new live answer" },
      });
      resolveIdleView(staleIdleView);
      await Promise.resolve();
    });
    const secondButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".session-item",
    )].find((button) => button.textContent?.includes("Second"))!;
    await act(async () => secondButton.click());
    const activeButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".session-item",
    )].find((button) => button.textContent?.includes("Active"))!;
    await act(async () => activeButton.click());
    assert.match(
      dom.window.document.querySelector(".timeline")?.textContent || "",
      /new live answer/,
      "an older idle response must be discarded after a newer Session event version",
    );
    assert.ok(dom.window.document.querySelector(".stop-button"));
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("paused queue activity preserves a still-running turn until terminal activity arrives", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      sessions: bootstrap.sessions.map((session) => ({
        ...session,
        running: true,
        queued: true,
        activity: { execution: "running" as const, awaitingConfirmation: false },
      })),
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "pi_chat_session_status",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        activity: { execution: "paused", awaitingConfirmation: false },
      });
      source.emitPi({
        type: "tool_execution_end",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        toolName: "bash",
        isError: false,
      });
    });
    assert.match(
      dom.window.document.querySelector(".agent-status")?.textContent || "",
      /bash 已完成，Pi 正在继续…/,
      "paused follow-up queue state must not falsely settle the active turn",
    );
    assert.ok(dom.window.document.querySelector(".stop-button"));
    assert.ok(
      dom.window.document.querySelector(".session-item.is-running"),
      "paused queue activity preserves the sidebar's active-turn authority",
    );

    await act(async () => {
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        queue: [],
        paused: true,
      });
    });
    assert.ok(
      dom.window.document.querySelector(".session-item.is-running"),
      "removing the last paused follow-up must not manufacture an idle active turn",
    );

    await act(async () => {
      source.emitPi({
        type: "pi_chat_session_status",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        activity: { execution: "idle", awaitingConfirmation: false },
      });
    });
    assert.equal(dom.window.document.querySelector(".agent-status"), null);
    assert.equal(dom.window.document.querySelector(".stop-button"), null);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("late tool completion after off-screen idle does not return when the Session is reopened", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "late-tool-offscreen-2";
  const secondSession = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "second",
    name: "Second",
    active: false,
    running: false,
    activity: { execution: "idle" as const, awaitingConfirmation: false },
  };
  const activeView: SessionViewData = {
    ...draftView,
    session: { ...draftView.session, ...bootstrap.sessions[0] },
    state: { ...bootstrap.state, isStreaming: true },
    isStreaming: true,
    toolStatus: "",
  };
  const secondView: SessionViewData = {
    ...draftView,
    session: secondSession,
    state: { ...bootstrap.state, sessionId: "second", isStreaming: false },
    isStreaming: false,
    toolStatus: "",
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      sessions: [
        {
          ...bootstrap.sessions[0],
          running: true,
          activity: { execution: "running" as const, awaitingConfirmation: false },
        },
        secondSession,
      ],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => id === secondId ? secondView : activeView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    const secondButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".session-item",
    )].find((button) => button.textContent?.includes("Second"))!;
    await act(async () => secondButton.click());
    await act(async () => {
      source.emitPi({
        type: "pi_chat_session_status",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        activity: { execution: "idle", awaitingConfirmation: false },
      });
      source.emitPi({
        type: "tool_execution_end",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        toolName: "bash",
        isError: false,
      });
    });
    const activeButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".session-item",
    )].find((button) => button.textContent?.includes("Active"))!;
    await act(async () => activeButton.click());
    assert.equal(
      dom.window.document.querySelector(".agent-status"),
      null,
      "late terminal tool frames must not repopulate an idle Session cache",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("ordinary tool Extension responses close without questionnaire continuity", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const request = {
    type: "extension_ui_request",
    id: "ordinary-confirm",
    method: "confirm",
    title: "Continue?",
    piChatSessionId: activeId,
  } as const;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      toolStatus: "正在运行工具：ordinary_tool",
      pendingExtensionRequest: request,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    respondToExtension: async () => ({ ok: true }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(dom.window.document.querySelector("section.extension-dialog"));
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(
      ".extension-dialog-actions .primary",
    )!.click());
    assert.equal(
      dom.window.document.querySelector("section.extension-dialog"),
      null,
      "non-questionnaire tools must not retain a blocking continuation frame",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("ask questionnaire collects all answers before bridging scalar RPC requests", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const responses: Array<Record<string, unknown>> = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      toolStatus: "",
      pendingExtensionRequest: null,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    respondToExtension: async (body: Record<string, unknown>) => {
      responses.push(body);
      return { ok: true };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "tool_execution_start",
        piChatSessionId: activeId,
        toolCallId: "ask-tool",
        toolName: "ask_user_question",
        args: {
          questions: [
            {
              question: "Which scope?",
              header: "Scope",
              options: [
                { label: "Narrow", description: "Only this bug" },
                { label: "Broad", description: "Related cleanup" },
              ],
              multiSelect: false,
            },
            {
              question: "How should it look?",
              header: "UX",
              options: [
                { label: "Compact", description: "Use less space" },
                { label: "Detailed", description: "Show descriptions" },
              ],
              multiSelect: false,
            },
          ],
        },
      });
      source.emitPi({
        type: "extension_ui_request",
        id: "ask-q1",
        method: "select",
        title: "[Scope] Which scope?",
        options: ["1. Narrow — Only this bug", "2. Broad — Related cleanup", "3. Type something."],
        piChatSessionId: activeId,
      });
    });

    const originalFrame = dom.window.document.querySelector("section.extension-dialog");
    assert.ok(originalFrame);
    assert.match(dom.window.document.body.textContent || "", /问题 1 \/ 2/);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(
      "button.ask-questionnaire-option",
    )!.click());
    assert.match(dom.window.document.body.textContent || "", /问题 2 \/ 2/);
    assert.deepEqual(responses, [], "the scalar Package request waits for final questionnaire submission");

    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(
      ".ask-questionnaire-custom-trigger",
    )!.click());
    const input = dom.window.document.querySelector<HTMLInputElement>(
      ".ask-questionnaire-custom input",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")
        ?.set?.call(input, "Inline answer");
      input.dispatchEvent(new dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "Inline answer",
      }));
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const submit = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".extension-dialog-actions button",
    )].find((button) => button.textContent === "提交")!;
    assert.equal(submit.disabled, false);
    await act(async () => submit.click());
    assert.deepEqual(responses, [{
      id: "ask-q1",
      sessionId: activeId,
      value: "1. Narrow — Only this bug",
    }]);

    await act(async () => source.emitPi({
      type: "extension_ui_request",
      id: "ask-q2",
      method: "select",
      title: "[UX] How should it look?",
      options: ["1. Compact — Use less space", "2. Detailed — Show descriptions", "3. Type something."],
      piChatSessionId: activeId,
    }));
    assert.deepEqual(responses.at(-1), {
      id: "ask-q2",
      sessionId: activeId,
      value: "3. Type something.",
    });
    await act(async () => source.emitPi({
      type: "extension_ui_request",
      id: "ask-q2-input",
      method: "input",
      title: "[UX] How should it look?\n\nType your answer:",
      piChatSessionId: activeId,
    }));
    assert.deepEqual(responses.at(-1), {
      id: "ask-q2-input",
      sessionId: activeId,
      value: "Inline answer",
    });
    assert.ok(dom.window.document.querySelector("section.extension-dialog") === originalFrame);

    await act(async () => source.emitPi({
      type: "tool_execution_end",
      piChatSessionId: activeId,
      toolCallId: "ask-tool",
      toolName: "ask_user_question",
      isError: false,
    }));
    assert.ok(!dom.window.document.querySelector("section.extension-dialog"));
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("server replacement clears a rich Ask projection and restores scalar fallback", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const scalarRequest = {
    type: "extension_ui_request",
    id: "replacement-select",
    method: "select",
    title: "[Scope] Which scope?",
    options: ["1. Narrow — Only this bug", "2. Broad — Related cleanup", "3. Type something."],
    piChatSessionId: activeId,
  } as const;
  let bootstrapCalls = 0;
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1
        ? {
          ...bootstrap,
          workspaceEpoch: "epoch-a",
          state: { ...bootstrap.state, isStreaming: true },
          pendingExtensionRequest: null,
        }
        : {
          ...bootstrap,
          workspaceEpoch: "epoch-b",
          state: { ...bootstrap.state, isStreaming: true },
          toolStatus: "正在运行工具：ask_user_question",
          pendingExtensionRequest: scalarRequest,
        };
    },
    eventsUrl: () => "/api/events",
    invalidateHandshake: () => undefined,
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => source.emitPi({
      type: "tool_execution_start",
      piChatSessionId: activeId,
      toolCallId: "ask-before-replacement",
      toolName: "ask_user_question",
      args: {
        questions: [{
          question: "Which scope?",
          header: "Scope",
          options: [
            { label: "Narrow", description: "Only this bug" },
            { label: "Broad", description: "Related cleanup" },
          ],
          multiSelect: false,
        }],
      },
    }));
    assert.ok(dom.window.document.querySelector(".ask-questionnaire"));

    await act(async () => source.dispatchEvent(new dom.window.MessageEvent("ready", {
      data: JSON.stringify({
        lifecycle: "idle",
        piChatRunEpoch: "epoch-b",
        workspaceEpoch: "epoch-b",
      }),
    }) as unknown as Event));
    assert.ok(bootstrapCalls >= 2);
    assert.equal(dom.window.document.querySelector(".ask-questionnaire"), null);
    assert.equal(dom.window.document.querySelectorAll(".dialog-options button").length, 3);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("extension resolution invalidates an older Session view before it can reopen confirmation", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
