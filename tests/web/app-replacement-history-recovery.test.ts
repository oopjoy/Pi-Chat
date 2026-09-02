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


test("a replacement invalidates an old early handshake and starts a fresh history request", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "abcdef0123456789abcd";
  dom.window.history.replaceState(null, "", `/?session=${coldId}`);
  let bootstrapCalls = 0;
  let resolveOldHandshake!: (
    value: Awaited<ReturnType<typeof api.handshake>>,
  ) => void;
  let resolveNewHandshake!: (
    value: Awaited<ReturnType<typeof api.handshake>>,
  ) => void;
  const oldHandshake = new Promise<Awaited<ReturnType<typeof api.handshake>>>(
    (resolve) => {
      resolveOldHandshake = resolve;
    },
  );
  const newHandshake = new Promise<Awaited<ReturnType<typeof api.handshake>>>(
    (resolve) => {
      resolveNewHandshake = resolve;
    },
  );
  let rejectInitialBootstrap!: (cause: Error) => void;
  const rejectedInitialBootstrap = new Promise<BootstrapData>(
    (_resolve, reject) => {
      rejectInitialBootstrap = reject;
    },
  );
  const pendingBootstrap = new Promise<BootstrapData>(() => undefined);
  const acceptedTokens: string[] = [];
  let handshakeCalls = 0;
  let viewCalls = 0;
  const view = (content: string): SessionViewData => ({
    ...draftView,
    session: {
      ...draftView.session,
      id: coldId,
      sessionId: "remembered",
      name: "Replacement history",
      messageCount: 2,
      active: false,
      writable: false,
    },
    state: { ...draftView.state, sessionId: coldId },
    messages: [{ role: "assistant", content }],
    messageTotal: 2,
    runtimeStatus: "view-only",
    isActive: false,
  });
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1 ? rejectedInitialBootstrap : pendingBootstrap;
    },
    handshake: async () => {
      handshakeCalls += 1;
      return handshakeCalls === 1 ? oldHandshake : newHandshake;
    },
    acceptHandshake: (handshake: Awaited<ReturnType<typeof api.handshake>>) => {
      acceptedTokens.push(handshake.requestToken);
    },
    invalidateHandshake: () => undefined,
    eventsUrl: () => "/api/events",
    viewSession: async () => {
      viewCalls += 1;
      return view("replacement history");
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => {
      root.render(createElement(App));
      rejectInitialBootstrap(new Error("initial bootstrap unavailable"));
      await Promise.resolve();
    });
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-old",
            workspaceEpoch: "epoch-old",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    assert.equal(
      bootstrapCalls,
      2,
      "A ready begins its pending recovery bootstrap",
    );
    assert.equal(
      handshakeCalls,
      1,
      "the old refresh begins its delayed handshake",
    );
    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-new",
            workspaceEpoch: "epoch-new",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    assert.equal(bootstrapCalls, 3, "replacement starts a distinct bootstrap");
    assert.equal(
      handshakeCalls,
      2,
      "replacement starts a fresh handshake instead of joining A",
    );
    await act(async () => {
      resolveNewHandshake({
        requestToken: "token-new",
        buildIdentity: {
          schemaVersion: 1,
          packageVersion: "test",
          revision: "new",
          fingerprint: "0".repeat(64),
          builtAt: "new",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      viewCalls,
      1,
      "the replacement performs its own early history view",
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /replacement history/,
    );
    assert.deepEqual(acceptedTokens, ["token-new"]);
    await act(async () => {
      resolveOldHandshake({
        requestToken: "token-old",
        buildIdentity: {
          schemaVersion: 1,
          packageVersion: "test",
          revision: "old",
          fingerprint: "1".repeat(64),
          builtAt: "old",
        },
      });
      await Promise.resolve();
    });
    assert.equal(
      viewCalls,
      1,
      "an old handshake cannot send an old-token history request",
    );
    assert.deepEqual(
      acceptedTokens,
      ["token-new"],
      "an old handshake cannot restore its token",
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /replacement history/,
    );
    assert.doesNotMatch(
      dom.window.document.body.textContent || "",
      /网页与服务版本不一致/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a replacement clears old sidebar inventory so its slow bootstrap still uses Session Index", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let bootstrapCalls = 0;
  let sessionReads = 0;
  const pendingReplacementBootstrap = new Promise<BootstrapData>(
    () => undefined,
  );
  const replacementSession = {
    ...bootstrap.sessions[0],
    id: "22222222222222222222",
    sessionId: "replacement",
    name: "Replacement row",
    cwd: "D:/replacement",
    active: false,
  };
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1 ? bootstrap : pendingReplacementBootstrap;
    },
    eventsUrl: () => "/api/events",
    sessions: async () => {
      sessionReads += 1;
      return { sessions: [replacementSession], total: 1, directories: [] };
    },
    markSessionViewed: async () => ({ viewing: activeId }),
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
    assert.match(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /Active/,
    );
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-new",
            workspaceEpoch: "epoch-new",
          }),
        }),
      ),
    );
    assert.equal(bootstrapCalls, 2);
    assert.ok(
      sidebarTimers.length >= 2,
      "the replacement schedules a fresh Session Index fallback after the cleared A timer",
    );
    const readsBeforeReplacementFallback = sessionReads;
    await act(async () => {
      sidebarTimers.at(-1)!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(
      sessionReads > readsBeforeReplacementFallback,
      "A's completed inventory cannot suppress B's fallback",
    );
    assert.match(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /d:\/replacement1/,
    );
    assert.doesNotMatch(
      dom.window.document.querySelector(".session-list")?.textContent || "",
      /c:\/work1/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a same-epoch recovery refresh detaches an older early handshake and paints cold history", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const coldId = "abcdef0123456789abcd";
  dom.window.history.replaceState(null, "", `/?session=${coldId}`);
  let bootstrapCalls = 0;
  let rejectInitialBootstrap!: (cause: Error) => void;
  const initialBootstrap = new Promise<BootstrapData>((_resolve, reject) => {
    rejectInitialBootstrap = reject;
  });
  const pendingRecoveryBootstrap = new Promise<BootstrapData>(() => undefined);
  let resolveFirstHandshake!: (
    value: Awaited<ReturnType<typeof api.handshake>>,
  ) => void;
  let resolveSecondHandshake!: (
    value: Awaited<ReturnType<typeof api.handshake>>,
  ) => void;
  const firstHandshake = new Promise<Awaited<ReturnType<typeof api.handshake>>>(
    (resolve) => {
      resolveFirstHandshake = resolve;
    },
  );
  const secondHandshake = new Promise<
    Awaited<ReturnType<typeof api.handshake>>
  >((resolve) => {
    resolveSecondHandshake = resolve;
  });
  let handshakeCalls = 0;
  let viewCalls = 0;
  const coldView: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: coldId,
      sessionId: "remembered",
      name: "Recovered cold",
      messageCount: 2,
      active: false,
      writable: false,
    },
    state: { ...draftView.state, sessionId: coldId },
    messages: [{ role: "assistant", content: "recovered cold history" }],
    messageTotal: 2,
    runtimeStatus: "view-only",
    isActive: false,
  };
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1 ? initialBootstrap : pendingRecoveryBootstrap;
    },
    handshake: async () => {
      handshakeCalls += 1;
      return handshakeCalls === 1 ? firstHandshake : secondHandshake;
    },
    acceptHandshake: () => undefined,
    eventsUrl: () => "/api/events",
    viewSession: async () => {
      viewCalls += 1;
      return coldView;
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    assert.equal(
      handshakeCalls,
      1,
      "R1 starts its early handshake before bootstrap fails",
    );
    await act(async () => {
      rejectInitialBootstrap(new Error("initial bootstrap unavailable"));
      await Promise.resolve();
    });
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({
            lifecycle: "idle",
            piChatRunEpoch: "epoch-a",
            workspaceEpoch: "epoch-a",
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    assert.equal(
      bootstrapCalls,
      2,
      "ready starts the slow same-epoch recovery bootstrap",
    );
    assert.equal(
      handshakeCalls,
      2,
      "R2 must detach from R1 and begin its own handshake",
    );
    await act(async () => {
      resolveFirstHandshake({
        requestToken: "token-r1",
        buildIdentity: {
          schemaVersion: 1,
          packageVersion: "test",
          revision: "r1",
          fingerprint: "1".repeat(64),
          builtAt: "r1",
        },
      });
      await Promise.resolve();
    });
    assert.equal(
      viewCalls,
      0,
      "the old handshake cannot produce an old early view",
    );
    await act(async () => {
      resolveSecondHandshake({
        requestToken: "token-r2",
        buildIdentity: {
          schemaVersion: 1,
          packageVersion: "test",
          revision: "r2",
          fingerprint: "0".repeat(64),
          builtAt: "r2",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      viewCalls,
      1,
      "R2's fresh handshake reads the remembered JSONL history",
    );
    assert.match(
      dom.window.document.body.textContent || "",
      /recovered cold history/,
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
