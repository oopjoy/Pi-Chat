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
