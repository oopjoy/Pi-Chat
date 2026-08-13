import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(import.meta.dirname, "..");

test("build identity defaults to the checked-out Git revision", async () => {
  const distRoot = await mkdtemp(join(tmpdir(), "pi-chat-build-identity-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CHAT_DIST_DIR: distRoot,
    PI_CHAT_BUILD_REVISION: undefined,
  };
  try {
    const [{ stdout: gitRevision }] = await Promise.all([
      execFile("git", ["rev-parse", "--short", "HEAD"], { cwd: projectRoot }),
      execFile(process.execPath, ["scripts/build-identity.mjs"], { cwd: projectRoot, env }),
    ]);
    const identity = JSON.parse(
      await readFile(join(distRoot, "build-identity.json"), "utf8"),
    ) as { revision: string };
    assert.equal(identity.revision, gitRevision.trim());
    assert.notEqual(identity.revision, "unknown");
  } finally {
    await rm(distRoot, { recursive: true, force: true });
  }
});

test("an explicit build revision overrides Git metadata", async () => {
  const distRoot = await mkdtemp(join(tmpdir(), "pi-chat-build-identity-override-"));
  const env = {
    ...process.env,
    PI_CHAT_DIST_DIR: distRoot,
    PI_CHAT_BUILD_REVISION: "release-candidate",
  };
  try {
    await execFile(process.execPath, ["scripts/build-identity.mjs"], {
      cwd: projectRoot,
      env,
    });
    const identity = JSON.parse(
      await readFile(join(distRoot, "build-identity.json"), "utf8"),
    ) as { revision: string };
    assert.equal(identity.revision, "release-candidate");
  } finally {
    await rm(distRoot, { recursive: true, force: true });
  }
});

test("production web build emits independently cacheable React, Markdown and KaTeX chunks", async () => {
  const distRoot = await mkdtemp(join(tmpdir(), "pi-chat-web-assets-"));
  const env = { ...process.env, PI_CHAT_DIST_DIR: distRoot };
  try {
    await execFile(process.execPath, ["scripts/build-identity.mjs"], { cwd: projectRoot, env });
    await execFile(process.execPath, ["scripts/build-web.mjs"], { cwd: projectRoot, env });
    const assets = await readdir(join(distRoot, "web", "assets"));
    for (const name of ["react", "markdown", "katex"])
      assert.ok(assets.some((asset) => asset.startsWith(`${name}-`) && asset.endsWith(".js")), `missing ${name} production chunk`);
  } finally {
    await rm(distRoot, { recursive: true, force: true });
  }
});
