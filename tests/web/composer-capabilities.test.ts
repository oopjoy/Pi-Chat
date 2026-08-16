import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { act, createElement, StrictMode } from "react";
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


test("a transient empty model inventory never leaks the Composer's internal model key", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const selected = {
    provider: "xwill",
    id: "gpt-5.6-sol",
    name: "gpt-5.6-sol",
    input: ["text"],
    reasoning: true,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, model: selected },
      models: [],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".composer-model-select .compact-select-trigger",
    )!;
    assert.equal(trigger.textContent?.trim(), "gpt-5.6-sol");
    assert.equal(trigger.parentElement?.title, "模型");
    assert.doesNotMatch(trigger.textContent || "", /xwill|\u0000/);
    assert.equal(
      trigger.disabled,
      true,
      "selection stays disabled until its inventory has arrived",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("slash suggestions survive an empty command inventory refresh", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const slashCommands = [
    { name: "gate", description: "Gate 模式", source: "extension" },
    { name: "compact", description: "压缩上下文", source: "builtin" },
  ];
  let requests = 0;
  Object.assign(api, {
    bootstrap: async () => {
      requests += 1;
      // A busy/starting Primary legitimately returns an empty inventory on a
      // later refresh; it must not erase already-working slash completions.
      return requests === 1
        ? { ...bootstrap, commands: slashCommands }
        : { ...bootstrap, commands: [], models: [] };
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    const typeSlash = () =>
      act(async () => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLTextAreaElement.prototype,
          "value",
        )?.set?.call(textarea, "/");
        textarea.dispatchEvent(
          new dom.window.InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: "/",
          }),
        );
      });
    await typeSlash();
    assert.ok(
      dom.window.document.querySelectorAll(".command-suggestions button").length >= 2,
      "initial commands render slash suggestions",
    );
    // A refresh whose command inventory is empty must keep the last confirmed
    // completions instead of wiping them (the pre-fix `??` treated [] as
    // authoritative). A newer Primary generation triggers the background refresh.
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_primary_runtime_status",
        primaryRuntime: {
          status: "ready",
          generation: 1,
          model: bootstrap.state.model,
          sessionId: activeId,
        },
      }),
    );
    assert.ok(requests >= 2, "a ready status refresh fetched the inventory");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "/comp");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "/comp",
        }),
      );
    });
    assert.ok(
      dom.window.document.querySelectorAll(".command-suggestions button").length >= 1,
      "slash suggestions survive an empty command inventory refresh",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("slash suggestions return after a starting bootstrap refreshes to ready", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const slashCommands = [
    { name: "gate", description: "Gate 模式", source: "extension" },
  ];
  let requests = 0;
  Object.assign(api, {
    bootstrap: async () => {
      requests += 1;
      if (requests === 1)
        return {
          ...bootstrap,
          commands: [],
          primaryRuntime: { status: "starting" as const, generation: 1 },
        };
      return {
        ...bootstrap,
        commands: slashCommands,
        primaryRuntime: { status: "ready" as const, generation: 1 },
      };
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    assert.equal(textarea.disabled, false, "starting Primary keeps the editor available");
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            primaryRuntime: { status: "ready", generation: 1 },
          }),
        }),
      ),
    );
    assert.equal(textarea.disabled, false, "ready unlocks the composer");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "/");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "/",
        }),
      );
    });
    assert.ok(
      dom.window.document.querySelectorAll(".command-suggestions button").length >= 1,
      "the refreshed ready inventory restores slash suggestions",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("cold and capability-only hot panes retain the confirmed slash catalog", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "abcdef0123456789abcd";
  const hotId = "fedcba9876543210abcd";
  const slashCommands = [
    { name: "gate", description: "Gate 模式", source: "extension" as const },
    { name: "compact", description: "压缩上下文", source: "builtin" as const },
  ];
  const cold: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: coldId,
      sessionId: "cold-commands",
      name: "Cold commands",
      messageCount: 1,
      active: false,
      writable: true,
    },
    state: {
      ...draftView.state,
      sessionId: "cold-commands",
      model: {
        provider: "archive",
        id: "cold-only-model",
        name: "Cold-only model",
        input: ["text"],
      },
    },
    isActive: false,
    runtimeStatus: "view-only",
    commands: [],
  };
  const hot: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: hotId,
      sessionId: "hot-commands",
      name: "Hot commands",
      messageCount: 1,
      active: false,
      writable: true,
    },
    state: { ...draftView.state, sessionId: "hot-commands" },
    isActive: true,
    runtimeStatus: "active",
    // A lightweight hot-memory view intentionally has not probed get_commands.
    commands: undefined,
  };
  let warmCalls = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      commands: slashCommands,
      sessions: [...bootstrap.sessions, cold.session, hot.session],
      sessionsTotal: 3,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => {
      if (id === coldId) return cold;
      if (id === hotId) return hot;
      throw new Error(`unexpected view ${id}`);
    },
    warmSession: async () => {
      warmCalls += 1;
      throw new Error("slash completion must not warm a Runtime");
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const select = async (name: string) => {
    const row = [...dom.window.document.querySelectorAll<HTMLElement>(".session-row")]
      .find((candidate) => candidate.textContent?.includes(name));
    assert.ok(row, `missing ${name} row`);
    await act(async () => {
      row.querySelector<HTMLButtonElement>(".session-item")?.click();
      await Promise.resolve();
    });
  };
  const typeSlash = async () => {
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "/");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "/",
        }),
      );
    });
  };
  const clearInput = async () => {
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", { bubbles: true }),
      );
    });
  };
  try {
    await act(async () => root.render(createElement(App)));
    await select("Cold commands");
    const coldTextarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    assert.equal(
      coldTextarea.disabled,
      false,
      "a cold history model mismatch must not lock ordinary text input",
    );
    assert.match(coldTextarea.placeholder, /输入消息/);
    assert.doesNotMatch(coldTextarea.placeholder, /状态同步|完成后才能输入/);
    await typeSlash();
    assert.equal(
      dom.window.document.querySelectorAll(".command-suggestions button").length,
      slashCommands.length,
      "JSONL-only cold navigation retains the confirmed command catalog",
    );
    await clearInput();
    await select("Hot commands");
    await typeSlash();
    assert.equal(
      dom.window.document.querySelectorAll(".command-suggestions button").length,
      slashCommands.length,
      "a hot-memory view without get_commands uses the same confirmed catalog",
    );
    assert.equal(warmCalls, 0);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("the initial ready frame releases controls when Primary became ready after bootstrap", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const cached = {
    provider: "cached",
    id: "ready-between-bootstrap-and-sse",
    name: "Ready between bootstrap and SSE",
    reasoning: true,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      models: [cached],
      primaryRuntime: { status: "starting" as const, generation: 1 },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const model = () =>
      dom.window.document.querySelector<HTMLButtonElement>(
        ".composer-model-select .compact-select-trigger",
      )!;
    assert.equal(model().disabled, false, "bootstrap starting keeps cached settings selectable");
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-ready-snapshot",
            workspaceEpoch: "epoch-ready-snapshot",
            primaryRuntime: { status: "ready", generation: 1, model: cached },
          }),
        }),
      ),
    );
    assert.equal(
      model().disabled,
      false,
      "ready carries the missed Primary capability transition without requiring another bootstrap",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("same-generation initial ready adopts its model without waiting for Bootstrap refresh", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const adoptedModel = {
    provider: "test",
    id: "adopted-ready",
    name: "Adopted ready",
    input: ["text", "image"],
    reasoning: true,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, model: null },
      models: [],
      primaryRuntime: { status: "starting" as const, generation: 9 },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            primaryRuntime: {
              status: "ready",
              generation: 9,
              model: adoptedModel,
              thinkingLevel: "high",
              sessionId: activeId,
            },
          }),
        }),
      ),
    );
    const input = dom.window.document.querySelector<HTMLTextAreaElement>(
      ".composer textarea",
    )!;
    assert.equal(input.disabled, false);
    const modelTrigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".composer-model-select .compact-select-trigger",
    )!;
    assert.match(modelTrigger.textContent || "", /Adopted ready/);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("Primary ready preserves a staged draft model and keeps its capability unconfirmed", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let newSessionCalls = 0;
  const runtimeModel = {
    provider: "test",
    id: "runtime-model",
    name: "Runtime model",
    input: ["text", "image"],
    reasoning: true,
  };
  const stagedModel = {
    provider: "test",
    id: "staged-model",
    name: "Staged model",
    input: ["text"],
    reasoning: true,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      activeSessionId: "",
      activeSessionIds: [],
      sessions: [],
      state: { ...bootstrap.state, model: runtimeModel },
      models: [runtimeModel, stagedModel],
      primaryRuntime: {
        status: "ready" as const,
        generation: 11,
        model: runtimeModel,
        sessionId: activeId,
      },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: "" }),
    newSession: async () => {
      newSessionCalls += 1;
      throw new Error("unconfirmed New-draft image must not reach newSession");
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".composer-model-select .compact-select-trigger",
    )!;
    await act(async () => trigger.click());
    const stagedOption = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".composer-model-select [role='option']",
    )].find((option) => option.textContent?.includes("Staged model"))!;
    await act(async () => stagedOption.click());
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            primaryRuntime: {
              status: "ready",
              generation: 12,
              model: runtimeModel,
              sessionId: activeId,
            },
          }),
        }),
      ),
    );
    assert.match(trigger.textContent || "", /Staged model/);
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(".composer textarea")!
        .disabled,
      false,
      "Runtime model A cannot confirm staged model B images, but text drafting remains available",
    );
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!
        .disabled,
      false,
      "a ready Composer may stage attachments before capability-sensitive submission",
    );
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!.click(),
    );
    const imageMenuItem = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".attachment-menu [role='menuitem']",
    )].find((item) => item.textContent?.includes("图片"))!;
    assert.match(
      imageMenuItem.textContent || "",
      /发送前等待模型能力同步/,
      "a New draft never claims that its atomic create call will confirm staged image capability",
    );
    Object.assign(globalThis, { FileReader: dom.window.FileReader });
    const fileInput = dom.window.document.querySelector<HTMLInputElement>(
      "input[type='file']",
    )!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [
        new dom.window.File(["image"], "pending-new.png", {
          type: "image/png",
        }),
      ],
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      const deadline = Date.now() + 250;
      while (
        !dom.window.document.querySelector(".image-preview") &&
        Date.now() < deadline
      )
        await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
    });
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      ".composer textarea",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "new draft image");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "new draft image",
        }),
      );
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
    });
    assert.match(
      dom.window.document.querySelector(".app-toast.error")?.textContent || "",
      /模型图片能力尚未确认/,
    );
    assert.ok(
      dom.window.document.querySelector(".image-preview"),
      "the rejected New-draft image remains staged",
    );
    assert.equal(newSessionCalls, 0);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("Primary startup keeps cached model choices selectable", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const cached = {
    provider: "cached",
    id: "ready-later",
    name: "Ready later",
    reasoning: true,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      models: [cached],
      primaryRuntime: { status: "starting" as const, generation: 1 },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const model = dom.window.document.querySelector<HTMLButtonElement>(
      ".composer-model-select .compact-select-trigger",
    )!;
    assert.equal(
      model.disabled,
      false,
      "cached model choices stage the next prompt while Primary prepares",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("Primary startup keeps editor and attachments available while capability is pending", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      primaryRuntime: { status: "starting" as const, generation: 1 },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const input = dom.window.document.querySelector<HTMLTextAreaElement>(
      ".composer textarea",
    )!;
    assert.equal(input.disabled, false, "text remains editable while Runtime prepares");
    assert.doesNotMatch(input.placeholder, /Runtime ready 后才能输入/);
    const attachment = dom.window.document.querySelector<HTMLButtonElement>(
      ".attachment-button",
    )!;
    assert.equal(attachment.disabled, false, "attachments remain editable while Runtime prepares");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a legacy ready without adopted capability allows text while image capability waits for refresh", async () => {
  const { dom, FakeEventSource } = installDom();
  Object.assign(globalThis, { FileReader: dom.window.FileReader });
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let requests = 0;
  let resolveRefresh: ((data: BootstrapData) => void) | undefined;
  const promptCalls: unknown[][] = [];
  const imageModel = {
    provider: "test",
    id: "image-ready",
    name: "Image ready",
    input: ["text", "image"],
    reasoning: true,
  };
  Object.assign(api, {
    bootstrap: async () => {
      requests += 1;
      if (requests === 1)
        return {
          ...bootstrap,
          state: { ...bootstrap.state, model: null },
          models: [],
          primaryRuntime: { status: "starting" as const, generation: 1 },
        };
      return new Promise<BootstrapData>((resolve) => {
        resolveRefresh = resolve;
      });
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async (...args: unknown[]) => {
      promptCalls.push(args);
      return { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const imageMenuItem = () =>
    [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".attachment-menu [role='menuitem']",
    )].find((item) => item.textContent?.includes("图片"))!;
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-ready-capability",
            workspaceEpoch: "epoch-ready-capability",
            primaryRuntime: { status: "ready", generation: 1 },
          }),
        }),
      ),
    );
    assert.equal(requests, 2, "a ready frame that missed the status SSE refreshes its capability snapshot");
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(".composer textarea")!.disabled,
      false,
      "ready Runtime authority unlocks ordinary text before image capability is confirmed",
    );
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!.disabled,
      false,
      "attachments may be staged while their submit-time capability check remains pending",
    );
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!.click(),
    );
    assert.match(imageMenuItem().textContent || "", /发送前等待模型能力同步/);
    const fileInput = dom.window.document.querySelector<HTMLInputElement>(
      "input[type='file']",
    )!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [
        new dom.window.File(["image"], "pending.png", {
          type: "image/png",
        }),
      ],
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      const deadline = Date.now() + 250;
      while (
        !dom.window.document.querySelector(".image-preview") &&
        Date.now() < deadline
      )
        await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
    });
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      ".composer textarea",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "send after capability confirmation");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "send after capability confirmation",
        }),
      );
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
    });
    assert.equal(promptCalls.length, 0, "pending image capability blocks image submission");
    assert.match(
      dom.window.document.querySelector(".app-toast.error")?.textContent || "",
      /模型图片能力尚未确认/,
    );
    assert.ok(
      dom.window.document.querySelector(".image-preview"),
      "a capability-rejected image remains in the draft",
    );
    await act(async () => {
      resolveRefresh!({
        ...bootstrap,
        state: { ...bootstrap.state, model: imageModel },
        models: [imageModel],
        primaryRuntime: { status: "ready", generation: 1 },
      });
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(".composer textarea")!.disabled,
      false,
    );
    assert.equal(imageMenuItem().disabled, false);
    assert.match(imageMenuItem().textContent || "", /直接解析/);
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click(),
    );
    assert.equal(promptCalls.length, 1, "confirmed image capability permits submission");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a new Primary generation keeps prior image capability pending until its refresh commits", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const imageModel = {
    provider: "test",
    id: "generation-image",
    name: "Generation image",
    input: ["text", "image"],
    reasoning: true,
  };
  let requests = 0;
  const resolveRefreshes: Array<(data: BootstrapData) => void> = [];
  Object.assign(api, {
    bootstrap: async () => {
      requests += 1;
      if (requests === 1)
        return {
          ...bootstrap,
          state: { ...bootstrap.state, model: imageModel },
          models: [imageModel],
          primaryRuntime: {
            status: "ready" as const,
            generation: 1,
            model: imageModel,
            sessionId: activeId,
          },
        };
      return new Promise<BootstrapData>((resolve) => {
        resolveRefreshes.push(resolve);
      });
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const imageMenuItem = () =>
    [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".attachment-menu [role='menuitem']",
    )].find((item) => item.textContent?.includes("图片"))!;
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    // Begin an old-generation refresh, then let Primary begin generation 2
    // before that response returns.
    await act(async () =>
      source.emitPi({
        type: "pi_chat_primary_runtime_status",
        primaryRuntime: { status: "ready", generation: 1 },
      }),
    );
    assert.equal(requests, 2);
    await act(async () =>
      source.emitPi({
        type: "pi_chat_primary_runtime_status",
        primaryRuntime: { status: "starting", generation: 2 },
      }),
    );
    await act(async () => {
      resolveRefreshes.shift()!({
        ...bootstrap,
        state: { ...bootstrap.state, model: imageModel },
        models: [imageModel],
        primaryRuntime: { status: "ready", generation: 1 },
      });
      await Promise.resolve();
    });
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            primaryRuntime: {
              status: "ready",
              generation: 2,
              model: imageModel,
              sessionId: activeId,
            },
          }),
        }),
      ),
    );
    assert.equal(
      requests,
      2,
      "an adopted ready snapshot needs no capability Bootstrap round trip",
    );
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(".composer textarea")!.disabled,
      false,
    );
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!.disabled,
      false,
    );
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!.click(),
    );
    assert.equal(imageMenuItem().disabled, false);
    assert.match(imageMenuItem().textContent || "", /直接解析/);
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(".composer textarea")!.disabled,
      false,
    );
    assert.equal(imageMenuItem().disabled, false);
    assert.match(imageMenuItem().textContent || "", /直接解析/);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("Primary failure keeps cached image capability unconfirmed without locking the draft", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const imageModel = {
    provider: "test",
    id: "cached-image",
    name: "Cached image",
    input: ["text", "image"],
    reasoning: true,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, model: imageModel },
      models: [imageModel],
      primaryRuntime: {
        status: "failed" as const,
        generation: 2,
        error: "simulated failure",
      },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const input = dom.window.document.querySelector<HTMLTextAreaElement>(
      ".composer textarea",
    )!;
    assert.equal(input.disabled, false);
    assert.doesNotMatch(input.placeholder, /Pi Runtime 当前不可用；恢复 ready 后才能输入/);
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(".attachment-button")!.disabled,
      false,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("ChatInput accepts an image draft and checks model support only at submit time", async () => {
  const { dom } = installDom();
  Object.assign(globalThis, { FileReader: dom.window.FileReader });
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const sent: unknown[][] = [];
  const errors: string[] = [];
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const render = (acceptsImages: boolean) =>
    createElement(ChatInput, {
      streaming: false,
      stopping: false,
      disabled: false,
      submissionScope: "session:image-capability",
      acceptsImages,
      commands: [],
      onSend: async (message: string, images: unknown[]) => { sent.push([message, images]); },
      onAbort: async () => undefined,
      onPickLocalFiles: async () => [],
      onReadClipboardFiles: async () => [],
      onError: (message: string) => { errors.push(message); },
    });
  try {
    await act(async () => root.render(render(false)));
    const fileInput = dom.window.document.querySelector<HTMLInputElement>(
      "input[type='file']",
    )!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new dom.window.File(["image"], "retained.png", { type: "image/png" })],
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      const deadline = Date.now() + 250;
      while (!dom.window.document.querySelector(".image-preview") && Date.now() < deadline)
        await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
    });
    assert.ok(
      dom.window.document.querySelector(".image-preview"),
      "a ready composer accepts an image before capability validation",
    );
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "send retained image");
      textarea.dispatchEvent(new dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "send retained image",
      }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
    });
    assert.deepEqual(sent, []);
    assert.equal(errors.at(-1), "当前模型不支持图片输入");
    assert.ok(dom.window.document.querySelector(".image-preview"), "rejected images remain removable");
  } finally {
    await act(async () => root.unmount());
  }
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
    onReadClipboardFiles: async () => [],
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
    onReadClipboardFiles: async () => [],
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
    submissionPausedMessage: "另一窗口正在控制此对话；消息已保留，控制权可用后将发送",
    submissionScope: "session:foreign-control",
    acceptsImages: true,
    commands: [],
    onSend: async (message: string) => { calls.push(message); },
    onAbort: async () => undefined,
    onPickLocalFiles: async () => [],
    onReadClipboardFiles: async () => [],
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
    assert.match(dom.window.document.querySelector(".composer-submission-status")?.textContent || "", /控制权可用后将发送/);
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

test("ChatInput defers a raced control conflict without retrying until the control pause clears", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { ChatInput } = await import("../../src/web/components/ChatInput");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  let attempts = 0;
  const conflict = Object.assign(new Error("foreign"), { code: "SESSION_CONTROL_CONFLICT" });
  const render = (submissionPaused: boolean) => createElement(ChatInput, {
    streaming: false,
    stopping: false,
    disabled: false,
    submissionPaused,
    submissionScope: "session:control-race",
    acceptsImages: true,
    commands: [],
    onSend: async () => {
      attempts += 1;
      if (attempts === 1) throw conflict;
    },
    onSubmissionDeferred: (error: unknown) => (error as { code?: string }).code === "SESSION_CONTROL_CONFLICT",
    onAbort: async () => undefined,
    onPickLocalFiles: async () => [],
    onReadClipboardFiles: async () => [],
    onError: () => undefined,
  });
  try {
    await act(async () => root.render(render(false)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "race safe");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "race safe" }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(attempts, 1, "a conflict leaves the snapshot queued instead of spinning a retry loop");
    await act(async () => {
      root.render(render(true));
      await Promise.resolve();
    });
    await act(async () => {
      root.render(render(false));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(attempts, 2, "a later control projection resumes the deferred snapshot");
  } finally {
    await act(async () => root.unmount());
  }
});

test("App does not hand a buffered follow-up to the API while another window owns the Session", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let resolveFirst!: (value: { accepted: true; queued: false }) => void;
  const first = new Promise<{ accepted: true; queued: false }>((resolve) => {
    resolveFirst = resolve;
  });
  const promptMessages: string[] = [];
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async (message: string) => {
      promptMessages.push(message);
      return promptMessages.length === 1
        ? first
        : { accepted: true, queued: true, id: "queued-second", queue: [{ id: "queued-second", message, imageCount: 0, createdAt: 2 }] };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
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
    await act(async () => root.render(createElement(App)));
    await typeAndSend("first");
    await typeAndSend("second");
    assert.deepEqual(promptMessages, ["first"]);
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => source.emitPi({
      type: "pi_chat_session_control_changed",
      sessionId: activeId,
      piChatSessionId: activeId,
      controlOwner: "foreign-window",
      controlledByThisWindow: false,
    }));
    await act(async () => {
      resolveFirst({ accepted: true, queued: false });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(promptMessages, ["first"], "foreign control keeps the follow-up inside the editor pump");
    await act(async () => source.emitPi({
      type: "pi_chat_session_control_changed",
      sessionId: activeId,
      piChatSessionId: activeId,
      controlOwner: "this-window",
      controlledByThisWindow: true,
    }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(promptMessages, ["first", "second"]);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("App resumes an unseen control conflict only after a newer control frame", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api, ApiRequestError } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let attempts = 0;
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => {
      attempts += 1;
      if (attempts === 1)
        throw new ApiRequestError("另一窗口正在控制", 409, "SESSION_CONTROL_CONFLICT");
      return { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "wait for authoritative clear");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "wait for authoritative clear" }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(attempts, 1);
    assert.match(dom.window.document.querySelector(".composer-submission-status")?.textContent || "", /消息已保留/);
    await act(async () => {
      FakeEventSource.instances.at(-1)!.emitPi({
        type: "pi_chat_session_control_changed",
        sessionId: activeId,
        piChatSessionId: activeId,
        controlledByThisWindow: false,
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(attempts, 2, "the conflict alone cannot cause an immediate retry");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a deferred A conflict retains A's control fence across navigation to B", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api, ApiRequestError } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "bbbbbbbbbbbbbbbbbbbb";
  const summaryB = { ...bootstrap.sessions[0], id: secondId, sessionId: "session-b", name: "Session B", active: false };
  const viewA = {
    ...draftView,
    session: bootstrap.sessions[0],
    state: { ...bootstrap.state, sessionName: "Active" },
  };
  const viewB = {
    ...draftView,
    session: summaryB,
    state: { ...draftView.state, sessionId: "session-b", sessionName: "Session B" },
  };
  let rejectFirst!: (reason: Error) => void;
  const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
  const targets: string[] = [];
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, sessions: [bootstrap.sessions[0], summaryB], sessionsTotal: 2 }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => id === secondId ? viewB : viewA,
    prompt: async (_message: string, _images: unknown[], id: string) => {
      targets.push(id);
      if (targets.length === 1) return first;
      return { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "A waits for control");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "A waits for control" }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
    });
    assert.deepEqual(targets, [activeId]);
    const buttonB = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")]
      .find((button) => button.textContent?.includes("Session B"))!;
    await act(async () => { buttonB.click(); await Promise.resolve(); await Promise.resolve(); });
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "pi_chat_session_control_changed",
        sessionId: secondId,
        piChatSessionId: secondId,
        controlOwner: "foreign-b",
        controlledByThisWindow: false,
      });
      rejectFirst(new ApiRequestError("另一窗口正在控制", 409, "SESSION_CONTROL_CONFLICT"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(targets, [activeId], "B's newer control event cannot resume A's snapshot");
    const buttonA = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")]
      .find((button) => button.textContent?.includes("Active"))!;
    await act(async () => { buttonA.click(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      source.emitPi({
        type: "pi_chat_session_control_changed",
        sessionId: activeId,
        piChatSessionId: activeId,
        controlledByThisWindow: false,
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(targets, [activeId, activeId], "only A's later control frame releases A's retained snapshot");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
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
    onReadClipboardFiles: async () => [],
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
    await act(async () => {
      resolvers.get("a:one")?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(calls, ["a:one", "b:three"], "the old pane's second snapshot remains paused");
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
    onReadClipboardFiles: async () => [],
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
          onReadClipboardFiles: async () => [],
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
          onReadClipboardFiles: async () => [],
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
    assert.equal(queueButton.nextElementSibling, steerButton);
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
    await act(async () =>
      source.emitPi({
        type: "message_start",
        piChatSessionId: activeId,
        nativeSteeringConsumed: true,
        message: { role: "user", content: "redirect consumed later" },
      }),
    );
    assert.equal(
      dom.window.document.querySelectorAll(".message-user").length,
      1,
      "a server-verified native steer consumption reveals the local Steer turn",
    );
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
    assert.equal(dom.window.document.querySelector(".message-generated-at"), null);
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
    assert.equal(dom.window.document.querySelector(".steer-submit-button"), null);
    assert.equal(dom.window.document.querySelector(".stop-button"), null);
    assert.ok(dom.window.document.querySelector(".send-button"));
    assert.equal(dom.window.document.querySelector(".session-status.is-running"), null);
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

test("system Gate selector remains visible when startup command inventory is empty", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      commands: [],
      gateMode: "strict" as const,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const gate = dom.window.document.querySelector<HTMLButtonElement>(
      ".composer .gate-control .compact-select-trigger",
    );
    assert.ok(
      gate,
      "the verified system Gate must not depend on get_commands()",
    );
    assert.equal(gate.textContent?.trim(), "严格");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("conversation controls live in the composer while settings moves to the top bar", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      commands: [{ name: "gate", description: "Gate", source: "extension" }],
      stats: {
        tokens: {
          input: 10,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          total: 12,
        },
        contextUsage: { tokens: 100, contextWindow: 1_000, percent: 10 },
      },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(dom.window.document.querySelector(".topbar-settings"));
    assert.ok(dom.window.document.querySelector(".diff-sidebar-toggle"));
    assert.equal(
      dom.window.document.querySelector(".topbar .model-menu"),
      null,
    );
    assert.equal(
      dom.window.document.querySelector(".topbar .usage-pill"),
      null,
    );
    assert.equal(dom.window.document.querySelector(".management-nav"), null);
    assert.ok(
      dom.window.document.querySelector(".composer .composer-model-select"),
    );
    assert.ok(dom.window.document.querySelector(".composer .thinking-control"));
    const gateTrigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".composer .gate-control .compact-select-trigger",
    )!;
    assert.equal(gateTrigger.textContent?.trim(), "未同步");
    await act(async () => gateTrigger.click());
    assert.deepEqual(
      [
        ...dom.window.document.querySelectorAll(
          ".gate-control .compact-select-option > span:last-of-type",
        ),
      ].map((node) => node.textContent),
      ["未同步", "严格", "放行"],
    );
    assert.ok(dom.window.document.querySelector(".composer .composer-usage"));
    assert.ok(
      dom.window.document.querySelector(
        ".attachment-button [data-icon='paperclip']",
      ),
    );
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(
          ".thinking-control .compact-select-trigger",
        )
        ?.click(),
    );
    const thinkingLabels = [
      ...dom.window.document.querySelectorAll(
        ".thinking-control .compact-select-option > span:last-of-type",
      ),
    ].map((node) => node.textContent);
    assert.deepEqual(thinkingLabels, [
      "off",
      "min",
      "low",
      "med",
      "high",
      "xhigh",
      "max",
    ]);
    assert.ok(
      dom.window.document.querySelector(
        ".thinking-control .compact-select-option.has-leading-check",
      ),
    );
    const settings =
      dom.window.document.querySelector<HTMLButtonElement>(".topbar-settings")!;
    assert.equal(settings.getAttribute("aria-expanded"), "false");
    assert.equal(
      settings.getAttribute("aria-controls"),
      "pi-chat-settings-dialog",
    );
    await act(async () => settings.click());
    assert.ok(dom.window.document.querySelector("#pi-chat-settings-dialog"));
    assert.equal(settings.getAttribute("aria-expanded"), "true");
    assert.equal(settings.getAttribute("aria-label"), "关闭设置");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
