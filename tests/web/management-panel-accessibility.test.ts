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
    onRestart: () => {},
    onShutdown: () => {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settingsFixture(models: Parameters<typeof panelProps>[0] = []) {
  const { dom } = installAppDom();
  const { api } = await import("../../src/web/api");
  const restoreApi = captureApiSnapshot(api);
  const { createRoot } = await import("react-dom/client");
  const { ManagementPanel } = await import("../../src/web/components/ManagementPanel");
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(createElement(ManagementPanel, panelProps(models))));
  return {
    dom, api,
    button(label: string) {
      const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
      assert.ok(button, `missing button: ${label}`);
      return button;
    },
    async close() { await act(async () => root.unmount()); restoreApi(); },
  };
}

test("adding a Provider works while another Session is generating", async () => {
  const { dom } = installAppDom();
  const { api } = await import("../../src/web/api");
  const restoreApi = captureApiSnapshot(api);
  Object.assign(api, {
    modelPreferences: async () => ({ defaultProvider: "", defaultModel: "", favorites: [], recent: [] }),
  });
  const { createRoot } = await import("react-dom/client");
  const { ManagementPanel } = await import("../../src/web/components/ManagementPanel");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(ManagementPanel, { ...panelProps([]), busy: true })));
    const add = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "添加自定义提供方")!;
    // A models.json edit no longer needs global quiescence: both the visible
    // control and its handler must remain actionable while another turn runs.
    assert.equal(add.disabled, false);
    await act(async () => add.click());
    assert.ok(dom.window.document.querySelector(".model-provider-editor"), "the editor opens on the first click");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("About has three update actions and no Pi connection setup button", async () => {
  const f = await settingsFixture();
  try {
    await act(async () => f.button("关于").click());
    const about = f.dom.window.document.querySelector(".about-panel")!;
    assert.equal(about.querySelectorAll(".about-actions > button, .about-actions > a").length, 3);
    assert.equal([...about.querySelectorAll("button")].some((button) => button.textContent?.includes("连接设置")), false);
    assert.match(about.textContent || "", /检查更新/);
    assert.match(about.textContent || "", /检查 Pi 内核更新/);
    assert.match(about.textContent || "", /打开 GitHub Releases/);
  } finally { await f.close(); }
});

const availableNpmUpdate = {
  packageName: "@earendil-works/pi-coding-agent", currentVersion: "1.0.1", latestVersion: "1.1.0",
  registryUrl: "https://registry.npmjs.org/x", checkedAt: "2026-10-12T00:00:00.000Z",
  updateAvailable: true, updateMode: "npm-global" as const,
};

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
      onRestart: () => {},
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
  Object.assign(api, {
    checkPiRuntimeUpdate: async () => ({
      packageName: "@earendil-works/pi-coding-agent",
      currentVersion: "1.0.1",
      latestVersion: "1.1.0",
      registryUrl: "https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent",
      checkedAt: "2026-10-12T00:00:00.000Z",
      updateAvailable: true,
      updateMode: "managed" as const,
    }),
    updatePiRuntime: async (version: string) => { updateRequested = version; },
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
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("Pi Runtime update upgrades an npm-global Pi with a manual-command fallback", async () => {
  const { dom } = installAppDom();
  const { api } = await import("../../src/web/api");
  const restoreApi = captureApiSnapshot(api);
  const { createRoot } = await import("react-dom/client");
  const { ManagementPanel } = await import("../../src/web/components/ManagementPanel");
  let updateRequested = "";
  Object.assign(api, {
    checkPiRuntimeUpdate: async () => ({
      packageName: "@earendil-works/pi-coding-agent",
      currentVersion: "1.0.1",
      latestVersion: "1.1.0",
      registryUrl: "https://registry.npmjs.org/x",
      checkedAt: "2026-10-12T00:00:00.000Z",
      updateAvailable: true,
      updateMode: "npm-global" as const,
    }),
    updatePiRuntime: async (version: string) => { updateRequested = version; },
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
    const upgradeButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "升级本机 Pi 到 v1.1.0")!;
    assert.ok(upgradeButton, "an npm-global Pi must be offered the in-app upgrade");
    const copyButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "复制 npm 命令")!;
    assert.ok(copyButton, "the manual npm command fallback must remain available");
    assert.equal([...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .some((button) => button.textContent === "更新到 v1.1.0"), false);
    await act(async () => upgradeButton.click());
    const confirm = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "确认更新")!;
    assert.ok(confirm, "npm-global upgrade must require an explicit confirmation");
    assert.ok(dom.window.document.body.textContent?.includes("你的 Pi CLI 也会被升级"));
    await act(async () => { confirm.click(); await Promise.resolve(); });
    assert.equal(updateRequested, "1.1.0");
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("Settings resource loading ignores late failures from a previous category", async () => {
  const f = await settingsFixture();
  const skills = deferred<Awaited<ReturnType<typeof f.api.skills>>>();
  const extensions = deferred<Awaited<ReturnType<typeof f.api.extensions>>>();
  f.api.skills = () => skills.promise;
  f.api.extensions = () => extensions.promise;
  try {
    await act(async () => f.button("Skills").click());
    await act(async () => f.button("Extensions").click());
    await act(async () => skills.reject(new Error("obsolete Skills failure")));
    assert.ok(f.dom.window.document.querySelector(".resource-error") === null, "the current category must not display an obsolete error");
    assert.match(f.dom.window.document.querySelector(".settings-resource-list")?.textContent || "", /正在扫描/);
    await act(async () => extensions.resolve({ resources: [], diagnostics: [] }));
    assert.match(f.dom.window.document.querySelector(".settings-resource-list")?.textContent || "", /当前没有已启用的 Extensions/);
  } finally { await f.close(); }
});

test("Settings revisiting a resource category cannot restore an older scan", async () => {
  const f = await settingsFixture();
  const first = deferred<Awaited<ReturnType<typeof f.api.skills>>>();
  const second = deferred<Awaited<ReturnType<typeof f.api.skills>>>();
  let requests = 0;
  f.api.skills = () => (++requests === 1 ? first.promise : second.promise);
  const skill = { id: "example", name: "Old scan", description: "", pathLabel: "skills/example", source: "user" as const, enabled: true, content: "" };
  try {
    await act(async () => f.button("Skills").click());
    await act(async () => f.button("外观").click());
    await act(async () => f.button("Skills").click());
    await act(async () => second.resolve({ resources: [{ ...skill, name: "New scan" }], diagnostics: [] }));
    await act(async () => first.resolve({ resources: [skill], diagnostics: [] }));
    const list = f.dom.window.document.querySelector(".settings-resource-list")!;
    assert.match(list.textContent || "", /New scan/);
    assert.doesNotMatch(list.textContent || "", /Old scan/);
  } finally { await f.close(); }
});

test("Settings resource errors are not presented as an empty installed inventory", async () => {
  const f = await settingsFixture();
  f.api.skills = async () => { throw new Error("Skills scan failed"); };
  try {
    await act(async () => f.button("Skills").click());
    assert.match(f.dom.window.document.querySelector(".resource-error")?.textContent || "", /Skills scan failed/);
    assert.doesNotMatch(f.dom.window.document.querySelector(".settings-resource-list")?.textContent || "", /当前没有已启用/);
  } finally { await f.close(); }
});

test("npm command Copy exposes unavailable clipboard and reports success on retry", async () => {
  const f = await settingsFixture();
  f.api.checkPiRuntimeUpdate = async () => availableNpmUpdate;
  Object.defineProperty(f.dom.window.navigator, "clipboard", { configurable: true, value: undefined });
  try {
    await act(async () => f.button("关于").click());
    await act(async () => f.button("检查 Pi 内核更新").click());
    await act(async () => f.button("复制 npm 命令").click());
    assert.match(f.dom.window.document.querySelector(".resource-error")?.textContent || "", /不支持剪贴板|复制失败/);
    const writes: string[] = [];
    Object.defineProperty(f.dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { writes.push(text); } } });
    await act(async () => f.button("复制 npm 命令").click());
    assert.deepEqual(writes, ["npm install -g @earendil-works/pi-coding-agent@1.1.0"]);
    assert.match(f.dom.window.document.querySelector('[role="status"]')?.textContent || "", /已复制/);
    assert.ok(f.dom.window.document.querySelector(".resource-error") === null, "successful copying clears the copy error");
  } finally { await f.close(); }
});

test("npm command Copy preserves an upgrade error and recovers from permission denial", async () => {
  const f = await settingsFixture();
  f.api.checkPiRuntimeUpdate = async () => availableNpmUpdate;
  f.api.updatePiRuntime = async () => { throw new Error("测试：对话运行中，更新被拒绝"); };
  let denied = true;
  Object.defineProperty(f.dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async () => { if (denied) throw new Error("NotAllowedError"); } } });
  try {
    await act(async () => f.button("关于").click());
    await act(async () => f.button("检查 Pi 内核更新").click());
    await act(async () => f.button("升级本机 Pi 到 v1.1.0").click());
    await act(async () => f.button("确认更新").click());
    await act(async () => f.button("复制 npm 命令").click());
    assert.match(f.dom.window.document.querySelector(".about-panel")?.textContent || "", /NotAllowedError/);
    assert.equal(f.dom.window.document.querySelector(".about-update-command")?.textContent, "npm install -g @earendil-works/pi-coding-agent@1.1.0");
    denied = false;
    await act(async () => f.button("复制 npm 命令").click());
    assert.match(f.dom.window.document.querySelector('[role="status"]')?.textContent || "", /已复制/);
    assert.match(f.dom.window.document.querySelector(".resource-error")?.textContent || "", /更新被拒绝/);
    assert.doesNotMatch(f.dom.window.document.querySelector(".about-panel")?.textContent || "", /NotAllowedError/);
  } finally { await f.close(); }
});

test("checking Pi updates again retires the previous confirmation and upgrade button", async () => {
  const f = await settingsFixture();
  f.api.checkPiRuntimeUpdate = async () => availableNpmUpdate;
  const recheck = deferred<Awaited<ReturnType<typeof f.api.checkPiRuntimeUpdate>>>();
  let updates = 0;
  f.api.updatePiRuntime = async () => { updates++; };
  try {
    await act(async () => f.button("关于").click());
    await act(async () => f.button("检查 Pi 内核更新").click());
    await act(async () => f.button("升级本机 Pi 到 v1.1.0").click());
    f.api.checkPiRuntimeUpdate = () => recheck.promise;
    await act(async () => f.button("检查 Pi 内核更新").click());
    assert.equal(f.dom.window.document.querySelectorAll(".about-update button").length, 0);
    await act(async () => recheck.resolve({ ...availableNpmUpdate, updateAvailable: false }));
    assert.equal(f.dom.window.document.querySelectorAll(".about-update button").length, 0);
    assert.equal(updates, 0, "checking metadata never dispatches an upgrade");
  } finally { await f.close(); }
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
    assert.ok([...dom.window.document.querySelectorAll("button")].some((button) => button.textContent === "获取上游模型列表"), "provider editor exposes upstream model discovery");
    const context = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="模型 1 上下文大小"]')!;
    const output = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="模型 1 最大输出"]')!;
    for (const input of [context, output]) {
      assert.equal(input.type, "text", "token counts have no numeric stepper arrows");
      assert.equal(input.inputMode, "numeric");
    }
    const fill = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    };
    await act(async () => { fill(context, "900000"); fill(output, "80000"); });
    assert.equal(context.value, "900000");
    assert.equal(output.value, "80000");
    await act(async () => { fill(context, "1e6"); });
    assert.equal(context.value, "900000", "non-integer text is not converted to a different token limit");
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
    assert.deepEqual(saved.models, [{ id: "renamed-id", originalId: "old-id", name: "Old name", contextWindow: 900_000, maxTokens: 80_000, reasoning: true }]);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("the model catalogue badge never claims ready while sync is pending", async () => {
  const { dom } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { ManagementPanel } = await import("../../src/web/components/ManagementPanel");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const badge = () => dom.window.document.querySelector(".model-runtime-status")?.textContent || "";
  try {
    await act(async () => root.render(createElement(ManagementPanel, { ...panelProps([]), modelRuntimeSyncPending: true })));
    assert.equal(badge(), "正在刷新模型目录");
    await act(async () => root.render(createElement(ManagementPanel, { ...panelProps([]), modelRuntimeSyncPending: false })));
    assert.equal(badge(), "模型目录已刷新");
  } finally {
    await act(async () => root.unmount());
  }
});

async function modelProbeFixture() {
  const f = await settingsFixture(["alpha", "beta"].map((provider) => ({
    id: "configured", name: "Configured", provider, source: "models-json", authMode: "api-key", custom: true,
  })));
  f.api.getCustomProvider = async (provider: string) => ({ provider: {
    provider, baseUrl: `https://${provider}.invalid/v1`, api: "openai-completions", apiKey: "",
    models: [{ id: "configured", name: "Configured" }],
  } });
  return {
    ...f,
    async edit(provider: string) {
      const button = [...f.dom.window.document.querySelectorAll<HTMLButtonElement>(".model-provider-disclosure")]
        .find((button) => button.textContent?.includes(provider))!;
      await act(async () => button.click());
    },
    async probe() { await act(async () => f.button("获取上游模型列表").click()); },
    async cancelProbe() {
      await act(async () => f.dom.window.document.querySelector<HTMLButtonElement>(".provider-discovered-actions button")!.click());
    },
    rows: () => f.dom.window.document.querySelector(".provider-discovered-list")?.textContent || "",
  };
}

test("a cancelled model probe cannot replace the result of a reopened picker", async () => {
  const f = await modelProbeFixture();
  const first = deferred<Awaited<ReturnType<typeof f.api.probeProviderModels>>>();
  let requests = 0;
  f.api.probeProviderModels = () => ++requests === 1 ? first.promise : Promise.resolve({ models: [{ id: "new-result" }] });
  try {
    await f.edit("alpha");
    await f.probe();
    await f.cancelProbe();
    assert.equal(f.button("获取上游模型列表").disabled, false, "cancel permits a fresh probe immediately");
    await f.probe();
    assert.match(f.rows(), /new-result/);
    await act(async () => first.resolve({ models: [{ id: "old-result" }] }));
    assert.match(f.rows(), /new-result/);
    assert.doesNotMatch(f.rows(), /old-result/);
    assert.equal(requests, 2);
  } finally { await f.close(); }
});

test("an old Provider probe failure cannot unlock or contaminate the new Provider picker", async () => {
  const f = await modelProbeFixture();
  const first = deferred<Awaited<ReturnType<typeof f.api.probeProviderModels>>>();
  const second = deferred<Awaited<ReturnType<typeof f.api.probeProviderModels>>>();
  f.api.probeProviderModels = (input) => input.provider === "alpha" ? first.promise : second.promise;
  try {
    await f.edit("alpha");
    await f.probe();
    await f.cancelProbe();
    await act(async () => f.button("取消").click());
    await f.edit("beta");
    await f.probe();
    await act(async () => first.reject(new Error("obsolete-alpha-failure")));
    const picker = f.dom.window.document.querySelector(".provider-discovered-dialog")!;
    assert.doesNotMatch(picker.textContent || "", /obsolete-alpha-failure/);
    assert.equal(f.button("正在探测…").disabled, true, "old finally cannot finish the new request");
    assert.equal(f.button("应用所选").disabled, true);
    await act(async () => second.resolve({ models: [{ id: "beta-result" }] }));
    assert.match(f.rows(), /beta-result/);
    assert.equal(f.button("应用所选").disabled, false);
  } finally { await f.close(); }
});
