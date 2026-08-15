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
      onClose: () => {},
      onAppearance: () => {},
      onPickWorkspace: () => {},
      onModel: () => {},
      onExportDiagnostics: async () => { calls.push("export"); },
      onShutdown: () => {},
    })));
    const button = (label: string) => [...dom.window.document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement | undefined;

    await act(async () => button("诊断")?.click());
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
