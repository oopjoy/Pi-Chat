import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, useState } from "react";
import { installAppDom } from "../helpers/app-dom";

test("Settings exposes explicit diagnostic start, export, and stop actions", async () => {
  const { dom } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { ManagementPanel } = await import("../../src/web/components/ManagementPanel");
  const calls: string[] = [];

  function Harness() {
    const [active, setActive] = useState(false);
    return createElement(ManagementPanel, {
      section: "settings",
      appearance: { theme: "system", font: "system", fontSize: 16, lineHeight: 1.6, chatWidth: 850, markdownCss: "" },
      workspaceCwd: "C:\\workspace",
      workspacePicking: false,
      workspaceDisabled: false,
      models: [],
      state: { model: null, isStreaming: false },
      busy: false,
      shutdownBlocked: false,
      diagnosticsActive: active,
      diagnosticsBusy: false,
      diagnosticsEntryCount: active ? 12 : 0,
      onClose: () => {},
      onAppearance: () => {},
      onPickWorkspace: () => {},
      onModel: () => {},
      onStartDiagnostics: async () => { calls.push("start"); setActive(true); },
      onStopDiagnostics: async () => { calls.push("stop"); setActive(false); },
      onExportDiagnostics: async () => { calls.push("export"); },
      onShutdown: () => {},
    });
  }

  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(Harness)));
    const button = (label: string) => [...dom.window.document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement | undefined;

    await act(async () => button("诊断")?.click());
    assert.match(dom.window.document.body.textContent || "", /只在内存中保留最近五分钟/);
    await act(async () => button("开始录制")?.click());
    assert.deepEqual(calls, ["start"]);
    assert.ok(button("重新开始录制"));
    assert.match(dom.window.document.body.textContent || "", /当前窗口 12 条/);
    await act(async () => button("导出最近五分钟 JSON")?.click());
    await act(async () => button("停止录制")?.click());
    assert.deepEqual(calls, ["start", "export", "stop"]);
    assert.ok(button("开始录制"));
  } finally {
    await act(async () => root.unmount());
  }
});
