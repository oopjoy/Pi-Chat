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


test("slow A to B navigation binds TopBar Subagents to B before its view resolves", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "bbbbbbbbbbbbbbbbbbbb";
  const summaryB = { ...bootstrap.sessions[0], id: secondId, name: "Session B", active: false };
  const pendingView = new Promise<SessionViewData>(() => {});
  const subagentCalls: string[] = [];
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, sessions: [bootstrap.sessions[0], summaryB], sessionsTotal: 2 }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => id === secondId ? pendingView : draftView,
    backgroundSubagents: async (id: string) => {
      subagentCalls.push(id);
      if (id !== activeId) return new Promise(() => {});
      return {
        total: 1,
        activeCount: 1,
        attentionCount: 0,
        truncated: false,
        steps: [{ key: "subagent-1", label: "实施子代理 1", status: "running", elapsedMs: 1_000, updateAgeMs: 0 }],
      };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const initialTrigger = dom.window.document.querySelector<HTMLButtonElement>(".subagent-status-trigger")!;
    assert.ok(initialTrigger);
    await act(async () => initialTrigger.click());
    assert.match(dom.window.document.body.textContent || "", /实施子代理 1/);
    const buttonB = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")]
      .find((button) => button.textContent?.includes("Session B"))!;
    await act(async () => { buttonB.click(); await Promise.resolve(); });
    assert.equal(dom.window.document.querySelector(".topbar-title")?.textContent, "Session B");
    assert.equal(dom.window.document.body.textContent?.includes("实施子代理 1"), false);
    assert.equal(dom.window.document.querySelector(".subagent-status-popover"), null);
    assert.equal(subagentCalls.at(-1), secondId);
  } finally {
    restoreApi();
    await act(async () => root.unmount());
  }
});


test("clicking a verified Subagent row opens its read-only transcript without warming or sidebar insertion", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const childId = "cccccccccccccccccccc";
  const childView = createSessionViewFixture();
  childView.session = {
    ...childView.session,
    id: childId,
    sessionId: "child-session",
    name: "review child",
    active: false,
    writable: false,
    messageCount: 2,
  };
  childView.state = {
    ...childView.state,
    sessionId: "child-session",
    sessionName: "review child",
    isStreaming: false,
    messageCount: 2,
  };
  childView.messages = [
    { role: "user", content: "inspect the boundary" },
    { role: "assistant", content: "child findings" },
  ];
  childView.messageTotal = 2;
  childView.turnTotal = 1;
  childView.runtimeStatus = "view-only";
  childView.isActive = false;
  childView.state = { ...childView.state, isStreaming: true };
  childView.isStreaming = true;
  childView.pendingExtensionRequest = {
    id: "child-confirmation",
    method: "confirm",
    title: "Child confirmation",
    piChatSessionId: childId,
  };
  const childReads: Array<[string, string]> = [];
  const warmed: string[] = [];
  const promptTargets: string[] = [];
  const abortedTargets: string[] = [];
  const extensionResponses: string[] = [];
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
      steps: [{
        key: "subagent-1",
        label: "review child",
        status: "running",
        elapsedMs: 1_000,
        updateAgeMs: 0,
        childSessionId: childId,
      }],
    } : { total: 0, activeCount: 0, attentionCount: 0, truncated: false, steps: [] },
    viewBackgroundSubagent: async (parentId: string, targetId: string) => {
      childReads.push([parentId, targetId]);
      return childView;
    },
    warmSession: async (id: string) => {
      warmed.push(id);
      if (id !== activeId) throw new Error("must not warm child");
      return { sessionId: id, state: bootstrap.state, gateMode: "strict" as const };
    },
    prompt: async (_message: string, _images: unknown[], id: string) => {
      promptTargets.push(id);
      return { accepted: true, queued: false };
    },
    abort: async (id: string) => {
      abortedTargets.push(id);
      return { ok: true, isStreaming: false, queuePaused: false };
    },
    respondToExtension: async ({ sessionId }: { sessionId: string }) => {
      extensionResponses.push(sessionId);
      return {};
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".subagent-status-trigger")!;
    await act(async () => trigger.click());
    const row = dom.window.document.querySelector<HTMLButtonElement>('.subagent-status-row[role="treeitem"]')!;
    await act(async () => { row.click(); await Promise.resolve(); await Promise.resolve(); });
    assert.deepEqual(childReads, [[activeId, childId]]);
    assert.equal(dom.window.document.querySelector(".topbar-title")?.textContent, "review child");
    assert.match(dom.window.document.body.textContent || "", /child findings/);
    assert.equal([...dom.window.document.querySelectorAll(".session-item")].some((item) => item.textContent?.includes("review child")), false);
    assert.equal(warmed.length, 0);
    assert.equal(viewed.includes(childId), false, "read-only child navigation never claims SessionControl presence");
    assert.equal(dom.window.document.querySelector(".stop-button"), null, "a streaming child never exposes a child abort action");
    assert.equal(dom.window.document.querySelector(".extension-dialog"), null, "a child confirmation stays read-only");
    assert.deepEqual(abortedTargets, []);
    assert.deepEqual(extensionResponses, []);
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "report to parent");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "report to parent" }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(warmed, [activeId], "a child send may prepare only its verified parent");
    assert.deepEqual(promptTargets, [activeId], "a child send never targets the child JSONL identity");
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.dispatchEvent(new dom.window.MessageEvent("ready", {
        data: JSON.stringify({ lifecycle: "idle", piChatRunEpoch: "replacement-epoch" }),
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(viewed.includes(childId), false, "lifecycle recovery also skips child presence");
    assert.equal([...dom.window.document.querySelectorAll(".session-item")].some((item) => item.textContent?.includes("review child")), false);
    assert.equal(dom.window.document.querySelector('[aria-label*="重命名 review child"], [aria-label*="删除 review child"]'), null);
    assert.equal(textarea.disabled, false, "the child transcript remains read-only while its parent-targeted composer stays editable");
  } finally {
    restoreApi();
    await act(async () => root.unmount());
  }
});


test("nested Subagent addresses rehydrate in order after a child read miss and lifecycle replacement", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api, ApiRequestError } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const childId = "cccccccccccccccccccc";
  const grandchildId = "dddddddddddddddddddd";
  const makeView = (id: string, name: string, answer: string): SessionViewData => {
    const view = createSessionViewFixture();
    view.session = { ...view.session, id, sessionId: `${id}-session`, name, active: false, writable: false, messageCount: 2 };
    view.state = { ...view.state, sessionId: `${id}-session`, sessionName: name, isStreaming: false, messageCount: 2 };
    view.messages = [{ role: "user", content: "inspect" }, { role: "assistant", content: answer }];
    view.messageTotal = 2;
    view.turnTotal = 1;
    view.runtimeStatus = "view-only";
    view.isActive = false;
    return view;
  };
  const childView = makeView(childId, "child", "child answer");
  const grandchildView = makeView(grandchildId, "grandchild", "grandchild answer");
  const mappings = new Set<string>();
  const catalogCalls: string[] = [];
  const childReads: string[] = [];
  let missGrandchildOnce = true;
  const unavailable = () => new ApiRequestError("子代理对话不存在或尚未准备好", 404, "SUBAGENT_VIEW_UNAVAILABLE");
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    backgroundSubagents: async (id: string) => {
      catalogCalls.push(id);
      if (id === activeId) {
        mappings.add(`${activeId}/${childId}`);
        return { total: 1, activeCount: 1, attentionCount: 0, truncated: false, steps: [{ key: "child", label: "child", status: "running", elapsedMs: 1, updateAgeMs: 0, childSessionId: childId }] };
      }
      if (id === childId) {
        if (!mappings.has(`${activeId}/${childId}`)) throw unavailable();
        mappings.add(`${childId}/${grandchildId}`);
        return { total: 1, activeCount: 1, attentionCount: 0, truncated: false, steps: [{ key: "grandchild", label: "grandchild", status: "running", elapsedMs: 1, updateAgeMs: 0, childSessionId: grandchildId }] };
      }
      if (id === grandchildId && mappings.has(`${childId}/${grandchildId}`))
        return { total: 0, activeCount: 0, attentionCount: 0, truncated: false, steps: [] };
      throw unavailable();
    },
    viewBackgroundSubagent: async (parentId: string, targetId: string) => {
      const edge = `${parentId}/${targetId}`;
      childReads.push(edge);
      if (!mappings.has(edge)) throw unavailable();
      if (edge === `${childId}/${grandchildId}` && missGrandchildOnce) {
        missGrandchildOnce = false;
        mappings.delete(edge);
        throw unavailable();
      }
      return targetId === childId ? childView : grandchildView;
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".subagent-status-trigger")!.click());
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>('.subagent-status-row[role="treeitem"]')!.click(); await Promise.resolve(); await Promise.resolve(); });
    assert.equal(dom.window.document.querySelector(".topbar-title")?.textContent, "child");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".subagent-status-trigger")!.click());
    const catalogsBeforeGrandchild = catalogCalls.length;
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>('.subagent-status-row[role="treeitem"]')!.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    assert.equal(dom.window.document.querySelector(".topbar-title")?.textContent, "grandchild");
    assert.match(dom.window.document.body.textContent || "", /grandchild answer/);
    assert.equal(childReads.filter((edge) => edge === `${childId}/${grandchildId}`).length, 2, "404 retries only after ordered catalog hydration");
    const grandchildHydration = catalogCalls.slice(catalogsBeforeGrandchild);
    const parentHydrationIndex = grandchildHydration.indexOf(activeId);
    assert.ok(parentHydrationIndex >= 0);
    assert.equal(grandchildHydration.indexOf(childId, parentHydrationIndex + 1) > parentHydrationIndex, true);

    mappings.clear();
    const callsBeforeReplacement = catalogCalls.length;
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.dispatchEvent(new dom.window.MessageEvent("ready", {
        data: JSON.stringify({ lifecycle: "idle", piChatRunEpoch: "replacement-nested" }),
      }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const replacementHydration = catalogCalls.slice(callsBeforeReplacement);
    const replacementParentIndex = replacementHydration.indexOf(activeId);
    assert.ok(replacementParentIndex >= 0);
    assert.equal(replacementHydration.indexOf(childId, replacementParentIndex + 1) > replacementParentIndex, true);
    assert.equal(mappings.has(`${activeId}/${childId}`), true);
    assert.equal(mappings.has(`${childId}/${grandchildId}`), true);
    assert.equal([...dom.window.document.querySelectorAll(".session-item")].some((item) => /child|grandchild/.test(item.textContent || "")), false);
  } finally {
    restoreApi();
    await act(async () => root.unmount());
  }
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

test("a stale A prompt acknowledgement cannot modify a newer A revisit", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "prompt-b-123456789012";
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "prompt-b",
    name: "Prompt B",
    active: false,
    writable: false,
  };
  const viewA: SessionViewData = {
    ...draftView,
    session: { ...bootstrap.sessions[0], active: true, writable: true },
    state: { ...bootstrap.state, isStreaming: false },
    runtimeStatus: "active",
    isActive: true,
    queue: [],
    queuePaused: false,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: { ...bootstrap.state, sessionId: "prompt-b" },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let resolvePrompt!: (result: {
    accepted: true;
    queued: true;
    id: string;
    queue: Array<{
      id: string;
      message: string;
      imageCount: number;
      createdAt: number;
    }>;
  }) => void;
  const pendingPrompt = new Promise<{
    accepted: true;
    queued: true;
    id: string;
    queue: Array<{
      id: string;
      message: string;
      imageCount: number;
      createdAt: number;
    }>;
  }>((resolve) => {
    resolvePrompt = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], summaryB],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === secondId ? viewB : viewA),
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
      )?.set?.call(textarea, "old prompt");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "old prompt",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => sessionButton("Prompt B").click());
    await act(async () => sessionButton("Active").click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(dom.window.document.querySelector(".prompt-queue"), null);
    await act(async () => {
      resolvePrompt({
        accepted: true,
        queued: true,
        id: "old-queue",
        queue: [
          {
            id: "old-queue",
            message: "old prompt",
            imageCount: 0,
            createdAt: 1,
          },
        ],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelector(".prompt-queue"),
      null,
      "a pre-navigation A acknowledgement cannot install its queue in later A",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a definite A prompt failure stays scoped across navigation and restores on return", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api, ApiRequestError } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "prompt-failure-b-12345";
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "prompt-failure-b",
    name: "Prompt failure B",
    active: false,
    writable: false,
  };
  const viewA: SessionViewData = {
    ...draftView,
    session: { ...bootstrap.sessions[0], active: true, writable: true },
    state: { ...bootstrap.state, isStreaming: false },
    runtimeStatus: "active",
    isActive: true,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: { ...bootstrap.state, sessionId: "prompt-failure-b" },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let rejectPrompt!: (cause: Error) => void;
  const pendingPrompt = new Promise<never>((_resolve, reject) => {
    rejectPrompt = reject;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], summaryB],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === secondId ? viewB : viewA),
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
      )?.set?.call(textarea, "old failed prompt");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "old failed prompt",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => sessionButton("Prompt failure B").click());
    await act(async () => {
      rejectPrompt(new ApiRequestError("old prompt rejected", 409, "PROMPT_REJECTED"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.doesNotMatch(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /old prompt rejected/,
      "A's rejection cannot paint an error into B",
    );
    assert.notEqual(
      dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")?.value,
      "old failed prompt",
      "A's rejected draft cannot overwrite B's composer",
    );
    await act(async () => {
      sessionButton("Active").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")?.value,
      "old failed prompt",
      "returning to A restores the exact rejected submission for retry",
    );
    assert.equal(dom.window.document.querySelector(".prompt-queue"), null);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale A extension failure cannot reopen a newer A pane", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldAId = "extension-a-123456789";
  const secondId = "extension-b-123456789";
  const summaryA = {
    ...bootstrap.sessions[0],
    id: coldAId,
    sessionId: "extension-a",
    name: "Extension A",
    active: false,
    writable: false,
  };
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "extension-b",
    name: "Extension B",
    active: false,
    writable: false,
  };
  const request = {
    type: "extension_ui_request",
    id: "stale-extension",
    method: "confirm",
    title: "Old confirmation",
    piChatSessionId: coldAId,
  } as const;
  const viewA: SessionViewData = {
    ...draftView,
    session: summaryA,
    state: { ...bootstrap.state, sessionId: "extension-a" },
    runtimeStatus: "view-only",
    isActive: false,
    pendingExtensionRequest: request,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: { ...bootstrap.state, sessionId: "extension-b" },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let rejectResponse!: (cause: Error) => void;
  const pendingResponse = new Promise<never>((_resolve, reject) => {
    rejectResponse = reject;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], summaryA, summaryB],
      sessionsTotal: 3,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) =>
      id === coldAId ? viewA : id === secondId ? viewB : draftView,
    respondToExtension: async () => pendingResponse,
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
    await act(async () => sessionButton("Extension A").click());
    assert.ok(dom.window.document.querySelector(".extension-dialog"));
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".extension-dialog button",
        ),
      ]
        .find((button) => button.textContent === "确定")!
        .click(),
    );
    await act(async () => sessionButton("Extension B").click());
    await act(async () => sessionButton("Extension A").click());
    assert.equal(
      dom.window.document.querySelector(".extension-dialog"),
      null,
      "the newer A cache projection has no pending confirmation",
    );
    await act(async () => {
      rejectResponse(new Error("response lost"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelector(".extension-dialog"),
      null,
      "the old A response cannot restore its confirmation after A → B → A",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale A reconcile rejection cannot retry or show an error on a newer A pane", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "reconcile-b-123456789";
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "reconcile-b",
    name: "Reconcile B",
    active: false,
    writable: false,
  };
  const streamingA: SessionViewData = {
    ...draftView,
    session: { ...bootstrap.sessions[0], active: true, writable: true },
    state: { ...bootstrap.state, isStreaming: true },
    runtimeStatus: "active",
    isActive: true,
    isStreaming: true,
    reconcilePending: true,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: { ...bootstrap.state, sessionId: "reconcile-b" },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let rejectOldReconcile!: (cause: Error) => void;
  const pendingOldReconcile = new Promise<SessionViewData>(
    (_resolve, reject) => {
      rejectOldReconcile = reject;
    },
  );
  let activeReads = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], summaryB],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => {
      if (id === secondId) return viewB;
      activeReads += 1;
      return activeReads === 2 ? pendingOldReconcile : streamingA;
    },
    prompt: async () => ({ accepted: true, queued: false, isStreaming: true }),
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
      )?.set?.call(textarea, "start reconcile");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "start reconcile",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
    });
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => sessionButton("Reconcile B").click());
    await act(async () => sessionButton("Active").click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 4_100)));
    assert.equal(
      activeReads,
      2,
      "the acknowledged A prompt starts one reconcile request after the initial read",
    );
    await act(async () => sessionButton("Reconcile B").click());
    await act(async () => sessionButton("Active").click());
    await act(async () => {
      rejectOldReconcile(new Error("stale reconcile failed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.doesNotMatch(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /stale reconcile failed/,
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
    assert.equal(
      activeReads,
      3,
      "the stale rejection must not schedule another reconcile retry",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale Gate auto-allow result cannot show feedback after A → B → A", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "gate-feedback-b-12345";
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "gate-feedback-b",
    name: "Gate feedback B",
    active: false,
    writable: false,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: { ...bootstrap.state, sessionId: "gate-feedback-b" },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let resolveResponse!: () => void;
  const pendingResponse = new Promise<void>((resolve) => {
    resolveResponse = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], summaryB],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === secondId ? viewB : draftView),
    respondToExtension: async () => pendingResponse,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_gate_mode_changed",
        piChatSessionId: activeId,
        mode: "open",
      }),
    );
    await act(async () =>
      source.emitPi({
        type: "extension_ui_request",
        piChatSessionId: activeId,
        id: "auto-allow-stale",
        method: "select",
        title: "Pi Chat Gate: bash\necho stale",
        options: ["allow", "block"],
      }),
    );
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => sessionButton("Gate feedback B").click());
    await act(async () => sessionButton("Active").click());
    await act(async () => {
      resolveResponse();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.doesNotMatch(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /已按放行模式自动允许/,
      "the old A success toast cannot appear on a newer A pane",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale Gate auto-allow failure cannot show an error after A → B", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "gate-feedback-failure-b";
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "gate-feedback-failure-b",
    name: "Gate failure B",
    active: false,
    writable: false,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: { ...bootstrap.state, sessionId: "gate-feedback-failure-b" },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let rejectResponse!: (cause: Error) => void;
  const pendingResponse = new Promise<never>((_resolve, reject) => {
    rejectResponse = reject;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], summaryB],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === secondId ? viewB : draftView),
    respondToExtension: async () => pendingResponse,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_gate_mode_changed",
        piChatSessionId: activeId,
        mode: "open",
      }),
    );
    await act(async () =>
      source.emitPi({
        type: "extension_ui_request",
        piChatSessionId: activeId,
        id: "auto-allow-stale-failure",
        method: "select",
        title: "Pi Chat Gate: bash\necho stale",
        options: ["allow", "block"],
      }),
    );
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ]
        .find((button) => button.textContent?.includes("Gate failure B"))!
        .click(),
    );
    await act(async () => {
      rejectResponse(new Error("stale auto-allow failed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.doesNotMatch(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /stale auto-allow failed/,
      "the old A failure toast cannot appear on B",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale A takeover cannot overwrite a newer A revisit or control SSE", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "takeover-b-1234567890";
  const summaryA = {
    ...bootstrap.sessions[0],
    controlOwner: "old-owner",
    controlledByThisWindow: false,
  };
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "takeover-b",
    name: "Takeover B",
    active: false,
    writable: false,
  };
  const revisitedA: SessionViewData = {
    ...draftView,
    session: {
      ...summaryA,
      controlOwner: "new-owner",
      controlledByThisWindow: false,
    },
    state: { ...bootstrap.state, isStreaming: false },
    isActive: true,
    runtimeStatus: "active",
    controlOwner: "new-owner",
    controlledByThisWindow: false,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: summaryB,
    state: { ...bootstrap.state, sessionId: "takeover-b" },
    isActive: false,
    runtimeStatus: "view-only",
  };
  let resolveTakeover!: (value: {
    controlOwner: string;
    controlledByThisWindow: true;
  }) => void;
  const pendingTakeover = new Promise<{
    controlOwner: string;
    controlledByThisWindow: true;
  }>((resolve) => {
    resolveTakeover = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [summaryA, summaryB],
      sessionsTotal: 2,
      controlOwner: "old-owner",
      controlledByThisWindow: false,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === secondId ? viewB : revisitedA),
    takeSessionControl: async () => pendingTakeover,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(
      async () => new Promise((resolve) => dom.window.setTimeout(resolve, 450)),
    );
    const takeover = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-control-banner button",
      ),
    ].find((button) => button.textContent?.includes("接管控制"));
    assert.ok(takeover, "the initially foreign A pane exposes takeover");
    await act(async () => {
      takeover.click();
      await Promise.resolve();
    });
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => sessionButton("Takeover B").click());
    await act(async () => sessionButton("Active").click());
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "pi_chat_session_control_changed",
        sessionId: activeId,
        controlOwner: "newer-sse-owner",
        controlledByThisWindow: false,
      });
      await Promise.resolve();
    });
    await act(async () => {
      resolveTakeover({
        controlOwner: "stale-takeover",
        controlledByThisWindow: true,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(
      async () => new Promise((resolve) => dom.window.setTimeout(resolve, 450)),
    );
    assert.ok(
      dom.window.document.querySelector(".session-control-banner"),
      "a stale pre-navigation takeover cannot claim the revisited A pane",
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /另一窗口中控制/,
      "the newer same-Session control SSE remains authoritative",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("late model and thinking responses from A do not overwrite the Session B composer", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "11111111111111111111";
  const modelA = {
    id: "model",
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
  const viewB: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: secondId,
      sessionId: "second",
      name: "Session B",
      active: false,
      messageCount: 1,
    },
    state: {
      ...draftView.state,
      model: modelB,
      thinkingLevel: "low",
      sessionId: "second",
    },
  };
  let resolveModel!: (value: { model: typeof modelA; pending: false }) => void;
  let resolveThinking!: (value: { level: "high"; pending: false }) => void;
  const pendingModel = new Promise<{ model: typeof modelA; pending: false }>(
    (resolve) => {
      resolveModel = resolve;
    },
  );
  const pendingThinking = new Promise<{ level: "high"; pending: false }>(
    (resolve) => {
      resolveThinking = resolve;
    },
  );
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, model: modelA },
      models: [modelA, modelB],
      sessions: [
        ...bootstrap.sessions,
        {
          ...bootstrap.sessions[0],
          id: secondId,
          sessionId: "second",
          name: "Session B",
          active: false,
          updatedAt: 2,
        },
      ],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) =>
      id === secondId
        ? viewB
        : {
            ...draftView,
            session: { ...draftView.session, id: activeId, name: "Active" },
            state: {
              ...draftView.state,
              model: modelA,
              thinkingLevel: "medium",
            },
          },
    setModel: async () => pendingModel,
    setThinking: async () => pendingThinking,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const visitB = async () => {
    const button = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((candidate) => candidate.textContent?.includes("Session B"));
    assert.ok(button);
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(
      dom.window.document.querySelector(
        ".composer-model-select .compact-select-trigger",
      )?.textContent || "",
      /Model B/,
    );
  };
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(
          ".composer-model-select .compact-select-trigger",
        )!
        .click(),
    );
    const modelOption = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        ".composer-model-select .compact-select-option",
      ),
    ].find((option) => option.textContent?.includes("Model B"));
    assert.ok(modelOption);
    await act(async () => modelOption.click());
    await visitB();
    await act(async () => resolveModel({ model: modelA, pending: false }));
    assert.match(
      dom.window.document.querySelector(
        ".composer-model-select .compact-select-trigger",
      )?.textContent || "",
      /Model B/,
    );

    // Switch back to A only long enough to initiate the request, then B again.
    const activeButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((candidate) => candidate.textContent?.includes("Active"));
    assert.ok(activeButton);
    await act(async () => {
      activeButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(
          ".thinking-control .compact-select-trigger",
        )!
        .click(),
    );
    const highOnA = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        ".thinking-control .compact-select-option",
      ),
    ].find((option) => option.textContent?.trim() === "high");
    assert.ok(highOnA);
    await act(async () => highOnA.click());
    await visitB();
    await act(async () => resolveThinking({ level: "high", pending: false }));
    assert.match(
      dom.window.document.querySelector(
        ".thinking-control .compact-select-trigger",
      )?.textContent || "",
      /low/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an abort result confirming settlement clears Stop without waiting for SSE", async () => {
  const { dom } = installDom();
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
    markSessionViewed: async () => ({ viewing: activeId }),
    abort: async () => ({
      ok: true,
      abortPending: false,
      isStreaming: false,
      queuePaused: false,
    }),
    viewSession: async () => ({
      ...draftView,
      session: bootstrap.sessions[0],
      state: { ...draftView.state, isStreaming: false },
      isStreaming: false,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".stop-button")!
        .click(),
    );
    assert.equal(
      dom.window.document.querySelector(".stop-button"),
      null,
      "an authoritative non-streaming abort result must remove Stop immediately",
    );
    assert.ok(dom.window.document.querySelector(".send-button"));
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a pending abort stays in stopping state until agent settlement", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      sessions: [
        {
          ...bootstrap.sessions[0],
          running: true,
          activity: {
            execution: "running" as const,
            awaitingConfirmation: false,
          },
        },
      ],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    abort: async () => ({
      ok: true,
      abortPending: true,
      isStreaming: true,
      queuePaused: false,
    }),
    viewSession: async () => ({ ...draftView, session: bootstrap.sessions[0] }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(dom.window.document.querySelector(".session-status.is-running"));
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".stop-button")!
        .click(),
    );
    assert.match(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /正在结束当前操作/,
    );
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(".stop-button")
        ?.disabled,
      true,
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({ type: "agent_settled", piChatSessionId: activeId }),
    );
    assert.equal(
      dom.window.document.querySelector(".session-status.is-running"),
      null,
    );
    assert.doesNotMatch(
      dom.window.document.querySelector(".app-toast")?.textContent || "",
      /正在结束当前操作/,
    );
    assert.equal(
      dom.window.document.querySelector(".stop-button"),
      null,
      "a terminal SSE must remove Stop rather than leave a stale abort control",
    );
    assert.ok(
      dom.window.document.querySelector(".send-button"),
      "the settled composer returns to its normal Send action",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("late stop and queue actions from A do not overwrite Session B", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "22222222222222222222";
  const queuedA = {
    id: "queue-a",
    message: "queued A",
    imageCount: 0,
    createdAt: 1,
  };
  const queuedB = {
    id: "queue-b",
    message: "queued B",
    imageCount: 0,
    createdAt: 2,
  };
  const sessionB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "second",
    name: "Session B",
    active: false,
    updatedAt: 2,
  };
  const viewA: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: activeId,
      name: "Active",
      active: true,
      messageCount: 1,
    },
    state: { ...draftView.state, isStreaming: true, sessionId: "active" },
    queue: [queuedA],
    queuePaused: true,
    isStreaming: true,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: { ...draftView.session, ...sessionB },
    state: { ...draftView.state, isStreaming: true, sessionId: "second" },
    queue: [queuedB],
    queuePaused: true,
    isStreaming: true,
  };
  let resolveAbort!: (value: {
    ok: boolean;
    isStreaming: false;
    queuePaused: true;
  }) => void;
  let resolveCancel!: (value: {
    queue: (typeof queuedA)[];
    paused: true;
  }) => void;
  let resolveResume!: (value: {
    queue: typeof viewA.queue;
    paused: false;
  }) => void;
  const pendingAbort = new Promise<{
    ok: boolean;
    isStreaming: false;
    queuePaused: true;
  }>((resolve) => {
    resolveAbort = resolve;
  });
  const pendingCancel = new Promise<{
    queue: (typeof queuedA)[];
    paused: true;
  }>((resolve) => {
    resolveCancel = resolve;
  });
  const pendingResume = new Promise<{
    queue: typeof viewA.queue;
    paused: false;
  }>((resolve) => {
    resolveResume = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      queue: [queuedA],
      queuePaused: true,
      sessions: [...bootstrap.sessions, sessionB],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => (id === secondId ? viewB : viewA),
    abort: async () => pendingAbort,
    cancelQueued: async () => pendingCancel,
    resumeQueue: async () => pendingResume,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const visitB = async () => {
    const button = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((candidate) => candidate.textContent?.includes("Session B"));
    assert.ok(button);
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(
      dom.window.document.querySelector(".prompt-queue")?.textContent || "",
      /queued B/,
    );
  };
  const visitA = async () => {
    const button = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((candidate) => candidate.textContent?.includes("Active"));
    assert.ok(button);
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".stop-button")!
        .click(),
    );
    await visitB();
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(".stop-button")
        ?.disabled,
      false,
      "A pending abort must not disable Session B's independent Stop control",
    );
    await act(async () =>
      resolveAbort({ ok: true, isStreaming: false, queuePaused: true }),
    );
    assert.ok(
      dom.window.document.querySelector(".stop-button"),
      "B remains streaming after A abort resolves",
    );

    await visitA();
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".prompt-queue article button")!
        .click(),
    );
    await visitB();
    await act(async () => resolveCancel({ queue: [], paused: true }));
    assert.match(
      dom.window.document.querySelector(".prompt-queue")?.textContent || "",
      /queued B/,
    );

    await visitA();
    assert.equal(
      dom.window.document.querySelector(".prompt-queue"),
      null,
      "the completed A cancellation remains projected while its response is stale to B",
    );
    await act(async () => {
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        queue: [queuedA],
        paused: true,
      });
    });
    assert.equal(
      dom.window.document.querySelector(".prompt-queue"),
      null,
      "a stale queue frame cannot resurrect A's cancelled identity",
    );
    // Resume remains Session-scoped; start it before navigation using a distinct
    // surviving item rather than the already-cancelled tombstoned identity.
    const resumedA = { ...queuedA, id: `${queuedA.id}-resume`, message: "queued A resume" };
    await act(async () => {
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        queue: [resumedA],
        paused: true,
      });
    });
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".prompt-queue header button")!
        .click(),
    );
    await visitB();
    await act(async () => resolveResume({ queue: [resumedA], paused: false }));
    assert.match(
      dom.window.document.querySelector(".prompt-queue")?.textContent || "",
      /queued B/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
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
