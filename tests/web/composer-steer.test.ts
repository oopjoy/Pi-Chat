import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { act, createElement } from "react";
import { LOCAL_COORDINATION_ROLE, type BootstrapData, type SessionViewData } from "../../src/shared/types";
import { activeSessionId as activeId, createBootstrapFixture, createSessionViewFixture } from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom as installDom } from "../helpers/app-dom";

let bootstrap: BootstrapData;
let draftView: SessionViewData;

beforeEach(() => {
  bootstrap = createBootstrapFixture();
  draftView = createSessionViewFixture();
});


test("a native Steer stays out of the transcript while its acknowledgement is pending", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let steerId = "";
  let resolvePrompt!: (value: { accepted: boolean; queued: boolean; steered: boolean; id: string }) => void;
  const prompt = new Promise<{ accepted: boolean; queued: boolean; steered: boolean; id: string }>((resolve) => {
    resolvePrompt = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      sessions: bootstrap.sessions.map((session) => ({ ...session, running: true })),
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async (...args: unknown[]) => {
      steerId = String(args[6] || "");
      return prompt;
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "steer without duplicate");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "steer without duplicate" }));
      dom.window.document.querySelector<HTMLButtonElement>(".steer-submit-button")!.click();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      0,
      "the optimistic pending bubble must not duplicate the waiting Steer row",
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => resolvePrompt({ accepted: true, queued: false, steered: true, id: steerId }));
    assert.equal(dom.window.document.querySelectorAll(".message-user").length, 0);
    assert.ok(dom.window.document.querySelector(".pending-steers"));
    await act(async () => source.emitPi({
      type: "message_start",
      piChatSessionId: activeId,
      nativeSteeringConsumed: true,
      nativeSteeringId: steerId,
      message: { role: "user", content: "provider-normalized" },
    }));
    assert.equal(dom.window.document.querySelectorAll(".message-user").length, 1);
    assert.equal(dom.window.document.querySelector(".pending-steers"), null);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("ChatInput places Steer beside Queue and sends explicit steering delivery", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const sent: Array<{ message: string; delivery?: string }> = [];
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () =>
      root.render(
        createElement(ChatInput, {
          streaming: true,
          activelyStreaming: true,
          stopping: false,
          disabled: false,
          submissionScope: "session:steer",
          acceptsImages: true,
          commands: [],
          onSend: async (message: string, _images: unknown[], delivery?: string) => {
            sent.push({ message, delivery });
          },
          onAbort: async () => undefined,
          onPickLocalFiles: async () => [],
              onError: () => undefined,
        }),
      ),
    );
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    const queueButton = dom.window.document.querySelector<HTMLButtonElement>(
      ".queue-submit-button",
    )!;
    const steerButton = dom.window.document.querySelector<HTMLButtonElement>(
      ".steer-submit-button",
    )!;
    assert.equal(queueButton.textContent, "排队");
    assert.equal(steerButton.textContent, "Steer");
    assert.ok(queueButton.nextElementSibling === steerButton);
    assert.equal(steerButton.nextElementSibling?.className, "attachment-control");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "change direction now");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "change direction now",
        }),
      );
      steerButton.click();
    });
    assert.deepEqual(sent, [
      { message: "change direction now", delivery: "steer" },
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("App reveals a Steer turn only when Pi consumes it", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const promptCalls: unknown[][] = [];
  let steerId = "";
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      sessions: bootstrap.sessions.map((session) => ({
        ...session,
        running: true,
      })),
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async (...args: unknown[]) => {
      promptCalls.push(args);
      steerId = String(args[6] || "");
      return { accepted: true, queued: false, steered: true };
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
      )?.set?.call(textarea, "redirect consumed later");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "redirect consumed later",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".steer-submit-button")!
        .click();
    });
    assert.equal(promptCalls[0]?.[4], "steer");
    const pendingSteer = () => dom.window.document.querySelector(".pending-steers");
    assert.match(pendingSteer()?.textContent || "", /Steer.*redirect consumed later.*等待 Pi 接收/s);
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      0,
      "native steering stays hidden while it is only queued inside Pi",
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "message_start",
        piChatSessionId: activeId,
        message: { role: "user", content: "redirect consumed later" },
      }),
    );
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      0,
      "an unverified user message_start must not reveal a hidden Steer",
    );
    assert.ok(pendingSteer(), "the Steer remains in its own waiting section before verified consumption");
    await act(async () =>
      source.emitPi({
        type: "message_start",
        piChatSessionId: activeId,
        nativeSteeringConsumed: true,
        nativeSteeringId: steerId,
        message: { role: "user", content: "provider-normalized" },
      }),
    );
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      1,
      "a server-verified native steer consumption reveals the local Steer turn",
    );
    assert.equal(pendingSteer(), null, "verified consumption moves the Steer out of its waiting section");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("App withdraws Pi-native Steers and prepends them back into the Composer", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let steerId = "";
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      sessions: bootstrap.sessions.map((session) => ({ ...session, running: true })),
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async (...args: unknown[]) => {
      steerId = String(args[6] || "");
      return { accepted: true, queued: false, steered: true, id: steerId };
    },
    dequeueSteers: async () => ({
      items: [{ id: steerId, message: "withdraw me" }],
      count: 1,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    const edit = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLTextAreaElement.prototype,
          "value",
        )?.set?.call(textarea, value);
        textarea.dispatchEvent(new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: value,
        }));
      });
    };
    await edit("withdraw me");
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".steer-submit-button")!.click();
    });
    assert.match(steerId, /^[a-f0-9-]{36}$/i);
    await edit("current editor text");
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".pending-steers header button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(textarea.value, "withdraw me\n\ncurrent editor text");
    assert.equal(dom.window.document.querySelector(".pending-steers"), null);
    assert.equal(dom.window.document.querySelectorAll(".message-user").length, 0);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an authoritative stopped Steer rejection settles the stale Composer and refreshes persisted answer metadata", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { ApiRequestError, api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const answer = "answer already persisted while settlement SSE was missed";
  let viewCalls = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      messages: [],
      messageTotal: 0,
      sessions: bootstrap.sessions.map((session) => ({
        ...session,
        running: true,
        activity: { execution: "running" as const, awaitingConfirmation: false },
      })),
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => {
      throw new ApiRequestError(
        "当前对话未在运行，无法发送 Steer 消息",
        409,
      );
    },
    viewSession: async () => {
      viewCalls += 1;
      return {
        ...draftView,
        session: { ...bootstrap.sessions[0], running: false },
        state: { ...bootstrap.state, isStreaming: false },
        messages: [
          { role: "assistant", content: answer, timestamp: Date.now() - 1_000 },
          {
            role: LOCAL_COORDINATION_ROLE,
            content: "intercom delivery persisted after the answer",
            timestamp: Date.now() - 500,
            localCoordination: { source: "peer-session" },
          },
        ],
        messageTotal: 2,
        isActive: true,
        runtimeStatus: "active" as const,
        isStreaming: false,
        toolStatus: "",
      };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(dom.window.document.querySelector(".steer-submit-button"));
    assert.ok(!dom.window.document.querySelector(".message-generated-at"));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "too late steer");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "too late steer",
        }),
      );
    });
    await act(async () => {
      dom.window.document
        .querySelector<HTMLButtonElement>(".steer-submit-button")!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(textarea.value, "too late steer", "the rejected Steer remains in the draft");
    assert.ok(!dom.window.document.querySelector(".steer-submit-button"));
    assert.ok(!dom.window.document.querySelector(".stop-button"));
    assert.ok(dom.window.document.querySelector(".send-button"));
    assert.ok(!dom.window.document.querySelector(".session-status.is-running"));
    assert.ok(
      dom.window.document.querySelector(".message-generated-at"),
      "the authoritative persisted view restores the terminal answer timestamp",
    );
    const coordination = dom.window.document.querySelector(".coordination-message");
    assert.match(
      coordination?.textContent || "",
      /协调消息.*peer-session.*intercom delivery persisted after the answer/s,
      "the persisted delivery is a headed read-only timeline boundary rather than hidden assistant process work",
    );
    assert.doesNotMatch(
      dom.window.document.querySelector(".conversation-process")?.textContent || "",
      /协调/,
      "coordination input never becomes a collapsed step of an assistant answer",
    );
    assert.match(
      dom.window.document.querySelector(".app-toast.error")?.textContent || "",
      /未在运行/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a cleared Steer with a reason surfaces the drop instead of staying silent", async () => {
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
      })),
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => ({ accepted: true, queued: false, steered: true }),
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
      )?.set?.call(textarea, "dropped steer");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "dropped steer",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".steer-submit-button")!
        .click();
    });
    assert.equal(dom.window.document.querySelectorAll(".message-user").length, 0);
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_native_steering_cleared",
        piChatSessionId: activeId,
        reason: "settled-before-consumption",
        droppedCount: 1,
      }),
    );
    const toast = dom.window.document.querySelector(".app-toast.error");
    assert.ok(toast, "an accepted-but-cleared Steer must surface a reason");
    assert.match(toast!.textContent || "", /已清除/);
    await act(async () =>
      source.emitPi({
        type: "pi_chat_process_error",
        piChatSessionId: activeId,
        error: "worker crashed",
        nativeSteeringDroppedCount: 1,
      }),
    );
    const retainedDropReason =
      dom.window.document.querySelector(".app-toast.error")?.textContent || "";
    assert.match(retainedDropReason, /Steer/);
    assert.match(
      retainedDropReason,
      /未执行/,
      "the following generic process error must not overwrite the specific drop reason",
    );
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      0,
      "the hidden local turn must be removed with the drop",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a background Session preserves its dropped Steer reason until opened", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const backgroundId = draftView.session.id;
  const backgroundView: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: backgroundId,
      name: "Background",
      active: true,
      writable: true,
    },
    runtimeStatus: "active",
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], backgroundView.session],
      sessionsTotal: 2,
      activeSessionIds: [activeId, backgroundId],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) =>
      id === backgroundId ? backgroundView : draftView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_native_steering_cleared",
        piChatSessionId: backgroundId,
        reason: "process-error",
        droppedCount: 1,
      }),
    );
    assert.equal(
      dom.window.document.querySelector(".app-toast.error"),
      null,
      "a background drop must not overwrite the current Session's UI",
    );
    const backgroundRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((row) => row.textContent?.includes("Background"));
    assert.ok(backgroundRow);
    await act(async () =>
      backgroundRow
        .querySelector<HTMLButtonElement>(".session-item")
        ?.click(),
    );
    assert.match(
      dom.window.document.querySelector(".app-toast.error")?.textContent || "",
      /Steer 消息未执行/,
      "opening the affected Session must reveal its stored drop reason",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
