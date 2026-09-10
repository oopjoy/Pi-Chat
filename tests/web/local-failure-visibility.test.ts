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

function failureCards(dom: ReturnType<typeof installDom>["dom"]): HTMLElement[] {
  return [...dom.window.document.querySelectorAll<HTMLElement>(".message-local-failure")];
}

function cardText(dom: ReturnType<typeof installDom>["dom"]): string {
  return failureCards(dom).map((card) => card.textContent || "").join(" | ");
}

async function sendMessage(dom: ReturnType<typeof installDom>["dom"], text: string) {
  const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
    "textarea[aria-label='消息输入']",
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(textarea, text);
    textarea.dispatchEvent(
      new dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }),
    );
    dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
    await Promise.resolve();
  });
}

test("a definite upstream failure keeps its reason in the conversation body", async () => {
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
        'OpenAI API error (503): {"message":"auth_unavailable: no auth available"}',
        503,
        undefined,
        "PC-ABCDEFGH",
      );
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await sendMessage(dom, "触发上游失败");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(failureCards(dom).length, 1, "the failure is readable after the toast expires");
    assert.match(cardText(dom), /模型服务凭据不可用/);
    assert.match(cardText(dom), /auth_unavailable/);
    assert.match(cardText(dom), /PC-ABCDEFGH/);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a failure whose outcome is unknown never records a card", async () => {
  // Regression: the recorder used to run before the catch decided the request
  // might still be executing, leaving a permanent failure card under a running turn.
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
    viewSession: async () => draftView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await sendMessage(dom, "可能仍在执行");
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({ type: "agent_start", piChatSessionId: activeId });
      await Promise.resolve();
      rejectPrompt(new Error("network response lost"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(failureCards(dom).length, 0, "an uncertain turn must not carry a failure card");
    assert.equal(dom.window.document.querySelectorAll(".message-user").length, 1);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a client-side rejection stays a toast instead of a card", async () => {
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
      throw new ApiRequestError("当前对话已不再运行，无法发送 Steer 消息", 409, "STEER_REJECTED");
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await sendMessage(dom, "会被拒绝");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(failureCards(dom).length, 0);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a New draft's first message keeps its failure reason on the draft screen", async () => {
  // The draft's prompt can fail before the client learns a Session id, which used
  // to leave the reason in a five-second toast and nowhere else.
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { ApiRequestError, api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const emptyBootstrap: BootstrapData = {
    ...bootstrap,
    state: { ...bootstrap.state, messageCount: 0, sessionName: undefined, isStreaming: false },
    messages: [],
    messageTotal: 0,
    turnTotal: 0,
    visibleTurnCount: 0,
    sessions: [],
    activeSessionId: activeId,
    activeSessionIds: [activeId],
  };
  Object.assign(api, {
    bootstrap: async () => emptyBootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    submitNewSession: async () => {
      throw new ApiRequestError("OpenAI API error (503): auth_unavailable", 503);
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    // The draft pane only exists after New; an unindexed Primary alone is still a
    // Session target, which is why the failure has to be recorded under the draft
    // scope rather than a Session id.
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".new-chat")!.click();
      await Promise.resolve();
    });
    await sendMessage(dom, "草稿的第一条消息");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(failureCards(dom).length, 1, "the draft screen keeps the reason");
    assert.match(cardText(dom), /模型服务凭据不可用|与模型服务的连接中断/);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
