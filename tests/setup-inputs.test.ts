import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifiedDownload, windowsBuildEnvironment } from "../scripts/prepare-setup-inputs.mjs";
import { applicationPackageFiles } from "../scripts/setup-package.mjs";

const bytes = Buffer.from("verified fixture");
const spec = { archive: "fixture.bin", url: "https://example.invalid/fixture.bin", sha256: createHash("sha256").update(bytes).digest("hex") };

test("installer build inputs are checksum pinned and do not inherit PowerShell 7 module paths", async () => {
  const config = JSON.parse(await readFile(new URL("../scripts/installer-dependencies.json", import.meta.url), "utf8"));
  for (const dependency of [config.node, config.inno]) {
    assert.match(dependency.sha256, /^[a-f0-9]{64}$/);
    assert.match(dependency.url, /^https:\/\//);
    assert.ok(dependency.version);
  }
  assert.equal(config.pi.package, "@earendil-works/pi-coding-agent");
  assert.equal(config.pi.version, "1.3.0");
  assert.deepEqual(windowsBuildEnvironment({ PSModulePath: "untrusted", Path: "keep" }), { Path: "keep" });
});

test("cached build dependencies are revalidated and corrupt downloads never replace a valid input", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-setup-download-"));
  try {
    await writeFile(join(root, spec.archive), "corrupt cache");
    await assert.rejects(verifiedDownload(spec, root, async () => new Response("wrong bytes")), /checksum mismatch/);
    const path = await verifiedDownload(spec, root, async () => new Response(bytes));
    assert.deepEqual(await readFile(path), bytes);
    await verifiedDownload(spec, root, async () => { throw new Error("must use the validated cache offline"); });
    assert.deepEqual(await readFile(path), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Setup embeds App, Node and a fallback Pi snapshot; existing Pi is never upgraded", async () => {
  const script = await readFile(new URL("../scripts/pi-chat-installer.iss", import.meta.url), "utf8");
  assert.match(script, /PayloadRoot.*app.*DestDir: "\{app\}\\app"/);
  assert.match(script, /PayloadRoot.*runtime\\node.*DestDir: "\{app\}\\runtime\\node"/);
  assert.match(script, /PayloadRoot.*runtime\\pi.*DestDir: "\{app\}\\runtime\\pi"/);
  assert.match(script, /PrivilegesRequired=lowest/);
  assert.doesNotMatch(script, /Pi Chat Git/, "Setup must not own or delete source-checkout shortcuts");
  assert.match(script, /CloseApplications=no/);
  const launcherIcons = script.split("\n").filter(line => line.startsWith('Name: "') && line.includes("start-pi-chat-ui.ps1"));
  assert.ok(launcherIcons.some(line => line.startsWith('Name: "{app}\\Pi Chat Web"')));
  assert.ok(launcherIcons.some(line => line.startsWith('Name: "{autodesktop}\\Pi Chat Web"')));
  assert.ok(!launcherIcons.some(line => line.startsWith('Name: "{autodesktop}\\Pi Chat"')));
  assert.doesNotMatch(script, /Type: files; Name: "\{autodesktop\}\\Pi Chat\.lnk"/);
  assert.match(script, /ShortcutLooksLikeLegacySetupPiChat/);
  assert.match(script, /DeleteLegacyDesktopPiChatShortcut/);
  for (const line of launcherIcons) assert.ok(line.includes(line.includes("Pi Chat PWA") ? '"" pwa"' : '"" web"'));
  assert.match(script, /start-pi-chat-ui\.ps1"" web"; WorkingDir: "\{app\}\\app"; Description: "Open Pi Chat in the default browser"/);
  assert.match(script, /InstallPi/);
  assert.doesNotMatch(script, /Check: NeedsPi/);
  assert.doesNotMatch(script, /skipifsilent runhidden/);
  assert.doesNotMatch(script, /https:\/\/nodejs|releases\/download|Type: filesandordirs/);
  const helper = await readFile(new URL("../scripts/pi-chat-setup.ps1", import.meta.url), "utf8");
  assert.doesNotMatch(helper, /Read-Host|Get-ReleaseAsset|InstallNode|InstallApp|RegisterUninstall|InstallShortcuts/);
  assert.match(helper, /if \(\$existing\)/);
  assert.match(helper, /existing Pi/i);
  assert.match(helper, /runtime\\pi/);
  assert.doesNotMatch(helper, /registry\.npmjs\.org/);
  const config = JSON.parse(await readFile(new URL("../scripts/installer-dependencies.json", import.meta.url), "utf8"));
  assert.equal(config.pi.package, "@earendil-works/pi-coding-agent");
  assert.match(config.pi.version, /^\d+\.\d+\.\d+/);
  assert.ok(applicationPackageFiles.includes("LICENSE"));
  assert.ok(applicationPackageFiles.includes("scripts/pi-chat-resolve-runtime.ps1"));
  assert.ok(!applicationPackageFiles.some(file => /pi-chat-setup\.cmd|pi-chat-uninstall\.ps1/.test(file)));
});
