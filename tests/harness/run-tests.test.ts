import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverTestFiles,
  parseTestArguments,
  repositoryRelativeTestPath,
  repositoryRoot,
  TestHarnessArgumentError,
} from "../../scripts/test-files.mjs";

test("test discovery recursively finds regular test files in stable order", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-test-discovery-"));
  try {
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "z.test.ts"), "");
    await writeFile(join(root, "nested", "a.test.ts"), "");
    await writeFile(join(root, "nested", "ignored.ts"), "");
    assert.deepEqual(
      discoverTestFiles(root).map((path) => path.replaceAll("\\", "/").slice(root.replaceAll("\\", "/").length + 1)),
      ["nested/a.test.ts", "z.test.ts"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("test discovery never follows symbolic-link entries", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-test-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-chat-test-outside-"));
  try {
    await writeFile(join(outside, "outside.test.ts"), "");
    try {
      await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`directory symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    assert.deepEqual(discoverTestFiles(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("repeatable file selection is contained, normalized, and deduplicated", () => {
  const discovered = discoverTestFiles();
  const first = "tests/active-sessions.test.ts";
  const second = "tests/api-route-admission.test.ts";
  const parsed = parseTestArguments([
    "--file",
    first,
    `--file=${second.replaceAll("/", "\\")}`,
    `--file=${first}`,
    "--test-name-pattern=active",
  ], discovered);
  assert.deepEqual(parsed.selectedFiles.map((path) => repositoryRelativeTestPath(path)), [first, second]);
  assert.deepEqual(parsed.nodeArguments, ["--test-name-pattern=active"]);
});

test("test selection preserves supported separate Node test option values", () => {
  const parsed = parseTestArguments([
    "--file=tests/active-sessions.test.ts",
    "--test-name-pattern",
    "active Session",
    "--test-concurrency",
    "1",
  ]);
  assert.deepEqual(parsed.nodeArguments, [
    "--test-name-pattern",
    "active Session",
    "--test-concurrency",
    "1",
  ]);
});

test("test selection rejects ambiguous or external paths before spawning Node", () => {
  const invalid = [
    ["--file"],
    ["--file="],
    ["tests/active-sessions.test.ts"],
    ["--eval=process.exit(0)"],
    ["--file", "package.json"],
    ["--file", "tests"],
    ["--file", "tests/missing.test.ts"],
    ["--file", "tests/../package.json"],
    ["--file", "C:\\outside.test.ts"],
    ["--file", "\\\\server\\share\\outside.test.ts"],
    ["--file", "tests/candidate:stream.test.ts"],
  ];
  for (const arguments_ of invalid) {
    assert.throws(
      () => parseTestArguments(arguments_),
      (error) => error instanceof TestHarnessArgumentError,
      arguments_.join(" "),
    );
  }
});

test("default selection includes this nested harness regression with NODE_ENV=test", () => {
  assert.equal(process.env.NODE_ENV, "test");
  const parsed = parseTestArguments([]);
  assert.ok(
    parsed.selectedFiles.some((path) => repositoryRelativeTestPath(path) === "tests/harness/run-tests.test.ts"),
  );
});

test("the official harness focuses a file from an unrelated caller cwd", () => {
  const result = spawnSync(
    process.execPath,
    [
      join(repositoryRoot, "scripts", "run-tests.mjs"),
      "--file=tests/active-sessions.test.ts",
      "--test-name-pattern=empty activeSessionIds",
    ],
    {
      cwd: tmpdir(),
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production", NODE_TEST_CONTEXT: undefined },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Running 1 test file/);
  assert.match(`${result.stdout}\n${result.stderr}`, /pass 1/);
});

test("the official harness rejects an external selection before starting tests", () => {
  const result = spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts", "run-tests.mjs"), "--file", "../outside.test.ts"],
    {
      cwd: tmpdir(),
      encoding: "utf8",
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown test file|repository-relative/);
  assert.doesNotMatch(result.stdout, /ℹ tests/);
});
