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


test("an empty unindexed Primary uses New presentation while keeping its real Session target", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const emptyPrimary: BootstrapData = {
    ...bootstrap,
    state: {
      ...bootstrap.state,
      messageCount: 0,
      sessionName: undefined,
      isStreaming: false,
    },
    messages: [],
    messageTotal: 0,
    turnTotal: 0,
    visibleTurnCount: 0,
    sessions: [],
    activeSessionId: activeId,
    activeSessionIds: [activeId],
  };
  let promptSessionId = "";
  let submitNewCalls = 0;
  Object.assign(api, {
    bootstrap: async () => emptyPrimary,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async (_message: string, _images: unknown[], sessionId: string) => {
      promptSessionId = sessionId;
      return { accepted: true, queued: false };
    },
    submitNewSession: async () => {
      submitNewCalls += 1;
      throw new Error("must keep the existing Primary target");
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.equal(dom.window.document.querySelector(".topbar-title")?.textContent, "新对话");
    assert.match(dom.window.document.querySelector(".welcome")?.textContent || "", /新对话工作路径/);
    assert.match(dom.window.document.querySelector(".draft-workspace")?.textContent || "", /当前新对话已准备就绪/);

    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "use existing primary");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "use existing primary" }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(promptSessionId, activeId);
    assert.equal(submitNewCalls, 0);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("New is instant and the first send shows Pi startup before materializing a Runtime", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
      dom.window.document.querySelector(".timeline-inner")?.textContent || "",
      /正在准备 Pi Runtime；消息已保存，准备完成后自动发送/,
    );
    assert.equal(
      dom.window.document.querySelector(".composer-submission-status"),
      null,
      "submission waiting belongs to the conversation body, not above the composer",
    );
    assert.equal(dom.window.document.querySelector(".stop-button"), null);

    await act(async () => {
      resolveClear();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(newSessionCalls, 1);
    assert.match(
      dom.window.document.querySelector(".timeline-inner")?.textContent || "",
      /正在准备 Pi Runtime；消息已保存，准备完成后自动发送/,
    );
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
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
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
      dom.window.document.querySelector(".agent-status.is-waiting"),
      null,
      "a completed answer clears waiting status even while prompt HTTP is pending",
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
      false,
      "a pending admission no longer locks the editor or its next submission",
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
      false,
      "a delayed first-turn event cannot re-lock an already usable editor",
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
      dom.window.document.querySelector(".agent-status.is-waiting"),
      null,
      "the late first acknowledgement cannot restore stale waiting status",
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

test("a New draft sends Model and Thinking only after an explicit Composer choice", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const submitted: Array<Record<string, unknown>> = [];
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    clearSessionViewed: async () => ({ viewing: "" }),
    submitNewSession: async (input: Record<string, unknown>) => {
      submitted.push(input);
      return {
        sessionId: draftView.session.id,
        session: draftView.session,
        state: draftView.state,
        gateMode: "strict" as const,
        accepted: true as const,
        queued: false as const,
      };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const newButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "New")!;
    await act(async () => newButton.click());
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "default model is display only");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "default model is display only" }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]?.model, undefined);
    assert.equal(submitted[0]?.thinkingLevel, undefined);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a late first-draft completion cannot steal a replacement draft selection", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const modelA = { provider: "xwill", id: "gpt-5.6-sol", name: "Sol", input: ["text"], reasoning: true };
  const modelB = { provider: "xwill", id: "gpt-5.6-terra", name: "Terra", input: ["text"], reasoning: true };
  const submissions: Array<Record<string, unknown>> = [];
  let resolveFirst!: (value: { sessionId: string; session: SessionViewData["session"]; state: SessionViewData["state"]; gateMode: "strict"; accepted: true; queued: false }) => void;
  const first = new Promise<{ sessionId: string; session: SessionViewData["session"]; state: SessionViewData["state"]; gateMode: "strict"; accepted: true; queued: false }>((resolve) => { resolveFirst = resolve; });
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, models: [...bootstrap.models, modelA, modelB] }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    clearSessionViewed: async () => ({ viewing: "" }),
    submitNewSession: async (input: Record<string, unknown>) => {
      submissions.push(input);
      return first;
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const choose = async (label: string) => {
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".composer-model-select .compact-select-trigger")!;
    await act(async () => { trigger.click(); await Promise.resolve(); });
    const option = [...dom.window.document.querySelectorAll<HTMLElement>(".compact-select-option")]
      .find((candidate) => candidate.textContent?.includes(label));
    assert.ok(option, `missing ${label} option`);
    await act(async () => { option.click(); await Promise.resolve(); });
  };
  try {
    await act(async () => root.render(createElement(App)));
    const newButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "New")!;
    await act(async () => newButton.click());
    await choose("Sol");
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "draft A");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "draft A" }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
    });
    assert.equal(submissions.length, 1);
    assert.deepEqual(submissions[0]?.model, modelA);
    await act(async () => newButton.click());
    await choose("Terra");
    await act(async () => {
      resolveFirst({
        sessionId: draftView.session.id,
        session: draftView.session,
        state: draftView.state,
        gateMode: "strict",
        accepted: true,
        queued: false,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(
      dom.window.document.querySelector<HTMLButtonElement>(".composer-model-select .compact-select-trigger")!.textContent || "",
      /Terra/,
      "the replacement draft retains its own next-prompt model after A resolves",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
