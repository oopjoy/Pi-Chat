import { spawn } from "node:child_process";
import {
  parseTestArguments,
  repositoryRelativeTestPath,
  repositoryRoot,
  TestHarnessArgumentError,
} from "./test-files.mjs";

// Keep the official test harness responsible for NODE_ENV=test: a few source
// tests deliberately expose test-only hooks that must be impossible in Web
// artifacts. Harness-owned --file selection is validated against recursively
// discovered repository tests; remaining supported Node test flags are passed
// through without relying on shell glob behavior.
let parsed;
try {
  parsed = parseTestArguments(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof TestHarnessArgumentError)) throw error;
  console.error(`[Pi Chat] ${error.message}`);
  console.error("Usage: node scripts/run-tests.mjs [--file tests/path/name.test.ts] [--test-*=value]");
  process.exit(2);
}

console.error(
  `[Pi Chat] Running ${parsed.selectedFiles.length} test file(s): ${parsed.selectedFiles
    .map((path) => repositoryRelativeTestPath(path))
    .join(", ")}`,
);

const child = spawn(
  process.execPath,
  ["--test", "--import", "tsx", ...parsed.nodeArguments, "--", ...parsed.selectedFiles],
  {
    cwd: repositoryRoot,
    env: { ...process.env, NODE_ENV: "test" },
    stdio: "inherit",
    windowsHide: true,
  },
);

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Test runner exited from signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
