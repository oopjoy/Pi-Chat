import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiChat, cleanupStaleDistArtifacts, promoteStagedDist, rollbackPromotedDist, restartServerArgs } from "../src/server/application-restart";

test("local application build stages a complete replacement without touching live dist", { skip: process.platform !== "win32", timeout: 120_000 }, async () => {
  const liveIndex = join(process.cwd(), "dist", "web", "index.html");
  const before = await readFile(liveIndex, "utf8");
  const build = await buildPiChat(process.cwd());
  try {
    assert.equal(await readFile(liveIndex, "utf8"), before);
    assert.match(await readFile(join(build.distPath, "web", "index.html"), "utf8"), /<div id="root"><\/div>/);
    assert.ok((await readFile(join(build.distPath, "server", "server", "index.js"))).length > 0);
  } finally {
    await build.discard();
  }
});

test("staged dist promotion replaces the live tree only after an explicit commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-dist-promotion-"));
  const live = join(root, "dist");
  const staged = join(root, "staged");
  const previous = join(root, "previous");
  try {
    await mkdir(live);
    await mkdir(staged);
    await writeFile(join(live, "version.txt"), "old", "utf8");
    await writeFile(join(staged, "version.txt"), "new", "utf8");
    assert.equal(await readFile(join(live, "version.txt"), "utf8"), "old");
    await promoteStagedDist(live, staged, previous);
    assert.equal(await readFile(join(live, "version.txt"), "utf8"), "new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retained promotion backup restores the old dist after candidate failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-dist-rollback-"));
  const live = join(root, "dist");
  const staged = join(root, "staged");
  const previous = join(root, "previous");
  try {
    await mkdir(live);
    await mkdir(staged);
    await writeFile(join(live, "version.txt"), "old", "utf8");
    await writeFile(join(staged, "version.txt"), "new", "utf8");
    await promoteStagedDist(live, staged, previous, { keepPrevious: true });
    assert.equal(await readFile(join(live, "version.txt"), "utf8"), "new");
    assert.equal(await readFile(join(previous, "version.txt"), "utf8"), "old");
    await rollbackPromotedDist(live, previous);
    assert.equal(await readFile(join(live, "version.txt"), "utf8"), "old");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("application handoff restarts the same Pi Chat entry with its listener and workspace arguments", () => {
  const args = restartServerArgs({
    projectRoot: "C:/work/pi-chat",
    serverEntry: "C:/work/pi-chat/dist/server/server/index.js",
    host: "127.0.0.1",
    port: 30170,
    cwd: "C:/work",
    dev: false,
  });
  assert.deepEqual(args, ["C:/work/pi-chat/dist/server/server/index.js", "--host", "127.0.0.1", "--port", "30170", "--cwd", "C:/work"]);
  assert.deepEqual(restartServerArgs({ projectRoot: "x", serverEntry: "entry", host: "::1", port: 12, cwd: "y", dev: true }).slice(-1), ["--dev"]);
});

test("cleanup removes abandoned staging and previous dist trees", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-dist-cleanup-"));
  try {
    await mkdir(join(root, ".pi-chat-dist-staging-1"));
    await mkdir(join(root, ".pi-chat-dist-previous-2"));
    await mkdir(join(root, ".pi-chat-dist-failed-3"));
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "keep.txt"), "ok", "utf8");
    const removed = await cleanupStaleDistArtifacts(root);
    assert.equal(removed, 3);
    await assert.rejects(readFile(join(root, ".pi-chat-dist-staging-1", "x"), "utf8"));
    assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promoteStagedDist fails clearly when staged tree is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-dist-missing-"));
  try {
    await mkdir(join(root, "dist"));
    await assert.rejects(
      () => promoteStagedDist(join(root, "dist"), join(root, "missing-staged"), join(root, "previous")),
      /暂存目录不存在/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
