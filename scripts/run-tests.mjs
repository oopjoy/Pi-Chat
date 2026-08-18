import { spawn } from "node:child_process";
import {
  controlledTestEnvironment,
  testRunnerArguments,
  windowsTestJobInvocation,
} from "./test-harness-policy.mjs";
import {
  parseTestArguments,
  repositoryRelativeTestPath,
  repositoryRoot,
  TestHarnessArgumentError,
} from "./test-files.mjs";

// Keep the official test harness responsible for NODE_ENV=test: a few source
// tests deliberately expose test-only hooks that must be impossible in Web
// artifacts. Harness-owned --file selection is validated against recursively
// discovered repository tests. The policy module also owns the fixed resource
// limits, so a caller cannot loosen them through --test-* or NODE_OPTIONS.
const originalArguments = process.argv.slice(2);
let parsed;
try {
  parsed = parseTestArguments(originalArguments);
} catch (error) {
  if (!(error instanceof TestHarnessArgumentError)) throw error;
  console.error(`[Pi Chat] ${error.message}`);
  console.error("Usage: node scripts/run-tests.mjs [--file tests/path/name.test.ts] [--test-name-pattern=<pattern>|--test-shard=<index>|--test-skip-pattern=<pattern>|--test-only]");
  process.exit(2);
}

function observeChild(child, label) {
  child.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });

  child.once("exit", (code, signal) => {
    if (signal) {
      console.error(`${label} exited from signal ${signal}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
}

const environment = controlledTestEnvironment();
const runnerArguments = testRunnerArguments(parsed.nodeArguments, parsed.selectedFiles);
console.error(
  `[Pi Chat] Running ${parsed.selectedFiles.length} test file(s): ${parsed.selectedFiles
    .map((path) => repositoryRelativeTestPath(path))
    .join(", ")}`,
);
if (process.platform === "win32") {
  // Pass final Node arguments directly to the native launcher. There is no
  // caller-controlled recursion marker that can accidentally skip the Job.
  const invocation = windowsTestJobInvocation({
    nodePath: process.execPath,
    workingDirectory: repositoryRoot,
    nodeArguments: runnerArguments,
  });
  const child = spawn(invocation.command, invocation.args, {
    cwd: repositoryRoot,
    env: { ...environment, ...invocation.environment },
    stdio: "inherit",
    windowsHide: true,
  });
  observeChild(child, "Windows test-job launcher");
} else {
  const child = spawn(
    process.execPath,
    runnerArguments,
    {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  observeChild(child, "Test runner");
}
