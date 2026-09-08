import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { act, createElement, StrictMode } from "react";
import { type BootstrapData, type SessionViewData } from "../../src/shared/types";
import { activeSessionId as activeId, createBootstrapFixture, createSessionViewFixture } from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom as installDom } from "../helpers/app-dom";

let bootstrap: BootstrapData;
let draftView: SessionViewData;

beforeEach(() => {
  bootstrap = createBootstrapFixture();
  draftView = createSessionViewFixture();
});


test("ChatInput accepts follow-up snapshots while one send is pending and drains them serially", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const calls: string[] = [];
  const resolvers: Array<() => void> = [];
  const pendingCounts: number[] = [];
  let active = 0;
  let maxActive = 0;
  const onSend = async (message: string) => {
    calls.push(message);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => resolvers.push(resolve));
    active -= 1;
  };
  const render = () => createElement(ChatInput, {
    streaming: false,
    stopping: false,
    disabled: false,
    submissionScope: "session:serial",
    allowFollowupSubmissions: true,
    acceptsImages: true,
    commands: [{ name: "fast", source: "extension", description: "Toggle Fast mode" }],
    onSubmissionPendingChange: (_scope: string, count: number) => pendingCounts.push(count),
    onSend,
    onAbort: async () => undefined,
    onPickLocalFiles: async () => [],
    onError: () => undefined,
  });
  const typeAndSend = async (message: string) => {
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, message);
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: message }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
    });
  };
  try {
    await act(async () => root.render(createElement(StrictMode, null, render())));
    await typeAndSend("first");
    assert.deepEqual(calls, ["first"]);
    await typeAndSend("/fast");
    assert.deepEqual(calls, ["first"], "the editor accepts the snapshot without invoking App.send concurrently");
    assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!.disabled, false);
    assert.equal(maxActive, 1);
    assert.ok(pendingCounts.includes(2));

    await act(async () => {
      resolvers.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(calls, ["first", "/fast"]);
    assert.equal(maxActive, 1);
    await act(async () => {
      resolvers.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(pendingCounts.at(-1), 0);
  } finally {
    await act(async () => root.unmount());
  }
});

test("ChatInput does not drain a queued snapshot while mutation authority is disabled", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const calls: string[] = [];
  const resolvers: Array<() => void> = [];
  const onSend = async (message: string) => {
    calls.push(message);
    await new Promise<void>((resolve) => resolvers.push(resolve));
  };
  const render = (disabled: boolean) => createElement(ChatInput, {
    streaming: false,
    stopping: false,
    disabled,
    submissionScope: "session:authority",
    allowFollowupSubmissions: true,
    acceptsImages: true,
    commands: [],
    onSend,
    onAbort: async () => undefined,
    onPickLocalFiles: async () => [],
    onError: () => undefined,
  });
  const typeAndSend = async (message: string) => {
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, message);
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: message }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
    });
  };
  try {
    await act(async () => root.render(render(false)));
    await typeAndSend("first");
    await typeAndSend("second");
    await act(async () => root.render(render(true)));
    await act(async () => {
      resolvers.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(calls, ["first"], "the queued snapshot remains local while mutations are disabled");
    await act(async () => {
      root.render(render(false));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(calls, ["first", "second"]);
    await act(async () => {
      resolvers.shift()?.();
      await Promise.resolve();
    });
  } finally {
    await act(async () => root.unmount());
  }
});

test("ChatInput keeps a send snapshot while local control is unavailable and drains it on recovery", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const calls: string[] = [];
  const render = (submissionPaused: boolean) => createElement(ChatInput, {
    streaming: false,
    stopping: false,
    disabled: false,
    submissionPaused,
    submissionScope: "session:foreign-control",
    acceptsImages: true,
    commands: [],
    onSend: async (message: string) => { calls.push(message); },
    onAbort: async () => undefined,
    onPickLocalFiles: async () => [],
    onError: () => undefined,
  });
  try {
    await act(async () => root.render(render(true)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "wait for control");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "wait for control" }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
    });
    assert.deepEqual(calls, []);
    assert.equal(textarea.disabled, false, "a paused send does not lock later editing");
    assert.equal(
      dom.window.document.querySelector(".composer-submission-status"),
      null,
      "retained submissions use the conversation-body status instead of a duplicate Composer banner",
    );
    await act(async () => {
      root.render(render(false));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(calls, ["wait for control"]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("ChatInput pauses undrained snapshots when navigation changes submission scope", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const calls: string[] = [];
  const resolvers = new Map<string, () => void>();
  const senders = {
    a: async (message: string) => {
      calls.push(`a:${message}`);
      await new Promise<void>((resolve) => resolvers.set(`a:${message}`, resolve));
    },
    b: async (message: string) => {
      calls.push(`b:${message}`);
      await new Promise<void>((resolve) => resolvers.set(`b:${message}`, resolve));
    },
  };
  const render = (scope: "a" | "b") => createElement(ChatInput, {
    streaming: false,
    stopping: false,
    disabled: false,
    submissionScope: `session:${scope}`,
    allowFollowupSubmissions: true,
    acceptsImages: true,
    commands: [],
    onSend: senders[scope],
    onAbort: async () => undefined,
    onPickLocalFiles: async () => [],
    onError: () => undefined,
  });
  const typeAndSend = async (message: string) => {
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, message);
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: message }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
    });
  };
  try {
    await act(async () => root.render(render("a")));
    await typeAndSend("one");
    await typeAndSend("two");
    assert.deepEqual(calls, ["a:one"]);

    await act(async () => root.render(render("b")));
    await typeAndSend("three");
    assert.deepEqual(
      calls,
      ["a:one", "b:three"],
      "a long in-flight send for the old pane must not block the new Session",
    );
    await act(async () => {
      resolvers.get("a:one")?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      resolvers.get("b:three")?.();
      await Promise.resolve();
      await Promise.resolve();
      root.render(render("a"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(calls, ["a:one", "b:three", "a:two"]);
    await act(async () => {
      resolvers.get("a:two")?.();
      await Promise.resolve();
    });
  } finally {
    await act(async () => root.unmount());
  }
});

test("ChatInput keeps unsent drafts partitioned by Session target and New generation", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const render = (draftKey: { kind: "session"; sessionId: string } | { kind: "new"; generation: number }) => createElement(ChatInput, {
    streaming: false,
    stopping: false,
    disabled: false,
    draftKey,
    submissionScope: draftKey.kind === "session" ? `session:${draftKey.sessionId}` : `draft:${draftKey.generation}`,
    acceptsImages: true,
    commands: [],
    onSend: async () => undefined,
    onAbort: async () => undefined,
    onPickLocalFiles: async () => [],
    onError: () => undefined,
  });
  const type = async (message: string) => {
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, message);
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: message }));
    });
  };
  try {
    await act(async () => root.render(render({ kind: "session", sessionId: "A" })));
    await type("A draft");
    await act(async () => root.render(render({ kind: "session", sessionId: "B" })));
    assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!.value, "");
    await type("B draft");
    await act(async () => root.render(render({ kind: "session", sessionId: "A" })));
    assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!.value, "A draft");
    await act(async () => root.render(render({ kind: "new", generation: 1 })));
    await type("first New");
    await act(async () => root.render(render({ kind: "new", generation: 2 })));
    assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!.value, "");
    await type("second New");
    await act(async () => root.render(render({ kind: "new", generation: 1 })));
    assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!.value, "first New");
  } finally {
    await act(async () => root.unmount());
  }
});

test("ChatInput protects IME confirmation and exposes slash suggestions as an active descendant", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const sent: string[] = [];
  try {
    await act(async () => root.render(createElement(ChatInput, {
      streaming: false,
      stopping: false,
      disabled: false,
      submissionScope: "session:ime",
      acceptsImages: true,
      commands: [{ name: "gate", source: "extension", description: "Gate" }],
      onSend: async (message: string) => { sent.push(message); },
      onAbort: async () => undefined,
      onPickLocalFiles: async () => [],
      onError: () => undefined,
    })));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "/g");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "/g" }));
    });
    const listboxId = textarea.getAttribute("aria-controls");
    assert.ok(listboxId);
    assert.equal(textarea.getAttribute("aria-expanded"), "true");
    assert.equal(textarea.getAttribute("aria-activedescendant"), `${listboxId}-option-0`);

    await act(async () => {
      textarea.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
      textarea.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      textarea.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true }));
      textarea.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    assert.deepEqual(sent, [], "IME confirmation Enter must not complete or submit a suggestion");
  } finally {
    await act(async () => root.unmount());
  }
});

test("ChatInput restores a definite failure without overwriting a newer draft", async () => {
  const { dom } = installDom();
  Object.assign(globalThis, { FileReader: dom.window.FileReader });
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  let rejectFirst!: () => void;
  let attempts = 0;
  const first = new Promise<void>((_resolve, reject) => {
    rejectFirst = () => reject(new Error("rejected"));
  });
  const render = () => createElement(ChatInput, {
    streaming: false,
    stopping: false,
    disabled: false,
    submissionScope: "session:restore",
    allowFollowupSubmissions: true,
    acceptsImages: true,
    commands: [],
    onSend: async () => {
      attempts += 1;
      if (attempts === 1) await first;
    },
    onAbort: async () => undefined,
    onPickLocalFiles: async () => [],
    onError: () => undefined,
  });
  const type = async (message: string) => {
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, message);
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: message }));
    });
  };
  try {
    await act(async () => root.render(render()));
    const fileInput = dom.window.document.querySelector<HTMLInputElement>("input[type='file']")!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new dom.window.File(["image"], "failed.png", { type: "image/png" })],
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      const deadline = Date.now() + 250;
      while (!dom.window.document.querySelector(".image-preview") && Date.now() < deadline)
        await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
    });
    await type("failed message");
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
    });
    await type("newer unsent draft");
    await act(async () => {
      rejectFirst();
      await Promise.resolve();
      await Promise.resolve();
    });
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    assert.equal(textarea.value, "failed message");
    assert.match(
      dom.window.document.querySelector(".composer-submission-status")?.textContent || "",
      /发送失败，草稿已恢复；rejected/,
    );
    assert.ok(dom.window.document.querySelector(".image-preview"), "the failed image is restored with its text");
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(attempts, 2);
    assert.equal(textarea.value, "newer unsent draft");
    assert.equal(dom.window.document.querySelector(".image-preview"), null);
  } finally {
    await act(async () => root.unmount());
  }
});

test("ChatInput never shows Stop from a stale stopping flag after streaming ended", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () =>
      root.render(
        createElement(ChatInput, {
          streaming: false,
          activelyStreaming: false,
          stopping: true,
          disabled: false,
          submissionScope: "session:stopping",
          acceptsImages: true,
          commands: [],
          onSend: async () => undefined,
          onAbort: async () => undefined,
          onPickLocalFiles: async () => [],
              onError: () => undefined,
        }),
      ),
    );
    assert.equal(
      dom.window.document.querySelector(".stop-button"),
      null,
      "Stop belongs exclusively to an active streaming turn",
    );
    assert.ok(
      dom.window.document.querySelector(".send-button"),
      "a settled composer retains the regular Send action",
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test("tool activity keeps Sidebar and Composer active when a stale state snapshot said idle", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const diagnostics = await import("../../src/web/lib/state-diagnostics");
  const backgroundId = "fedcba9876543210abcd";
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: false },
      sessions: [
        ...bootstrap.sessions.map((session) => ({
          ...session,
          running: false,
          activity: { execution: "idle" as const, awaitingConfirmation: false },
        })),
        {
          ...bootstrap.sessions[0],
          id: backgroundId,
          sessionId: "background-diagnostic",
          active: false,
          running: false,
          queued: false,
          activity: { execution: "idle" as const, awaitingConfirmation: false },
        },
      ],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(dom.window.document.querySelector(".send-button"));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_session_control_changed",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        sessionId: activeId,
        controlOwner: "foreign-window",
        controlledByThisWindow: false,
      }),
    );
    const observingProjection = diagnostics.browserStateDiagnosticSnapshot().entries
      .filter((entry) => entry.category === "projection" && entry.name === "ui-state")
      .at(-1);
    assert.equal(observingProjection?.details.observing, true);
    assert.equal(observingProjection?.details.foreignOwnerPresent, true);
    assert.equal(observingProjection?.details.controlledByThisWindow, false);
    await act(async () =>
      source.emitPi({
        type: "pi_chat_session_control_changed",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        sessionId: activeId,
        controlOwner: "this-window",
        controlledByThisWindow: true,
      }),
    );
    const controllingProjection = diagnostics.browserStateDiagnosticSnapshot().entries
      .filter((entry) => entry.category === "projection" && entry.name === "ui-state")
      .at(-1);
    assert.equal(controllingProjection?.details.observing, false);
    assert.equal(controllingProjection?.details.foreignOwnerPresent, false);
    assert.equal(controllingProjection?.details.controlledByThisWindow, true);

    await act(async () =>
      source.emitPi({
        type: "pi_chat_session_status",
        piChatSessionId: backgroundId,
        piChatRunGeneration: 1,
        activity: { execution: "running", awaitingConfirmation: false },
      }),
    );
    const backgroundProjection = diagnostics.browserStateDiagnosticSnapshot().entries
      .filter((entry) =>
        entry.category === "projection" &&
        entry.name === "sidebar-session" &&
        entry.sessionId === backgroundId,
      )
      .at(-1);
    assert.equal(backgroundProjection?.details.sidebarExecution, "running");
    assert.equal(backgroundProjection?.details.sidebarRunning, true);
    assert.equal(backgroundProjection?.details.viewed, false);
    await act(async () =>
      source.emitPi({
        type: "pi_chat_session_status",
        piChatSessionId: backgroundId,
        piChatRunGeneration: 1,
        activity: { execution: "idle", awaitingConfirmation: false },
      }),
    );
    const settledBackgroundProjection = diagnostics.browserStateDiagnosticSnapshot().entries
      .filter((entry) =>
        entry.category === "projection" &&
        entry.name === "sidebar-session" &&
        entry.sessionId === backgroundId,
      )
      .at(-1);
    assert.equal(settledBackgroundProjection?.details.sidebarExecution, "idle");
    assert.equal(settledBackgroundProjection?.details.sidebarRunning, false);

    await act(async () =>
      source.emitPi({
        type: "tool_execution_start",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        toolName: "bash",
      }),
    );
    assert.ok(dom.window.document.querySelector(".stop-button"));
    assert.ok(dom.window.document.querySelector(".queue-submit-button"));
    assert.ok(dom.window.document.querySelector(".steer-submit-button"));
    assert.equal(dom.window.document.querySelector(".send-button"), null);
    assert.ok(dom.window.document.querySelector(".session-status.is-running"));
    const activeProjection = diagnostics.browserStateDiagnosticSnapshot().entries
      .filter((entry) => entry.category === "projection" && entry.name === "ui-state")
      .at(-1);
    assert.equal(activeProjection?.details.toolActive, true);
    assert.equal(activeProjection?.details.composerStopVisible, true);
    assert.equal(activeProjection?.details.composerSendVisible, false);
    assert.equal(activeProjection?.details.sidebarRunning, true);
    await act(async () =>
      source.emitPi({
        type: "tool_execution_end",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        toolName: "bash",
        isError: false,
      }),
    );
    assert.ok(
      dom.window.document.querySelector(".stop-button"),
      "tool completion still belongs to the active turn until terminal activity arrives",
    );
    await act(async () =>
      source.emitPi({
        type: "pi_chat_session_status",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        activity: { execution: "idle", awaitingConfirmation: false },
      }),
    );
    assert.equal(dom.window.document.querySelector(".stop-button"), null);
    assert.equal(dom.window.document.querySelector(".steer-submit-button"), null);
    assert.ok(dom.window.document.querySelector(".send-button"));
    assert.equal(dom.window.document.querySelector(".session-status.is-running"), null);
    const idleProjection = diagnostics.browserStateDiagnosticSnapshot().entries
      .filter((entry) => entry.category === "projection" && entry.name === "ui-state")
      .at(-1);
    assert.equal(idleProjection?.details.composerStopVisible, false);
    assert.equal(idleProjection?.details.composerSendVisible, true);
    assert.equal(idleProjection?.details.sidebarRunning, false);

    await act(async () =>
      source.emitPi({
        type: "agent_start",
        piChatSessionId: activeId,
        piChatRunGeneration: 2,
      }),
    );
    const rejectionStart = diagnostics.browserStateDiagnosticSnapshot().entries.at(-1)?.sequence || 0;
    await act(async () => {
      for (let index = 0; index < 2; index += 1)
        source.emitPi({
          type: "message_update",
          piChatSessionId: activeId,
          piChatRunGeneration: 1,
          message: { role: "assistant", content: [{ type: "text", text: String(index) }] },
        });
    });
    const staleUpdates = diagnostics.browserStateDiagnosticSnapshot().entries.filter((entry) =>
      entry.sequence > rejectionStart &&
      entry.category === "sse" &&
      entry.name === "rejected" &&
      entry.sessionId === activeId &&
      entry.details.eventType === "message_update",
    );
    assert.equal(staleUpdates.length, 1, "a stale update flood retains one structural rejection fact");
    assert.equal(staleUpdates[0]?.details.decisionReason, "stale-run-generation");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
