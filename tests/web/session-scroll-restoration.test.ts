import assert from "node:assert/strict";
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

function withGeometry(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight });
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
    assert.equal(timeline.scrollTop, 2_400, "New must not inherit the previous Session reading position");
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
    assert.equal(timeline.scrollTop, 2_400, "New must move the old timeline to the latest position");
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
