import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { prepareSetupInputs, windowsBuildEnvironment } from "./prepare-setup-inputs.mjs";
import { buildSetup } from "./setup-package.mjs";

const execute = promisify(execFileCallback);
if (process.platform !== "win32") throw new Error("Windows installer integration test requires Windows");
const repo = resolve(import.meta.dirname, "..");
const root = await mkdtemp(join(tmpdir(), "pi-chat-inno-test-"));
const install = join(root, "Pi Chat's & (test)");
const exe = join(root, "pi-chat-setup.exe");
const appId = "PiChat.Test." + randomUUID();
const inputs = await prepareSetupInputs();
const env = windowsBuildEnvironment();
for (const key of Object.keys(env)) if (/^(PI_CHAT_|PI_CODING_AGENT_)/i.test(key)) delete env[key];
Object.assign(env, {
  USERPROFILE: join(root, "profile"), HOME: join(root, "profile"),
  PI_CODING_AGENT_DIR: join(root, "profile/.pi/agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
  PI_CHAT_PI_ENTRY: join(root, "missing/rpc-entry.js"),
});
for (const dir of ["profile/.pi/agent", "sessions", "workspace"]) await mkdir(join(root, dir), { recursive: true });
const sentinelFile = join(root, "profile/.pi/agent/keep.json");
await writeFile(sentinelFile, '{"userData":"preserve"}\n');
const flags = ["/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/NOICONS", "/TASKS=", `/DIR=${install}`, `/LOG=${join(root, "setup.log")}`];
const ps = (code, extra = {}) => execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", code], { env: { ...env, ...extra }, windowsHide: true, timeout: 30_000 });
const exists = path => access(path).then(() => true).catch(() => false);
let uninstaller;
let passed = false;
try {
  console.log("[Setup check] Build with the private, pinned Node binary in an isolated staging directory");
  const stage = join(root, "dist");
  const buildEnv = { ...env, PATH: inputs.nodeRoot + delimiter + (env.PATH || env.Path || ""), PI_CHAT_DIST_DIR: stage, PI_CHAT_RELEASE_MODE: "0" };
  const build = await execute(join(inputs.nodeRoot, "node.exe"), [join(inputs.nodeRoot, "node_modules/npm/bin/npm-cli.js"), "run", "build"], {
    cwd: repo, env: buildEnv, windowsHide: true, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
  });
  await writeFile(join(root, "build.log"), build.stdout + build.stderr);
  await buildSetup({ repoRoot: repo, stagingDir: stage, outputPath: exe, inputs, appId });
  console.log("[Setup check] Install embedded App + Node; seed bundled Pi only when none exists");
  await execute(exe, flags, { env, windowsHide: true, timeout: 120_000 });
  uninstaller = join(install, "unins000.exe");
  assert.ok(await exists(uninstaller));
  assert.ok(await exists(join(install, "app/LICENSE")));
  assert.ok(await exists(join(install, "runtime/node/LICENSE")));
  const node = join(install, "runtime/node/node.exe");
  assert.equal((await execute(node, ["--version"], { env })).stdout.trim(), `v${inputs.node.version}`);
  const npmVersion = (await execute(node, [join(install, "runtime/node/node_modules/npm/bin/npm-cli.js"), "--version"], { env, windowsHide: true })).stdout.trim();
  assert.match(npmVersion, /^\d+\.\d+\.\d+$/);
  const rootShortcut = join(install, "Pi Chat Web.lnk");
  assert.ok(await exists(rootShortcut), "installation root must contain a native-uninstall-owned Web entry");
  const shortcutResult = await ps('$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut($env:SETUP_CHECK_SHORTCUT); $s | Select-Object Arguments,WorkingDirectory | ConvertTo-Json -Compress', { SETUP_CHECK_SHORTCUT: rootShortcut });
  const shortcut = JSON.parse(shortcutResult.stdout);
  assert.match(shortcut.Arguments, /start-pi-chat-ui\.ps1" web$/);
  assert.equal(await realpath(shortcut.WorkingDirectory), await realpath(join(install, "app")));
  const identity = JSON.parse(await readFile(join(install, "app/dist/build-identity.json"), "utf8"));
  assert.ok(await exists(join(install, "app/dist/web/index.html")));
  assert.ok(await exists(join(install, "runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js")), "Setup must embed the pinned Pi snapshot");
  assert.equal(JSON.parse(await readFile(join(install, "runtime/pi/node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version, inputs.pi.version);
  assert.equal((await readFile(join(root, "profile/.pi/agent/install/current-version"), "utf8")).trim(), inputs.pi.version, "silent install seeds bundled Pi when none is present");
  const key = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appId}_is1`;
  const registration = await ps('$p=Get-ItemProperty -LiteralPath $env:SETUP_CHECK_KEY; $p | Select-Object DisplayVersion,InstallLocation | ConvertTo-Json -Compress', { SETUP_CHECK_KEY: key });
  assert.equal(JSON.parse(registration.stdout).DisplayVersion, identity.packageVersion);

  console.log("[Setup check] Existing Pi is never upgraded; bundled Pi seeds offline when missing");
  const piPackage = join(root, "existing-pi");
  await mkdir(join(piPackage, "dist"), { recursive: true });
  await writeFile(join(piPackage, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.1" }));
  const piEntry = join(piPackage, "dist/rpc-entry.js");
  await writeFile(piEntry, "// existing user-owned Pi fixture\n");
  const helper = join(install, "app/scripts/pi-chat-setup.ps1");
  const invokeHelper = '$ErrorActionPreference="Stop"; & $env:SETUP_CHECK_HELPER -Action InstallPi -InstallRoot $env:SETUP_CHECK_ROOT -ResultFile $env:SETUP_CHECK_RESULT; exit $LASTEXITCODE';
  const resultIni = join(root, "pi-result.ini");
  const helperEnv = { SETUP_CHECK_HELPER: helper, SETUP_CHECK_ROOT: install, SETUP_CHECK_RESULT: resultIni, PI_CHAT_PI_ENTRY: piEntry };
  await ps(invokeHelper, helperEnv);
  assert.match((await readFile(resultIni)).toString("utf16le"), /Found=1/);
  assert.equal(await readFile(piEntry, "utf8"), "// existing user-owned Pi fixture\n");
  // Proxy override is local to this one PowerShell process. No machine network
  // settings change, no real npm installation, and no user credentials loaded.
  const offlineEnv = { ...helperEnv, PI_CHAT_PI_ENTRY: "", USERPROFILE: join(root, "offline-profile"), HOME: join(root, "offline-profile"),
    APPDATA: join(root, "empty-appdata"), PI_CHAT_MANAGED_INSTALL_ROOT: "", PI_MANAGED_INSTALL_ROOT: "",
    npm_config_prefix: "", NPM_CONFIG_PREFIX: "",
    PATH: inputs.nodeRoot + delimiter + join(process.env.SystemRoot, "System32") + delimiter + join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0") };
  await mkdir(join(root, "offline-profile"), { recursive: true });
  await ps('[Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy("http://127.0.0.1:9"); ' + invokeHelper, offlineEnv);
  const offlineResult = (await readFile(resultIni)).toString("utf16le");
  assert.match(offlineResult, /Found=1/);
  assert.match(offlineResult, /existing Pi|Installed bundled Pi/);
  assert.doesNotMatch(offlineResult, /registry|download failed/i);
  assert.equal((await readFile(join(root, "profile/.pi/agent/install/current-version"), "utf8")).trim(), inputs.pi.version);
  assert.ok(await exists(node));

  console.log("[Setup check] Running installation refuses upgrade and uninstall without killing the owned process");
  const sentinel = spawn(node, ["-e", "console.log('ready'); setInterval(() => {}, 1000)", "--", install + "\\owned-sentinel"], { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const stopped = once(sentinel, "exit");
  try {
    await once(sentinel.stdout, "data", { signal: AbortSignal.timeout(15_000) });
    const canonicalInstall = await realpath(install);
    console.log(`[Setup check] Running guard: requested=${install}; canonical=${canonicalInstall}`);
    for (const directory of new Set([install, canonicalInstall])) {
      await assert.rejects(execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Action", "CheckRunning", "-InstallRoot", directory, "-ResultFile", resultIni], { env, windowsHide: true, timeout: 30_000 }), error => error.code === 11, "helper must refuse this running installation through either path spelling");
    }
    await assert.rejects(execute(exe, flags, { env, windowsHide: true, timeout: 30_000 }), "installer must reject an active target");
    await assert.rejects(execute(uninstaller, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], { env, windowsHide: true, timeout: 30_000 }), "uninstaller must reject an active target");
    assert.equal(sentinel.exitCode, null, "installer must never kill an active process");
    assert.ok(await exists(node));
  } finally { sentinel.kill("SIGTERM"); await stopped; }

  console.log("[Setup check] System Node with relative app argv also blocks target upgrade/uninstall");
  const relativeProbe = join(install, "guard-probe");
  await mkdir(join(relativeProbe, "dist/server/server"), { recursive: true });
  await writeFile(join(relativeProbe, "dist/server/server/index.js"), "console.log('ready'); setInterval(() => {}, 1000);\n");
  const external = spawn(process.execPath, ["dist/server/server/index.js"], { cwd: relativeProbe, env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const externalExited = once(external, "exit");
  try {
    await once(external.stdout, "data", { signal: AbortSignal.timeout(15_000) });
    await assert.rejects(execute(exe, flags, { env, windowsHide: true, timeout: 30_000 }), "system-Node owner must prevent upgrade");
    await assert.rejects(execute(uninstaller, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], { env, windowsHide: true, timeout: 30_000 }), "system-Node owner must prevent uninstall");
    assert.equal(external.exitCode, null);
  } finally {
    external.kill("SIGTERM"); await externalExited;
    await rm(relativeProbe, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  await execute(exe, flags, { env, windowsHide: true, timeout: 120_000 });

  console.log("[Setup check] Start installed release without source/system npm or an available Pi");
  const service = spawn(node, [join(install, "app/dist/server/server/index.js"), "--port", "0", "--cwd", join(root, "workspace")], { cwd: join(install, "app"), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(service, "exit");
  let output = "";
  const listening = new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error("Installed service did not listen")), 30_000);
    service.once("error", error => { clearTimeout(timer); reject(error); });
    service.once("exit", code => { clearTimeout(timer); reject(new Error(`Service exited early: ${code}`)); });
    service.stdout.on("data", chunk => { output += chunk; const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if (match) { clearTimeout(timer); resolveUrl(match[0]); } });
    service.stderr.on("data", chunk => { output += chunk; });
  });
  try {
    const url = await listening;
    const health = await fetch(url + "/api/health").then(response => response.json());
    assert.equal(health.buildIdentity.fingerprint, identity.fingerprint);
    assert.equal((await fetch(url + "/")).status, 200);
    const handshake = await fetch(url + "/api/bootstrap/handshake").then(response => response.json());
    assert.ok(handshake.requestToken);
    assert.equal(handshake.buildIdentity.fingerprint, identity.fingerprint);
  } finally { service.kill("SIGTERM"); await exited; await writeFile(join(root, "service.log"), output); }
  console.log("[Setup check] Uninstall native files/registration, preserve Pi data");
  await execute(uninstaller, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/LOG=${join(root, "uninstall.log")}`], { env, windowsHide: true, timeout: 90_000 });
  assert.equal(await exists(node), false);
  assert.equal(await exists(rootShortcut), false, "native uninstall must remove the generated root shortcut");
  assert.equal(await exists(join(install, "app/dist/server/server/index.js")), false);
  assert.equal(await readFile(sentinelFile, "utf8"), '{"userData":"preserve"}\n');
  const removed = await ps('if(Test-Path -LiteralPath $env:SETUP_CHECK_KEY){exit 1}', { SETUP_CHECK_KEY: key });
  assert.equal(removed.stderr.trim(), "");
  passed = true;
  console.log(`[Setup check] PASS: ${identity.packageVersion}, private Node ${inputs.node.version}, native install/upgrade/uninstall`);
} catch (error) {
  console.error(error.message, error.stdout || "", error.stderr || "");
  console.error(`[Setup check] Diagnostic staging retained: ${root}`);
  process.exitCode = 1;
} finally {
  if (passed) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
