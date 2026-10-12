import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import type { CustomProviderInput } from "../../src/shared/types";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom } from "../helpers/app-dom";

function panelProps(models: Array<{ id: string; name: string; provider: string; source: "models-json"; authMode: "api-key"; custom: true }>, onModelsChanged: () => void = () => {}) {
  return {
    section: "models" as const,
    appearance: { theme: "system" as const, font: "system" as const, fontSize: 16, lineHeight: 1.6, chatWidth: 850, markdownCss: "" },
    workspaceCwd: "C:\\workspace",
    workspacePicking: false,
    workspaceDisabled: false,
    models,
    modelRuntimeSyncPending: false,
    state: { model: null, isStreaming: false },
    busy: false,
    shutdownBlocked: false,
    diagnosticsBusy: false,
    buildIdentity: { schemaVersion: 1 as const, packageVersion: "0.4.8", revision: "abc123", fingerprint: "a".repeat(64), builtAt: "2026-01-01T00:00:00.000Z" },
    webBuildIdentity: { schemaVersion: 1 as const, packageVersion: "0.4.8", revision: "abc123", fingerprint: "a".repeat(64), builtAt: "2026-01-01T00:00:00.000Z" },
    primaryRuntime: { status: "ready" as const, generation: 1 },
    onClose: () => {},
    onAppearance: () => {},
    onPickWorkspace: () => {},
    onModel: () => {},
    onModelsChanged,
    onExportDiagnostics: async () => {},
    onShutdown: () => {},
  };
}

test("Settings navigation and Provider disclosure use native non-nested controls", async () => {
  const { dom } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { ManagementPanel } = await import("../../src/web/components/ManagementPanel");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(ManagementPanel, {
      section: "models",
      appearance: { theme: "system", font: "system", fontSize: 16, lineHeight: 1.6, chatWidth: 850, markdownCss: "" },
      workspaceCwd: "C:\\workspace",
      workspacePicking: false,
      workspaceDisabled: false,
      models: [
        { id: "builtin", name: "Built in", provider: "pi", source: "pi-runtime", authMode: "pi-managed" },
        { id: "custom", name: "Custom", provider: "local", source: "models-json", authMode: "api-key", custom: true },
      ],
      modelRuntimeSyncPending: false,
      state: { model: null, isStreaming: false },
      busy: false,
      shutdownBlocked: false,
      diagnosticsBusy: false,
      buildIdentity: { schemaVersion: 1, packageVersion: "0.4.8", revision: "abc123", fingerprint: "a".repeat(64), builtAt: "2026-01-01T00:00:00.000Z" },
      webBuildIdentity: { schemaVersion: 1, packageVersion: "0.4.8", revision: "abc123", fingerprint: "a".repeat(64), builtAt: "2026-01-01T00:00:00.000Z" },
      primaryRuntime: { status: "ready", generation: 1 },
      onClose: () => {},
      onAppearance: () => {},
      onPickWorkspace: () => {},
      onModel: () => {},
      onModelsChanged: () => {},
      onExportDiagnostics: async () => {},
      onShutdown: () => {},
    })));

    const modelsTab = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".settings-nav-tabs button")]
      .find((button) => button.textContent === "Models")!;
    assert.equal(modelsTab.getAttribute("aria-current"), "page");
    assert.equal(dom.window.document.querySelectorAll('.settings-nav-tabs [aria-current="page"]').length, 1);

    const cards = [...dom.window.document.querySelectorAll<HTMLElement>(".model-provider-card")];
    const customCard = cards.find((card) => card.textContent?.includes("local"))!;
    const customDisclosure = customCard.querySelector<HTMLButtonElement>(".model-provider-disclosure")!;
    assert.equal(customCard.querySelector(".model-provider-head")?.getAttribute("role"), null);
    assert.equal(customDisclosure.tagName, "BUTTON");
    assert.equal(customDisclosure.getAttribute("aria-expanded"), "false");
    assert.equal(customDisclosure.querySelector("button"), null, "disclosure cannot contain Edit/Delete buttons");
    assert.equal(customCard.querySelectorAll(".model-provider-actions button").length, 2);

    const builtInCard = cards.find((card) => card.textContent?.includes("pi"))!;
    const builtInDisclosure = builtInCard.querySelector<HTMLButtonElement>(".model-provider-disclosure")!;
    await act(async () => builtInCard.querySelector<HTMLElement>(".model-provider-count")!.click());
    assert.equal(builtInDisclosure.getAttribute("aria-expanded"), "true", "the former broad pointer target remains available");
    await act(async () => builtInDisclosure.click());
    assert.equal(builtInDisclosure.getAttribute("aria-expanded"), "false");
    await act(async () => builtInDisclosure.click());
    assert.equal(builtInDisclosure.getAttribute("aria-expanded"), "true", "native disclosure reopens with one click");
    const panelId = builtInDisclosure.getAttribute("aria-controls")!;
    assert.ok(panelId);
    assert.equal(builtInCard.querySelector(`#${panelId}`)?.classList.contains("model-provider-panel"), true);
    assert.match(builtInCard.textContent || "", /Pi Runtime 管理|Pi 登录管理/);
  } finally {
    await act(async () => root.unmount());
  }
});

test("Pi Runtime update offers in-place update with an explicit confirmation", async () => {
  const { dom } = installAppDom();
  const { api } = await import("../../src/web/api");
  const restoreApi = captureApiSnapshot(api);
  const { createRoot } = await import("react-dom/client");
  const { ManagementPanel } = await import("../../src/web/components/ManagementPanel");
  let updateRequested = "";
  let adoptRequested: boolean | null = null;
  Object.assign(api, {
    checkPiRuntimeUpdate: async () => ({
      packageName: "@earendil-works/pi-coding-agent",
      currentVersion: "1.0.1",
      latestVersion: "1.1.0",
      registryUrl: "https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent",
      checkedAt: "2026-10-12T00:00:00.000Z",
      updateAvailable: true,
      inPlaceUpdateAvailable: true,
    }),
    updatePiRuntime: async (version: string, adopt: boolean) => { updateRequested = version; adoptRequested = adopt; },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(ManagementPanel, {
      ...panelProps([]),
      section: "settings" as never,
    })));
    const aboutTab = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".settings-nav-tabs button")]
      .find((button) => button.textContent === "关于")!;
    await act(async () => aboutTab.click());
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".about-actions .about-link-button")!.click();
      await Promise.resolve();
    });
    const updateButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "更新到 v1.1.0")!;
    assert.ok(updateButton);
    assert.equal(dom.window.document.querySelector(".about-update a"), null, "update flow must not jump to an external page");
    await act(async () => updateButton.click());
    const confirm = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "确认更新")!;
    await act(async () => { confirm.click(); await Promise.resolve(); });
    assert.equal(updateRequested, "1.1.0");
    assert.equal(adoptRequested, false, "a managed install must not request adoption");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("Pi Runtime update offers managed adoption for a user-owned Pi install", async () => {
  const { dom } = installAppDom();
  const { api } = await import("../../src/web/api");
  const restoreApi = captureApiSnapshot(api);
  const { createRoot } = await import("react-dom/client");
  const { ManagementPanel } = await import("../../src/web/components/ManagementPanel");
  let adoptRequested: boolean | null = null;
  Object.assign(api, {
    checkPiRuntimeUpdate: async () => ({
      packageName: "@earendil-works/pi-coding-agent",
      currentVersion: "1.0.1",
      latestVersion: "1.1.0",
      registryUrl: "https://registry.npmjs.org/x",
      checkedAt: "2026-10-12T00:00:00.000Z",
      updateAvailable: true,
      inPlaceUpdateAvailable: false,
    }),
    updatePiRuntime: async (_version: string, adopt: boolean) => { adoptRequested = adopt; },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(ManagementPanel, {
      ...panelProps([]),
      section: "settings" as never,
    })));
    const aboutTab = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".settings-nav-tabs button")]
      .find((button) => button.textContent === "关于")!;
    await act(async () => aboutTab.click());
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".about-actions .about-link-button")!.click();
      await Promise.resolve();
    });
    const adoptButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.startsWith("切换到受管 Pi 并更新到 v1.1.0"))!;
    assert.ok(adoptButton, "a user-owned Pi install must be offered managed adoption");
    assert.equal([...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .some((button) => button.textContent === "更新到 v1.1.0"), false);
    await act(async () => adoptButton.click());
    const confirm = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "确认更新")!;
    await act(async () => { confirm.click(); await Promise.resolve(); });
    assert.equal(adoptRequested, true, "adoption must be requested for a user-owned Pi");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("Provider editor preserves the stable source key when saving an edited model", async () => {
  const { dom } = installAppDom();
  const { api } = await import("../../src/web/api");
  const restoreApi = captureApiSnapshot(api);
  const { createRoot } = await import("react-dom/client");
  const { ManagementPanel } = await import("../../src/web/components/ManagementPanel");
  let saved: CustomProviderInput | null = null;
  Object.assign(api, {
    getCustomProvider: async () => ({
      provider: {
        provider: "local",
        baseUrl: "https://api.example.com/v1",
        api: "openai-responses",
        apiKey: "",
        models: [{ id: "old-id", originalId: "old-id", name: "Old name", contextWindow: 128_000 }],
      },
    }),
    updateCustomProvider: async (_provider: string, config: CustomProviderInput) => {
      saved = config;
      return {
        models: [{ id: "renamed-id", name: "Renamed", provider: "local", source: "models-json", authMode: "api-key", custom: true }],
        state: { model: null, isStreaming: false },
        modelRuntimeSyncPending: true,
        modelCatalogueRevision: 2,
      };
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(ManagementPanel, panelProps([
      { id: "old-id", name: "Old name", provider: "local", source: "models-json", authMode: "api-key", custom: true },
    ]))));
    const edit = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".model-provider-actions button")]
      .find((button) => button.textContent === "编辑")!;
    await act(async () => {
      edit.click();
      await Promise.resolve();
    });
    const idInput = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="模型 1 ID"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set?.call(idInput, "renamed-id");
      idInput.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "renamed-id" }));
    });
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".model-save-button")!.click();
      await Promise.resolve();
    });
    assert.ok(saved);
    assert.deepEqual(saved.models, [{ id: "renamed-id", originalId: "old-id", name: "Old name", contextWindow: 128_000 }]);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
