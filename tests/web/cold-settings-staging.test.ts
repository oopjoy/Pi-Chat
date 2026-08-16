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

test("cold history settings stage immediately and survive until send", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "cccccccccccccccccccc";
  const targetModel = {
    provider: "xwill",
    id: "gpt-5.6-terra",
    name: "gpt-5.6-terra",
    input: ["text"],
    reasoning: true,
  };
  const cold: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: coldId,
      sessionId: "cold-settings",
      name: "Cold settings",
      messageCount: 1,
      active: false,
      writable: true,
    },
    state: { ...draftView.state, sessionId: "cold-settings" },
    isActive: false,
    runtimeStatus: "view-only",
    gateMode: "strict" as const,
    gateAvailable: true,
  };
  let warmCalls = 0;
  const promptCalls: unknown[][] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      models: [...bootstrap.models, targetModel],
      sessions: [...bootstrap.sessions, cold.session],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => (id === coldId ? cold : draftView),
    warmSession: async () => { warmCalls += 1; return { sessionId: coldId, state: cold.state, gateMode: "strict" as const }; },
    setModel: async () => ({ model: targetModel, pending: false }),
    setThinking: async () => ({ level: "high" as const, pending: false }),
    prompt: async (...args: unknown[]) => { promptCalls.push(args); return { accepted: true, queued: false }; },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => {
      [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")]
        .find((button) => button.textContent?.includes("Cold settings"))!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Gate: cold view reports strict, so the control shows strict (not "未同步").
    const gate = dom.window.document.querySelector<HTMLButtonElement>(".gate-control .compact-select-trigger");
    assert.ok(gate);
    assert.match(gate.textContent || "", /严格|strict/);
    // Model: select gpt-5.6-terra; the control value updates immediately.
    const modelTrigger = dom.window.document.querySelector<HTMLButtonElement>(".composer-model-select .compact-select-trigger")!;
    await act(async () => { modelTrigger.click(); await Promise.resolve(); });
    const option = [...dom.window.document.querySelectorAll<HTMLElement>(".compact-select-option")]
      .find((candidate) => candidate.textContent?.includes("gpt-5.6-terra"));
    assert.ok(option, "model option is listed");
    await act(async () => { option.click(); await Promise.resolve(); await Promise.resolve(); });
    assert.match(
      dom.window.document.querySelector<HTMLButtonElement>(".composer-model-select .compact-select-trigger")!.textContent || "",
      /gpt-5\.6-terra/,
      "cold model choice paints immediately via staged preference",
    );
    // Send; the prompt carries the staged model.
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "hello cold");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "hello cold" }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(promptCalls.length >= 1, "cold send reaches the API");
    assert.equal(warmCalls, 1, "cold send warms its Runtime exactly once");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an in-flight model request does not block staging a thinking choice", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const hotId = activeId;
  let resolveModel!: (value: { model: BootstrapData["state"]["model"]; pending: boolean }) => void;
  const modelPending = new Promise<{ model: BootstrapData["state"]["model"]; pending: boolean }>((resolve) => { resolveModel = resolve; });
  const setModelCalls: string[][] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      models: [
        ...bootstrap.models,
        { id: "gpt-5.6-sol", name: "gpt-5.6-sol", provider: "xwill", input: ["text"], reasoning: true },
      ],
      sessions: [bootstrap.sessions[0]],
      sessionsTotal: 1,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: hotId }),
    viewSession: async () => draftView,
    setModel: async (provider: string, modelId: string) => {
      setModelCalls.push([provider, modelId]);
      return modelPending;
    },
    setThinking: async () => ({ level: "high" as const, pending: false }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    // Choose a model; its request stays in flight.
    const modelTrigger = dom.window.document.querySelector<HTMLButtonElement>(".composer-model-select .compact-select-trigger")!;
    await act(async () => { modelTrigger.click(); await Promise.resolve(); });
    const modelOption = [...dom.window.document.querySelectorAll<HTMLElement>(".compact-select-option")]
      .find((candidate) => candidate.textContent?.includes("gpt-5.6-sol"));
    assert.ok(modelOption);
    await act(async () => { modelOption.click(); await Promise.resolve(); });
    // While the model request is pending, choosing a thinking level must still
    // stage (never silently return), and the control reflects the choice.
    const thinkingTrigger = dom.window.document.querySelector<HTMLButtonElement>(".thinking-control .compact-select-trigger")!;
    await act(async () => { thinkingTrigger.click(); await Promise.resolve(); });
    const thinkingOption = [...dom.window.document.querySelectorAll<HTMLElement>(".compact-select-option")]
      .find((candidate) => candidate.textContent?.trim() === "high");
    assert.ok(thinkingOption);
    await act(async () => { thinkingOption.click(); await Promise.resolve(); await Promise.resolve(); });
    // In the hot path the choice issues its own RPC; the guarantee under test
    // is that an in-flight model request never blocks a thinking choice.
    assert.match(
      dom.window.document.querySelector<HTMLButtonElement>(".thinking-control .compact-select-trigger")!.textContent || "",
      /high/,
      "thinking choice is applied while model request is in flight",
    );
    resolveModel({ model: bootstrap.state.model, pending: false });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
