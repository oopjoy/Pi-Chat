import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(import.meta.dirname, "..");

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
