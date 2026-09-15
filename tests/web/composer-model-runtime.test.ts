import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { act, createElement } from "react";
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


test("a transient empty model inventory keeps the selected Model editable", async () => {
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
      primaryRuntime: { status: "starting" as const, generation: 1 },
      modelInventoryPending: true,
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
    assert.equal(
      trigger.parentElement?.title,
      "模型列表正在加载；可以先编辑，发送时由 Pi 再次确认",
    );
    assert.doesNotMatch(trigger.textContent || "", /xwill|\u0000/);
    assert.equal(
      trigger.disabled,
      false,
      "a transient empty inventory must not make Model look unavailable",
    );
    await act(async () => trigger.click());
    assert.ok(
      dom.window.document.querySelector(
        ".composer-model-select [role='option']",
      ),
      "the selected Runtime model remains an explicit fallback option",
    );
    assert.match(
      dom.window.document.querySelector(".composer-model-status")?.textContent || "",
      /发送时由 Pi 复核/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a ready empty model inventory ends pending state without resurrecting stale choices", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const { MODEL_CATALOG_STORAGE_KEY } = await import("../../src/web/lib/model-catalog");
  const restoreApi = captureApiSnapshot(api);
  const stale = {
    provider: "old-provider",
    id: "old-model",
    name: "Old model",
    input: ["text"],
    reasoning: true,
  };
  dom.window.localStorage.setItem(MODEL_CATALOG_STORAGE_KEY, JSON.stringify([stale]));
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, model: null },
      models: [],
      primaryRuntime: { status: "ready" as const, generation: 3 },
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
    assert.equal(trigger.disabled, false, "an empty catalogue is not a startup failure");
    assert.equal(trigger.getAttribute("aria-busy"), null, "ready empty discovery is settled");
    await act(async () => trigger.click());
    assert.equal(
      dom.window.document.querySelector(".composer-model-status")?.textContent,
      "暂无可用模型",
    );
    assert.equal(
      [...dom.window.document.querySelectorAll<HTMLElement>(
        ".composer-model-select [role='option']",
      )].some((option) => option.textContent?.includes("Old model")),
      false,
      "an authoritative empty catalogue does not present stale cached models",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a browser-cached model catalogue stays selectable across a restart bootstrap", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const { MODEL_CATALOG_STORAGE_KEY } = await import("../../src/web/lib/model-catalog");
  const restoreApi = captureApiSnapshot(api);
  const selected = {
    provider: "xwill",
    id: "gpt-5.6-sol",
    name: "gpt-5.6-sol",
    input: ["text"],
    reasoning: true,
  };
  const alternative = {
    provider: "xwill",
    id: "gpt-5.6-terra",
    name: "gpt-5.6-terra",
    input: ["text"],
    reasoning: true,
  };
  dom.window.localStorage.setItem(
    MODEL_CATALOG_STORAGE_KEY,
    JSON.stringify([selected, alternative]),
  );
  const promptCalls: unknown[][] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, model: selected },
      models: [],
      primaryRuntime: { status: "ready" as const, generation: 2 },
      modelInventoryPending: true,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async (...args: unknown[]) => {
      promptCalls.push(args);
      return { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".composer-model-select .compact-select-trigger",
    )!;
    assert.equal(trigger.disabled, false);
    await act(async () => trigger.click());
    const alternativeOption = [...dom.window.document.querySelectorAll<HTMLElement>(
      ".composer-model-select [role='option']",
    )].find((option) => option.textContent?.includes("gpt-5.6-terra"));
    assert.ok(alternativeOption, "a previous catalogue supplies a real switch option");
    await act(async () => alternativeOption!.click());
    assert.match(trigger.textContent || "", /gpt-5.6-terra/);
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "send cached choice");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "send cached choice",
        }),
      );
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(
      promptCalls[0]?.[5],
      { model: { provider: "xwill", modelId: "gpt-5.6-terra" } },
      "the cached choice is rechecked by the server at prompt admission",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an explicit Composer Thinking choice survives reload without mutating Pi", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const highBootstrap = {
    ...bootstrap,
    state: { ...bootstrap.state, thinkingLevel: "high" as const },
  };
  let promptSettings: unknown;
  Object.assign(api, {
    bootstrap: async () => highBootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async (...args: unknown[]) => {
      promptSettings = args[5];
      return { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const selectLow = async () => {
      const trigger = dom.window.document.querySelector<HTMLButtonElement>(".thinking-control .compact-select-trigger")!;
      await act(async () => { trigger.click(); await Promise.resolve(); });
      const low = [...dom.window.document.querySelectorAll<HTMLElement>(".thinking-control .compact-select-option")]
        .find((option) => option.textContent?.trim() === "low");
      assert.ok(low);
      await act(async () => { low.click(); await Promise.resolve(); });
    };
    await selectLow();
    assert.match(
      dom.window.document.querySelector<HTMLButtonElement>(".thinking-control .compact-select-trigger")!.textContent || "",
      /low/,
    );
    await act(async () => root.unmount());
    const reloaded = createRoot(dom.window.document.querySelector("#root")!);
    try {
      await act(async () => reloaded.render(createElement(App)));
      assert.match(
        dom.window.document.querySelector<HTMLButtonElement>(".thinking-control .compact-select-trigger")!.textContent || "",
        /low/,
        "browser-local next-turn intent outranks a conflicting Runtime display projection",
      );
      const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea[aria-label='消息输入']")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "preserve low");
        textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "preserve low" }));
        dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.deepEqual(promptSettings, { thinkingLevel: "low" });
    } finally {
      await act(async () => reloaded.unmount());
    }
  } finally {
    restoreApi();
  }
});

test("a selected model without a new inventory retains the last selectable catalogue", async () => {
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
  const alternative = {
    provider: "xwill",
    id: "gpt-5.6-terra",
    name: "gpt-5.6-terra",
    input: ["text"],
    reasoning: true,
  };
  let requests = 0;
  Object.assign(api, {
    bootstrap: async () => {
      requests += 1;
      return requests === 1
        ? { ...bootstrap, state: { ...bootstrap.state, model: selected }, models: [selected, alternative] }
        : { ...bootstrap, state: { ...bootstrap.state, model: selected }, models: [] };
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const trigger = () => dom.window.document.querySelector<HTMLButtonElement>(
      ".composer-model-select .compact-select-trigger",
    )!;
    assert.equal(trigger().disabled, false);
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(trigger().disabled, false, "an empty refresh does not grey out Model");
    await act(async () => { trigger().click(); await Promise.resolve(); });
    assert.ok(
      [...dom.window.document.querySelectorAll<HTMLElement>(".composer-model-select .compact-select-option")]
        .some((option) => option.textContent?.includes("gpt-5.6-terra")),
      "the prior catalogue remains selectable until a real replacement arrives",
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

test("a Primary replacement clears the previous Fast indicator before the new Runtime reports status", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, fastModeActive: true },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(dom.window.document.querySelector(".fast-mode-indicator"));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => source.emitPi({
      type: "pi_chat_primary_runtime_status",
      primaryRuntime: { status: "starting", generation: 1 },
    }));
    assert.equal(dom.window.document.querySelector(".fast-mode-indicator"), null);

    // A full Pi Chat restart creates a new process epoch. Even if the old
    // pane is still visible while the replacement reconnects, its Fast footer
    // must not survive until the replacement bootstrap finishes.
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "restarting",
            piChatRunEpoch: "epoch-b",
            workspaceEpoch: "epoch-b",
            primaryRuntime: { status: "starting", generation: 0 },
          }),
        }),
      ),
    );
    assert.equal(
      dom.window.document.querySelector(".fast-mode-indicator"),
      null,
      "a process restart must clear Fast from the retained visible pane",
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
    assert.equal(
      modelTrigger.disabled,
      false,
      "an adopted ready model must also populate the selectable catalogue",
    );
    await act(async () => modelTrigger.click());
    assert.ok(
      [...dom.window.document.querySelectorAll<HTMLElement>(
        ".composer-model-select [role='option']",
      )].some((option) => option.textContent?.includes("Adopted ready")),
      "the adopted model remains selectable before the next Bootstrap refresh",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
