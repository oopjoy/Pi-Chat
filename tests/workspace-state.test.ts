import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

test("workspace state retries a transient Windows target replacement failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-rename-retry-"));
  const workspace = join(root, "workspace");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let replacements = 0;
  try {
    await mkdir(workspace);
    await saveWorkspace(workspace, {
      renameTemporary: async (temporary, path) => {
        replacements += 1;
        if (replacements === 1) {
          const error = new Error("simulated Windows replace contention") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        await rename(temporary, path);
      },
    });
    assert.equal(replacements, 2);
    assert.equal(await loadWorkspace(root), resolve(workspace));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("separate Node processes share one workspace state without replacement failures", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-multiprocess-"));
  const agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const first = join(root, "first");
  const second = join(root, "second");
  const start = join(root, "start");
  const releaseReplace = join(root, "release-replace");
  const moduleUrl = pathToFileURL(resolve(process.cwd(), "src/server/workspace-state.ts")).href;
  const source = `import { access } from "node:fs/promises"; import { saveWorkspace } from ${JSON.stringify(moduleUrl)}; const wait = async (path) => { for (;;) { try { await access(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } } }; console.log("ready"); await wait(process.env.START_FILE); await saveWorkspace(process.env.WORKSPACE, { beforeReplace: async () => { console.log("replace-ready"); await wait(process.env.RELEASE_REPLACE_FILE); } });`;
  const waitWithin = async <T>(pending: Promise<T>, label: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const children: ReturnType<typeof spawn>[] = [];
  const run = (workspace: string) => {
    let resolveReady!: () => void;
    let rejectReady!: (cause: Error) => void;
    let resolveReplaceReady!: () => void;
    let rejectReplaceReady!: (cause: Error) => void;
    const ready = new Promise<void>((resolveReadySignal, rejectReadySignal) => {
      resolveReady = resolveReadySignal;
      rejectReady = rejectReadySignal;
    });
    const replaceReady = new Promise<void>((resolveReplaceSignal, rejectReplaceSignal) => {
      resolveReplaceReady = resolveReplaceSignal;
      rejectReplaceReady = rejectReplaceSignal;
    });
    // Phase promises may be rejected before their caller reaches await; retain
    // a handler so a failing child reports through the bounded phase wait.
    void ready.catch(() => undefined);
    void replaceReady.catch(() => undefined);
    let resolveDone!: () => void;
    let rejectDone!: (cause: Error) => void;
    const done = new Promise<void>((resolveChild, rejectChild) => {
      resolveDone = resolveChild;
      rejectDone = rejectChild;
    });
    void done.catch(() => undefined);
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        START_FILE: start,
        RELEASE_REPLACE_FILE: releaseReplace,
        WORKSPACE: workspace,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    let errors = "";
    const fail = (cause: Error) => {
      rejectReady(cause);
      rejectReplaceReady(cause);
      rejectDone(cause);
    };
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("ready\n")) resolveReady();
      if (output.includes("replace-ready\n")) resolveReplaceReady();
    });
    child.stderr.on("data", (chunk) => { errors += String(chunk); });
    child.once("error", (cause) => fail(cause));
    child.once("exit", (code) => {
      if (code === 0) resolveDone();
      else fail(new Error(`workspace child failed (${code}): ${errors || output}`));
    });
    return { ready, replaceReady, done };
  };
  try {
    await Promise.all([mkdir(first), mkdir(second)]);
    const firstChild = run(first);
    const secondChild = run(second);
    await waitWithin(Promise.all([firstChild.ready, secondChild.ready]), "workspace child startup");
    await writeFile(start, "go", "utf8");
    await waitWithin(Promise.all([firstChild.replaceReady, secondChild.replaceReady]), "workspace child replace barrier");
    await writeFile(releaseReplace, "go", "utf8");
    await waitWithin(Promise.all([firstChild.done, secondChild.done]), "workspace child completion");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const persisted = await loadWorkspace(root);
    assert.ok([resolve(first), resolve(second)].includes(persisted));
  } finally {
    const activeChildren = children.filter((child) => child.exitCode === null && !child.killed);
    const childExits = activeChildren.map((child) => new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())));
    for (const child of activeChildren) child.kill();
    await Promise.all(childExits);
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
