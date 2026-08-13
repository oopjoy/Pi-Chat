import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BoundedStreamCapture, combinedFixtureError } from "../e2e/fixtures.ts";
import { importE2eSessionFixtures } from "../scripts/e2e-fixture-import.mjs";
import { observeOwnedProcess, requireSuccessfulTaskkill, terminateOwnedProcessTree } from "../scripts/e2e-process-tree.mjs";

test("bounded server capture copies a truncated tail out of a giant input allocation", () => {
  const capture = new BoundedStreamCapture();
  const giant = Buffer.alloc(1024 * 1024, 0x61);
  capture.append(giant);
  const snapshot = capture.snapshot();
  assert.equal(snapshot.length, 256 * 1024);
  assert.notEqual(snapshot.buffer, giant.buffer);
  assert.deepEqual(capture.metadata(), { totalBytes: giant.length, retainedBytes: snapshot.length, truncated: true });
});

test("fixture error aggregation preserves the primary error and every secondary error", () => {
  const primary = new Error("use failed");
  const shutdown = new Error("shutdown failed");
  const attachment = new Error("attachment failed");
  const result = combinedFixtureError(primary, [shutdown, attachment], "fixture failed");
  assert.ok(result instanceof AggregateError);
  assert.equal(result.cause, primary);
  assert.deepEqual(result.errors, [primary, shutdown, attachment]);
});

test("a lone primary fixture error is rethrown unchanged", () => {
  const primary = new Error("setup failed");
  assert.equal(combinedFixtureError(primary, [], "fixture failed"), primary);
});

test("explicit E2E fixture import copies only regular top-level JSONL files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-e2e-import-"));
  try {
    const source = join(root, "source");
    const destination = join(root, "destination");
    await Promise.all([mkdir(source), mkdir(destination)]);
    await writeFile(join(source, "benchmark.jsonl"), "{\"type\":\"session\"}\n");
    await writeFile(join(source, "ignored.txt"), "not a fixture");
    assert.deepEqual(await importE2eSessionFixtures(source, destination), ["benchmark.jsonl"]);
    assert.equal(await readFile(join(destination, "benchmark.jsonl"), "utf8"), "{\"type\":\"session\"}\n");
    await assert.rejects(
      importE2eSessionFixtures(source, destination),
      /collides with an existing Session/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit E2E fixture import rejects a linked source directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-e2e-source-link-"));
  try {
    const source = join(root, "source");
    const destination = join(root, "destination");
    await Promise.all([mkdir(source), mkdir(destination)]);
    await symlink(source, join(root, "source-link"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      importE2eSessionFixtures(join(root, "source-link"), destination),
      /must not be a symbolic link/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit E2E fixture import rejects a top-level JSONL symlink", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-e2e-entry-link-"));
  try {
    const source = join(root, "source");
    const destination = join(root, "destination");
    await Promise.all([mkdir(source), mkdir(destination)]);
    const target = join(root, "target.jsonl");
    await writeFile(target, "{\"type\":\"session\"}\n");
    try {
      await symlink(target, join(source, "linked.jsonl"), "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "EACCES", "ENOTSUP"].includes(code || "")) {
        context.skip(`file symlink creation unavailable: ${code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      importE2eSessionFixtures(source, destination),
      /must not contain symbolic links/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nonzero taskkill status always fails closed", () => {
  assert.throws(() => requireSuccessfulTaskkill(1, 1234), /taskkill failed/);
  assert.doesNotThrow(() => requireSuccessfulTaskkill(0, 1234));
});

test("owned E2E process-tree termination confirms wrapper and descendant exit", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-e2e-process-tree-"));
  const childPidPath = join(root, "child.pid");
  const childEntry = join(root, "child.mjs");
  const wrapperEntry = join(root, "wrapper.mjs");
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  };
  try {
    await writeFile(childEntry, "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);", "utf8");
    await writeFile(wrapperEntry, String.raw`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, [process.argv[2]], { stdio: "ignore" });
writeFileSync(process.argv[3], String(child.pid));
setInterval(() => undefined, 1000);
`, "utf8");
    const wrapper = spawn(process.execPath, [wrapperEntry, childEntry, childPidPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    const observed = observeOwnedProcess(wrapper, process.platform !== "win32");
    const until = Date.now() + 5_000;
    let childPid = 0;
    while (Date.now() < until && !childPid) {
      try { childPid = Number(await readFile(childPidPath, "utf8")); }
      catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 25)); }
    }
    assert.ok(wrapper.pid && childPid > 0);
    await terminateOwnedProcessTree(observed, 5_000);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (alive(wrapper.pid!) || alive(childPid)))
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    assert.equal(alive(wrapper.pid!), false);
    assert.equal(alive(childPid), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an E2E-style wrapper confirms its direct child tree before exiting", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-e2e-wrapper-close-"));
  const childPidPath = join(root, "child.pid");
  const childEntry = join(root, "child.mjs");
  const wrapperEntry = join(root, "wrapper.mjs");
  const helperUrl = new URL("../scripts/e2e-process-tree.mjs", import.meta.url).href;
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  };
  try {
    await writeFile(childEntry, "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);", "utf8");
    await writeFile(wrapperEntry, String.raw`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { observeOwnedProcess, terminateOwnedProcessTree } from ${JSON.stringify(helperUrl)};
const child = spawn(process.execPath, [process.argv[2]], { detached: process.platform !== "win32", stdio: "ignore" });
const observed = observeOwnedProcess(child, process.platform !== "win32");
writeFileSync(process.argv[3], String(child.pid));
process.once("message", () => void terminateOwnedProcessTree(observed, 5_000).then(() => process.exit(0), () => process.exit(1)));
setInterval(() => undefined, 1000);
`, "utf8");
    const wrapper = spawn(process.execPath, [wrapperEntry, childEntry, childPidPath], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    const observedWrapper = observeOwnedProcess(wrapper);
    const until = Date.now() + 5_000;
    let childPid = 0;
    while (Date.now() < until && !childPid) {
      try { childPid = Number(await readFile(childPidPath, "utf8")); }
      catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 25)); }
    }
    assert.ok(wrapper.pid && childPid > 0);
    wrapper.send({ type: "cleanup" });
    const closed = await Promise.race([
      observedWrapper.close.promise.then(() => true),
      new Promise<boolean>((resolveDelay) => setTimeout(() => resolveDelay(false), 8_000)),
    ]);
    assert.equal(closed, true);
    assert.equal(wrapper.exitCode, 0);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && alive(childPid))
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    assert.equal(alive(childPid), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
