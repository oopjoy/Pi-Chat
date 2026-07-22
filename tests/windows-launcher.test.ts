import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readProjectFile = (path: string) => readFile(join(root, path), "utf8");

test("Windows launcher assets are packaged and project shortcuts are ignored", async () => {
  const [gitignore, packageJson, wrapper] = await Promise.all([
    readProjectFile(".gitignore"),
    readProjectFile("package.json"),
    readProjectFile("start-pi-chat.cmd"),
  ]);
  const pkg = JSON.parse(packageJson) as { files: string[]; scripts: Record<string, string> };
  assert.match(gitignore, /^\*\.lnk$/m);
  for (const file of ["start-pi-chat.cmd", "start-pi-chat-ui.ps1", "scripts/install-shortcuts.ps1", "resources"]) {
    assert.ok(pkg.files.includes(file), `${file} must be included in the package`);
  }
  assert.equal(pkg.scripts["install:shortcuts"], "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-shortcuts.ps1");
  assert.match(wrapper, /pi-chat-launch\.cmd" web/i);
});

test("launcher scripts derive paths dynamically and avoid unsafe PowerShell interpolation", async () => {
  const [cmd, ui, installer, readiness] = await Promise.all([
    readProjectFile("pi-chat-launch.cmd"),
    readProjectFile("start-pi-chat-ui.ps1"),
    readProjectFile("scripts/install-shortcuts.ps1"),
    readProjectFile("scripts/pi-chat-port-ready.ps1"),
  ]);
  for (const source of [cmd, ui, installer]) {
    assert.doesNotMatch(source, /C:\\Users\\/i);
  }
  assert.match(cmd, /set "PI_CHAT_PROJECT_DIR=%~dp0"/);
  assert.match(cmd, /-WorkingDirectory \$env:PI_CHAT_PROJECT_DIR/);
  assert.match(cmd, /-RedirectStandardOutput \$env:PI_CHAT_SERVER_OUT/);
  assert.match(cmd, /-RedirectStandardError \$env:PI_CHAT_SERVER_ERR/);
  assert.doesNotMatch(cmd, /-WorkingDirectory\s+'%~dp0'/i);
  assert.equal(cmd.includes("-WorkingDirectory '%~dp0'"), false);
  assert.match(ui, /resources\\icons\\pi-chat\.ico/i);
  assert.match(ui, /launcherExitCode -ne 0/);
  assert.match(ui, /server-\$runId\.stdout\.log/);
  assert.match(ui, /server-\$runId\.stderr\.log/);
  assert.match(ui, /Open log/);
  assert.match(ui, /Close/);
  assert.match(installer, /Split-Path -Parent \$PSScriptRoot/);
  assert.match(installer, /-WindowStyle Hidden/);
  assert.match(installer, /\$shortcut\.WindowStyle = 7/);
  assert.match(installer, /GetFolderPath\('DesktopDirectory'\)/);
  assert.match(installer, /-Name 'Pi Chat' -Mode 'pwa'/);
  assert.match(installer, /-Name 'Pi Chat Web' -Mode 'web'/);
  assert.match(readiness, /\/api\/health/);
  assert.match(readiness, /service -eq 'pi-chat'/);
  assert.doesNotMatch(readiness, /Get-NetTCPConnection/);
});

test("packaged icon is a multi-image Windows ICO", async () => {
  const icon = await readFile(join(root, "resources/icons/pi-chat.ico"));
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.ok(icon.readUInt16LE(4) >= 4);
});

test("shortcut installer supports checkout paths with shell metacharacters", { skip: process.platform !== "win32" }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "pi-chat-shortcuts-"));
  const portableRoot = join(sandbox, "Pi Chat's & (portable)");
  const desktop = join(sandbox, "Desktop");
  try {
    await mkdir(join(portableRoot, "scripts"), { recursive: true });
    await mkdir(join(portableRoot, "resources", "icons"), { recursive: true });
    await Promise.all([
      cp(join(root, "scripts", "install-shortcuts.ps1"), join(portableRoot, "scripts", "install-shortcuts.ps1")),
      cp(join(root, "start-pi-chat-ui.ps1"), join(portableRoot, "start-pi-chat-ui.ps1")),
      cp(join(root, "resources", "icons", "pi-chat.ico"), join(portableRoot, "resources", "icons", "pi-chat.ico")),
    ]);
    execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", join(portableRoot, "scripts", "install-shortcuts.ps1"),
      "-DesktopPath", desktop,
    ], { cwd: portableRoot, stdio: "pipe" });
    const inspect = [
      "$shell = New-Object -ComObject WScript.Shell",
      "$names = @('Pi Chat.lnk', 'Pi Chat Web.lnk')",
      "$names | ForEach-Object {",
      "  $shortcut = $shell.CreateShortcut((Join-Path $env:PI_CHAT_TEST_DESKTOP $_))",
      "  [pscustomobject]@{ Name = $_; TargetPath = $shortcut.TargetPath; Arguments = $shortcut.Arguments; WorkingDirectory = $shortcut.WorkingDirectory; IconLocation = $shortcut.IconLocation }",
      "} | ConvertTo-Json -Compress",
    ].join("; ");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", inspect], {
      encoding: "utf8",
      env: { ...process.env, PI_CHAT_TEST_DESKTOP: desktop },
    });
    const shortcuts = JSON.parse(output) as Array<Record<string, string>>;
    assert.equal(shortcuts.length, 2);
    assert.match(shortcuts[0].TargetPath, /powershell\.exe$/i);
    assert.match(shortcuts[0].Arguments, /start-pi-chat-ui\.ps1" pwa$/i);
    assert.match(shortcuts[1].Arguments, /start-pi-chat-ui\.ps1" web$/i);
    for (const shortcut of shortcuts) {
      assert.equal(shortcut.WorkingDirectory, portableRoot);
      assert.ok(shortcut.Arguments.includes("Pi Chat's & (portable)"));
      assert.match(shortcut.IconLocation, /resources\\icons\\pi-chat\.ico,0$/i);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
