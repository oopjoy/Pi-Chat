import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { beforeEach } from "node:test";
import { act, createElement } from "react";
import type { BootstrapData, PiMessage, SessionViewData } from "../../src/shared/types";
import { activeSessionId as activeId, createBootstrapFixture, createSessionViewFixture } from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom as installDom } from "../helpers/app-dom";

let bootstrap: BootstrapData;

beforeEach(() => {
  bootstrap = createBootstrapFixture();
});

test("timeline rows keep real browser geometry for initial-bottom and restoration", () => {
  const css = readFileSync(new URL("../../src/web/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(
    css,
    /content-visibility\s*:/,
    "content-visibility may report provisional timeline geometry and break scroll restoration",
  );
  assert.doesNotMatch(
    css,
    /contain-intrinsic-size\s*:/,
    "intrinsic placeholders must not replace real timeline row heights",
  );
});

function withGeometry(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
  let top = 0;
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight });
  // Browsers clamp scrollTop to scrollHeight - clientHeight; model that here
  // instead of allowing jsdom to accept an impossible scrollTop.
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.min(Math.max(0, value), Math.max(0, scrollHeight - clientHeight));
    },
  });
}

function activeMessages(): PiMessage[] {
  return [
    { role: "user", content: "older question" },
    { role: "assistant", content: "older answer" },
    { role: "user", content: "latest question" },
    { role: "assistant", content: "latest answer" },
  ];
}

function viewFor(session: BootstrapData["sessions"][number], messages: PiMessage[]): SessionViewData {
  const view = createSessionViewFixture();
  return {
    ...view,
    session,
    state: {
      ...view.state,
      sessionId: session.sessionId,
      sessionName: session.name,
      messageCount: messages.length,
    },
    messages,
    messageTotal: messages.length,
    turnTotal: messages.filter((message) => message.role === "user").length,
    visibleTurnCount: messages.filter((message) => message.role === "user").length,
    isActive: session.active,
    runtimeStatus: "view-only",
  };
}

test("opening New resets a reused timeline to the latest bottom", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const messages = activeMessages();
  const active = { ...bootstrap.sessions[0], messageCount: messages.length, preview: "latest answer" };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [active],
      messages,
      messageTotal: messages.length,
      turnTotal: 2,
      visibleTurnCount: 2,
      state: { ...bootstrap.state, messageCount: messages.length },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const timeline = dom.window.document.querySelector<HTMLElement>(".timeline")!;
    withGeometry(timeline, 2_400, 600);
    timeline.scrollTop = 280;
    timeline.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    const newButton = dom.window.document.querySelector<HTMLButtonElement>(".new-chat")!;
    await act(async () => {
      newButton.click();
      await Promise.resolve();
    });
    assert.equal(timeline.scrollTop, 1_800, "New must not inherit the previous Session reading position");
  } finally {
    restoreApi();
    await act(async () => root.unmount());
  }
});

test("switching A to B and back restores A's last reading position", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const messages = activeMessages();
  const sessionA = { ...bootstrap.sessions[0], messageCount: messages.length, preview: "A latest answer" };
  const sessionB = {
    ...bootstrap.sessions[0],
    id: "fedcba9876543210abcd",
    sessionId: "history-b",
    name: "History B",
    messageCount: messages.length,
    preview: "B latest answer",
    active: false,
  };
  const viewA = viewFor(sessionA, messages);
  const viewB = viewFor(sessionB, messages.map((message) => ({
    ...message,
    content: typeof message.content === "string" ? `${message.content} B` : message.content,
  })));
  let resolveViewB!: (view: SessionViewData) => void;
  const pendingViewB = new Promise<SessionViewData>((resolve) => {
    resolveViewB = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [sessionA, sessionB],
      messages,
      messageTotal: messages.length,
      turnTotal: 2,
      visibleTurnCount: 2,
      state: { ...bootstrap.state, messageCount: messages.length },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async (id: string) => (id === sessionB.id ? pendingViewB : viewA),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const timeline = dom.window.document.querySelector<HTMLElement>(".timeline")!;
    withGeometry(timeline, 2_400, 600);
    timeline.scrollTop = 420;
    timeline.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    const sessionButton = (name: string) => [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")]
      .find((button) => button.textContent?.includes(name))!;
    await act(async () => {
      sessionButton("History B").click();
      await Promise.resolve();
    });
    assert.doesNotMatch(
      timeline.textContent || "",
      /older question B/,
      "A remains the painted pane while the B view is pending",
    );
    // The destination view is still pending while A is being replaced by the
    // loading pane. Browsers emit a scroll event for that transient geometry;
    // it must not overwrite A's saved position with the loading pane's top.
    timeline.scrollTop = 0;
    timeline.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));

    resolveViewB(viewB);
    await Promise.resolve();
    assert.doesNotMatch(
      timeline.textContent || "",
      /older question B/,
      "the old A DOM remains painted until React flushes B",
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(timeline.textContent || "", /older question B/);
    await act(async () => {
      sessionButton("Active").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      timeline.scrollTop,
      420,
      "A → loading B → transient scroll event → B → A must restore A's saved position",
    );
  } finally {
    restoreApi();
    await act(async () => root.unmount());
  }
});

test("returning to a hot Session restores its remembered reading position", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const messages = activeMessages();
  const sessionA = { ...bootstrap.sessions[0], messageCount: messages.length, preview: "latest answer" };
  const viewA = viewFor(sessionA, messages);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      sessions: [sessionA],
      messages,
      messageTotal: messages.length,
      turnTotal: 2,
      visibleTurnCount: 2,
      state: { ...bootstrap.state, messageCount: messages.length },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async (id: string) => ({ viewing: id }),
    viewSession: async () => viewA,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const timeline = dom.window.document.querySelector<HTMLElement>(".timeline")!;
    withGeometry(timeline, 2_400, 600);
    timeline.scrollTop = 420;
    timeline.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    const newButton = dom.window.document.querySelector<HTMLButtonElement>(".new-chat")!;
    await act(async () => {
      newButton.click();
      await Promise.resolve();
    });
    assert.equal(timeline.scrollTop, 1_800, "New must move the old timeline to the latest position");
    const sessionAButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")]
      .find((button) => button.textContent?.includes("Active"));
    assert.ok(sessionAButton);
    await act(async () => {
      sessionAButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(dom.window.document.querySelector(".topbar-title")?.textContent, "Active");
    assert.equal(timeline.scrollTop, 420, "a hot Session must return to its last non-bottom reading position");
  } finally {
    restoreApi();
    await act(async () => root.unmount());
  }
});
