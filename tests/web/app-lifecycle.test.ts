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


test("foreground presence renews on ready, visible lifecycle events, stays quiet while hidden, and cleans up on unmount", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  let renewals = 0;
  let relinquishments = 0;
  const closeForegroundIntents: boolean[] = [];
  Object.assign(api, {
    bootstrap: async () => bootstrap,
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    renewPresence: async () => {
      renewals += 1;
      return { present: true as const };
    },
    relinquishPresence: async () => {
      relinquishments += 1;
      return { present: false as const };
    },
    signalWindowClose: (foreground: boolean) => {
      closeForegroundIntents.push(foreground);
      return true;
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(renewals >= 1, "visible initial lifecycle renews presence");
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.dispatchEvent(
        new dom.window.MessageEvent("ready", {
          data: JSON.stringify({ lifecycle: "idle" }),
        }),
      ),
    );
    assert.ok(renewals >= 2, "ready renews presence");
    const beforeFocus = renewals;
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("focus")),
    );
    assert.ok(renewals > beforeFocus, "focus renews presence");
    Object.defineProperty(dom.window.document, "hasFocus", {
      value: () => false,
      configurable: true,
    });
    const beforeBlur = renewals;
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("blur")),
    );
    assert.equal(
      relinquishments,
      0,
      "ordinary blur pauses renewal without immediately releasing foreground control",
    );
    assert.equal(
      closeForegroundIntents.length,
      0,
      "blur must not declare the browser window closed",
    );
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("focus")),
    );
    assert.equal(
      renewals,
      beforeBlur,
      "focus without document focus cannot renew foreground presence",
    );
    Object.defineProperty(dom.window.document, "hasFocus", {
      value: () => true,
      configurable: true,
    });
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("focus")),
    );
    assert.ok(
      renewals > beforeBlur,
      "a genuinely focused renderer renews presence",
    );
    const sourcesBeforeFailedRenewal = FakeEventSource.instances.length;
    Object.assign(api, {
      renewPresence: async () => {
        throw new Error("temporary presence failure");
      },
    });
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      dom.window.document.querySelector(".app-toast.error"),
      null,
      "best-effort presence failure must not become a visible error",
    );
    assert.equal(
      FakeEventSource.instances.length,
      sourcesBeforeFailedRenewal,
      "presence failure must not create a reconnect storm",
    );
    Object.assign(api, {
      renewPresence: async () => {
        renewals += 1;
        return { present: true as const };
      },
    });
    Object.defineProperty(dom.window.document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    const beforeHidden = renewals;
    await act(async () =>
      dom.window.document.dispatchEvent(
        new dom.window.Event("visibilitychange"),
      ),
    );
    assert.equal(renewals, beforeHidden, "hidden pages do not renew presence");
    Object.defineProperty(dom.window.document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("pageshow")),
    );
    assert.ok(renewals > beforeHidden, "pageshow renews presence");
    const relinquishmentsBeforeClose = relinquishments;
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("beforeunload")),
    );
    assert.deepEqual(
      closeForegroundIntents,
      [],
      "beforeunload only latches intent because navigation may still be cancelled",
    );
    Object.defineProperty(dom.window.document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    await act(async () =>
      dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")),
    );
    assert.equal(
      relinquishments,
      relinquishmentsBeforeClose,
      "the latched close sequence preserves the fresh foreground lease required by the server",
    );
    await act(async () =>
      dom.window.dispatchEvent(
        new dom.window.PageTransitionEvent("pagehide", { persisted: false }),
      ),
    );
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("unload")),
    );
    assert.deepEqual(
      closeForegroundIntents,
      [true],
      "unload sends the foreground intent latched before the hidden transition",
    );
    Object.defineProperty(dom.window.document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("pageshow")),
    );
    Object.defineProperty(dom.window.document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    await act(async () =>
      dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")),
    );
    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("unload")),
    );
    assert.deepEqual(
      closeForegroundIntents,
      [true, false],
      "an already-hidden discard without beforeunload cannot request service shutdown",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("a build mismatch blocks ordinary mutations but preserves server-guarded lifecycle recovery", async () => {
  assert.equal(
    process.env.NODE_ENV,
    "test",
    "此测试依赖受限的 Web identity override；请使用 `npm test` 或 `node scripts/run-tests.mjs` 运行。",
  );
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const testGlobal = globalThis as typeof globalThis & {
    __PI_CHAT_TEST_WEB_BUILD_IDENTITY__?: BootstrapData["buildIdentity"];
  };
  testGlobal.__PI_CHAT_TEST_WEB_BUILD_IDENTITY__ = {
    schemaVersion: 1,
    packageVersion: "test",
    revision: "test",
    fingerprint: "0".repeat(64),
    builtAt: "test",
  };
  let restartCalls = 0;
  let shutdownCalls = 0;
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      buildIdentity: {
        schemaVersion: 1,
        packageVersion: "test",
        revision: "test",
        fingerprint: "1".repeat(64),
        builtAt: "test",
      },
    }),
    eventsUrl: () => "/api/events",
    restart: async () => {
      restartCalls += 1;
      return { restarting: true as const };
    },
    shutdown: async () => {
      shutdownCalls += 1;
      return { shuttingDown: true as const };
    },
    waitForApplicationHandoff: async () => {
      throw new Error("test handoff unavailable");
    },
    markSessionViewed: async () => ({ viewing: activeId }),
    renewPresence: async () => ({ present: true as const }),
    signalWindowClose: () => true,
  });
  Object.defineProperty(dom.window, "confirm", {
    value: () => true,
    configurable: true,
  });
  Object.defineProperty(dom.window, "close", {
    value: () => undefined,
    configurable: true,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => {
      root.render(createElement(App));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(
      dom.window.document.body.textContent || "",
      /网页与服务版本不一致/,
    );
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>("textarea")
        ?.disabled,
      true,
      "ordinary prompt writes remain blocked",
    );
    const restart =
      dom.window.document.querySelector<HTMLButtonElement>(".restart-pi")!;
    assert.equal(
      restart.disabled,
      false,
      "the guarded restart recovery remains available",
    );
    await act(async () => {
      restart.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(restartCalls, 1);
    const settings =
      dom.window.document.querySelector<HTMLButtonElement>(".topbar-settings")!;
    await act(async () => settings.click());
    const workspacePicker =
      dom.window.document.querySelector<HTMLButtonElement>(
        "button[aria-label='选择默认工作路径']",
      )!;
    assert.equal(
      workspacePicker.disabled,
      true,
      "ordinary workspace changes remain blocked",
    );
    const shutdown =
      dom.window.document.querySelector<HTMLButtonElement>(
        ".settings-shutdown",
      )!;
    assert.equal(
      shutdown.disabled,
      false,
      "the guarded shutdown recovery remains available",
    );
    await act(async () => {
      shutdown.click();
      await Promise.resolve();
    });
    assert.equal(shutdownCalls, 1);
  } finally {
    await act(async () => root.unmount());
    delete testGlobal.__PI_CHAT_TEST_WEB_BUILD_IDENTITY__;
    restoreApi();
  }
});
