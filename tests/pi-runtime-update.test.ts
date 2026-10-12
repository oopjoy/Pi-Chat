import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPiRuntimeUpdate, comparePiVersions, PI_RUNTIME_PACKAGE, resolveManagedPiInstall, resolveNpmCli, switchManagedPiVersion } from "../src/server/pi-runtime-update";

test("Pi Runtime version comparison handles release versions", () => {
  assert.equal(comparePiVersions("1.0.1", "1.0.1"), 0);
  assert.equal(comparePiVersions("1.0.0", "1.0.1"), -1);
  assert.equal(comparePiVersions("1.2.0", "1.1.9"), 1);
  assert.equal(comparePiVersions(undefined, "1.0.1"), null);
});

test("Pi Runtime update check is read-only and reports the npm latest version", async () => {
  let requested = "";
  const result = await checkPiRuntimeUpdate("1.0.1", async (input) => {
    requested = input;
    return new Response(JSON.stringify({ "dist-tags": { latest: "1.1.0" } }), { status: 200 });
  });
  assert.equal(requested, "https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent");
  assert.equal(result.packageName, PI_RUNTIME_PACKAGE);
  assert.equal(result.currentVersion, "1.0.1");
  assert.equal(result.latestVersion, "1.1.0");
  assert.equal(result.updateAvailable, true);
  assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("managed install resolution only claims entries inside a managed releases root", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-chat-managed-res-"));
  try {
    const managedRoot = join(home, ".pi", "agent", "install");
    const entry = join(managedRoot, "releases", "1.1.0", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "rpc-entry.js");
    await mkdir(join(managedRoot, "releases", "1.1.0"), { recursive: true });
    const env = { USERPROFILE: home, HOME: home } as NodeJS.ProcessEnv;
    const inside = resolveManagedPiInstall(entry, env, join(home, "app"));
    assert.ok(inside);
    assert.equal(inside.root, managedRoot);
    const outside = resolveManagedPiInstall("C:\\ elsewhere \\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\rpc-entry.js", env, join(home, "app"));
    assert.equal(outside, null, "a user-owned npm install must never be claimed for in-place updates");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("managed pointer switch is atomic and refuses uninstalled versions", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-chat-managed-ptr-"));
  try {
    const managedRoot = join(home, "install");
    await mkdir(managedRoot, { recursive: true });
    await assert.rejects(switchManagedPiVersion(managedRoot, "9.9.9"), /尚未安装完成/);
    const release = join(managedRoot, "releases", "2.0.0", "node_modules", "@earendil-works", "pi-coding-agent", "dist");
    await mkdir(release, { recursive: true });
    await writeFile(join(release, "rpc-entry.js"), "// fixture\n");
    await switchManagedPiVersion(managedRoot, "2.0.0");
    assert.equal(await import("node:fs/promises").then(m => m.readFile(join(managedRoot, "current-version"), "utf8")), "2.0.0");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("resolveNpmCli finds a usable npm-cli.js on this machine", { skip: process.platform !== "win32" }, async () => {
  const cli = await resolveNpmCli("D:\\nonexistent-pi-chat-app");
  assert.ok(cli, "expected a usable npm-cli.js beside the Node.js installation");
  assert.match(cli, /npm-cli\.js$/);
});

test("Pi Runtime update check fails closed on malformed registry metadata", async () => {
  await assert.rejects(
    checkPiRuntimeUpdate("1.0.1", async () => new Response(JSON.stringify({ "dist-tags": {} }), { status: 200 })),
    /检查 Pi Runtime 更新失败/,
  );
});
