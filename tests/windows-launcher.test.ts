import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  for (const file of ["CONTRIBUTING.md", "docs", "start-pi-chat.cmd", "start-pi-chat-ui.ps1", "scripts/install-shortcuts.ps1", "scripts/pi-chat-launch-process.ps1", "scripts/pi-chat-preflight.ps1", "scripts/pi-chat-start-server.ps1", "scripts/check-runtime-files.mjs", "scripts/runtime-required-files.json", "scripts/assert-safe-live-dist.mjs", "scripts/dist-paths.mjs", "scripts/workspace-artifacts.mjs", "scripts/run-staged-verification.mjs", "resources"]) {
    assert.ok(pkg.files.includes(file), `${file} must be included in the package`);
  }
  assert.equal(pkg.scripts["install:shortcuts"], "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-shortcuts.ps1");
  assert.equal(pkg.scripts["test:focus"], "node scripts/run-tests.mjs");
  assert.equal(pkg.scripts["verify:unit"], "node scripts/run-staged-verification.mjs unit");
  assert.equal(pkg.scripts["verify:e2e"], "node scripts/run-staged-verification.mjs e2e");
  assert.equal(pkg.scripts.verify, "node scripts/run-staged-verification.mjs all");
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
  assert.match(cmd, /pi-chat-preflight\.ps1/i);
  assert.match(cmd, /pi-chat-start-server\.ps1/i);
  assert.doesNotMatch(cmd, /call npm|npm run build|npm install|current-version/i);
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

test("double-click wrapper preserves errors and offers an explicit noninteractive escape", { skip: process.platform !== "win32" }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "pi-chat-wrapper-"));
  try {
    await cp(join(root, "start-pi-chat.cmd"), join(sandbox, "start-pi-chat.cmd"));
    await writeFile(join(sandbox, "pi-chat-launch.cmd"), "@echo off\r\necho fixture-launch-failure\r\nexit /b 7\r\n");
    assert.throws(() => execFileSync("cmd.exe", ["/d", "/c", join(sandbox, "start-pi-chat.cmd")], {
      env: { ...process.env, PI_CHAT_NONINTERACTIVE: "1" }, encoding: "utf8", timeout: 5000,
    }), (error: unknown) => {
      const result = error as { status: number; stdout: string };
      assert.equal(result.status, 7);
      assert.match(result.stdout, /fixture-launch-failure/);
      assert.match(result.stdout, /recovery steps above/);
      return true;
    });
    const wrapper = await readProjectFile("start-pi-chat.cmd");
    assert.match(wrapper, /PI_CHAT_NONINTERACTIVE.*pause/);
  } finally { await rm(sandbox, { recursive: true, force: true }); }
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
        response.end(JSON.stringify({ requestToken: "test-token", buildIdentity: { schemaVersion: 1, packageVersion: "0.4.6", revision: "test-revision", fingerprint } }));
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
    await writeFile(join(sandbox, "dist", "build-identity.json"), JSON.stringify({ schemaVersion: 1, packageVersion: "0.4.6", revision: "test-revision", fingerprint: matching }), "utf8");
    assert.equal(await runReadiness(port), 0, "matching listener is ready");
    await writeFile(join(sandbox, "dist", "build-identity.json"), JSON.stringify({ schemaVersion: 1, packageVersion: "0.4.6", revision: "other-revision", fingerprint: matching }), "utf8");
    assert.equal(await runReadiness(port), 2, "revision mismatch is distinguished from a matching build");
    await writeFile(join(sandbox, "dist", "build-identity.json"), JSON.stringify({ schemaVersion: 1, packageVersion: "0.4.6", revision: "test-revision", fingerprint: stale }), "utf8");
    assert.equal(await runReadiness(port), 2, "fingerprint mismatch is distinguished from no listener");
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
    await writeFile(launcher, "@echo off\r\necho mode=%~1\r\necho captured-error 1>&2\r\nexit /b %PI_CHAT_TEST_EXIT%\r\n", "utf8");
    const invoke = [
      ". $env:PI_CHAT_PROCESS_HELPER",
      "$process = Start-PiChatLauncherProcess -ProjectDirectory $env:PI_CHAT_TEST_ROOT -LauncherPath $env:PI_CHAT_TEST_LAUNCHER -Mode $env:PI_CHAT_TEST_MODE -StandardOutputPath $env:PI_CHAT_TEST_OUT -StandardErrorPath $env:PI_CHAT_TEST_ERR",
      "while (-not $process.HasExited) { Start-Sleep -Milliseconds 10 }",
      "$exitCode = Get-PiChatLauncherExitCode -Process $process",
      "$process.Dispose()",
      "[pscustomobject]@{ ExitCode = $exitCode; Stdout = [string](Get-Content -LiteralPath $env:PI_CHAT_TEST_OUT -Raw); Stderr = [string](Get-Content -LiteralPath $env:PI_CHAT_TEST_ERR -Raw) } | ConvertTo-Json -Compress",
    ].join("; ");
    for (const [expected, mode] of [[0, "web"], [7, "pwa"], [2, "web"]] as const) {
      const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", invoke], {
        encoding: "utf8",
        env: {
          ...process.env,
          PI_CHAT_PROCESS_HELPER: join(root, "scripts", "pi-chat-launch-process.ps1"),
          PI_CHAT_TEST_ROOT: portableRoot,
          PI_CHAT_TEST_EXIT: String(expected),
          PI_CHAT_TEST_MODE: mode,
          PI_CHAT_TEST_LAUNCHER: launcher,
          PI_CHAT_TEST_OUT: stdoutPath,
          PI_CHAT_TEST_ERR: stderrPath,
        },
      });
      const result = JSON.parse(output) as { ExitCode: number; Stdout: string; Stderr: string };
      assert.equal(result.ExitCode, expected);
      assert.ok(result.Stdout.includes(`mode=${mode}`));
      assert.match(result.Stderr, /captured-error/);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("installer running guard identifies filesystem aliases and does not block another installation", { skip: process.platform !== "win32" }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "pi-chat-running-alias-"));
  const actual = join(sandbox, "actual"), alias = join(sandbox, "junction");
  const result = join(sandbox, "check.ini");
  await mkdir(actual);
  await cp(process.execPath, join(actual, "node.exe"));
  await symlink(actual, alias, "junction");
  const child = spawn(join(actual, "node.exe"), ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const exited = once(child, "exit");
  try {
    await once(child.stdout!, "data", { signal: AbortSignal.timeout(10_000) });
    const check = (directory: string) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts/pi-chat-setup.ps1"), "-Action", "CheckRunning", "-InstallRoot", directory, "-ResultFile", result], { stdio: "pipe", windowsHide: true, timeout: 20_000 });
    for (const directory of [actual, alias]) {
      assert.throws(() => check(directory), (error: unknown) => (error as { status: number }).status === 11);
      assert.match((await readFile(result)).toString("utf16le"), /running from this installation/);
    }
    check(join(sandbox, "another-installation"));
    assert.match((await readFile(result)).toString("utf16le"), /not owned by a running Node process/);
    assert.equal(child.exitCode, null, "checking aliases must never stop the process");
  } finally {
    child.kill("SIGTERM"); await exited;
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
  const startMenu = join(sandbox, "Start Menu", "Programs", "Pi Chat");
  try {
    await mkdir(join(portableRoot, "scripts"), { recursive: true });
    await mkdir(join(portableRoot, "resources", "icons"), { recursive: true });
    await Promise.all([
      cp(join(root, "scripts", "install-shortcuts.ps1"), join(portableRoot, "scripts", "install-shortcuts.ps1")),
      cp(join(root, "start-pi-chat-ui.ps1"), join(portableRoot, "start-pi-chat-ui.ps1")),
      cp(join(root, "resources", "icons", "pi-chat.ico"), join(portableRoot, "resources", "icons", "pi-chat.ico")),
    ]);
    const setupNames = ["Pi Chat.lnk", "Pi Chat Web.lnk"];
    const setupOwned: string[] = [];
    for (const directory of [desktop, startMenu]) {
      await mkdir(directory, { recursive: true });
      for (const name of setupNames) {
        const path = join(directory, name);
        await writeFile(path, "Setup-owned shortcut sentinel");
        setupOwned.push(path);
      }
    }
    execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", join(portableRoot, "scripts", "install-shortcuts.ps1"),
      "-DesktopPath", desktop,
      "-StartMenuPath", startMenu,
    ], { cwd: portableRoot, stdio: "pipe" });
    const inspect = [
      "$shell = New-Object -ComObject WScript.Shell",
      "$locations = @($env:PI_CHAT_TEST_DESKTOP, $env:PI_CHAT_TEST_START_MENU, $env:PI_CHAT_TEST_PROJECT)",
      "$items = @($locations | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter 'Pi Chat Git*.lnk' -File })",
      "$items | ForEach-Object {",
      "  $shortcut = $shell.CreateShortcut($_.FullName)",
      "  [pscustomobject]@{ Location = $_.DirectoryName; Name = $_.Name; TargetPath = $shortcut.TargetPath; Arguments = $shortcut.Arguments; WorkingDirectory = $shortcut.WorkingDirectory; IconLocation = $shortcut.IconLocation }",
      "} | ConvertTo-Json -Compress",
    ].join("; ");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", inspect], {
      encoding: "utf8",
      env: { ...process.env, PI_CHAT_TEST_DESKTOP: desktop, PI_CHAT_TEST_START_MENU: startMenu, PI_CHAT_TEST_PROJECT: portableRoot },
    });
    const shortcuts = JSON.parse(output) as Array<Record<string, string>>;
    assert.equal(shortcuts.length, 4);
    for (const path of setupOwned) assert.equal(await readFile(path, "utf8"), "Setup-owned shortcut sentinel");
    assert.equal(shortcuts.filter(s => s.Name === "Pi Chat Git PWA.lnk").length, 1);
    assert.ok(shortcuts.some(s => s.Name === "Pi Chat Git.lnk" && s.Location.includes("Pi Chat's & (portable)")));
    assert.match(shortcuts[0].TargetPath, /powershell\.exe$/i);
    const canonicalPortableRoot = await realpath(portableRoot);
    for (const shortcut of shortcuts) {
      // Windows may expose the Node-created temporary directory through an 8.3
      // short path while the Shortcut COM API returns its long-path spelling.
      assert.equal(await realpath(shortcut.WorkingDirectory), canonicalPortableRoot);
      assert.ok(shortcut.Arguments.includes("Pi Chat's & (portable)"));
      assert.match(shortcut.IconLocation, /resources\\icons\\pi-chat\.ico,0$/i);
      assert.ok(shortcut.Arguments.endsWith(shortcut.Name === "Pi Chat Git PWA.lnk" ? '" pwa' : '" web'));
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
