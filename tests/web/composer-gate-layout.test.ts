import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { act, createElement } from "react";
import { type BootstrapData, type SessionViewData } from "../../src/shared/types";
import { activeSessionId as activeId, createBootstrapFixture, createSessionViewFixture } from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom as installDom, waitForDomSelector } from "../helpers/app-dom";

let bootstrap: BootstrapData;
let draftView: SessionViewData;

beforeEach(() => {
  bootstrap = createBootstrapFixture();
  draftView = createSessionViewFixture();
});


test("system Gate selector remains visible when startup command inventory is empty", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      commands: [],
      gateMode: "strict" as const,
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const gate = dom.window.document.querySelector<HTMLButtonElement>(
      ".composer .gate-control .compact-select-trigger",
    );
    assert.ok(
      gate,
      "the verified system Gate must not depend on get_commands()",
    );
    assert.equal(gate.textContent?.trim(), "严格");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("Gate control disables an unconfirmed existing Session instead of inventing strict", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { GateControl } = await import("../../src/web/components/GateControl");
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(GateControl, {
      mode: undefined,
      disabled: false,
      onChange: () => undefined,
    })));
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".gate-control .compact-select-trigger")!;
    assert.equal(trigger.disabled, true);
    assert.equal(trigger.textContent?.trim(), "正在确认");
    assert.doesNotMatch(trigger.textContent || "", /未同步|严格/);
  } finally {
    await act(async () => root.unmount());
  }
});

test("conversation controls live in the composer while settings moves to the top bar", async () => {
  const { dom } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      commands: [{ name: "gate", description: "Gate", source: "extension" }],
      gateMode: "strict" as const,
      stats: {
        tokens: {
          input: 10,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          total: 12,
        },
        contextUsage: { tokens: 100, contextWindow: 1_000, percent: 10 },
      },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(dom.window.document.querySelector(".topbar-settings"));
    assert.ok(dom.window.document.querySelector(".diff-sidebar-toggle"));
    assert.equal(
      dom.window.document.querySelector(".topbar .model-menu"),
      null,
    );
    assert.equal(
      dom.window.document.querySelector(".topbar .usage-pill"),
      null,
    );
    assert.equal(dom.window.document.querySelector(".management-nav"), null);
    assert.ok(
      dom.window.document.querySelector(".composer .composer-model-select"),
    );
    assert.ok(dom.window.document.querySelector(".composer .thinking-control"));
    const gateTrigger = dom.window.document.querySelector<HTMLButtonElement>(
      ".composer .gate-control .compact-select-trigger",
    )!;
    assert.equal(gateTrigger.textContent?.trim(), "严格");
    await act(async () => gateTrigger.click());
    assert.deepEqual(
      [
        ...dom.window.document.querySelectorAll(
          ".gate-control .compact-select-option > span:last-of-type",
        ),
      ].map((node) => node.textContent),
      ["严格", "放行"],
    );
    assert.ok(dom.window.document.querySelector(".composer .composer-usage"));
    assert.ok(
      dom.window.document.querySelector(
        ".attachment-button [data-icon='paperclip']",
      ),
    );
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>(
          ".thinking-control .compact-select-trigger",
        )
        ?.click(),
    );
    const thinkingLabels = [
      ...dom.window.document.querySelectorAll(
        ".thinking-control .compact-select-option > span:last-of-type",
      ),
    ].map((node) => node.textContent);
    assert.deepEqual(thinkingLabels, [
      "off",
      "min",
      "low",
      "med",
      "high",
      "xhigh",
      "max",
    ]);
    assert.ok(
      dom.window.document.querySelector(
        ".thinking-control .compact-select-option.has-leading-check",
      ),
    );
    const settings =
      dom.window.document.querySelector<HTMLButtonElement>(".topbar-settings")!;
    assert.equal(settings.getAttribute("aria-expanded"), "false");
    assert.equal(
      settings.getAttribute("aria-controls"),
      "pi-chat-settings-dialog",
    );
    await act(async () => settings.click());
    await waitForDomSelector(dom.window.document, "#pi-chat-settings-dialog");
    assert.equal(settings.getAttribute("aria-expanded"), "true");
    assert.equal(settings.getAttribute("aria-label"), "关闭设置");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
