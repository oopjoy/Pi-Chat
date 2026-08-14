import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  npmInvocation,
  runStagedVerification,
  verificationSteps,
} from "../../scripts/run-staged-verification.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("staged verification gives unit work an isolated output and removes success", async () => {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const removed: string[] = [];
  const result = await runStagedVerification("unit", {
    cwd: repositoryRoot,
    environment: {
      PI_CHAT_DIST_DIR: "unsafe-inherited-value",
      PI_CHAT_BUILD_REVISION: "expected-revision",
    },
    createStage: async () => "C:\\Temp\\pi-chat-unit-test",
    removeStage: async (path: string) => { removed.push(path); },
    execute: async (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: options.env });
      return 0;
    },
    log: { error: () => undefined },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.args), [["test"]]);
  assert.equal(calls[0]!.env.PI_CHAT_DIST_DIR, "C:\\Temp\\pi-chat-unit-test");
  assert.equal(calls[0]!.env.PI_CHAT_BUILD_REVISION, "expected-revision");
  assert.deepEqual(removed, ["C:\\Temp\\pi-chat-unit-test"]);
});

test("Windows npm scripts reuse npm's JavaScript entrypoint without a command shell", () => {
  const invocation = npmInvocation(["test"], { npm_execpath: "C:\\npm\\npm-cli.js" });
  if (process.platform === "win32") {
    assert.deepEqual(invocation, {
      command: process.execPath,
      args: ["C:\\npm\\npm-cli.js", "test"],
    });
  } else {
    assert.deepEqual(invocation.args, ["test"]);
  }
});

test("failed staged verification retains its exact diagnostics directory", async () => {
  const removed: string[] = [];
  const result = await runStagedVerification("e2e", {
    createStage: async () => "/tmp/pi-chat-e2e-test",
    removeStage: async (path: string) => { removed.push(path); },
    execute: async () => 7,
    log: { error: () => undefined },
  });

  assert.deepEqual(result, {
    ok: false,
    completed: [{
      label: "e2e",
      code: 7,
      stage: "/tmp/pi-chat-e2e-test",
    }],
    failed: "e2e",
    retainedStage: "/tmp/pi-chat-e2e-test",
  });
  assert.deepEqual(removed, []);
});

test("a successful gate fails closed when its staging cannot be removed", async () => {
  const cleanupError = new Error("locked stage");
  const result = await runStagedVerification("unit", {
    createStage: async () => "/tmp/pi-chat-locked-stage",
    removeStage: async () => { throw cleanupError; },
    execute: async () => 0,
    log: { error: () => undefined },
  });

  assert.deepEqual(result, {
    ok: false,
    completed: [{
      label: "unit",
      code: 0,
      stage: "/tmp/pi-chat-locked-stage",
    }],
    failed: "unit-cleanup",
    retainedStage: "/tmp/pi-chat-locked-stage",
    error: cleanupError,
  });
});

test("full verification runs typecheck, isolated unit and e2e, then diff check serially", async () => {
  const calls: Array<{ command: string; args: string[]; stage?: string }> = [];
  const created: string[] = [];
  const removed: string[] = [];
  const result = await runStagedVerification("all", {
    environment: {},
    createStage: async (label: string) => {
      const path = `/tmp/pi-chat-${label}-${created.length}`;
      created.push(path);
      return path;
    },
    removeStage: async (path: string) => { removed.push(path); },
    execute: async (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, stage: options.env.PI_CHAT_DIST_DIR });
      return 0;
    },
    log: { error: () => undefined },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.args), [
    ["run", "typecheck"],
    ["test"],
    ["run", "test:e2e"],
    ["diff", "HEAD", "--check"],
  ]);
  assert.equal(calls[0]!.stage, undefined);
  assert.equal(calls[1]!.stage, "/tmp/pi-chat-unit-0");
  assert.equal(calls[2]!.stage, "/tmp/pi-chat-e2e-1");
  assert.equal(calls[3]!.stage, undefined);
  assert.deepEqual(removed, created);
});

test("the local diff gate rejects a staged whitespace error against HEAD", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-diff-check-"));
  const git = (args: string[]) => spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  try {
    assert.equal(git(["init", "--quiet"]).status, 0);
    assert.equal(git(["config", "user.email", "pi-chat@example.invalid"]).status, 0);
    assert.equal(git(["config", "user.name", "Pi Chat Test"]).status, 0);
    await writeFile(join(root, "sample.txt"), "clean\n", "utf8");
    assert.equal(git(["add", "sample.txt"]).status, 0);
    assert.equal(git(["commit", "--quiet", "-m", "baseline"]).status, 0);

    await writeFile(join(root, "sample.txt"), "trailing space \n", "utf8");
    assert.equal(git(["add", "sample.txt"]).status, 0);
    const result = git(["diff", "HEAD", "--check"]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /trailing whitespace/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification modes reject unsupported aliases before any process starts", () => {
  assert.throws(() => verificationSteps("fast"), /Unknown verification mode/);
  const result = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, "scripts", "run-staged-verification.mjs"), "fast"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: .*unit\|e2e\|all/);
});
