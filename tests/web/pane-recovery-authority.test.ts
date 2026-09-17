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


test("token recovery clears full inventory retained by the previous process", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const oldOnly = {
    ...bootstrap.sessions[0],
    id: "aaaaaaaaaaaaaaaaaaaa",
    sessionId: "process-a-only",
    name: "Process A retained archive",
    active: false,
    writable: false,
  };
  let recovered = false;
  Object.assign(api, {
    bootstrap: async () =>
      recovered
        ? { ...bootstrap, sessionsTotal: 1 }
        : { ...bootstrap, sessionsTotal: 2 },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    sessions: async (all = false) => ({
      sessions: all && !recovered
        ? [bootstrap.sessions[0], oldOnly]
        : bootstrap.sessions,
      total: recovered ? 1 : 2,
    }),
    recoverConnection: async () => {
      recovered = true;
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const search = dom.window.document.querySelector<HTMLInputElement>(
      "input[aria-label='搜索对话']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "archive");
      search.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "archive",
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(dom.window.document.body.textContent || "", /Process A retained archive/);
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".session-search-clear")!
        .click(),
    );

    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.onerror?.(new dom.window.Event("error"));
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /Process A retained archive/,
      "a token-only replacement must not merge process-A full inventory into B",
    );
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      1,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("token recovery resets process-local readiness before a lower replacement generation", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  let resolveRecoveredBootstrap!: (value: BootstrapData) => void;
  const recoveredBootstrap = new Promise<BootstrapData>((resolve) => {
    resolveRecoveredBootstrap = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) {
        return {
          ...bootstrap,
          primaryRuntime: {
            status: "ready" as const,
            generation: 9,
            model: bootstrap.state.model,
            sessionId: activeId,
          },
        };
      }
      return recoveredBootstrap;
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    recoverConnection: async () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.equal(
      dom.window.document.querySelector(".primary-runtime-status"),
      null,
      "process A begins ready at its higher local generation",
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.onerror?.(new dom.window.Event("error"));
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
    assert.equal(bootstrapCalls, 2);
    assert.ok(
      dom.window.document.querySelector(".primary-runtime-status.is-starting"),
      "accepted recovery token retires process A readiness before B bootstrap",
    );

    await act(async () => {
      resolveRecoveredBootstrap({
        ...bootstrap,
        primaryRuntime: {
          status: "failed",
          generation: 1,
          error: "replacement Runtime generation one",
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(
      dom.window.document.querySelector(".primary-runtime-status.is-failed"),
      "process B lower readiness generation is accepted without a ready frame",
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /replacement Runtime generation one/,
    );
  } finally {
    await act(async () => {
      resolveRecoveredBootstrap(bootstrap);
      root.unmount();
    });
    restoreApi();
  }
});

test("transient SSE recovery keeps an active turn visible until fresh bootstrap authority arrives", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  let releaseBootstrap!: () => void;
  const heldBootstrap = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
  const activeBootstrap = {
    ...bootstrap,
    state: { ...bootstrap.state, isStreaming: true },
    sessions: bootstrap.sessions.map((session) => ({
      ...session,
      running: true,
      activity: { execution: "running" as const, awaitingConfirmation: false },
    })),
  };
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls > 1) await heldBootstrap;
      return activeBootstrap;
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    recoverConnection: async () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    assert.ok(dom.window.document.querySelector(".session-status.is-running"));
    assert.ok(dom.window.document.querySelector(".queue-submit-button"));
    assert.ok(dom.window.document.querySelector(".steer-submit-button"));

    await act(async () => {
      source.onerror?.(new dom.window.Event("error"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(
      dom.window.document.querySelector(".session-status.is-running"),
      "a transient SSE error must not erase the running sidebar state",
    );
    assert.ok(
      dom.window.document.querySelector(".queue-submit-button"),
      "Queue must remain available while the active turn is being revalidated",
    );
    assert.ok(
      dom.window.document.querySelector(".steer-submit-button"),
      "Steer must remain available while the active turn is being revalidated",
    );

    await act(async () => releaseBootstrap());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("SSE recovery settles a retained turn when fresh bootstrap proves it stopped", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  let releaseBootstrap!: () => void;
  const heldBootstrap = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
  const activeBootstrap = {
    ...bootstrap,
    state: { ...bootstrap.state, isStreaming: true },
    sessions: bootstrap.sessions.map((session) => ({
      ...session,
      running: true,
      activity: { execution: "running" as const, awaitingConfirmation: false },
    })),
  };
  const stoppedBootstrap = {
    ...bootstrap,
    state: { ...bootstrap.state, isStreaming: false },
    sessions: bootstrap.sessions.map((session) => ({
      ...session,
      running: false,
      activity: { execution: "idle" as const, awaitingConfirmation: false },
    })),
  };
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls > 1) await heldBootstrap;
      return bootstrapCalls === 1 ? activeBootstrap : stoppedBootstrap;
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    recoverConnection: async () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.onerror?.(new dom.window.Event("error"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(dom.window.document.querySelector(".stop-button"));
    assert.ok(dom.window.document.querySelector(".queue-submit-button"));
    assert.ok(dom.window.document.querySelector(".steer-submit-button"));

    await act(async () => releaseBootstrap());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(dom.window.document.querySelector(".stop-button"), null);
    assert.equal(dom.window.document.querySelector(".queue-submit-button"), null);
    assert.equal(dom.window.document.querySelector(".steer-submit-button"), null);
    assert.equal(dom.window.document.querySelector(".session-status.is-running"), null);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("token recovery clears a stale ask questionnaire owned by the prior process", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    recoverConnection: async () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "tool_execution_start",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        toolName: "ask_user_question",
        toolCallId: "ask-process-a",
        args: {
          questions: [{
            question: "Process A question?",
            header: "Process A",
            options: [
              { label: "One", description: "first" },
              { label: "Two", description: "second" },
            ],
          }],
        },
      }),
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /Process A question\?/,
      "A's live Ask projection is initially visible",
    );

    await act(async () => {
      source.onerror?.(new dom.window.Event("error"));
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /Process A question\?/,
      "token recovery must not render an Ask projection produced by process A",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("EventSource reconnect refreshes an authoritative terminal without duplicating it", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const terminal = {
    role: "assistant",
    content: "terminal recovered after reconnect",
    timestamp: 2,
  } as const;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      messages: [{ role: "user", content: "question", timestamp: 1 }, terminal],
      messageTotal: 2,
      turnTotal: 1,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    recoverConnection: async () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "message_end",
        piChatSessionId: activeId,
        message: terminal,
      }),
    );
    assert.equal(
      (dom.window.document.body.textContent || "").match(
        /terminal recovered after reconnect/g,
      )?.length,
      1,
    );
    await act(async () => {
      source.onerror?.(new dom.window.Event("error"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      (dom.window.document.body.textContent || "").match(
        /terminal recovered after reconnect/g,
      )?.length,
      1,
    );
    assert.ok(FakeEventSource.instances.length >= 2);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an addressed child transcript disables Model, Thinking, and Gate controls", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const childId = "dddddddddddddddddddd";
  const childView = createSessionViewFixture();
  childView.session = {
    ...childView.session,
    id: childId,
    sessionId: "child-ro",
    name: "RO child",
    active: false,
    writable: false,
    messageCount: 2,
  };
  // Unknown reasoning (no reasoning field) — must still stay locked in a child.
  childView.state = {
    ...childView.state,
    sessionId: "child-ro",
    sessionName: "RO child",
    model: { id: "child-model", name: "Child model", provider: "child-provider" },
    thinkingLevel: "high",
    isStreaming: false,
  };
  childView.messages = [
    { role: "user", content: "inspect" },
    { role: "assistant", content: "child notes" },
  ];
  childView.messageTotal = 2;
  childView.turnTotal = 1;
  childView.runtimeStatus = "view-only";
  childView.isActive = false;
  childView.pendingExtensionRequest = {
    id: "child-confirmation",
    method: "confirm",
    title: "Child confirmation",
    piChatSessionId: childId,
  };
  const parentView: SessionViewData = {
    ...draftView,
    session: { ...bootstrap.sessions[0] },
    state: { ...bootstrap.state },
    messages: [{ role: "assistant", content: "parent history" }],
    messageTotal: 1,
    turnTotal: 0,
    runtimeStatus: "active",
    isActive: true,
  };
  const settingCalls: string[] = [];
  const promptTargets: string[] = [];
  const viewed: string[] = [];
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => { viewed.push(id); return { viewing: id }; },
    backgroundSubagents: async (id: string) => id === activeId ? {
      total: 1,
      activeCount: 1,
      attentionCount: 0,
      truncated: false,
      steps: [{ key: "subagent-ro", label: "RO child", status: "running", elapsedMs: 1_000, updateAgeMs: 0, childSessionId: childId }],
    } : { total: 0, activeCount: 0, attentionCount: 0, truncated: false, steps: [] },
    viewBackgroundSubagent: async () => childView,
    viewSession: async (id: string) => { assert.equal(id, activeId); return parentView; },
    warmSession: async (id: string) => {
      if (id !== activeId) throw new Error("must not warm child");
      return { sessionId: id, state: bootstrap.state, gateMode: "strict" as const };
    },
    prompt: async (_message: string, _images: unknown[], id: string) => { promptTargets.push(id); return { accepted: true, queued: false }; },
    setModel: async (_p: string, _m: string, id: string) => { settingCalls.push(`model:${id}`); return { model: bootstrap.state.model, pending: false }; },
    setThinking: async (_l: string, id: string) => { settingCalls.push(`thinking:${id}`); return { level: "medium", pending: false }; },
    respondToExtension: async () => ({}),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".subagent-status-trigger")!;
    await act(async () => trigger.click());
    const row = dom.window.document.querySelector<HTMLButtonElement>('.subagent-status-row[role="treeitem"]')!;
    await act(async () => { row.click(); await Promise.resolve(); await Promise.resolve(); });
    assert.match(dom.window.document.body.textContent || "", /child notes/, "child transcript is open");
    const model = dom.window.document.querySelector<HTMLButtonElement>(".composer-model-select .compact-select-trigger")!;
    const thinking = dom.window.document.querySelector<HTMLButtonElement>(".thinking-control .compact-select-trigger")!;
    const gate = dom.window.document.querySelector<HTMLButtonElement>(".gate-control .compact-select-trigger")!;
    assert.equal(model.disabled, true, "child transcript disables the Model control even with an unknown-reasoning model");
    assert.equal(thinking.disabled, true, "child transcript disables the Thinking control");
    assert.equal(gate.disabled, true, "child transcript disables the Gate control");
    // An ordinary parent-targeted send still reaches only the verified parent and
    // never triggers child-originated settings mutations.
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "report to parent");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "report to parent" }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(promptTargets, [activeId], "a child send targets only the verified parent");
    assert.deepEqual(settingCalls, [], "no child-originated Model/Thinking mutation reaches any Runtime");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a missing selected model keeps the Thinking control disabled", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const noModelView: SessionViewData = {
    ...draftView,
    session: { ...draftView.session, id: "eeeeeeeeeeeeeeeeeeee", sessionId: "no-model", name: "No model" },
    state: { ...draftView.state, sessionId: "no-model", model: null },
    isActive: false,
    runtimeStatus: "view-only",
    gateMode: "strict" as const,
    gateAvailable: true,
  };
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, sessions: [...bootstrap.sessions, noModelView.session], sessionsTotal: 2 }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => (id === "eeeeeeeeeeeeeeeeeeee" ? noModelView : draftView),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => {
      [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")]
        .find((button) => button.textContent?.includes("No model"))!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const thinking = dom.window.document.querySelector<HTMLButtonElement>(".thinking-control .compact-select-trigger")!;
    assert.equal(thinking.disabled, true, "no selected model keeps the Thinking control disabled");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
