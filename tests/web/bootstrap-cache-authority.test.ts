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

test("resource reload detaches a held bootstrap before capturing new authority", async () => {
  const { dom, FakeEventSource } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const fixture = createBootstrapFixture();
  const staleText = "Bootstrap started before resource reload";
  const freshText = "Bootstrap started after resource reload";
  let bootstrapCalls = 0;
  let resolveOldBootstrap!: (data: BootstrapData) => void;
  let resolveFreshBootstrap!: (data: BootstrapData) => void;
  const oldBootstrap = new Promise<BootstrapData>((resolve) => {
    resolveOldBootstrap = resolve;
  });
  const freshBootstrap = new Promise<BootstrapData>((resolve) => {
    resolveFreshBootstrap = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) return fixture;
      if (bootstrapCalls === 2) return oldBootstrap;
      return freshBootstrap;
    },
    eventsUrl: () => "/api/events",
    invalidateHandshake: () => undefined,
    renewPresence: async () => undefined,
    sessions: async () => ({
      sessions: fixture.sessions,
      total: fixture.sessions.length,
    }),
    markSessionViewed: async () => ({ viewing: activeSessionId }),
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
    assert.equal(bootstrapCalls, 2, "the pre-reload bootstrap remains held");

    await act(async () => source.emitPi({
      type: "pi_chat_application_lifecycle",
      lifecycle: "resources-reloading",
    }));
    await act(async () => source.emitPi({
      type: "pi_chat_application_lifecycle",
      lifecycle: "idle",
    }));
    assert.equal(
      bootstrapCalls,
      3,
      "post-reload recovery must start a new bootstrap instead of reusing the old request",
    );

    await act(async () => {
      resolveOldBootstrap({
        ...fixture,
        messages: [{ role: "assistant", content: staleText }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      dom.window.document.body.textContent?.includes(staleText),
      false,
      "the detached pre-reload bootstrap cannot paint with post-reload authority",
    );
    await act(async () => source.emitPi({
      type: "pi_chat_application_lifecycle",
      lifecycle: "idle",
    }));
    assert.equal(
      bootstrapCalls,
      3,
      "the old request finalizer cannot detach the live post-reload bootstrap",
    );

    await act(async () => {
      resolveFreshBootstrap({
        ...fixture,
        messages: [{ role: "assistant", content: freshText }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(
      dom.window.document.body.textContent?.includes(freshText),
      "the independently started post-reload bootstrap can commit",
    );
  } finally {
    await act(async () => {
      resolveOldBootstrap(fixture);
      resolveFreshBootstrap(fixture);
      root.unmount();
    });
    restoreApi();
  }
});
