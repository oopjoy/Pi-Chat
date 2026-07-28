import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiChat, cleanupStaleDistArtifacts, promoteStagedDist, rollbackPromotedDist, restartServerArgs, terminateProcessTree } from "../src/server/application-restart";

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

test("process-tree termination stops a detached build wrapper and its descendant", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-process-tree-"));
  const childPidPath = join(root, "child.pid");
  const childEntry = join(root, "child.mjs");
  const wrapperEntry = join(root, "wrapper.mjs");
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  };
  try {
    await writeFile(childEntry, "setInterval(() => undefined, 1000);", "utf8");
    await writeFile(wrapperEntry, String.raw`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, [process.argv[2]], { detached: false, stdio: "ignore" });
writeFileSync(process.argv[3], String(child.pid));
setInterval(() => undefined, 1000);
`, "utf8");
    const wrapper = spawn(process.execPath, [wrapperEntry, childEntry, childPidPath], { detached: true, stdio: "ignore" });
    const until = Date.now() + 5_000;
    let childPid = 0;
    while (Date.now() < until && !childPid) {
      try { childPid = Number(await readFile(childPidPath, "utf8")); }
      catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    assert.ok(wrapper.pid && childPid > 0);
    await terminateProcessTree(wrapper, 250);
    const exitDeadline = Date.now() + 5_000;
    while (Date.now() < exitDeadline && (alive(wrapper.pid!) || alive(childPid))) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(alive(wrapper.pid!), false);
    assert.equal(alive(childPid), false);
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
    await mkdir(join(root, ".pi-chat-dist-staging-999999991"));
    await mkdir(join(root, ".pi-chat-dist-previous-999999992"));
    await mkdir(join(root, ".pi-chat-dist-failed-999999993"));
    const active = join(root, `.pi-chat-dist-staging-${process.pid}-${Date.now()}`);
    await mkdir(active);
    await writeFile(join(active, "in-use.txt"), "active", "utf8");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "keep.txt"), "ok", "utf8");
    const removed = await cleanupStaleDistArtifacts(root);
    assert.equal(removed, 3);
    await assert.rejects(readFile(join(root, ".pi-chat-dist-staging-999999991", "x"), "utf8"));
    assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "ok");
    assert.equal(await readFile(join(active, "in-use.txt"), "utf8"), "active");
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
