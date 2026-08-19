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


test("a lost prompt acknowledgement cannot remove a user turn after SSE proves acceptance", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { ApiRequestError, api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
    assert.equal(input.disabled, false, "compaction pauses sends without locking the composer draft");

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

test("a tool completion preserves compaction only when Pi explicitly starts it", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      sessions: [{ ...bootstrap.sessions[0], running: true }],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (sessionId: string) => ({ viewing: sessionId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: activeId,
        piChatRunGeneration: 41,
      });
      source.emitPi({
        type: "tool_execution_end",
        piChatSessionId: activeId,
        piChatRunGeneration: 41,
        toolName: "bash",
        isError: false,
      });
      await Promise.resolve();
    });
    assert.match(
      dom.window.document.querySelector(".agent-status")?.textContent || "",
      /bash 已完成，Pi 正在继续…/,
      "a completed tool alone must not guess that Pi is compacting",
    );

    await act(async () => {
      source.emitPi({
        type: "compaction_start",
        piChatSessionId: activeId,
        piChatRunGeneration: 41,
        reason: "overflow",
      });
      await Promise.resolve();
    });
    assert.match(
      dom.window.document.querySelector(".agent-status")?.textContent || "",
      /上下文溢出，正在自动压缩…/,
    );

    await act(async () => {
      source.emitPi({
        type: "tool_execution_end",
        piChatSessionId: activeId,
        piChatRunGeneration: 41,
        toolName: "bash",
        isError: false,
      });
      await Promise.resolve();
    });
    assert.match(
      dom.window.document.querySelector(".agent-status")?.textContent || "",
      /上下文溢出，正在自动压缩…/,
      "a delayed tool terminal cannot clear an actual compaction_start",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a recovered Runtime clears the sidebar's retained failure reason before its status refresh", async () => {
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
