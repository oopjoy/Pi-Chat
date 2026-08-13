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
