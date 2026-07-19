import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResourceManager } from "../src/server/resource-manager";

test("resource manager scans and toggles managed skills and plugins", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-resources-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-chat-skill-source-"));
  try {
    await mkdir(join(root, "skills", "demo"), { recursive: true });
    await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\n\n# Demo\n");
    await mkdir(join(root, "extensions"), { recursive: true });
    await writeFile(join(root, "extensions", "demo.ts"), "export default function () {}\n");
    await writeFile(join(root, "settings.json"), "{}\n");

    const manager = new ResourceManager(root);
    let skills = await manager.listSkills(root);
    assert.equal(skills.resources.length, 1);
    assert.equal(skills.resources[0].enabled, true);
    await manager.setSkillEnabled(skills.resources[0].id, false, root);
    skills = await manager.listSkills(root);
    assert.equal(skills.resources[0].enabled, false);
    assert.match(await readFile(join(root, "skills", "demo", "SKILL.md"), "utf8"), /disable-model-invocation: true/);

    let plugins = await manager.listPlugins(root);
    const extension = plugins.resources.find((item) => item.kind === "extension");
    assert.ok(extension);
    await manager.setPluginEnabled(extension.id, false, root);
    plugins = await manager.listPlugins(root);
    assert.equal(plugins.resources.find((item) => item.id === extension.id)?.enabled, false);

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
    await manager.installPlugin(localPackage);
    plugins = await manager.listPlugins(root);
    const packagePlugin = plugins.resources.find((item) => item.kind === "package");
    assert.ok(packagePlugin);
    assert.equal(packagePlugin.resources.length, 2);
    await manager.setPluginEnabled(packagePlugin.id, false, root);
    assert.equal((await manager.listPlugins(root)).resources.find((item) => item.id === packagePlugin.id)?.enabled, false);
    await manager.removePlugin(packagePlugin.id, root);
    assert.equal((await manager.listPlugins(root)).resources.some((item) => item.id === packagePlugin.id), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});
