import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import type { BootstrapData, SessionViewData } from "../../src/shared/types";
import { activeSessionId, createBootstrapFixture, createSessionViewFixture } from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom } from "../helpers/app-dom";

for (const statusShape of ["activity", "legacy", "stop"] as const) {
  for (const replacement of [false, true]) {
    test(`${statusShape} status reconciliation ${replacement ? "cannot repopulate a replacement cache" : "can cache after same-process navigation"}`, async () => {
      const { dom, FakeEventSource } = installAppDom();
      const { createRoot } = await import("react-dom/client");
      const { api } = await import("../../src/web/api");
      const { App } = await import("../../src/web/App");
      const restoreApi = captureApiSnapshot(api);
      const fixture = createBootstrapFixture();
      const lateText = "Late response owned by process A";
      const currentText = "Current response owned by process B";
      const bootstrapFor = (epoch: string): BootstrapData => ({
        ...fixture,
        workspaceEpoch: epoch,
        state: { ...fixture.state, isStreaming: statusShape === "stop" && epoch === "epoch-a" },
        messages: [{ role: "assistant", content: epoch === "epoch-a" ? "Initial process A history" : currentText }],
      });
      const viewFor = (text: string): SessionViewData => ({
        ...createSessionViewFixture(),
        session: fixture.sessions[0],
        state: fixture.state,
        messages: [{ role: "assistant", content: text }],
        messageTotal: 1,
        viewSource: "hot-memory",
      });
      let epoch = "epoch-a";
      let bootstrapCalls = 0;
      let viewCalls = 0;
      let resolveOld!: (view: SessionViewData) => void;
      let resolveFresh!: (view: SessionViewData) => void;
      const pendingOld = new Promise<SessionViewData>((resolve) => { resolveOld = resolve; });
      const pendingFresh = new Promise<SessionViewData>((resolve) => { resolveFresh = resolve; });
      Object.assign(api, {
        bootstrap: async () => { bootstrapCalls += 1; return bootstrapFor(epoch); },
        eventsUrl: () => "/api/events",
        markSessionViewed: async (id: string) => ({ viewing: id }),
        clearSessionViewed: async () => ({ viewing: "" }),
        invalidateHandshake: () => undefined,
        renewPresence: async () => undefined,
        sessions: async () => ({ sessions: fixture.sessions, total: fixture.sessions.length }),
        abort: async (id: string) => {
          assert.equal(id, activeSessionId);
          return { isStreaming: false, queuePaused: false };
        },
        viewSession: async (id: string) => {
          assert.equal(id, activeSessionId);
          viewCalls += 1;
          return viewCalls === 1 ? pendingOld : pendingFresh;
        },
      });
      const root = createRoot(dom.window.document.querySelector("#root")!);
      try {
        await act(async () => root.render(createElement(App)));
        assert.equal(viewCalls, 0, "bootstrap supplies initial history without a competing view read");
        const source = FakeEventSource.instances.at(-1)!;
        if (statusShape === "stop") {
          const stop = dom.window.document.querySelector<HTMLButtonElement>(".stop-button");
          assert.ok(stop);
          await act(async () => stop.click());
        } else {
          await act(async () => source.emitPi({
            type: "pi_chat_session_status",
            piChatSessionId: activeSessionId,
            piChatRunEpoch: "epoch-a",
            piChatRunGeneration: 1,
            ...(statusShape === "activity"
              ? { activity: { execution: "idle", awaitingConfirmation: false } }
              : { running: false }),
          }));
        }
        assert.equal(viewCalls, 1, "terminal observation starts the held reconciliation read");

        if (replacement) {
          epoch = "epoch-b";
          await act(async () => source.dispatchEvent(new dom.window.MessageEvent("ready", {
            data: JSON.stringify({ lifecycle: "idle", piChatRunEpoch: epoch, workspaceEpoch: epoch }),
          })));
          assert.equal(bootstrapCalls, 2, "replacement commits its own bootstrap before the old view resolves");
          assert.ok(dom.window.document.body.textContent?.includes(currentText));
        }
        const newButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.trim() === "New");
        assert.ok(newButton);
        await act(async () => newButton.click());
        await act(async () => resolveOld(viewFor(lateText)));
        assert.ok(dom.window.document.querySelector(".draft-workspace"), "late response cannot paint over New");
        assert.equal(dom.window.document.body.textContent?.includes(lateText), false);

        const activeButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".session-item")]
          .find((button) => button.textContent?.includes("Active"));
        assert.ok(activeButton);
        const sources: string[] = [];
        dom.window.addEventListener("pi-chat:pane-first-commit", ((event: CustomEvent) => {
          sources.push(event.detail.source);
        }) as EventListener);
        await act(async () => activeButton.click());
        assert.equal(viewCalls, 2, "a fresh navigation reconciliation remains held while the cache paints");
        assert.ok(sources.includes("browser-cache"), "assertions observe cached history, not a newer HTTP response");
        const text = dom.window.document.body.textContent || "";
        if (replacement) {
          assert.equal(text.includes(lateText), false, "old process response must not re-enter the replacement cache");
          assert.ok(text.includes(currentText), "replacement bootstrap remains the cached history authority");
        } else {
          assert.ok(text.includes(lateText), "same-process navigation still retains useful background reconciliation");
        }
      } finally {
        await act(async () => {
          resolveOld(viewFor(lateText));
          resolveFresh(viewFor(currentText));
          root.unmount();
        });
        restoreApi();
      }
    });
  }
}
