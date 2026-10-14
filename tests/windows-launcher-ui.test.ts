import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repo = resolve(import.meta.dirname, "..");

test("Windows launch UI defaults to Web, preserves optional PWA, and renders readable failure without opening a browser", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-ui-check-"));
  try {
    await mkdir(join(root, "scripts"));
    await cp(join(repo, "scripts/pi-chat-launch-process.ps1"), join(root, "scripts/pi-chat-launch-process.ps1"));
    const original = await readFile(join(repo, "start-pi-chat-ui.ps1"), "utf8");
    assert.equal(original.charCodeAt(0), 0xfeff, "PowerShell 5 must decode Chinese as UTF-8, not the system ANSI code page");
    assert.match(original, /\[string\]\$Mode = 'web'/);
    const marker = "[void]$form.ShowDialog()";
    assert.equal(original.split(marker).length, 2);
    // Exercise the real WinForms timers and failure branch. Only the external
    // browser open is replaced; logs/profile and all fixtures stay in temp.
    const harness = String.raw`
function Open-PiChatWindow {
  param([string]$OpenMode)
  [IO.File]::WriteAllText($env:PI_CHAT_UI_BROWSER, $OpenMode)
}
$form.TopMost = $false
$form.Opacity = 0
$form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point(-30000, -30000)
$watch = New-Object Windows.Forms.Timer
$watch.Interval = 100
$script:watchTicks = 0
$watch.Add_Tick({
  $script:watchTicks++
  if ($script:failureShown -or $script:watchTicks -gt 70) { $form.Close() }
})
$form.Add_Shown({ $watch.Start() })
$form.Add_FormClosed({
  $watch.Stop()
  $watch.Dispose()
  $result = [pscustomobject]@{
    ExitCode = $script:launcherExitCode
    Failed = $script:failureShown
    Succeeded = $script:successHandled
    Label = $label.Text
    Detail = $detailLabel.Text
    LogButton = $openLogButton.Text
    RetryButton = $retryButton.Text
    CloseButton = $closeButton.Text
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($env:PI_CHAT_UI_RESULT, $result, [Text.UTF8Encoding]::new($false))
})
`;
    await writeFile(join(root, "start-pi-chat-ui.ps1"), original.replace(marker, harness + "\n" + marker));
    const cases = [{ code: 0, mode: "web" }, { code: 0, mode: "pwa" }, { code: 2, mode: "web" }];
    for (const [index, item] of cases.entries()) {
      const result = join(root, `result-${index}.json`), browser = join(root, `browser-${index}.txt`);
      await writeFile(join(root, "pi-chat-launch.cmd"), `@echo off\r\necho controlled-launch-fixture\r\nexit /b ${item.code}\r\n`);
      const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(root, "start-pi-chat-ui.ps1"), "-Mode", item.mode], {
        env: { ...process.env, LOCALAPPDATA: join(root, "local"), PI_CHAT_UI_RESULT: result, PI_CHAT_UI_BROWSER: browser },
        windowsHide: true, timeout: 15_000, encoding: "utf8",
      });
      assert.equal(child.status, item.code, child.stderr);
      const state = JSON.parse(await readFile(result, "utf8"));
      assert.equal(state.ExitCode, item.code);
      assert.equal(state.Failed, item.code !== 0);
      if (item.code === 0) {
        assert.equal(state.Succeeded, true);
        assert.equal(await readFile(browser, "utf8"), item.mode);
      } else {
        assert.equal(state.Succeeded, false);
        assert.equal(state.Label, "Pi Chat 启动失败");
        assert.match(state.Detail, /另一版本占用了 30170/);
        assert.equal(state.LogButton, "打开日志");
        assert.equal(state.RetryButton, "重试");
        assert.equal(state.CloseButton, "关闭");
        await assert.rejects(readFile(browser), /ENOENT/);
      }
    }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
