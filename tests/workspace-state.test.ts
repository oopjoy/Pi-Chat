import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadWorkspace, saveWorkspace } from "../src/server/workspace-state";

test("a fresh portable workspace fallback is the user's Desktop", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-default-"));
  const desktop = join(root, "Desktop");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    await mkdir(desktop);
    assert.equal(await loadWorkspace(desktop), resolve(desktop));
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(join(root, "agent", "pi-chat-workspace.json"), JSON.stringify({ cwd: join(root, "missing") }), "utf8");
    assert.equal(await loadWorkspace(desktop), resolve(desktop));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace state persists an existing selected directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-state-"));
  const workspace = join(root, "project");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    await mkdir(workspace);
    assert.equal(await loadWorkspace(workspace), resolve(workspace));
    await saveWorkspace(workspace);
    assert.equal(await loadWorkspace(root), resolve(workspace));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed workspace save cleans its temporary file and releases the next queued save", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-failed-save-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let temporary = "";
  let releaseFailure!: () => void;
  const failureHeld = new Promise<void>((resolve) => { releaseFailure = resolve; });
  let firstTemporaryWritten!: () => void;
  const temporaryWritten = new Promise<void>((resolve) => { firstTemporaryWritten = resolve; });
  try {
    await Promise.all([mkdir(first), mkdir(second)]);
    const failedSave = saveWorkspace(first, {
      writeTemporary: async (path, contents) => {
        temporary = path;
        await writeFile(path, contents, "utf8");
        firstTemporaryWritten();
        await failureHeld;
        throw new Error("simulated temporary write failure");
      },
    });
    await temporaryWritten;
    const succeedingSave = saveWorkspace(second);
    releaseFailure();
    await assert.rejects(failedSave, /simulated temporary write failure/);
    await assert.rejects(access(temporary), /ENOENT/, "the failed save removes its unique temporary file");
    await succeedingSave;
    assert.equal(await loadWorkspace(root), resolve(second), "a rejected save does not poison the per-path queue");
  } finally {
    releaseFailure?.();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent workspace saves serialize their target replacement and leave valid state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-concurrent-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstAtReplace!: () => void;
  const firstReachedReplace = new Promise<void>((resolve) => { firstAtReplace = resolve; });
  let secondReachedReplace = false;
  try {
    await Promise.all([mkdir(first), mkdir(second)]);
    const firstSave = saveWorkspace(first, {
      beforeReplace: async () => {
        firstAtReplace();
        await firstHeld;
      },
    });
    await firstReachedReplace;
    const secondSave = saveWorkspace(second, {
      beforeReplace: async () => { secondReachedReplace = true; },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondReachedReplace, false, "the second writer must wait before Windows target replacement");
    releaseFirst();
    await Promise.all([firstSave, secondSave]);
    assert.equal(secondReachedReplace, true);
    assert.equal(await loadWorkspace(root), resolve(second));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
