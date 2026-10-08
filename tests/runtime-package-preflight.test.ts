import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { assertRuntimeFiles } from "../scripts/check-runtime-files.mjs";

const project = resolve(import.meta.dirname, "..");
const required = JSON.parse(await readFile(join(project, "scripts/runtime-required-files.json"), "utf8")) as string[];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-package-preflight-"));
  for (const file of required) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), "fixture\n");
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-chat", type: "module", version: "0.5.0" }));
  await writeFile(join(root, "dist/build-identity.json"), JSON.stringify({ schemaVersion: 1, packageVersion: "0.5.0", revision: "fixture", fingerprint: "a".repeat(64) }));
  await mkdir(join(root, "dist/web/assets"));
  await writeFile(join(root, "dist/web/assets/index.js"), "// fixture\n");
  await writeFile(join(root, "dist/web/index.html"), '<script src="/assets/index.js"></script>');
  return root;
}

test("runtime preflight accepts a complete release without source, npm or node_modules", async () => {
  const root = await fixture();
  try { await assertRuntimeFiles(root); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime preflight rejects every missing required file and missing Web entry assets", async () => {
  const root = await fixture();
  try {
    for (const file of required) {
      const path = join(root, file);
      const content = await readFile(path);
      await rm(path);
      await assert.rejects(assertRuntimeFiles(root), /runtime files are missing/);
      await writeFile(path, content);
    }
    await rm(join(root, "dist/web/assets/index.js"));
    await assert.rejects(assertRuntimeFiles(root), /Web asset is missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime preflight rejects inconsistent metadata and unsafe Web entry assets", async () => {
  const root = await fixture();
  try {
    for (const src of ["../outside.js", "https://example.invalid/app.js", "//example.invalid/app.js"]) {
      await writeFile(join(root, "dist/web/index.html"), `<script src="${src}"></script>`);
      await assert.rejects(assertRuntimeFiles(root), /Web asset/);
    }
    await writeFile(join(root, "dist/web/index.html"), "<html></html>");
    await assert.rejects(assertRuntimeFiles(root), /no JavaScript entry/);
    await writeFile(join(root, "dist/build-identity.json"), "{}");
    await assert.rejects(assertRuntimeFiles(root), /metadata and build identity/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows preflight explains missing Node without downloading or starting a service", { skip: process.platform !== "win32" }, async () => {
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const result = (() => {
    try {
      execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(project, "scripts/pi-chat-preflight.ps1"), "-ProjectDirectory", project], {
        env: { ...process.env, PATH: "", Path: "" }, encoding: "utf8", windowsHide: true,
      });
      return "unexpected success";
    } catch (error) {
      return String((error as { stderr: string }).stderr);
    }
  })();
  assert.match(result, /Node.js was not found/);
  assert.match(result, /computer restart is not required/);
});

test("runtime preflight distinguishes source setup from an incomplete release", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-preflight-guidance-"));
  const run = () => {
    try {
      execFileSync(process.execPath, [join(project, "scripts/check-runtime-files.mjs"), root], { encoding: "utf8", stdio: "pipe" });
      return "unexpected success";
    } catch (error) { return String((error as { stderr: string }).stderr); }
  };
  try {
    assert.match(run(), /fully extract/);
    assert.match(run(), /Do not run npm install/);
    await mkdir(join(root, "src/server"), { recursive: true });
    await writeFile(join(root, "src/server/index.ts"), "// fixture\n");
    const sourceError = run();
    assert.match(sourceError, /source checkout/);
    assert.match(sourceError, /npm ci --include=dev/);
    assert.match(sourceError, /npm run build/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows preflight rejects old Node before loading modern JavaScript", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-old-node-"));
  try {
    const fakeNode = join(root, "node.cmd");
    await writeFile(fakeNode, "@echo off\r\necho 20.19.0\r\nexit /b 0\r\n");
    const command = 'function Get-Command { [pscustomobject]@{ Source = $env:PI_CHAT_FAKE_NODE } }; & $env:PI_CHAT_PREFLIGHT -ProjectDirectory $env:PI_CHAT_FAKE_PROJECT';
    assert.throws(() => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
      env: { ...process.env, PI_CHAT_FAKE_NODE: fakeNode, PI_CHAT_PREFLIGHT: join(project, "scripts/pi-chat-preflight.ps1"), PI_CHAT_FAKE_PROJECT: root }, encoding: "utf8", stdio: "pipe",
    }), (error: unknown) => {
      assert.match(String((error as { stderr: string }).stderr), /22.19 or newer is required; detected: 20.19.0/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows server launcher reports immediate child exit and includes its diagnostic log", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-start-failure-"));
  try {
    await mkdir(join(root, "dist/server/server"), { recursive: true });
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "dist/server/server/index.js"), "console.error('fixture-service-error'); process.exit(7);\n");
    await writeFile(join(root, "scripts/pi-chat-port-ready.ps1"), "exit 1\r\n");
    assert.throws(() => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(project, "scripts/pi-chat-start-server.ps1"), "-ProjectDirectory", root], {
      env: { ...process.env, PI_CHAT_SERVER_OUT: join(root, "stdout.log"), PI_CHAT_SERVER_ERR: join(root, "stderr.log") },
      encoding: "utf8", windowsHide: true, timeout: 15000,
    }), (error: unknown) => {
      const output = String((error as { stderr: string }).stderr);
      assert.match(output, /fixture-service-error/);
      assert.match(output, /exited before it was ready/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
