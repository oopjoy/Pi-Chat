import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import type { BootstrapData } from "../../src/shared/types";
import { activeSessionId, createBootstrapFixture } from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom } from "../helpers/app-dom";

test("a deleted Session cannot return through a held bootstrap", async () => {
  const { dom, FakeEventSource } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const fixture = createBootstrapFixture();
  const staleText = "Deleted Session bootstrap history";
  let bootstrapCalls = 0;
  let resolveBootstrap!: (data: BootstrapData) => void;
  const pendingBootstrap = new Promise<BootstrapData>((resolve) => {
    resolveBootstrap = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      return bootstrapCalls === 1 ? fixture : pendingBootstrap;
    },
    eventsUrl: () => "/api/events",
    invalidateHandshake: () => undefined,
    renewPresence: async () => undefined,
    sessions: async () => ({ sessions: [], total: 0 }),
    markSessionViewed: async () => ({ viewing: "" }),
    clearSessionViewed: async () => ({ viewing: "" }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => source.emitPi({
      type: "pi_chat_application_lifecycle",
      lifecycle: "models-refreshing",
    }));
    await act(async () => source.emitPi({
      type: "pi_chat_application_lifecycle",
      lifecycle: "idle",
    }));
    assert.equal(bootstrapCalls, 2, "recovery bootstrap remains held");
    await act(async () => source.emitPi({
      type: "pi_chat_sessions_changed",
      action: "deleted",
      sessionId: activeSessionId,
    }));
    await act(async () => {
      resolveBootstrap({
        ...fixture,
        messages: [{ role: "assistant", content: staleText }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = dom.window.document.body.textContent || "";
    assert.equal(text.includes(staleText), false);
    assert.equal(text.includes("Active"), false);
    assert.equal(
      dom.window.document.querySelectorAll(".session-item").length,
      0,
      "stale bootstrap metadata cannot restore the deleted sidebar row",
    );
    assert.notEqual(
      dom.window.document.querySelector(".topbar-title")?.textContent,
      "Active",
      "stale bootstrap cannot commit the deleted Session pane",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
