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
  const directSettingCalls: string[] = [];
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
    setModel: async () => { directSettingCalls.push("model"); return { model: targetModel, pending: false }; },
    setThinking: async () => { directSettingCalls.push("thinking"); return { level: "high" as const, pending: false }; },
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
    assert.deepEqual(directSettingCalls, [], "the Composer does not split a next-turn selection into pre-prompt Runtime mutations");
    assert.deepEqual(
      promptCalls[0]?.[5],
      { model: { provider: "xwill", modelId: "gpt-5.6-terra" } },
      "the cold prompt receives the exact Model snapshot captured at Send",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a cold prompt remains visible between Runtime readiness and prompt acknowledgement", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "cold-visible-12345678";
  const cold: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: coldId,
      sessionId: "cold-visible",
      name: "Cold visible",
      active: false,
      writable: true,
    },
    state: { ...draftView.state, sessionId: "cold-visible" },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let resolveWarm!: (value: Awaited<ReturnType<typeof api.warmSession>>) => void;
  let resolvePrompt!: (value: Awaited<ReturnType<typeof api.prompt>>) => void;
  const warm = new Promise<Awaited<ReturnType<typeof api.warmSession>>>((resolve) => { resolveWarm = resolve; });
  const prompt = new Promise<Awaited<ReturnType<typeof api.prompt>>>((resolve) => { resolvePrompt = resolve; });
  let promptCalls = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [...bootstrap.sessions, cold.session],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => id === coldId ? cold : draftView,
    warmSession: async () => warm,
    prompt: async () => { promptCalls += 1; return prompt; },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => {
      [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")]
        .find((button) => button.textContent?.includes("Cold visible"))!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "keep me visible");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "keep me visible" }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
    });
    assert.match(dom.window.document.body.textContent || "", /keep me visible/);

    await act(async () => {
      resolveWarm({ sessionId: coldId, state: cold.state, gateMode: "strict" });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(promptCalls, 1, "prompt dispatch begins after Runtime readiness");
    assert.match(
      dom.window.document.body.textContent || "",
      /keep me visible/,
      "Runtime readiness cannot clear the local bubble before acknowledgement",
    );

    await act(async () => {
      resolvePrompt({ accepted: true, queued: false });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(dom.window.document.body.textContent || "", /keep me visible/);
  } finally {
    resolveWarm?.({ sessionId: coldId, state: cold.state, gateMode: "strict" });
    resolvePrompt?.({ accepted: true, queued: false });
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("one active-session Composer selection stays local until its prompt captures Model and Thinking together", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const hotId = activeId;
  const directSettingCalls: string[][] = [];
  const promptCalls: unknown[][] = [];
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
      directSettingCalls.push([provider, modelId]);
      return { model: bootstrap.state.model, pending: false };
    },
    setThinking: async (level: string) => {
      directSettingCalls.push(["thinking", level]);
      return { level: "high" as const, pending: false };
    },
    prompt: async (...args: unknown[]) => { promptCalls.push(args); return { accepted: true, queued: false }; },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    // Choosing Model/Thinking only changes this session's next-prompt intent.
    const modelTrigger = dom.window.document.querySelector<HTMLButtonElement>(".composer-model-select .compact-select-trigger")!;
    await act(async () => { modelTrigger.click(); await Promise.resolve(); });
    const modelOption = [...dom.window.document.querySelectorAll<HTMLElement>(".compact-select-option")]
      .find((candidate) => candidate.textContent?.includes("gpt-5.6-sol"));
    assert.ok(modelOption);
    await act(async () => { modelOption.click(); await Promise.resolve(); });
    // A second choice augments the same complete next-prompt intent.
    const thinkingTrigger = dom.window.document.querySelector<HTMLButtonElement>(".thinking-control .compact-select-trigger")!;
    await act(async () => { thinkingTrigger.click(); await Promise.resolve(); });
    const thinkingOption = [...dom.window.document.querySelectorAll<HTMLElement>(".compact-select-option")]
      .find((candidate) => candidate.textContent?.trim() === "high");
    assert.ok(thinkingOption);
    await act(async () => { thinkingOption.click(); await Promise.resolve(); await Promise.resolve(); });
    assert.match(
      dom.window.document.querySelector<HTMLButtonElement>(".thinking-control .compact-select-trigger")!.textContent || "",
      /high/,
      "thinking choice is displayed as this Composer's next selection",
    );
    assert.deepEqual(directSettingCalls, [], "selecting controls never mutates the active Runtime before Send");
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "capture complete selection");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "capture complete selection" }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(
      promptCalls[0]?.[5],
      {
        model: { provider: "xwill", modelId: "gpt-5.6-sol" },
        thinkingLevel: "high",
      },
      "one prompt carries one immutable complete selection rather than split setting requests",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an unknown-capability cold model keeps thinking staggable until first send", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "dddddddddddddddddddd";
  // Fallback persisted model: known only by name, reasoning unknown (undefined).
  const coldModel = {
    provider: "removed-provider",
    id: "old-history-model",
    name: "old-history-model",
  };
  const cold: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: coldId,
      sessionId: "cold-unknown",
      name: "Cold unknown",
      messageCount: 1,
      active: false,
      writable: true,
    },
    state: { ...draftView.state, sessionId: "cold-unknown", model: coldModel },
    isActive: false,
    runtimeStatus: "view-only",
    gateMode: "strict" as const,
    gateAvailable: true,
  };
  let warmCalls = 0;
  const thinkingCalls: unknown[][] = [];
  const promptCalls: unknown[][] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [...bootstrap.sessions, cold.session],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => (id === coldId ? cold : draftView),
    warmSession: async () => { warmCalls += 1; return { sessionId: coldId, state: cold.state, gateMode: "strict" as const }; },
    setThinking: async (level: unknown, sessionId: unknown) => { thinkingCalls.push([level, sessionId]); return { level: "high" as const, pending: false }; },
    prompt: async (...args: unknown[]) => { promptCalls.push(args); return { accepted: true, queued: false }; },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => {
      [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")]
        .find((button) => button.textContent?.includes("Cold unknown"))!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const thinkingTrigger = dom.window.document.querySelector<HTMLButtonElement>(".thinking-control .compact-select-trigger")!;
    assert.equal(thinkingTrigger.disabled, false, "unknown reasoning must not lock the thinking control");
    await act(async () => { thinkingTrigger.click(); await Promise.resolve(); });
    const option = [...dom.window.document.querySelectorAll<HTMLElement>(".compact-select-option")]
      .find((candidate) => candidate.textContent?.trim() === "high");
    assert.ok(option, "thinking option is listed for an unknown-capability model");
    await act(async () => { option.click(); await Promise.resolve(); await Promise.resolve(); });
    assert.match(
      dom.window.document.querySelector<HTMLButtonElement>(".thinking-control .compact-select-trigger")!.textContent || "",
      /high/,
      "the staged thinking choice paints immediately",
    );
    assert.equal(warmCalls, 0, "staging a cold thinking choice must not warm the Runtime");
    assert.deepEqual(thinkingCalls, [], "staging is local: setThinking is not called before the first send");
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "first send");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "first send" }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(warmCalls, 1, "the first ordinary send warms the target Runtime exactly once");
    assert.deepEqual(
      thinkingCalls,
      [],
      "the Composer no longer mutates a cold Runtime through a separate setting request",
    );
    assert.deepEqual(
      promptCalls[0]?.[5],
      { thinkingLevel: "high" },
      "the first send carries its immutable staged thinking snapshot to exactly this cold Session",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a reasoning:false model keeps the thinking control locked", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "eeeeeeeeeeeeeeeeeeee";
  const noReasoning = {
    provider: "test",
    id: "no-thinking-model",
    name: "no-thinking-model",
    reasoning: false,
    input: ["text"],
  };
  const cold: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: coldId,
      sessionId: "cold-no-reasoning",
      name: "Cold no reasoning",
      messageCount: 1,
      active: false,
      writable: true,
    },
    state: { ...draftView.state, sessionId: "cold-no-reasoning", model: noReasoning },
    isActive: false,
    runtimeStatus: "view-only",
    gateMode: "strict" as const,
    gateAvailable: true,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [...bootstrap.sessions, cold.session],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => (id === coldId ? cold : draftView),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => {
      [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")]
        .find((button) => button.textContent?.includes("Cold no reasoning"))!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const thinkingTrigger = dom.window.document.querySelector<HTMLButtonElement>(".thinking-control .compact-select-trigger")!;
    assert.equal(thinkingTrigger.disabled, true, "an explicitly non-reasoning model keeps thinking locked");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
