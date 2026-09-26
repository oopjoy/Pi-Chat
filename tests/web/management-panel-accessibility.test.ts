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
