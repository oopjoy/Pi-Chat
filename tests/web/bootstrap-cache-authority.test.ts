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
        primaryRuntime: {
          status: "failed",
          generation: 9,
          error: "stale pre-reload Runtime failure",
        },
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
    assert.equal(
      dom.window.document.body.textContent?.includes(
        "stale pre-reload Runtime failure",
      ),
      false,
      "the detached bootstrap cannot update the post-reload Runtime projection",
    );
    assert.equal(
      dom.window.document
        .querySelector(".primary-runtime-status")
        ?.classList.contains("is-starting"),
      true,
      "Runtime projection remains at the reload boundary while fresh bootstrap is held",
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
        primaryRuntime: { status: "ready", generation: 1 },
        messages: [{ role: "assistant", content: freshText }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(
      dom.window.document.body.textContent?.includes(freshText),
      "the independently started post-reload bootstrap can commit",
    );
    assert.equal(
      dom.window.document.querySelector(".primary-runtime-status.is-starting"),
      null,
      "fresh post-reload readiness replaces the starting projection",
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

test("a newer Runtime observation cannot reuse an older bootstrap request", async () => {
  const { dom, FakeEventSource } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const fixture = createBootstrapFixture();
  const initial = {
    ...fixture,
    primaryRuntime: { status: "starting" as const, generation: 7 },
  };
  const staleText = "pre-observation bootstrap";
  const freshText = "post-observation bootstrap";
  let bootstrapCalls = 0;
  let resolveOld!: (data: BootstrapData) => void;
  let resolveFresh!: (data: BootstrapData) => void;
  const oldBootstrap = new Promise<BootstrapData>((resolve) => {
    resolveOld = resolve;
  });
  const freshBootstrap = new Promise<BootstrapData>((resolve) => {
    resolveFresh = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) return initial;
      if (bootstrapCalls === 2) return oldBootstrap;
      return freshBootstrap;
    },
    eventsUrl: () => "/api/events",
    renewPresence: async () => undefined,
    markSessionViewed: async () => ({ viewing: activeSessionId }),
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
        type: "pi_chat_primary_runtime_status",
        primaryRuntime: {
          status: "ready",
          generation: 7,
          model: fixture.state.model,
          sessionId: activeSessionId,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      bootstrapCalls,
      3,
      "post-observation refresh must not borrow the older request",
    );

    await act(async () => {
      resolveOld({
        ...initial,
        messages: [{ role: "assistant", content: staleText }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(dom.window.document.body.textContent?.includes(staleText), false);

    await act(async () => {
      resolveFresh({
        ...fixture,
        primaryRuntime: {
          ...fixture.primaryRuntime!,
          generation: 7,
        },
        messages: [{ role: "assistant", content: freshText }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(dom.window.document.body.textContent?.includes(freshText));
  } finally {
    await act(async () => {
      resolveOld(fixture);
      resolveFresh(fixture);
      root.unmount();
    });
    restoreApi();
  }
});

test("resource-reload ready is a self-contained boundary and malformed lifecycle cannot unlock it", async () => {
  const { dom, FakeEventSource } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const fixture = createBootstrapFixture();
  const staleText = "bootstrap before maintenance ready";
  const freshText = "bootstrap after maintenance ready";
  let bootstrapCalls = 0;
  let resolveOld!: (data: BootstrapData) => void;
  let resolveFresh!: (data: BootstrapData) => void;
  const oldBootstrap = new Promise<BootstrapData>((resolve) => {
    resolveOld = resolve;
  });
  const freshBootstrap = new Promise<BootstrapData>((resolve) => {
    resolveFresh = resolve;
  });
  Object.assign(api, {
    bootstrap: async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) return fixture;
      if (bootstrapCalls === 2) return oldBootstrap;
      return freshBootstrap;
    },
    eventsUrl: () => "/api/events",
    renewPresence: async () => undefined,
    markSessionViewed: async () => ({ viewing: activeSessionId }),
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

    await act(async () => source.dispatchEvent(
      new dom.window.MessageEvent("ready", {
        data: JSON.stringify({
          ok: true,
          lifecycle: "resources-reloading",
          piChatRunEpoch: "epoch-a",
          primaryRuntime: fixture.primaryRuntime,
        }),
      }) as unknown as Event,
    ));
    assert.ok(
      dom.window.document.querySelector(".primary-runtime-status.is-starting"),
      "maintenance snapshot clears the pre-reload readiness projection",
    );

    await act(async () => source.dispatchEvent(
      new dom.window.MessageEvent("ready", {
        data: JSON.stringify({
          ok: true,
          piChatRunEpoch: "epoch-b",
          primaryRuntime: {
            status: "failed",
            generation: 99,
            error: "malformed ready must be inert",
          },
        }),
      }) as unknown as Event,
    ));
    assert.ok(
      dom.window.document.querySelector(".primary-runtime-status.is-starting"),
      "malformed ready cannot change process or readiness authority",
    );
    assert.equal(
      dom.window.document.body.textContent?.includes("malformed ready must be inert"),
      false,
    );

    await act(async () => {
      source.emitPi({ type: "pi_chat_application_lifecycle", lifecycle: "" });
      source.emitPi({ type: "pi_chat_application_lifecycle" });
      await Promise.resolve();
    });
    assert.equal(
      bootstrapCalls,
      2,
      "malformed lifecycle frames cannot manufacture idle recovery",
    );
    assert.ok(
      dom.window.document.querySelector(".primary-runtime-status.is-starting"),
    );

    await act(async () => source.dispatchEvent(
      new dom.window.MessageEvent("ready", {
        data: JSON.stringify({
          ok: true,
          lifecycle: "idle",
          piChatRunEpoch: "epoch-a",
          primaryRuntime: { status: "ready", generation: 1 },
        }),
      }) as unknown as Event,
    ));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      bootstrapCalls,
      3,
      "idle ready starts a fresh post-maintenance bootstrap",
    );

    await act(async () => {
      resolveOld({
        ...fixture,
        primaryRuntime: {
          status: "failed",
          generation: 9,
          error: staleText,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(dom.window.document.body.textContent?.includes(staleText), false);

    await act(async () => {
      resolveFresh({
        ...fixture,
        primaryRuntime: { status: "ready", generation: 1 },
        messages: [{ role: "assistant", content: freshText }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(dom.window.document.body.textContent?.includes(freshText));
  } finally {
    await act(async () => {
      resolveOld(fixture);
      resolveFresh(fixture);
      root.unmount();
    });
    restoreApi();
  }
});
