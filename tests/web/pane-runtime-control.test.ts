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

test("a historical view with unknown queue authority cannot erase a newer Queue projection", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondId = "33333333333333333333";
  const queued = {
    id: "queue-unknown-view",
    message: "must remain visible",
    imageCount: 0,
    createdAt: 3,
  };
  const sessionA = {
    ...bootstrap.sessions[0],
    running: true,
    queued: true,
    activity: { execution: "running" as const, awaitingConfirmation: false },
  };
  const sessionB = {
    ...bootstrap.sessions[0],
    id: secondId,
    sessionId: "second",
    name: "Session B",
    active: false,
    running: false,
    activity: { execution: "idle" as const, awaitingConfirmation: false },
  };
  const viewA: SessionViewData = {
    ...draftView,
    session: sessionA,
    state: { ...bootstrap.state, sessionId: "active", isStreaming: true },
    isActive: true,
    isStreaming: true,
    queue: [queued],
    queuePaused: true,
  };
  const viewB: SessionViewData = {
    ...draftView,
    session: sessionB,
    state: { ...bootstrap.state, sessionId: "second", isStreaming: false },
    isActive: false,
    isStreaming: false,
    queue: [],
    queuePaused: false,
  };
  const { queue: _queue, queuePaused: _queuePaused, ...viewAWithoutQueue } = viewA;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
      sessions: [sessionA, sessionB],
      queue: [queued],
      queuePaused: true,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => id === secondId ? viewB : viewAWithoutQueue,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const clickSession = async (label: string) => {
    const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")]
      .find((candidate) => candidate.textContent?.includes(label));
    assert.ok(button);
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    });
  };
  try {
    await act(async () => root.render(createElement(App)));
    assert.match(dom.window.document.querySelector(".prompt-queue")?.textContent || "", /must remain visible/);
    await clickSession("Session B");
    await clickSession("Active");
    assert.match(
      dom.window.document.querySelector(".prompt-queue")?.textContent || "",
      /must remain visible/,
      "an omitted queue field is unknown, not an authoritative empty queue",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
