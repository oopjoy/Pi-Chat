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


test("queued prompt moves exclusively between queue and transcript across dispatch failure", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, thinkingLevel: "max" },
      queue: [],
      queuePaused: true,
    }),
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
        settings: { thinkingLevel: "high" },
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
    assert.equal(
      dom.window.document.querySelector<HTMLSpanElement>(".message-thinking")?.textContent,
      "high",
      "queue dispatch applies the queued turn's captured thinking level",
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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

test("queue update promotes an accepted turn when its dispatch SSE frame is missed", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const queuedItem = {
    id: "00000000-0000-4000-8000-000000000032",
    message: "dispatch frame was missed",
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
      // Lose both the admission snapshot and the separate queue_dispatch frame.
      // Only the complete empty pre-dispatch snapshot reaches this browser.
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        queue: [],
        paused: false,
      });
    });
    await act(async () => {
      resolvePrompt({
        accepted: true,
        queued: true,
        id: queuedItem.id,
        // This is the older enqueue response; it must not resurrect the row.
        queue: [queuedItem],
      });
      await Promise.resolve();
    });
    assert.equal(dom.window.document.querySelector(".prompt-queue"), null);
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      1,
      "an omitted queue_dispatch must not strand the accepted turn",
    );
    await act(async () => {
      source.emitPi({
        type: "pi_chat_queue_dispatch",
        piChatSessionId: activeId,
        id: queuedItem.id,
        message: queuedItem.message,
        imageCount: 0,
      });
    });
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      1,
      "a late dispatch frame cannot duplicate the promoted user turn",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a late dispatch after persisted-view confirmation does not append a duplicate", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const queuedItem = {
    id: "00000000-0000-4000-8000-000000000034",
    message: "already persisted before dispatch echo",
    imageCount: 0,
    createdAt: 2,
  };
  const persistedMessage = {
    role: "user" as const,
    content: queuedItem.message,
    piChatPersistedMessageId: "persisted-entry-34",
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      queue: [],
      queuePaused: true,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => ({
      accepted: true as const,
      queued: true as const,
      id: queuedItem.id,
      queue: [queuedItem],
    }),
    viewSession: async () => ({
      ...draftView,
      session: { ...draftView.session, id: activeId, sessionId: activeId },
      state: { ...bootstrap.state, isStreaming: false },
      messages: [persistedMessage],
      messageTotal: 1,
      turnTotal: 1,
      messagesTruncated: false,
      isActive: false,
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
        queue: [queuedItem],
        paused: true,
      });
    });
    await act(async () => {
      source.emitPi({
        type: "agent_settled",
        piChatSessionId: activeId,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      1,
      "the persisted view should contain one user bubble",
    );
    await act(async () => {
      source.emitPi({
        type: "pi_chat_queue_dispatch",
        piChatSessionId: activeId,
        id: queuedItem.id,
        message: queuedItem.message,
        imageCount: 0,
      });
    });
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      1,
      "a late dispatch echo must not append a synthetic duplicate",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an in-flight cancellation fences an empty queue snapshot from promoting the turn", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const queuedItem = {
    id: "00000000-0000-4000-8000-000000000033",
    message: "cancellation is still pending",
    imageCount: 0,
    createdAt: 2,
  };
  let cancelCalls = 0;
  const pendingCancel = new Promise<{ queue: []; paused: false }>(() => undefined);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      queue: [],
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
    cancelQueued: async () => {
      cancelCalls += 1;
      return pendingCancel;
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
      await Promise.resolve();
    });
    const source = FakeEventSource.instances.at(-1)!;
    const cancel = dom.window.document.querySelector<HTMLButtonElement>(
      ".prompt-queue-cancel",
    )!;
    await act(async () => cancel.click());
    assert.equal(cancelCalls, 1);
    await act(async () => {
      // The server sends this before the delayed DELETE acknowledgement. It
      // must not make a cancellation look like an executed prompt.
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        queue: [],
        paused: false,
      });
    });
    assert.match(
      dom.window.document.querySelector(".prompt-queue")?.textContent || "",
      /cancellation is still pending/,
      "an unresolved cancellation keeps the item visible for recovery",
    );
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      0,
      "an in-flight cancellation cannot promote the item into the transcript",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
