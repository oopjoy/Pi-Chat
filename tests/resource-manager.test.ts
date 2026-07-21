import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResourceManager } from "../src/server/resource-manager";

test("package install rejects option-like or control-character sources before spawning Pi", async () => {
  const manager = new ResourceManager();
  await assert.rejects(manager.installPackage("--help"), /格式无效/);
  await assert.rejects(manager.installPackage("npm:valid\n--flag"), /格式无效/);
});

test("resource manager separates skills, extensions, and packages with their real Pi ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-resources-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-chat-skill-source-"));
  try {
    await mkdir(join(root, "skills", "demo"), { recursive: true });
    await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\n\n# Demo\n");
    await mkdir(join(root, "extensions"), { recursive: true });
    await writeFile(join(root, "extensions", "demo.ts"), "export default function () {}\n");
    await writeFile(join(root, "extensions", "pi-chat-file-permission-gate.ts"), "export default function systemGate() {}\n");
    await writeFile(join(root, "settings.json"), "{}\n");

    const manager = new ResourceManager(root);
    let skills = await manager.listSkills(root);
    assert.equal(skills.resources.length, 1);
    assert.equal(skills.resources[0].enabled, true);
    await manager.setSkillEnabled(skills.resources[0].id, false, root);
    skills = await manager.listSkills(root);
    assert.equal(skills.resources[0].enabled, false);
    assert.match(await readFile(join(root, "skills", "demo", "SKILL.md"), "utf8"), /disable-model-invocation: true/);

    let extensions = await manager.listExtensions(root);
    const extension = extensions.resources.find((item) => item.name === "demo");
    assert.ok(extension);
    assert.equal(extensions.resources.some((item) => item.name === "pi-chat-file-permission-gate"), false);
    assert.equal(await manager.systemGateEnabled(), true);
    await manager.setExtensionEnabled(extension.id, false, root);
    extensions = await manager.listExtensions(root);
    assert.equal(extensions.resources.find((item) => item.id === extension.id)?.enabled, false);

    await mkdir(join(sourceRoot, "installed"));
    await writeFile(join(sourceRoot, "installed", "SKILL.md"), "---\nname: installed\ndescription: Installed skill\n---\n");
    await manager.installSkill(join(sourceRoot, "installed"));
    skills = await manager.listSkills(root);
    const installed = skills.resources.find((item) => item.name === "installed");
    assert.ok(installed?.removable);
    await manager.removeSkill(installed.id, root);
    assert.equal((await manager.listSkills(root)).resources.some((item) => item.name === "installed"), false);

    const localPackage = join(sourceRoot, "plugin-package");
    await mkdir(join(localPackage, "extensions"), { recursive: true });
    await mkdir(join(localPackage, "skills", "packaged"), { recursive: true });
    await writeFile(join(localPackage, "package.json"), JSON.stringify({ name: "test-plugin", version: "1.0.0" }));
    await writeFile(join(localPackage, "extensions", "index.ts"), "export default function () {}\n");
    await writeFile(join(localPackage, "skills", "packaged", "SKILL.md"), "---\nname: packaged\ndescription: Package skill\n---\n");
    await manager.installPackage(localPackage);
    let packages = await manager.listPackages(root);
    const packageResource = packages.resources.find((item) => item.name === "test-plugin");
    assert.ok(packageResource);
    assert.equal(packageResource.resources.length, 2);
    extensions = await manager.listExtensions(root);
    const packagedExtension = extensions.resources.find((item) => item.packageSource === packageResource.source);
    assert.ok(packagedExtension);
    assert.equal(packagedExtension.removable, false);
    await assert.rejects(manager.setExtensionEnabled(packagedExtension.id, false, root), /Package-provided/);
    await manager.setPackageEnabled(packageResource.id, false, root);
    packages = await manager.listPackages(root);
    assert.equal(packages.resources.find((item) => item.id === packageResource.id)?.enabled, false);
    extensions = await manager.listExtensions(root);
    assert.equal(extensions.resources.find((item) => item.id === packagedExtension.id)?.enabled, false);
    await manager.removePackage(packageResource.id, root);
    assert.equal((await manager.listPackages(root)).resources.some((item) => item.id === packageResource.id), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});
