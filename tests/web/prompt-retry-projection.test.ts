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

const RUN_EPOCH = "epoch-a";
const SERVER_PROMPT_ID = "11111111-1111-4111-8111-111111111111";

function capturingView(): SessionViewData {
  return {
    ...draftView,
    session: { ...bootstrap.sessions[0], active: true, writable: true },
    state: { ...draftView.state, sessionId: "active", isStreaming: true },
    runtimeStatus: "active",
    isActive: true,
    isStreaming: true,
    queue: [],
    queuePaused: false,
  };
}

async function typeAndSend(dom: ReturnType<typeof installDom>["dom"], message: string) {
  const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
    "textarea[aria-label='消息输入']",
  )!;
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
    dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
    await Promise.resolve();
  });
}

test("a New first-send adopts the returned Prompt identity for retry projection", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const sessionId = draftView.session.id;
  let resolveInitial!: (value: {
    sessionId: string;
    session: SessionViewData["session"];
    state: SessionViewData["state"];
    gateMode: "strict";
    accepted: true;
    queued: false;
    promptId: string;
  }) => void;
  const pendingInitial = new Promise<{
    sessionId: string;
    session: SessionViewData["session"];
    state: SessionViewData["state"];
    gateMode: "strict";
    accepted: true;
    queued: false;
    promptId: string;
  }>((resolve) => {
    resolveInitial = resolve;
  });
  const initial = {
    ...draftView,
    session: { ...draftView.session, id: sessionId, sessionId, active: true },
    state: { ...draftView.state, sessionId, isStreaming: true },
  } satisfies SessionViewData;
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    clearSessionViewed: async () => ({ viewing: "" }),
    submitNewSession: async () => pendingInitial,
    viewSession: async () => initial,
    prompt: async () => ({ accepted: true, queued: false }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const text = () => dom.window.document.body.textContent || "";
  try {
    await act(async () => root.render(createElement(App)));
    const newButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "New");
    assert.ok(newButton);
    await act(async () => newButton.click());
    await typeAndSend(dom, "draft retry prompt");
    const source = FakeEventSource.instances.at(-1)!;
    resolveInitial({
      sessionId,
      session: initial.session,
      state: initial.state,
      gateMode: "strict",
      accepted: true,
      queued: false,
      promptId: SERVER_PROMPT_ID,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: sessionId,
        piChatRunGeneration: 0,
        piChatPromptId: SERVER_PROMPT_ID,
      });
      source.emitPi({
        type: "pi_chat_prompt_retry_scheduled",
        piChatSessionId: sessionId,
        piChatRunGeneration: 0,
        piChatPromptId: SERVER_PROMPT_ID,
        retryAttempt: 1,
        maxAttempts: 2,
      });
      await Promise.resolve();
    });
    assert.ok(
      text().includes("Pi 正在等待重试"),
      "the New first-send operation owns retry projection after Server identity binding",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a terminal lifecycle wins over retry facts that arrive before HTTP admission settles", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const view = capturingView();
  let resolvePrompt!: (value: {
    accepted: true;
    queued: false;
    promptId: string;
  }) => void;
  const pendingPrompt = new Promise<{
    accepted: true;
    queued: false;
    promptId: string;
  }>((resolve) => {
    resolvePrompt = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async () => view,
    prompt: async () => pendingPrompt,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const text = () => dom.window.document.body.textContent || "";
  try {
    await act(async () => root.render(createElement(App)));
    await typeAndSend(dom, "late terminal retry prompt");
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: activeId,
        piChatRunEpoch: RUN_EPOCH,
        piChatRunGeneration: 1,
        piChatPromptId: SERVER_PROMPT_ID,
      });
      source.emitPi({
        type: "pi_chat_prompt_retry_scheduled",
        piChatSessionId: activeId,
        piChatRunEpoch: RUN_EPOCH,
        piChatRunGeneration: 1,
        piChatPromptId: SERVER_PROMPT_ID,
        retryAttempt: 1,
        maxAttempts: 1,
      });
      source.emitPi({
        type: "pi_chat_prompt_retry_exhausted",
        piChatSessionId: activeId,
        piChatRunEpoch: RUN_EPOCH,
        piChatRunGeneration: 1,
        piChatPromptId: SERVER_PROMPT_ID,
        retryAttempt: 1,
        maxAttempts: 1,
      });
      source.emitPi({
        type: "pi_chat_process_error",
        piChatSessionId: activeId,
        piChatRunEpoch: RUN_EPOCH,
        piChatRunGeneration: 1,
        piChatPromptId: SERVER_PROMPT_ID,
        error: "retry failed",
      });
      await Promise.resolve();
    });
    await act(async () => {
      source.emitPi({
        type: "pi_chat_prompt_retry_started",
        piChatSessionId: activeId,
        piChatRunEpoch: RUN_EPOCH,
        piChatRunGeneration: 1,
        piChatPromptId: SERVER_PROMPT_ID,
        retryAttempt: 2,
        retryAttempts: 1,
      });
      await Promise.resolve();
    });
    resolvePrompt({
      accepted: true,
      queued: false,
      promptId: SERVER_PROMPT_ID,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(text().includes("Pi 正在等待重试"), false);
    assert.equal(text().includes("Pi 正在重试"), false);
    assert.equal(text().includes("Pi 原生重试已耗尽"), false);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("retry metadata reaches the active pane and is retired with its Prompt", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const view = capturingView();
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async () => view,
    prompt: async () => ({
      accepted: true,
      queued: false,
      promptId: SERVER_PROMPT_ID,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const text = () => dom.window.document.body.textContent || "";
  try {
    await act(async () => root.render(createElement(App)));
    await typeAndSend(dom, "retry prompt");
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: activeId,
        piChatRunEpoch: RUN_EPOCH,
        piChatRunGeneration: 1,
        piChatPromptId: SERVER_PROMPT_ID,
      });
      await Promise.resolve();
    });
    await act(async () => {
      source.emitPi({
        type: "pi_chat_prompt_retry_scheduled",
        piChatSessionId: activeId,
        piChatRunEpoch: RUN_EPOCH,
        piChatRunGeneration: 1,
        piChatPromptId: SERVER_PROMPT_ID,
        retryAttempt: 1,
        maxAttempts: 3,
      });
      await Promise.resolve();
    });
    assert.ok(
      text().includes("Pi 正在等待重试"),
      "an accepted retry fact is projected onto the pane that owns the operation",
    );
    await act(async () => {
      source.emitPi({
        type: "pi_chat_prompt_retry_started",
        piChatSessionId: activeId,
        piChatRunEpoch: RUN_EPOCH,
        piChatRunGeneration: 1,
        piChatPromptId: SERVER_PROMPT_ID,
        retryAttempt: 2,
        retryAttempts: 3,
      });
      await Promise.resolve();
    });
    assert.ok(text().includes("Pi 正在重试"));
    await act(async () => {
      source.emitPi({
        type: "agent_settled",
        piChatSessionId: activeId,
        piChatRunEpoch: RUN_EPOCH,
        piChatRunGeneration: 1,
        piChatPromptId: SERVER_PROMPT_ID,
      });
      await Promise.resolve();
    });
    assert.equal(
      text().includes("Pi 正在等待重试") || text().includes("Pi 正在重试"),
      false,
      "settlement clears the transient retry status",
    );
    await act(async () => {
      source.emitPi({
        type: "pi_chat_prompt_retry_scheduled",
        piChatSessionId: activeId,
        piChatRunEpoch: RUN_EPOCH,
        piChatRunGeneration: 1,
        piChatPromptId: SERVER_PROMPT_ID,
        retryAttempt: 3,
        maxAttempts: 3,
      });
      await Promise.resolve();
    });
    assert.equal(
      text().includes("Pi 正在等待重试"),
      false,
      "a retired Server Prompt identity cannot repaint the settled pane",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a retry frame from another Session never paints the viewed pane", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const view = capturingView();
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async () => view,
    prompt: async () => ({
      accepted: true,
      queued: false,
      promptId: SERVER_PROMPT_ID,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const text = () => dom.window.document.body.textContent || "";
  try {
    await act(async () => root.render(createElement(App)));
    await typeAndSend(dom, "retry prompt");
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "agent_start",
        piChatSessionId: activeId,
        piChatRunEpoch: RUN_EPOCH,
        piChatRunGeneration: 1,
        piChatPromptId: SERVER_PROMPT_ID,
      });
      await Promise.resolve();
    });
    await act(async () => {
      source.emitPi({
        type: "pi_chat_prompt_retry_scheduled",
        piChatSessionId: "fedcba9876543210abcd",
        piChatRunEpoch: RUN_EPOCH,
        piChatRunGeneration: 4,
        piChatPromptId: "22222222-2222-4222-8222-222222222222",
        retryAttempt: 1,
        maxAttempts: 2,
      });
      await Promise.resolve();
    });
    assert.equal(
      text().includes("Pi 正在等待重试"),
      false,
      "a foreign Session retry fact cannot claim the current pane",
    );
    assert.ok(
      text().includes("正在等待 Pi 处理") || text().includes("Pi 正在思考"),
      "the owning Session keeps its own status as the pane authority",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
