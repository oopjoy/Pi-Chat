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


test("an accepted prompt advances the sidebar turn count before stale metadata catches up", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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

test("cancelling the last queued prompt clears stale running and tool state after an idle Runtime snapshot", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const queuedItem = {
    id: "00000000-0000-4000-8000-000000000003",
    message: "withdraw stale running turn",
    imageCount: 0,
    createdAt: 3,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      queue: [queuedItem],
      queuePaused: true,
      sessions: bootstrap.sessions.map((session) => ({
        ...session,
        running: true,
        queued: true,
        activity: { execution: "paused" as const, awaitingConfirmation: false },
      })),
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    cancelQueued: async () => ({ queue: [], paused: false }),
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
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".prompt-queue article button")!
        .click(),
    );
    await act(async () => {
      source.emitPi({
        type: "pi_chat_session_status",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        activity: { execution: "idle", awaitingConfirmation: false },
      });
    });
    assert.equal(dom.window.document.querySelector(".prompt-queue"), null);
    assert.equal(dom.window.document.querySelector(".agent-status"), null);
    assert.equal(
      dom.window.document.querySelector(".session-status.is-running"),
      null,
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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

test("queue SSE invalidates an older Session view before it can erase queue state", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
    assert.equal(dom.window.document.querySelector("section.extension-dialog"), originalFrame);

    await act(async () => source.emitPi({
      type: "tool_execution_end",
      piChatSessionId: activeId,
      toolCallId: "ask-tool",
      toolName: "ask_user_question",
      isError: false,
    }));
    assert.equal(dom.window.document.querySelector("section.extension-dialog"), null);
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
