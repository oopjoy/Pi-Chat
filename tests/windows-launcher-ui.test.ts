import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
    // Known-folder APIs ignore LOCALAPPDATA overrides. Redirect initialization
    // in this temporary copy before any log file is opened, not in the later UI hook.
    const logAssignment = String.raw`$logDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Pi Chat'`;
    assert.equal(original.split(logAssignment).length, 2);
    const isolated = original.replace(logAssignment, "$logDirectory = Join-Path $env:PI_CHAT_UI_LOG_ROOT 'Pi Chat'");
    // Exercise real WinForms timers with a stub browser; no production logs.
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
    LogDirectory = $logDirectory
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($env:PI_CHAT_UI_RESULT, $result, [Text.UTF8Encoding]::new($false))
})
`;
    await writeFile(join(root, "start-pi-chat-ui.ps1"), isolated.replace(marker, harness + "\n" + marker));
    const cases = [{ code: 0, mode: "web", omitMode: true }, { code: 0, mode: "pwa", omitMode: false }, { code: 2, mode: "web", omitMode: false }, { code: 7, mode: "web", omitMode: false }];
    for (const [index, item] of cases.entries()) {
      const result = join(root, `result-${index}.json`), browser = join(root, `browser-${index}.txt`);
      await writeFile(join(root, "pi-chat-launch.cmd"), `@echo off\r\necho controlled-launch-fixture\r\nexit /b ${item.code}\r\n`);
      const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(root, "start-pi-chat-ui.ps1"), ...(item.omitMode ? [] : ["-Mode", item.mode])], {
        env: { ...process.env, PI_CHAT_UI_LOG_ROOT: join(root, "local"), PI_CHAT_UI_RESULT: result, PI_CHAT_UI_BROWSER: browser },
        windowsHide: true, timeout: 15_000, encoding: "utf8",
      });
      assert.equal(child.status, item.code, child.stderr);
      const state = JSON.parse(await readFile(result, "utf8"));
      assert.equal(await realpath(state.LogDirectory), await realpath(join(root, "local", "Pi Chat")));
      assert.equal(state.ExitCode, item.code);
      assert.equal(state.Failed, item.code !== 0);
      if (item.code === 0) {
        assert.equal(state.Succeeded, true);
        assert.equal(await readFile(browser, "utf8"), item.mode);
      } else {
        assert.equal(state.Succeeded, false);
        assert.equal(state.Label, "Pi Chat 启动失败");
        if (item.code === 2) assert.match(state.Detail, /另一版本占用了 30170/);
        else assert.match(state.Detail, /controlled-launch-fixture/);
        assert.equal(state.LogButton, "打开日志");
        assert.equal(state.RetryButton, "重试");
        assert.equal(state.CloseButton, "关闭");
        await assert.rejects(readFile(browser), /ENOENT/);
      }
    }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("Retry launches the complete quoted script path and selected mode", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-retry-"));
  try {
    const project = join(root, "Pi Chat's & (retry)");
    await mkdir(project);
    const ui = await readFile(join(repo, "start-pi-chat-ui.ps1"), "utf8");
    const start = "$retryButton.Add_Click({", end = "})\n$form.Controls.Add($retryButton)";
    const body = ui.replace(/\r\n/g, "\n").split(start)[1]?.split(end)[0];
    assert.ok(body);
    const entry = join(project, "fake-ui.ps1"), result = join(root, "result.json");
    await writeFile(entry, "param([string]$Mode); [IO.File]::WriteAllText($env:PI_CHAT_RETRY_RESULT, ($PSCommandPath + '|' + $Mode))\n");
    const invoke = String.raw`$ErrorActionPreference='Stop'; $uiScriptPath=$env:PI_CHAT_RETRY_ENTRY; $project=Split-Path -Parent $uiScriptPath; $Mode='pwa'; $form=New-Object PSObject; foreach($method in @('Hide','Show','Close')){$form | Add-Member ScriptMethod $method {}}; ` + body + "; $retry.WaitForExit()";
    const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", invoke], {
      env: { ...process.env, PI_CHAT_RETRY_ENTRY: entry, PI_CHAT_RETRY_RESULT: result }, windowsHide: true, timeout: 15_000, encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    const text = await readFile(result, "utf8");
    const [path, mode] = text.split("|");
    assert.equal(await realpath(path), await realpath(entry));
    assert.equal(mode, "pwa");
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
