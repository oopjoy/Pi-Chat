import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResourceManager } from "../src/server/resource-manager";

test("resource manager exposes a read-only inventory with real Pi ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-resources-"));
  try {
    await mkdir(join(root, "skills", "demo"), { recursive: true });
    await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\n\n# Demo\n");
    await mkdir(join(root, "extensions"), { recursive: true });
    await writeFile(join(root, "extensions", "demo.ts"), "export default function () {}\n");
    await writeFile(join(root, "extensions", "pi-chat-file-permission-gate.ts"), "export default function systemGate() {}\n");

    const localPackage = join(root, "plugin-package");
    await mkdir(join(localPackage, "extensions"), { recursive: true });
    await mkdir(join(localPackage, "skills", "packaged"), { recursive: true });
    await writeFile(join(localPackage, "package.json"), JSON.stringify({
      name: "test-plugin",
      version: "1.0.0",
      pi: { extensions: ["extensions"], skills: ["skills"] },
    }));
    await writeFile(join(localPackage, "extensions", "index.ts"), "export default function () {}\n");
    await writeFile(join(localPackage, "skills", "packaged", "SKILL.md"), "---\nname: packaged\ndescription: Package skill\n---\n");
    await writeFile(join(root, "settings.json"), `${JSON.stringify({ packages: [localPackage] }, null, 2)}\n`);

    const manager = new ResourceManager(root);
    const skills = await manager.listSkills(root);
    assert.equal(skills.resources.some((item) => item.name === "demo" && item.enabled), true);
    assert.equal(skills.resources.some((item) => item.name === "packaged" && item.packageSource === localPackage), true);

    const extensions = await manager.listExtensions(root);
    assert.equal(extensions.resources.some((item) => item.name === "demo" && item.enabled), true);
    assert.equal(extensions.resources.some((item) => item.name === "pi-chat-file-permission-gate"), false);
    assert.equal(extensions.resources.some((item) => item.packageSource === localPackage), true);
    assert.equal(await manager.systemGateEnabled(), true);

    const packages = await manager.listPackages(root);
    const packageResource = packages.resources.find((item) => item.name === "test-plugin");
    assert.ok(packageResource?.enabled);
    assert.equal(packageResource.resources.length, 2);

    assert.equal(manager.resolveBrowsePath("models-root"), root);
    assert.equal(manager.resolveBrowsePath("skills-root"), join(root, "skills"));
    assert.equal(manager.resolveBrowsePath("extensions-root"), join(root, "extensions"));
    assert.equal(manager.resolveBrowsePath("packages-root"), join(root, "npm", "node_modules"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resource inventories share a short cache, invalidate explicitly, and bound skill reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-resource-cache-"));
  try {
    const skillPath = join(root, "skills", "large", "SKILL.md");
    await mkdir(join(root, "skills", "large"), { recursive: true });
    await writeFile(skillPath, `---\nname: first-name\ndescription: first\n---\n\n${"x".repeat(300_000)}`);
    await writeFile(join(root, "settings.json"), "{}\n");
    const manager = new ResourceManager(root);
    const first = await manager.listSkills(root);
    const firstSkill = first.resources.find((resource) => resource.name === "first-name");
    assert.equal(firstSkill?.name, "first-name");
    assert.ok((firstSkill?.content || "").length <= 200_000);

    await writeFile(skillPath, `---\nname: second-name\ndescription: second\n---\n\nupdated\n`);
    const cached = await manager.listSkills(root);
    assert.equal(cached.resources.find((resource) => resource.name === "first-name")?.name, "first-name");
    manager.invalidate();
    const refreshed = await manager.listSkills(root);
    assert.equal(refreshed.resources.find((resource) => resource.name === "second-name")?.name, "second-name");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
