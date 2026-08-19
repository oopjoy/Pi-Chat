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


test("ChatInput partitions unsent drafts and images by Session without remounting", async () => {
  const { dom } = installDom();
  Object.assign(globalThis, {
    FileReader: dom.window.FileReader,
    File: dom.window.File,
  });
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "draft-preservation-123";
  const imageModel = {
    ...bootstrap.state.model!,
    input: ["text", "image"],
  };
  const secondView: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: secondId,
      sessionId: "draft-preservation",
      name: "Draft preservation",
      active: false,
      writable: false,
    },
    state: {
      ...draftView.state,
      model: imageModel,
      sessionId: "draft-preservation",
    },
    runtimeStatus: "view-only",
    isActive: false,
  };
  const activeView: SessionViewData = {
    ...draftView,
    session: bootstrap.sessions[0],
    state: { ...draftView.state, model: imageModel, sessionId: "active" },
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, model: imageModel },
      models: [imageModel],
      sessions: [...bootstrap.sessions, secondView.session],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) =>
      id === secondId ? secondView : activeView,
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
      )?.set?.call(textarea, "keep this unsent draft");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "keep this unsent draft",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".attachment-button")!
        .click();
    });
    await act(async () => {
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".attachment-menu [role='menuitem']",
        ),
      ]
        .find((button) => button.textContent?.includes("图片"))!
        .click();
      const fileInput =
        dom.window.document.querySelector<HTMLInputElement>(
          "input[type='file']",
        )!;
      Object.defineProperty(fileInput, "files", {
        configurable: true,
        value: [
          new dom.window.File(["image"], "keep.png", { type: "image/png" }),
        ],
      });
      fileInput.dispatchEvent(
        new dom.window.Event("change", { bubbles: true }),
      );
      const deadline = Date.now() + 250;
      while (
        !dom.window.document.querySelector(
          ".image-preview img[alt='keep.png']",
        ) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
    });
    assert.equal(textarea.value, "keep this unsent draft");
    assert.ok(
      dom.window.document.querySelector(".image-preview img[alt='keep.png']"),
    );
    const sessionButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((button) => button.textContent?.includes("Draft preservation"))!;
    await act(async () => sessionButton.click());
    const inSecondSession =
      dom.window.document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='消息输入']",
      )!;
    assert.equal(inSecondSession, textarea, "the unkeyed ChatInput must not remount");
    assert.equal(inSecondSession.value, "");
    assert.equal(dom.window.document.querySelector(".image-preview img[alt='keep.png']"), null);
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ]
        .find((button) => button.textContent?.includes("Active"))!
        .click(),
    );
    const afterReturn =
      dom.window.document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='消息输入']",
      )!;
    assert.equal(afterReturn.value, "keep this unsent draft");
    assert.ok(dom.window.document.querySelector(".image-preview img[alt='keep.png']"));
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("loading earlier history is isolated per Session across a pane switch", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "11111111111111111111";
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "second",
    name: "History B",
    active: false,
  };
  const recent = (label: string): SessionViewData => ({
    ...draftView,
    session: label === "A" ? bootstrap.sessions[0] : summaryB,
    state: { ...bootstrap.state, sessionId: label.toLowerCase() },
    messages: [{ role: "user", content: `${label} recent` }],
    messageTotal: 40,
    turnTotal: 20,
    visibleTurnCount: 10,
    messagesTruncated: true,
    isActive: label === "A",
    runtimeStatus: label === "A" ? "active" : "view-only",
  });
  const expanded = (label: string): SessionViewData => ({
    ...recent(label),
    messages: [
      { role: "user", content: `${label} older` },
      { role: "user", content: `${label} recent` },
    ],
    visibleTurnCount: 20,
    messagesTruncated: false,
  });
  let resolveA!: (view: SessionViewData) => void;
  let resolveB!: (view: SessionViewData) => void;
  const earlierA = new Promise<SessionViewData>((resolve) => {
    resolveA = resolve;
  });
  const earlierB = new Promise<SessionViewData>((resolve) => {
    resolveB = resolve;
  });
  const earlierCalls: string[] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      messages: recent("A").messages,
      messageTotal: 40,
      turnTotal: 20,
      visibleTurnCount: 10,
      messagesTruncated: true,
      sessions: [bootstrap.sessions[0], summaryB],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string, turns?: number) => {
      if (!turns) return id === secondId ? recent("B") : recent("A");
      earlierCalls.push(id);
      return id === secondId ? earlierB : earlierA;
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const loadButton = () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => /加载更早|正在加载/.test(button.textContent || ""))!;
    await act(async () => {
      loadButton().click();
      await Promise.resolve();
    });
    assert.deepEqual(earlierCalls, [activeId]);

    const secondButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((button) => button.textContent?.includes("History B"))!;
    await act(async () => secondButton.click());
    assert.match(dom.window.document.body.textContent || "", /B recent/);
    await act(async () => {
      loadButton().click();
      await Promise.resolve();
    });
    assert.deepEqual(
      earlierCalls,
      [activeId, secondId],
      "B starts its own history request while A is still pending",
    );

    await act(async () => {
      resolveA(expanded("A"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      loadButton().textContent,
      "正在加载…",
      "A completion cannot clear B's loading lease",
    );
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /A older/,
      "A's late page cannot replace B",
    );

    await act(async () => {
      resolveB(expanded("B"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(dom.window.document.body.textContent || "", /B older/);
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /正在加载…/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an old history request cannot affect a later visit to the same Session", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "22222222222222222222";
  const summaryB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "second",
    name: "History B",
    active: false,
  };
  const view = (
    id: string,
    content: string,
    truncated = true,
  ): SessionViewData => ({
    ...draftView,
    session: id === activeId ? bootstrap.sessions[0] : summaryB,
    state: { ...bootstrap.state, sessionId: id },
    messages: [{ role: "user", content }],
    messageTotal: 40,
    turnTotal: 20,
    visibleTurnCount: truncated ? 10 : 20,
    messagesTruncated: truncated,
    isActive: id === activeId,
    runtimeStatus: id === activeId ? "active" : "view-only",
  });
  let resolveOldA!: (value: SessionViewData) => void;
  let resolveNewA!: (value: SessionViewData) => void;
  const oldA = new Promise<SessionViewData>((resolve) => {
    resolveOldA = resolve;
  });
  const newA = new Promise<SessionViewData>((resolve) => {
    resolveNewA = resolve;
  });
  let aEarlierCalls = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      messages: view(activeId, "A recent").messages,
      messageTotal: 40,
      turnTotal: 20,
      visibleTurnCount: 10,
      messagesTruncated: true,
      sessions: [bootstrap.sessions[0], summaryB],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string, turns?: number) => {
      if (id === activeId && turns === 20) {
        aEarlierCalls += 1;
        return aEarlierCalls === 1 ? oldA : newA;
      }
      return id === activeId
        ? view(activeId, "A recent")
        : view(secondId, "B recent");
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const loadButton = () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => /加载更早|正在加载/.test(button.textContent || ""))!;
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name))!;
    await act(async () => {
      loadButton().click();
      await Promise.resolve();
    });
    await act(async () => sessionButton("History B").click());
    await act(async () => sessionButton("Active").click());
    await act(async () => {
      loadButton().click();
      await Promise.resolve();
    });
    assert.equal(
      aEarlierCalls,
      2,
      "the later visit starts a fresh A history request",
    );

    await act(async () => {
      resolveOldA(view(activeId, "A stale older", false));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      loadButton().textContent,
      "正在加载…",
      "the old visit cannot clear the new visit's lease",
    );
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /A stale older/,
    );

    await act(async () => {
      resolveNewA(view(activeId, "A current older", false));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(dom.window.document.body.textContent || "", /A current older/);
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /正在加载…/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a fast bootstrap restores its remembered active Session without a competing view request", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  dom.window.history.replaceState(null, "", `/?session=${activeId}`);
  let viewCalls = 0;
  let bootstrapCalls = 0;
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrap;
    },
    eventsUrl: () => "/api/events",
    viewSession: async () => {
      viewCalls += 1;
      return draftView;
    },
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => {
      root.render(createElement(App));
      await new Promise((resolve) => setTimeout(resolve, 140));
    });
    assert.equal(
      viewCalls,
      0,
      "the bootstrap-selected Primary must not race a redundant /view request",
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-a",
          }),
        }),
      ),
    );
    assert.equal(
      bootstrapCalls,
      1,
      "initial ready after a successful bootstrap must not repeat it",
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Active",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("remembered cold history paints before global bootstrap finishes while mutations stay disabled", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "abcdef0123456789abcd";
  dom.window.history.replaceState(null, "", `/?session=${coldId}`);
  const cold: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: coldId,
      sessionId: "remembered-cold",
      name: "Remembered cold",
      messageCount: 2,
      active: false,
      writable: false,
    },
    messages: [
      { role: "user", content: "remembered question" },
      { role: "assistant", content: "remembered answer" },
    ],
    messageTotal: 2,
    runtimeStatus: "view-only",
    isActive: false,
    viewSource: "cold-jsonl",
  };
  let resolveBootstrap!: (value: BootstrapData) => void;
  const pendingBootstrap = new Promise<BootstrapData>((resolve) => {
    resolveBootstrap = resolve;
  });
  let coldViews = 0;
  Object.assign(api, {
    handshake: async () => ({
      requestToken: "test-token",
      buildIdentity: {
        schemaVersion: 1,
        packageVersion: "test",
        revision: "test",
        fingerprint: "0".repeat(64),
        builtAt: "test",
      },
    }),
    bootstrap: async () => pendingBootstrap,
    eventsUrl: () => "/api/events",
    viewSession: async (id: string) => {
      assert.equal(id, coldId);
      coldViews += 1;
      return cold;
    },
    markSessionViewed: async () => ({ viewing: coldId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 140));
    });
    assert.match(
      dom.window.document.body.textContent || "",
      /remembered answer/,
    );
    assert.equal(coldViews, 1);
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='消息输入']",
      )?.disabled,
      false,
      "history may paint early and its draft stays editable while bootstrap identity/readiness recover",
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Remembered cold",
      "an early committed JSONL pane owns its title before sidebar inventory arrives",
    );
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      0,
      "a remembered pane cannot become a fake one-row sidebar before bootstrap inventory arrives",
    );
    assert.match(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /正在加载对话…/,
      "an unconfirmed inventory must not claim that history is empty",
    );

    await act(async () => {
      resolveBootstrap({
        ...bootstrap,
        sessions: [...bootstrap.sessions, cold.session],
        sessionsTotal: 2,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(
      dom.window.document.body.textContent || "",
      /remembered answer/,
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Remembered cold",
    );
    assert.equal(
      coldViews,
      1,
      "bootstrap reuses the in-flight remembered view instead of reading it twice",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("initial idle ready retries one rejected bootstrap and restores the page projection", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) throw new Error("bootstrap unavailable");
      return bootstrap;
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.equal(bootstrapCalls, 1);
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-a",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      bootstrapCalls,
      2,
      "the first healthy ready retries a failed initial bootstrap once",
    );
    assert.equal(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Active",
    );
    const model = dom.window.document.querySelector<HTMLButtonElement>(
      ".composer-model-select .compact-select-trigger",
    )!;
    assert.equal(
      model.disabled,
      false,
      "the successful retry restores Primary capability metadata",
    );
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-a",
          }),
        }),
      ),
    );
    assert.equal(
      bootstrapCalls,
      2,
      "repeated initial ready frames cannot create a retry loop",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an initial ready consumes its only retry even when that retry fails", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      throw new Error("bootstrap unavailable");
    },
    eventsUrl: () => "/api/events",
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.equal(bootstrapCalls, 1);
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-a",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(bootstrapCalls, 2, "first ready uses the one initial retry");
    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-a",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      bootstrapCalls,
      2,
      "a failed initial retry cannot loop on later ready frames",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a slow bootstrap still completes the sidebar inventory through its independent Session Index read", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const pendingBootstrap = new Promise<BootstrapData>(() => undefined);
  let sessionReads = 0;
  Object.assign(api, {
    bootstrap: async () => pendingBootstrap,
    eventsUrl: () => "/api/events",
    sessions: async () => {
      sessionReads += 1;
      return {
        sessions: bootstrap.sessions,
        total: 1,
        directories: [],
      };
    },
  });
  const browserSetTimeout = dom.window.setTimeout.bind(dom.window);
  const sidebarTimers: Array<() => void> = [];
  Object.defineProperty(dom.window, "setTimeout", {
    configurable: true,
    value(callback: TimerHandler, delay?: number) {
      if (delay === 250 && typeof callback === "function") {
        sidebarTimers.push(callback);
        return 1;
      }
      return browserSetTimeout(callback, delay);
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.equal(
      sidebarTimers.length,
      1,
      "slow bootstrap schedules its independent sidebar read",
    );
    await act(async () => {
      sidebarTimers[0]!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      sessionReads,
      1,
      "the fallback performs one JSONL-only inventory read",
    );
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      1,
    );
    assert.doesNotMatch(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /正在加载对话…/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a rejected bootstrap does not discard an already-started sidebar inventory fallback", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let rejectBootstrap!: (cause: Error) => void;
  let resolveSessions!: (value: {
    sessions: typeof bootstrap.sessions;
    total: number;
    directories: [];
  }) => void;
  const pendingBootstrap = new Promise<BootstrapData>((_resolve, reject) => {
    rejectBootstrap = reject;
  });
  const pendingSessions = new Promise<{
    sessions: typeof bootstrap.sessions;
    total: number;
    directories: [];
  }>((resolve) => {
    resolveSessions = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => pendingBootstrap,
    eventsUrl: () => "/api/events",
    sessions: async () => pendingSessions,
  });
  const browserSetTimeout = dom.window.setTimeout.bind(dom.window);
  const sidebarTimers: Array<() => void> = [];
  Object.defineProperty(dom.window, "setTimeout", {
    configurable: true,
    value(callback: TimerHandler, delay?: number) {
      if (delay === 250 && typeof callback === "function") {
        sidebarTimers.push(callback);
        return 1;
      }
      return browserSetTimeout(callback, delay);
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.equal(sidebarTimers.length, 1);
    await act(async () => {
      sidebarTimers[0]!();
      await Promise.resolve();
    });
    await act(async () => {
      rejectBootstrap(new Error("bootstrap unavailable"));
      await Promise.resolve();
    });
    await act(async () => {
      resolveSessions({
        sessions: bootstrap.sessions,
        total: 1,
        directories: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      1,
    );
    assert.doesNotMatch(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /正在加载对话…/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a bootstrap rejected before the sidebar delay leaves its independent inventory timer active", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let rejectBootstrap!: (cause: Error) => void;
  const pendingBootstrap = new Promise<BootstrapData>((_resolve, reject) => {
    rejectBootstrap = reject;
  });
  let sessionReads = 0;
  Object.assign(api, {
    bootstrap: async () => pendingBootstrap,
    eventsUrl: () => "/api/events",
    sessions: async () => {
      sessionReads += 1;
      return { sessions: bootstrap.sessions, total: 1, directories: [] };
    },
  });
  const browserSetTimeout = dom.window.setTimeout.bind(dom.window);
  const browserClearTimeout = dom.window.clearTimeout.bind(dom.window);
  const sidebarTimers: Array<() => void> = [];
  const clearedSidebarTimers: number[] = [];
  Object.defineProperty(dom.window, "setTimeout", {
    configurable: true,
    value(callback: TimerHandler, delay?: number) {
      if (delay === 250 && typeof callback === "function") {
        sidebarTimers.push(callback);
        return 91;
      }
      return browserSetTimeout(callback, delay);
    },
  });
  Object.defineProperty(dom.window, "clearTimeout", {
    configurable: true,
    value(id?: number) {
      if (id === 91) clearedSidebarTimers.push(id);
      else browserClearTimeout(id);
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.equal(sidebarTimers.length, 1);
    await act(async () => {
      rejectBootstrap(
        new Error("bootstrap unavailable before sidebar fallback"),
      );
      await Promise.resolve();
    });
    assert.deepEqual(
      clearedSidebarTimers,
      [],
      "a bootstrap failure must not cancel the pending Session Index fallback",
    );
    await act(async () => {
      sidebarTimers[0]!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(
      sessionReads >= 1,
      "the original independent fallback still reads Session Index after rejection",
    );
    assert.equal(
      dom.window.document.querySelectorAll(".session-row").length,
      1,
    );
    assert.doesNotMatch(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /正在加载对话…/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("opening a cold conversation paints JSONL without starting a dedicated Runtime", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "abcdef0123456789abcd";
  const cold: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: coldId,
      sessionId: "cold",
      name: "Cold",
      messageCount: 1,
      active: false,
      writable: false,
    },
    runtimeStatus: "view-only",
    isActive: false,
  };
  let activations = 0;
  let coldViews = 0;
  let resolveActivation!: (view: SessionViewData) => void;
  const activation = new Promise<SessionViewData>((resolve) => {
    resolveActivation = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [...bootstrap.sessions, cold.session],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => {
      if (id === coldId) {
        coldViews += 1;
        return cold;
      }
      return {
        ...draftView,
        session: bootstrap.sessions[0],
        state: bootstrap.state,
        isActive: true,
        runtimeStatus: "active" as const,
      };
    },
    warmSession: async () => {
      activations += 1;
      await activation;
      return {
        sessionId: coldId,
        state: cold.state,
        gateMode: "strict" as const,
      };
    },
    prompt: async () => ({ accepted: true, queued: false }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const coldRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((row) => row.textContent?.includes("Cold"));
    assert.ok(coldRow);
    await act(async () =>
      coldRow.querySelector<HTMLButtonElement>(".session-item")?.click(),
    );
    assert.equal(coldViews, 1);
    const activeRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((row) => row.textContent?.includes("Active"));
    assert.ok(activeRow);
    await act(async () =>
      activeRow.querySelector<HTMLButtonElement>(".session-item")?.click(),
    );
    await act(async () =>
      coldRow.querySelector<HTMLButtonElement>(".session-item")?.click(),
    );
    assert.equal(
      coldViews,
      1,
      "a fresh stable cold pane reopens from data cache without another JSONL request",
    );
    const input = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => input.focus());
    assert.equal(
      activations,
      0,
      "passive JSONL browsing and focus must not warm a dedicated Runtime",
    );

    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(input, "first cold message");
      input.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "first cold message",
        }),
      );
    });
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")
        ?.click(),
    );
    assert.equal(activations, 1);
    assert.match(
      dom.window.document.body.textContent || "",
      /first cold message/,
    );
    assert.match(
      dom.window.document.querySelector(".timeline-inner")?.textContent || "",
      /正在准备 Pi Runtime；消息已保存，准备完成后自动发送/,
    );
    assert.equal(
      dom.window.document.querySelector(".composer-submission-status"),
      null,
      "the conversation body owns the retained-submission explanation",
    );
    assert.equal(
      coldRow
        .querySelector(".session-status")
        ?.classList.contains("is-running"),
      false,
    );

    await act(async () =>
      resolveActivation({ ...cold, isActive: true, runtimeStatus: "active" }),
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a cold image prompt prepares its Runtime before validating model support", async () => {
  const { dom } = installDom();
  Object.assign(globalThis, { FileReader: dom.window.FileReader });
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "cold-image-1234567890";
  const imageModel = {
    provider: "archive",
    id: "cold-image-model",
    name: "Cold image model",
    input: ["text", "image"],
    reasoning: true,
  };
  const cold: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: coldId,
      sessionId: "cold-image",
      name: "Cold image",
      messageCount: 2,
      active: false,
      writable: false,
    },
    state: { ...draftView.state, sessionId: "cold-image", model: imageModel },
    isActive: false,
    runtimeStatus: "view-only",
  };
  let warmCalls = 0;
  const promptCalls: unknown[][] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      models: [...bootstrap.models, imageModel],
      sessions: [...bootstrap.sessions, cold.session],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) => (id === coldId ? cold : draftView),
    warmSession: async () => {
      warmCalls += 1;
      return {
        sessionId: coldId,
        state: { ...cold.state, isStreaming: false },
        gateMode: "strict" as const,
      };
    },
    prompt: async (...args: unknown[]) => {
      promptCalls.push(args);
      return { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const row = [...dom.window.document.querySelectorAll<HTMLElement>(".session-row")]
      .find((candidate) => candidate.textContent?.includes("Cold image"));
    assert.ok(row);
    await act(async () =>
      row.querySelector<HTMLButtonElement>(".session-item")?.click(),
    );
    const fileInput = dom.window.document.querySelector<HTMLInputElement>(
      "input[type='file']",
    )!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new dom.window.File(["image"], "cold.png", { type: "image/png" })],
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      const deadline = Date.now() + 250;
      while (!dom.window.document.querySelector(".image-preview") && Date.now() < deadline)
        await new Promise((resolve) => dom.window.setTimeout(resolve, 5));
    });
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "cold image prompt");
      textarea.dispatchEvent(new dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "cold image prompt",
      }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(warmCalls, 1);
    assert.equal(promptCalls.length, 1);
    assert.equal((promptCalls[0]?.[1] as unknown[])?.length, 1);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a background completed reply becomes green until this browser opens the conversation", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const backgroundId = "abcdef0123456789abcd";
  const background: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: backgroundId,
      sessionId: "background",
      name: "Background",
      messageCount: 2,
      active: true,
      writable: true,
    },
    messages: [
      { role: "user", content: "question" },
      { role: "assistant", content: "completed reply" },
    ],
    messageTotal: 2,
    turnTotal: 1,
  };
  let resolveBackgroundView!: (view: SessionViewData) => void;
  const pendingBackgroundView = new Promise<SessionViewData>((resolve) => {
    resolveBackgroundView = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [
        ...bootstrap.sessions,
        { ...background.session, active: true },
      ],
      sessionsTotal: 2,
      activeSessionIds: [activeId, backgroundId],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) =>
      id === backgroundId ? pendingBackgroundView : draftView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "message_end",
        piChatSessionId: backgroundId,
        message: { role: "assistant", content: "completed reply" },
      }),
    );
    await act(async () =>
      source.emitPi({ type: "agent_settled", piChatSessionId: backgroundId }),
    );
    const backgroundRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((row) => row.textContent?.includes("Background"));
    assert.ok(backgroundRow);
    assert.equal(
      backgroundRow
        .querySelector(".session-status")
        ?.classList.contains("is-unread"),
      true,
    );

    await act(async () =>
      backgroundRow.querySelector<HTMLButtonElement>(".session-item")?.click(),
    );
    assert.equal(
      backgroundRow
        .querySelector(".session-status")
        ?.classList.contains("is-unread"),
      false,
      "selection consumes the green marker immediately",
    );
    assert.equal(
      backgroundRow
        .querySelector(".session-status")
        ?.classList.contains("is-running"),
      false,
      "a delayed stale view must not replace green with a blue running ring",
    );
    await act(async () =>
      resolveBackgroundView({
        ...background,
        session: { ...background.session, running: true },
        state: { ...background.state, isStreaming: true },
        isStreaming: true,
      }),
    );
    const openedRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((row) => row.textContent?.includes("Background"));
    assert.ok(openedRow);
    assert.equal(
      openedRow
        .querySelector(".session-status")
        ?.classList.contains("is-running"),
      false,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("opening an unread conversation preserves a newer running state", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const backgroundId = "unread-running-123456";
  const background: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: backgroundId,
      sessionId: "unread-running",
      name: "Unread then running",
      messageCount: 2,
      active: true,
      writable: true,
    },
    messages: [
      { role: "user", content: "question" },
      { role: "assistant", content: "completed reply" },
    ],
    messageTotal: 2,
    turnTotal: 1,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [...bootstrap.sessions, background.session],
      sessionsTotal: 2,
      activeSessionIds: [activeId, backgroundId],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) =>
      id === backgroundId ? background : draftView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "message_end",
        piChatSessionId: backgroundId,
        message: { role: "assistant", content: "completed reply" },
      });
      source.emitPi({ type: "agent_settled", piChatSessionId: backgroundId });
      source.emitPi({ type: "agent_start", piChatSessionId: backgroundId });
    });
    const row = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((candidate) =>
      candidate.textContent?.includes("Unread then running"),
    );
    assert.ok(row);
    assert.equal(
      row.querySelector(".session-status")?.classList.contains("is-running"),
      true,
    );

    await act(async () =>
      row.querySelector<HTMLButtonElement>(".session-item")?.click(),
    );
    assert.equal(
      row.querySelector(".session-status")?.classList.contains("is-unread"),
      false,
    );
    assert.equal(
      row.querySelector(".session-status")?.classList.contains("is-running"),
      true,
      "selection must not overwrite a newer agent_start with settled=false",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a reply viewed before settlement does not become unread after leaving", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const backgroundId = "viewed-before-settle";
  const background: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: backgroundId,
      sessionId: "viewed-before-settle",
      name: "Viewed before settle",
      messageCount: 2,
      active: true,
      writable: true,
    },
    messages: [
      { role: "user", content: "question" },
      { role: "assistant", content: "reply already inspected" },
    ],
    messageTotal: 2,
    turnTotal: 1,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [...bootstrap.sessions, background.session],
      sessionsTotal: 2,
      activeSessionIds: [activeId, backgroundId],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async (id: string) =>
      id === backgroundId ? background : draftView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "message_end",
        piChatSessionId: backgroundId,
        message: { role: "assistant", content: "reply already inspected" },
      }),
    );
    const sessionButton = (name: string) =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ].find((button) => button.textContent?.includes(name));
    await act(async () => sessionButton("Viewed before settle")?.click());
    await act(async () => sessionButton("Active")?.click());
    await act(async () =>
      source.emitPi({ type: "agent_settled", piChatSessionId: backgroundId }),
    );

    const backgroundRow = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
    ].find((row) => row.textContent?.includes("Viewed before settle"));
    assert.ok(backgroundRow);
    assert.equal(
      backgroundRow
        .querySelector(".session-status")
        ?.classList.contains("is-unread"),
      false,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a stale sidebar snapshot cannot restore the running spinner after settlement", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const backgroundId = "running-stale-012345";
  const background = {
    ...draftView.session,
    id: backgroundId,
    sessionId: "running-stale",
    name: "Previously running",
    messageCount: 2,
    active: true,
    writable: true,
  };
  let staleExecution: "running" | "dispatching" = "running";
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [
        ...bootstrap.sessions,
        {
          ...background,
          running: true,
          activity: {
            execution: staleExecution,
            awaitingConfirmation: false,
          },
        },
      ],
      sessionsTotal: 2,
      activeSessionIds: [activeId, backgroundId],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({ type: "agent_settled", piChatSessionId: backgroundId }),
    );
    const statusIsRunning = () => {
      const row = [
        ...dom.window.document.querySelectorAll<HTMLElement>(".session-row"),
      ].find((candidate) =>
        candidate.textContent?.includes("Previously running"),
      );
      assert.ok(row);
      return row
        .querySelector(".session-status")
        ?.classList.contains("is-running");
    };
    await act(async () => {
      source.emitPi({ type: "pi_chat_sse_resync" });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      statusIsRunning(),
      false,
      "stale running activity cannot override settlement",
    );
    staleExecution = "dispatching";
    await act(async () => {
      source.emitPi({ type: "pi_chat_sse_resync" });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      statusIsRunning(),
      false,
      "stale dispatching activity cannot override settlement",
    );
    await act(async () =>
      source.emitPi({ type: "agent_start", piChatSessionId: backgroundId }),
    );
    assert.equal(
      statusIsRunning(),
      true,
      "a later authoritative agent_start must restore the spinner for the new turn",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("failed Primary keeps historical navigation and an editable recoverable draft", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      primaryRuntime: {
        status: "failed" as const,
        generation: 2,
        error: "protocol mismatch",
      },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const status = dom.window.document.querySelector<HTMLElement>(
      ".primary-runtime-status",
    )!;
    assert.match(status.textContent || "", /仍可阅读历史/);
    assert.match(status.textContent || "", /protocol mismatch/);
    assert.equal(status.parentElement?.className, "system-notice-stack");
    assert.equal(
      status.parentElement?.parentElement?.className,
      "composer-wrap",
    );
    const input = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    assert.equal(input.disabled, false);
    assert.doesNotMatch(input.placeholder, /Pi Runtime 当前不可用；恢复 ready 后才能输入/);
    // The server's ready SSE triggers a guarded background metadata refresh;
    // the status transition itself is covered by server contract tests. Keep
    // this JSDOM test focused on the failed-readiness capability boundary.
    assert.ok(FakeEventSource.instances.length > 0);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("changing Gate on cold history stages the next prompt without activating its Runtime", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "gate-cold-1234567890";
  const coldSummary = {
    ...bootstrap.sessions[0],
    id: coldId,
    sessionId: "gate-cold",
    name: "Cold Gate",
    active: false,
    writable: false,
  };
  const coldView: SessionViewData = {
    ...draftView,
    session: coldSummary,
    state: { ...bootstrap.state, sessionId: "gate-cold" },
    runtimeStatus: "view-only",
    isActive: false,
    gateMode: "strict",
  };
  const promptCalls: unknown[][] = [];
  let warmCalls = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], coldSummary],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === coldId ? coldView : draftView),
    warmSession: async (id: string) => {
      warmCalls += 1;
      return {
        sessionId: id,
        state: coldView.state,
        gateMode: "strict" as const,
      };
    },
    prompt: async (...args: unknown[]) => {
      promptCalls.push(args);
      return { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const sessionButton = [
      ...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      ),
    ].find((button) => button.textContent?.includes("Cold Gate"))!;
    await act(async () => sessionButton.click());
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".gate-control .compact-select-trigger",
    )!;
    assert.equal(trigger.textContent?.trim(), "严格");
    await act(async () => trigger.click());
    const openOption = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        ".gate-control .compact-select-option",
      ),
    ].find((option) => option.textContent?.trim() === "放行");
    assert.ok(openOption);
    await act(async () => openOption.click());
    assert.equal(trigger.textContent?.trim(), "放行");
    assert.equal(
      warmCalls,
      0,
      "changing Gate alone must not activate cold history",
    );
    assert.deepEqual(
      promptCalls,
      [],
      "changing Gate alone must not send an extension command",
    );

    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "first message");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "first message",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      warmCalls,
      1,
      "the first actual prompt may activate the Session",
    );
    assert.deepEqual(promptCalls, [["first message", [], coldId, "open"]]);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("an explicit active Gate choice supersedes an older cold staged mode", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "gate-active-choice-123";
  const coldSummary = {
    ...bootstrap.sessions[0],
    id: coldId,
    sessionId: "gate-active-choice",
    name: "Gate active choice",
    active: false,
    writable: true,
  };
  const coldView: SessionViewData = {
    ...draftView,
    session: coldSummary,
    state: { ...bootstrap.state, sessionId: "gate-active-choice" },
    runtimeStatus: "view-only",
    isActive: false,
    gateMode: "strict",
  };
  const promptCalls: unknown[][] = [];
  const autoAllowResponses: unknown[] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], coldSummary],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === coldId ? coldView : draftView),
    warmSession: async (id: string) => ({
      sessionId: id,
      state: coldView.state,
      gateMode: "strict" as const,
    }),
    respondToExtension: async (body: unknown) => {
      autoAllowResponses.push(body);
    },
    prompt: async (...args: unknown[]) => {
      promptCalls.push(args);
      const message = args[0];
      return typeof message === "string" && message.startsWith("/gate ")
        ? {
            accepted: true,
            queued: false,
            extension: true,
            command: "gate",
            isStreaming: false,
          }
        : { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ]
        .find((button) => button.textContent?.includes("Gate active choice"))!
        .click(),
    );
    const trigger = () =>
      dom.window.document.querySelector<HTMLButtonElement>(
        ".gate-control .compact-select-trigger",
      )!;
    const chooseGate = async (label: string) => {
      await act(async () => trigger().click());
      const option = [
        ...dom.window.document.querySelectorAll<HTMLElement>(
          ".gate-control .compact-select-option",
        ),
      ].find((candidate) => candidate.textContent?.trim() === label);
      assert.ok(option);
      await act(async () => option.click());
    };
    await chooseGate("放行");
    assert.equal(trigger().textContent?.trim(), "放行");

    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_session_control_changed",
        sessionId: coldId,
        controlOwner: "other-window",
        controlledByThisWindow: false,
      }),
    );
    await act(
      async () => new Promise((resolve) => dom.window.setTimeout(resolve, 450)),
    );
    assert.equal(
      trigger().textContent?.trim(),
      "放行",
      "cold staging survives an active foreign viewer",
    );
    await chooseGate("严格");
    assert.equal(
      trigger().textContent?.trim(),
      "严格",
      "the explicit active choice drops the stale cold preference",
    );
    await act(async () =>
      source.emitPi({
        type: "extension_ui_request",
        piChatSessionId: coldId,
        id: "strict-must-not-auto-allow",
        method: "select",
        title: "Pi Chat Gate: bash\necho strict",
        options: ["allow", "block"],
      }),
    );
    assert.deepEqual(
      autoAllowResponses,
      [],
      "the discarded cold open cannot revive auto-allow",
    );

    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "continue strictly");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "continue strictly",
        }),
      );
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(promptCalls.at(-1), [
      "continue strictly",
      [],
      coldId,
      "strict",
    ]);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a staged cold Gate mode cannot auto-allow before Runtime confirmation", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "gate-confirmation-123";
  const coldSummary = {
    ...bootstrap.sessions[0],
    id: coldId,
    sessionId: "gate-confirmation",
    name: "Gate confirmation",
    active: false,
    writable: false,
  };
  const coldView: SessionViewData = {
    ...draftView,
    session: coldSummary,
    state: { ...bootstrap.state, sessionId: "gate-confirmation" },
    runtimeStatus: "view-only",
    isActive: false,
    gateMode: "strict",
  };
  const responses: unknown[] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [bootstrap.sessions[0], coldSummary],
      sessionsTotal: 2,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === coldId ? coldView : draftView),
    respondToExtension: async (body: unknown) => {
      responses.push(body);
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () =>
      [
        ...dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".session-item",
        ),
      ]
        .find((button) => button.textContent?.includes("Gate confirmation"))!
        .click(),
    );
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".gate-control .compact-select-trigger",
    )!;
    await act(async () => trigger.click());
    const openOption = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        ".gate-control .compact-select-option",
      ),
    ].find((option) => option.textContent?.trim() === "放行");
    assert.ok(openOption);
    await act(async () => openOption.click());
    assert.equal(
      trigger.textContent?.trim(),
      "放行",
      "the staged preference remains visible",
    );

    const source = FakeEventSource.instances.at(-1)!;
    // Another browser action may warm this Runtime, but its ready state remains
    // strict until the staged value is synchronized by a real prompt.
    await act(async () =>
      source.emitPi({
        type: "pi_chat_gate_mode_changed",
        piChatSessionId: coldId,
        mode: "strict",
      }),
    );
    await act(async () =>
      source.emitPi({
        type: "extension_ui_request",
        piChatSessionId: coldId,
        id: "must-not-auto-allow",
        method: "select",
        title: "Pi Chat Gate: bash\necho strict",
        options: ["allow", "block"],
      }),
    );
    assert.deepEqual(
      responses,
      [],
      "an unconfirmed staged open value cannot auto-allow",
    );
    assert.ok(dom.window.document.querySelector(".extension-dialog"));

    await act(async () =>
      source.emitPi({
        type: "pi_chat_gate_mode_changed",
        piChatSessionId: coldId,
        mode: "open",
      }),
    );
    await act(async () =>
      source.emitPi({
        type: "extension_ui_request",
        piChatSessionId: coldId,
        id: "confirmed-auto-allow",
        method: "select",
        title: "Pi Chat Gate: bash\necho open",
        options: ["allow", "block"],
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    assert.deepEqual(responses, [
      {
        id: "confirmed-auto-allow",
        value: "allow",
        sessionId: coldId,
      },
    ]);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("Gate mode changes only after the Runtime confirms the command", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let resolveGate!: (value: {
    accepted: boolean;
    queued: boolean;
    extension: true;
    command: string;
    isStreaming: false;
  }) => void;
  const pendingGate = new Promise<{
    accepted: boolean;
    queued: boolean;
    extension: true;
    command: string;
    isStreaming: false;
  }>((resolve) => {
    resolveGate = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      gateMode: "strict",
      commands: [{ name: "gate", description: "Gate", source: "extension" }],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    prompt: async () => pendingGate,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".gate-control .compact-select-trigger",
    )!;
    assert.equal(trigger.textContent?.trim(), "严格");
    await act(async () => trigger.click());
    const openOption = [
      ...dom.window.document.querySelectorAll<HTMLElement>(
        ".gate-control .compact-select-option",
      ),
    ].find((option) => option.textContent?.trim() === "放行");
    assert.ok(openOption);
    await act(async () => openOption.click());
    assert.equal(
      trigger.textContent?.trim(),
      "严格",
      "pending HTTP must not optimistically enable auto-allow",
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "pi_chat_gate_mode_changed",
        piChatSessionId: activeId,
        mode: "open",
      }),
    );
    assert.equal(
      trigger.textContent?.trim(),
      "放行",
      "Runtime confirmation SSE must update every window before HTTP post-processing ends",
    );
    await act(async () =>
      resolveGate({
        accepted: true,
        queued: false,
        extension: true,
        command: "gate",
        isStreaming: false,
      }),
    );
    assert.equal(trigger.textContent?.trim(), "放行");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("the next turn carries the Gate mode shown after refresh", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const promptCalls: unknown[][] = [];
  Object.assign(api, {
    bootstrap: async () => ({ ...bootstrap, gateMode: "strict" }),
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
    const textarea =
      dom.window.document.querySelector<HTMLTextAreaElement>(
        ".composer textarea",
      )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "next turn");
      textarea.dispatchEvent(
        new dom.window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: "next turn",
        }),
      );
    });
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(".send-button")!
        .click(),
    );
    assert.deepEqual(promptCalls, [["next turn", [], activeId, "strict"]]);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
