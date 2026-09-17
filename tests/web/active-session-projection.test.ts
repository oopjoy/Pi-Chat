import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { act, createElement } from "react";
import type { BootstrapData, SessionViewData } from "../../src/shared/types";
import {
  createBootstrapFixture,
  createSessionViewFixture,
} from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom as installDom } from "../helpers/app-dom";

let bootstrap: BootstrapData;
let primaryView: SessionViewData;

beforeEach(() => {
  bootstrap = createBootstrapFixture();
  primaryView = createSessionViewFixture();
});

function secondaryFixture(id: string, name: string) {
  const session = {
    ...bootstrap.sessions[0],
    id,
    sessionId: id.slice(0, 20),
    name,
    active: false,
    writable: true,
  };
  const view: SessionViewData = {
    ...primaryView,
    session,
    state: { ...primaryView.state, sessionId: session.sessionId },
    isActive: true,
    runtimeStatus: "active",
  };
  return { session, view };
}

test("an equal-set reclaim SSE fences a held Bootstrap", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondaryId = "held-bootstrap-hot-123";
  const { session, view } = secondaryFixture(secondaryId, "Held hot");
  const currentBootstrap: BootstrapData = {
    ...bootstrap,
    sessions: [...bootstrap.sessions, { ...session, writable: false }],
    sessionsTotal: 2,
    activeSessionIds: [bootstrap.sessions[0].id],
  };
  const staleBootstrap: BootstrapData = {
    ...currentBootstrap,
    sessions: [...bootstrap.sessions, session],
    activeSessionIds: [bootstrap.sessions[0].id, secondaryId],
  };
  let bootstrapCalls = 0;
  let resolveHeld!: (value: BootstrapData) => void;
  const held = new Promise<BootstrapData>((resolve) => { resolveHeld = resolve; });
  const fastReads: boolean[] = [];
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1 ? currentBootstrap : held;
    },
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (
      _id: string,
      _turns?: number,
      options?: { fast?: boolean },
    ) => {
      fastReads.push(options?.fast === true);
      return { ...view, isActive: false, runtimeStatus: "view-only" };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({ type: "pi_chat_sse_resync" });
      await Promise.resolve();
    });
    assert.equal(bootstrapCalls, 2);
    await act(async () => {
      source.emitPi({
        type: "pi_chat_active_session_changed",
        sessionId: secondaryId,
        activeSessionIds: [bootstrap.sessions[0].id],
        reclaimed: true,
      });
      resolveHeld(staleBootstrap);
      await held;
      await Promise.resolve();
    });
    const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".session-item",
    )].find((candidate) => candidate.textContent?.includes("Held hot"))!;
    await act(async () => button.click());
    assert.deepEqual(
      fastReads,
      [false],
      "navigation must not borrow the stale Bootstrap hot-set membership",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a cached hot view cannot regain writable authority after reclaim", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondaryId = "cached-hot-view-1234";
  const { session, view } = secondaryFixture(secondaryId, "Cached hot");
  let secondaryReads = 0;
  let warmCalls = 0;
  const heldReconcile = new Promise<SessionViewData>(() => undefined);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [...bootstrap.sessions, session],
      sessionsTotal: 2,
      activeSessionIds: [bootstrap.sessions[0].id, secondaryId],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => {
      if (id !== secondaryId) return primaryView;
      secondaryReads += 1;
      return secondaryReads === 1 ? view : heldReconcile;
    },
    warmSession: async (id: string) => {
      warmCalls += 1;
      return { sessionId: id, state: view.state, gateMode: "strict" as const };
    },
    prompt: async () => ({ accepted: true, queued: false }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const sessionButton = (name: string) =>
      [...dom.window.document.querySelectorAll<HTMLButtonElement>(
        ".session-item",
      )].find((candidate) => candidate.textContent?.includes(name))!;
    await act(async () => sessionButton("Cached hot").click());
    await act(async () => sessionButton(bootstrap.sessions[0].name).click());
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "pi_chat_active_session_changed",
        sessionId: secondaryId,
        activeSessionIds: [bootstrap.sessions[0].id],
        reclaimed: true,
      });
      await Promise.resolve();
    });
    await act(async () => {
      sessionButton("Cached hot").click();
      await Promise.resolve();
    });
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "cached view must warm");
      textarea.dispatchEvent(new dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "cached view must warm",
      }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(warmCalls, 1);
    assert.ok(secondaryReads >= 2, "cache follow-up read remains in flight");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a held hot view cannot restore active status after reclaim SSE", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const secondaryId = "held-hot-view-123456";
  const { session, view } = secondaryFixture(secondaryId, "Held view");
  let resolveView!: (value: SessionViewData) => void;
  const heldView = new Promise<SessionViewData>((resolve) => { resolveView = resolve; });
  let warmCalls = 0;
  const promptCalls: unknown[][] = [];
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [...bootstrap.sessions, session],
      sessionsTotal: 2,
      activeSessionIds: [bootstrap.sessions[0].id, secondaryId],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => id === secondaryId ? heldView : primaryView,
    warmSession: async (id: string) => {
      warmCalls += 1;
      return { sessionId: id, state: view.state, gateMode: "strict" as const };
    },
    prompt: async (...args: unknown[]) => {
      promptCalls.push(args);
      return { accepted: true, queued: false };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".session-item",
    )].find((candidate) => candidate.textContent?.includes("Held view"))!;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      source.emitPi({
        type: "pi_chat_active_session_changed",
        sessionId: secondaryId,
        activeSessionIds: [bootstrap.sessions[0].id],
        reclaimed: true,
      });
      resolveView(view);
      await heldView;
      await Promise.resolve();
    });

    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='消息输入']",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "must warm again");
      textarea.dispatchEvent(new dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "must warm again",
      }));
      dom.window.document.querySelector<HTMLButtonElement>(".send-button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(warmCalls, 1);
    assert.equal(promptCalls.length, 1);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
