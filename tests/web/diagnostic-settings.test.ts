import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { installAppDom } from "../helpers/app-dom";

test("Settings exposes one export-only diagnostic action", async () => {
  const { dom } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { ManagementPanel } = await import("../../src/web/components/ManagementPanel");
  const calls: string[] = [];

  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(ManagementPanel, {
      section: "settings",
      appearance: { theme: "system", font: "system", fontSize: 16, lineHeight: 1.6, chatWidth: 850, markdownCss: "" },
      workspaceCwd: "C:\\workspace",
      workspacePicking: false,
      workspaceDisabled: false,
      models: [],
      state: { model: null, isStreaming: false },
      busy: false,
      shutdownBlocked: false,
      diagnosticsBusy: false,
      buildIdentity: { schemaVersion: 1, packageVersion: "0.4.5", revision: "abc123", fingerprint: "a".repeat(64), builtAt: "2026-01-01T00:00:00.000Z" },
      webBuildIdentity: { schemaVersion: 1, packageVersion: "0.4.5", revision: "abc123", fingerprint: "a".repeat(64), builtAt: "2026-01-01T00:00:00.000Z" },
      piVersion: "0.84.2",
      applicationLifecycle: "idle",
      primaryRuntime: { status: "ready", generation: 1 },
      onClose: () => {},
      onAppearance: () => {},
      onPickWorkspace: () => {},
      onModel: () => {},
      onExportDiagnostics: async () => { calls.push("export"); },
      onShutdown: () => {},
    })));
    const button = (label: string) => [...dom.window.document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement | undefined;

    await act(async () => button("关于")?.click());
    assert.equal(button("诊断"), undefined);
    assert.match(dom.window.document.body.textContent || "", /自动保留最近五分钟/);
    assert.match(dom.window.document.body.textContent || "", /稳定 Session ID/);
    assert.equal(button("开始录制"), undefined);
    assert.equal(button("停止录制"), undefined);
    await act(async () => button("导出最近五分钟诊断")?.click());
    assert.deepEqual(calls, ["export"]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("Settings About panel shows build diagnostics and checks GitHub releases on demand", async () => {
  const { dom } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { ManagementPanel } = await import("../../src/web/components/ManagementPanel");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    tag_name: "v0.4.6",
    html_url: "https://github.com/oopjoy/Pi-Chat/releases/tag/v0.4.6",
    published_at: "2026-01-02T00:00:00.000Z",
  }), { status: 200, headers: { "content-type": "application/json" } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(ManagementPanel, {
      section: "settings",
      appearance: { theme: "system", font: "system", fontSize: 16, lineHeight: 1.6, chatWidth: 850, markdownCss: "" },
      workspaceCwd: "C:\\workspace",
      workspacePicking: false,
      workspaceDisabled: false,
      models: [],
      state: { model: null, isStreaming: false },
      busy: false,
      shutdownBlocked: false,
      diagnosticsBusy: false,
      buildIdentity: { schemaVersion: 1, packageVersion: "0.4.5", revision: "abc123", fingerprint: "a".repeat(64), builtAt: "2026-01-01T00:00:00.000Z" },
      webBuildIdentity: { schemaVersion: 1, packageVersion: "0.4.5", revision: "abc123", fingerprint: "a".repeat(64), builtAt: "2026-01-01T00:00:00.000Z" },
      piVersion: "0.84.2",
      applicationLifecycle: "idle",
      primaryRuntime: { status: "ready", generation: 1 },
      onClose: () => {},
      onAppearance: () => {},
      onPickWorkspace: () => {},
      onModel: () => {},
      onExportDiagnostics: async () => {},
      onShutdown: () => {},
    })));
    const button = (label: string) => [...dom.window.document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement | undefined;
    await act(async () => button("关于")?.click());
    assert.match(dom.window.document.body.textContent || "", /v0\.4\.5/);
    assert.match(dom.window.document.body.textContent || "", /v0\.84\.2/);
    assert.match(dom.window.document.body.textContent || "", /Build Fingerprint/);
    await act(async () => button("检查更新")?.click());
    assert.match(dom.window.document.body.textContent || "", /发现新版本 v0\.4\.6/);
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
  }
});
