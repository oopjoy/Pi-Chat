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
  const summaryB = { ...bootstrap.sessions[0], id: secondId, name: "Session B", cwd: "C:/work-b", active: false };
  const pendingView = new Promise<SessionViewData>(() => {});
  const subagentCalls: string[] = [];
  const workspaceCalls: string[] = [];
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, sessions: [bootstrap.sessions[0], summaryB], sessionsTotal: 2 }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => id === secondId ? pendingView : draftView,
    workspaceFiles: async (id: string) => {
      workspaceCalls.push(id);
      return { files: [], truncated: false };
    },
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
    const groupB = [...dom.window.document.querySelectorAll<HTMLElement>(".session-directory")]
      .find((group) => group.getAttribute("aria-label")?.includes("work-b"));
    const groupToggle = groupB?.querySelector<HTMLButtonElement>(".session-directory-toggle");
    if (groupToggle?.getAttribute("aria-expanded") === "false")
      await act(async () => groupToggle.click());
    const buttonB = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")]
      .find((button) => button.textContent?.includes("Session B"))!;
    assert.ok(buttonB);
    await act(async () => { buttonB.click(); await Promise.resolve(); });
    assert.equal(dom.window.document.querySelector(".topbar-title")?.textContent, "Session B");
    assert.equal(dom.window.document.body.textContent?.includes("实施子代理 1"), false);
    assert.equal(dom.window.document.querySelector(".subagent-status-popover"), null);
    assert.equal(subagentCalls.at(-1), secondId);
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".diff-sidebar-toggle")!.click();
      await Promise.resolve();
    });
    assert.equal(workspaceCalls.at(-1), secondId);
    assert.equal(dom.window.document.querySelector(".workspace-files-toolbar strong")?.getAttribute("title"), "C:/work-b");
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
    model: {
      id: "child-model",
      name: "Child model",
      provider: "child-provider",
      input: ["image"],
    },
    thinkingLevel: "high",
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
  const childReads: Array<[string, string]> = [];
  const warmed: string[] = [];
  const promptTargets: string[] = [];
  const abortedTargets: string[] = [];
  const extensionResponses: string[] = [];
  const parentSettingChanges: string[] = [];
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
    viewSession: async (id: string) => {
      assert.equal(id, activeId);
      return parentView;
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
    setModel: async (_provider: string, _modelId: string, id: string) => {
      parentSettingChanges.push(`model:${id}`);
      return { model: bootstrap.state.model, pending: false };
    },
    setThinking: async (_level: string, id: string) => {
      parentSettingChanges.push(`thinking:${id}`);
      return { level: "medium", pending: false };
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
    assert.deepEqual(
      [...dom.window.document.querySelectorAll(".topbar-breadcrumb-link, .topbar-breadcrumb-current")]
        .map((item) => item.textContent),
      ["Active", "review child"],
      "a child transcript replaces the ordinary title with its verified parent trail",
    );
    assert.equal(dom.window.document.querySelector(".topbar-breadcrumb-current")?.textContent, "review child");
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
    assert.deepEqual(parentSettingChanges, [], "a child transcript's historical settings never reconfigure its parent");
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
    const attachment = dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!;
    await act(async () => attachment.click());
    assert.match(
      dom.window.document.querySelector(".attachment-menu")?.textContent || "",
      /是否支持由上游模型返回结果/,
      "child historical image capability is advisory and never blocks a parent-targeted attachment",
    );
    const parentBreadcrumb = dom.window.document.querySelector<HTMLButtonElement>(
      '.topbar-breadcrumb-link[aria-label="返回父对话：Active"]',
    );
    assert.ok(parentBreadcrumb, "the verified ordinary parent is navigable from the child trail");
    const childReadsBeforeParentNavigation = childReads.length;
    await act(async () => {
      parentBreadcrumb.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(dom.window.document.querySelector(".topbar-title")?.textContent, "Active");
    assert.equal(dom.window.document.querySelector(".topbar-breadcrumb"), null);
    assert.equal(childReads.length, childReadsBeforeParentNavigation, "returning to a normal parent never rereads or activates the child");
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
  const warmed: string[] = [];
  const promptTargets: string[] = [];
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
    warmSession: async (id: string) => {
      warmed.push(id);
      if (id !== activeId) throw new Error("a nested child must never be warmed");
      return { sessionId: id, state: bootstrap.state, gateMode: "strict" as const };
    },
    prompt: async (_message: string, _images: unknown[], id: string) => {
      promptTargets.push(id);
      return { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".subagent-status-trigger")!.click());
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>('.subagent-status-row[role="treeitem"]')!.click(); await Promise.resolve(); await Promise.resolve(); });
    assert.deepEqual(
      [...dom.window.document.querySelectorAll(".topbar-breadcrumb-link, .topbar-breadcrumb-current")]
        .map((item) => item.textContent),
      ["Active", "child"],
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".subagent-status-trigger")!.click());
    const catalogsBeforeGrandchild = catalogCalls.length;
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>('.subagent-status-row[role="treeitem"]')!.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    assert.deepEqual(
      [...dom.window.document.querySelectorAll(".topbar-breadcrumb-link, .topbar-breadcrumb-current")]
        .map((item) => item.textContent),
      ["Active", "child", "grandchild"],
      "nested child navigation keeps every verified parent in order",
    );
    assert.match(dom.window.document.body.textContent || "", /grandchild answer/);
    assert.equal(childReads.filter((edge) => edge === `${childId}/${grandchildId}`).length, 2, "404 retries only after ordered catalog hydration");
    const grandchildHydration = catalogCalls.slice(catalogsBeforeGrandchild);
    const parentHydrationIndex = grandchildHydration.indexOf(activeId);
    assert.ok(parentHydrationIndex >= 0);
    assert.equal(grandchildHydration.indexOf(childId, parentHydrationIndex + 1) > parentHydrationIndex, true);
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "report through ordinary parent");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "report through ordinary parent" }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(warmed, [activeId], "nested sends warm only the verified ordinary ancestor");
    assert.deepEqual(promptTargets, [activeId], "nested sends never target an intermediate child JSONL");

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
    const childBreadcrumb = dom.window.document.querySelector<HTMLButtonElement>(
      '.topbar-breadcrumb-link[aria-label="返回父对话：child"]',
    );
    assert.ok(childBreadcrumb, "a nested trail exposes its intermediate verified parent");
    await act(async () => {
      childBreadcrumb.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(
      [...dom.window.document.querySelectorAll(".topbar-breadcrumb-link, .topbar-breadcrumb-current")]
        .map((item) => item.textContent),
      ["Active", "child"],
      "an intermediate breadcrumb returns to that read-only parent transcript",
    );
    assert.match(dom.window.document.body.textContent || "", /child answer/);
    assert.deepEqual(warmed, [activeId], "breadcrumb return never warms an intermediate child Runtime");
  } finally {
    restoreApi();
    await act(async () => root.unmount());
  }
});
