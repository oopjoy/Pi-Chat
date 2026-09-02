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


test("a late cold activation from A cannot overwrite the Session B composer", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "aaaaaaaaaaaaaaaaaaaa";
  const secondId = "bbbbbbbbbbbbbbbbbbbb";
  const modelA = {
    id: "model-a",
    name: "Model A",
    provider: "test",
    input: ["text"],
    reasoning: true,
  };
  const modelB = {
    id: "model-b",
    name: "Model B",
    provider: "test",
    input: ["text"],
    reasoning: true,
  };
  const summaryA = {
    ...bootstrap.sessions[0],
    id: coldId,
    sessionId: "cold-a",
    name: "Cold A",
    active: false,
    writable: false,
  };
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "session-b",
    name: "Session B",
    active: false,
  };
  const viewA: SessionViewData = {
    ...draftView,
    session: summaryA,
    state: {
      ...bootstrap.state,
      model: modelA,
      thinkingLevel: "high",
      sessionId: "cold-a",
    },
    runtimeStatus: "view-only",
    isActive: false,
  };
  const activatedA: SessionViewData = {
    ...viewA,
    session: { ...summaryA, active: true, writable: true },
    runtimeStatus: "active",
    isActive: true,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: {
      ...bootstrap.state,
      model: modelB,
      thinkingLevel: "low",
      sessionId: "session-b",
    },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let resolveActivation!: (view: SessionViewData) => void;
  const pendingActivation = new Promise<SessionViewData>((resolve) => {
    resolveActivation = resolve;
  });
  const promptTargets: string[] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      models: [modelA, modelB],
      sessions: [bootstrap.sessions[0], summaryA, summaryB],
      sessionsTotal: 3,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) =>
      id === coldId ? viewA : id === secondId ? viewB : draftView,
    warmSession: async (id: string) => {
      if (id === secondId)
        return {
          sessionId: id,
          state: viewB.state,
          gateMode: "strict" as const,
        };
      const view = await pendingActivation;
      return {
        sessionId: view.session.id,
        state: view.state,
        gateMode: "strict" as const,
      };
    },
    prompt: async (_message: string, _images: unknown[], sessionId: string) => {
      promptTargets.push(sessionId);
      return { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => sessionButton("Cold A").click());
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "send to cold A");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "send to cold A",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    await act(async () => sessionButton("Session B").click());
    assert.match(
      dom.window.document.querySelector(
        ".composer-model-select .compact-select-trigger",
      )?.textContent || "",
      /Model B/,
    );
    assert.match(
      dom.window.document.querySelector(
        ".thinking-control .compact-select-trigger",
      )?.textContent || "",
      /low/,
    );

    await act(async () => {
      resolveActivation(activatedA);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(
      promptTargets,
      [coldId],
      "the background send still targets A",
    );
    assert.match(
      dom.window.document.querySelector(
        ".composer-model-select .compact-select-trigger",
      )?.textContent || "",
      /Model B/,
    );
    assert.match(
      dom.window.document.querySelector(
        ".thinking-control .compact-select-trigger",
      )?.textContent || "",
      /low/,
    );
    assert.equal(
      dom.window.document.querySelector(".agent-status.is-waiting"),
      null,
      "A's waiting projection cannot appear in B's conversation body",
    );
    assert.equal(
      textarea.disabled,
      false,
      "A activation cannot lock B's composer",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale A Runtime warm cannot overwrite a newer A revisit", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "warm-a-12345678901234";
  const secondId = "warm-b-12345678901234";
  const modelA = {
    id: "warm-model-a",
    name: "Warm Model A",
    provider: "test",
    input: ["text"],
    reasoning: true,
  };
  const modelB = {
    id: "warm-model-b",
    name: "Warm Model B",
    provider: "test",
    input: ["text"],
    reasoning: true,
  };
  const summaryA = {
    ...bootstrap.sessions[0],
    id: coldId,
    sessionId: "warm-a",
    name: "Warm A",
    active: false,
    writable: false,
  };
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "warm-b",
    name: "Warm B",
    active: false,
    writable: false,
  };
  const viewA = {
    ...draftView,
    session: summaryA,
    state: {
      ...bootstrap.state,
      model: modelA,
      thinkingLevel: "low",
      sessionId: "warm-a",
    },
    runtimeStatus: "view-only" as const,
    isActive: false,
    historyPending: true,
  };
  const revisitA = {
    ...viewA,
    historyPending: false,
    state: { ...viewA.state, model: modelB, thinkingLevel: "high" },
  };
  const viewB = {
    ...draftView,
    session: summaryB,
    state: {
      ...bootstrap.state,
      model: modelB,
      thinkingLevel: "medium",
      sessionId: "warm-b",
    },
    runtimeStatus: "view-only" as const,
    isActive: false,
  };
  let resolveWarm!: (ready: {
    sessionId: string;
    state: typeof viewA.state;
    gateMode: "strict";
  }) => void;
  const pendingWarm = new Promise<{
    sessionId: string;
    state: typeof viewA.state;
    gateMode: "strict";
  }>((resolve) => {
    resolveWarm = resolve;
  });
  let viewsOfA = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      models: [modelA, modelB],
      sessions: [bootstrap.sessions[0], summaryA, summaryB],
      sessionsTotal: 3,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => {
      if (id === coldId) return ++viewsOfA === 1 ? viewA : revisitA;
      if (id === secondId) return viewB;
      return draftView;
    },
    warmSession: async () => pendingWarm,
    prompt: async () => ({ accepted: true, queued: false }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => sessionButton("Warm A").click());
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "start stale warm");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "start stale warm",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    await act(async () => sessionButton("Warm B").click());
    await act(async () => sessionButton("Warm A").click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(
      dom.window.document.querySelector(
        ".composer-model-select .compact-select-trigger",
      )?.textContent || "",
      /Warm Model B/,
    );
    assert.match(
      dom.window.document.querySelector(
        ".thinking-control .compact-select-trigger",
      )?.textContent || "",
      /high/,
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Warm A",
      "the newer A revisit owns the title before an earlier A warm completes",
    );
    await act(async () => {
      resolveWarm({
        sessionId: coldId,
        state: { ...viewA.state, model: modelA, thinkingLevel: "low" },
        gateMode: "strict",
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(
      dom.window.document.querySelector(
        ".composer-model-select .compact-select-trigger",
      )?.textContent || "",
      /Warm Model B/,
    );
    assert.match(
      dom.window.document.querySelector(
        ".thinking-control .compact-select-trigger",
      )?.textContent || "",
      /high/,
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Warm A",
      "the stale A warm result cannot replace the current A pane title",
    );
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='消息输入']",
      )?.placeholder,
      "输入消息，或粘贴、拖入附件",
      "the returned A pane joins the existing warm and becomes active",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a replacement ignores stale A warm cache writes", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "replacement-warm-12345";
  let promptCalls = 0;
  const coldSession = {
    ...bootstrap.sessions[0],
    id: coldId,
    sessionId: "replacement-warm",
    name: "Replacement warm",
    active: false,
    writable: false,
  };
  const coldView: SessionViewData = {
    ...draftView,
    session: coldSession,
    state: { ...draftView.state, sessionId: "replacement-warm" },
    isActive: false,
    runtimeStatus: "view-only",
  };
  let resolveWarm!: (value: {
    sessionId: string;
    state: typeof coldView.state;
    gateMode: "strict";
  }) => void;
  const pendingWarm = new Promise<{
    sessionId: string;
    state: typeof coldView.state;
    gateMode: "strict";
  }>((resolve) => {
    resolveWarm = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], coldSession],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => (id === coldId ? coldView : draftView),
    warmSession: async () => pendingWarm,
    prompt: async () => {
      promptCalls += 1;
      return { accepted: true, queued: false };
    },
    invalidateHandshake: () => undefined,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const coldButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((button) => button.textContent?.includes("Replacement warm"))!;
    await act(async () => coldButton.click());
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "warm");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "warm",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "workspace-changing",
            piChatRunEpoch: "epoch-warm-b",
            workspaceEpoch: "epoch-warm-b",
          }),
        }),
      ),
    );
    await act(async () => {
      resolveWarm({
        sessionId: coldId,
        state: coldView.state,
        gateMode: "strict",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Replacement warm",
      "the old warm completion cannot replace process-B UI state",
    );
    assert.equal(
      promptCalls,
      0,
      "the old send chain cannot use process B's transport after its warm settles",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
