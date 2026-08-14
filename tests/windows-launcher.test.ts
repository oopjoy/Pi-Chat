import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  for (const file of ["start-pi-chat.cmd", "start-pi-chat-ui.ps1", "scripts/install-shortcuts.ps1", "scripts/pi-chat-launch-process.ps1", "scripts/assert-safe-live-dist.mjs", "scripts/dist-paths.mjs", "scripts/workspace-artifacts.mjs", "resources"]) {
    assert.ok(pkg.files.includes(file), `${file} must be included in the package`);
  }
  assert.equal(pkg.scripts["install:shortcuts"], "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-shortcuts.ps1");
  for (const script of ["preclean", "prebuild", "prebuild:identity", "prebuild:web", "prebuild:server", "precopy:resources"]) {
    assert.equal(pkg.scripts[script], "node scripts/assert-safe-live-dist.mjs", `${script} must protect live dist`);
  }
  assert.match(wrapper, /pi-chat-launch\.cmd" web/i);
});

test("launcher keeps portable path resolution and refuses to take over another build", async () => {
  const [cmd, ui, installer, readiness] = await Promise.all([
    readProjectFile("pi-chat-launch.cmd"),
    readProjectFile("start-pi-chat-ui.ps1"),
    readProjectFile("scripts/install-shortcuts.ps1"),
    readProjectFile("scripts/pi-chat-port-ready.ps1"),
  ]);
  for (const source of [cmd, ui, installer])
    assert.doesNotMatch(source, /C:\\Users\\/i);

  assert.match(cmd, /%~dp0/);
  assert.match(cmd, /pi-chat-port-ready\.ps1/i);
  assert.match(readiness, /\/api\/bootstrap\/handshake/);
  assert.match(readiness, /exit 2/);
  assert.match(cmd, /if errorlevel 2 goto :stale/i);
  assert.match(cmd, /A different Pi Chat build is already running/i);
  assert.match(cmd, /exit \/b 1/i);
  assert.doesNotMatch(cmd, /\/api\/shutdown/);
  assert.doesNotMatch(cmd, /X-Pi-Chat-Token/);
  assert.doesNotMatch(readiness, /X-Pi-Chat-Token/);
});

test("PowerShell readiness distinguishes the expected build from a verified stale listener", { skip: process.platform !== "win32" }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "pi-chat-readiness-"));
  const readyScript = join(root, "scripts", "pi-chat-port-ready.ps1");
  const matching = "a".repeat(64);
  const stale = "b".repeat(64);
  const fixtureSource = String.raw`
    import { createServer } from "node:http";
    const fingerprint = process.env.PI_CHAT_TEST_FINGERPRINT;
    const server = createServer((request, response) => {
      if (request.url === "/api/bootstrap/handshake") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ requestToken: "test-token", buildIdentity: { schemaVersion: 1, fingerprint } }));
      } else { response.statusCode = 404; response.end(); }
    });
    server.listen(0, "127.0.0.1", () => console.log("PORT=" + server.address().port));
  `;
  const fixture = spawn(process.execPath, ["--input-type=module", "-e", fixtureSource], {
    env: { ...process.env, PI_CHAT_TEST_FINGERPRINT: matching },
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  let output = "";
  fixture.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const runReadiness = (port: number) => new Promise<number>((resolveExit, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", readyScript,
      "-Port", String(port), "-ProjectDirectory", sandbox,
    ], { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!/PORT=(\d+)/.test(output) && Date.now() < deadline)
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    const port = Number(/PORT=(\d+)/.exec(output)?.[1]);
    assert.ok(port > 0, "test listener must announce a port");
    await mkdir(join(sandbox, "dist"));
    await writeFile(join(sandbox, "dist", "build-identity.json"), JSON.stringify({ schemaVersion: 1, fingerprint: matching }), "utf8");
    assert.equal(await runReadiness(port), 0, "matching listener is ready");
    await writeFile(join(sandbox, "dist", "build-identity.json"), JSON.stringify({ schemaVersion: 1, fingerprint: stale }), "utf8");
    assert.equal(await runReadiness(port), 2, "verified mismatched listener is distinguished from no listener");
  } finally {
    fixture.kill("SIGTERM");
    await Promise.race([once(fixture, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("PowerShell launcher wrapper preserves exit code and captures output through metacharacter paths", { skip: process.platform !== "win32" }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "pi-chat-process-"));
  const portableRoot = join(sandbox, "Pi Chat's & (portable)");
  const launcher = join(portableRoot, "fake-launcher.cmd");
  const stdoutPath = join(sandbox, "launcher stdout.log");
  const stderrPath = join(sandbox, "launcher stderr.log");
  try {
    await mkdir(portableRoot, { recursive: true });
    await writeFile(launcher, "@echo off\r\necho mode=%~1\r\necho captured-error 1>&2\r\nexit /b 0\r\n", "utf8");
    const invoke = [
      ". $env:PI_CHAT_PROCESS_HELPER",
      "$process = Start-PiChatLauncherProcess -ProjectDirectory $env:PI_CHAT_TEST_ROOT -LauncherPath $env:PI_CHAT_TEST_LAUNCHER -Mode 'pwa' -StandardOutputPath $env:PI_CHAT_TEST_OUT -StandardErrorPath $env:PI_CHAT_TEST_ERR",
      "$exitCode = Get-PiChatLauncherExitCode -Process $process",
      "$process.Dispose()",
      "[pscustomobject]@{ ExitCode = $exitCode; Stdout = [string](Get-Content -LiteralPath $env:PI_CHAT_TEST_OUT -Raw); Stderr = [string](Get-Content -LiteralPath $env:PI_CHAT_TEST_ERR -Raw) } | ConvertTo-Json -Compress",
    ].join("; ");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", invoke], {
      encoding: "utf8",
      env: {
        ...process.env,
        PI_CHAT_PROCESS_HELPER: join(root, "scripts", "pi-chat-launch-process.ps1"),
        PI_CHAT_TEST_ROOT: portableRoot,
        PI_CHAT_TEST_LAUNCHER: launcher,
        PI_CHAT_TEST_OUT: stdoutPath,
        PI_CHAT_TEST_ERR: stderrPath,
      },
    });
    const result = JSON.parse(output) as { ExitCode: number; Stdout: string; Stderr: string };
    assert.equal(result.ExitCode, 0);
    assert.match(result.Stdout, /mode=pwa/);
    assert.match(result.Stderr, /captured-error/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
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
    const canonicalPortableRoot = await realpath(portableRoot);
    for (const shortcut of shortcuts) {
      // Windows may expose the Node-created temporary directory through an 8.3
      // short path while the Shortcut COM API returns its long-path spelling.
      assert.equal(await realpath(shortcut.WorkingDirectory), canonicalPortableRoot);
      assert.ok(shortcut.Arguments.includes("Pi Chat's & (portable)"));
      assert.match(shortcut.IconLocation, /resources\\icons\\pi-chat\.ico,0$/i);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
