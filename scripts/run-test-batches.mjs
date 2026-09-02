import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  DEFAULT_BENCHMARK_BATCH_COUNT,
  DEFAULT_SOURCE_BATCH_COUNT,
  batchSummary,
  benchmarkTestFiles,
  partitionBenchmarkTests,
  partitionSourceTests,
  sourceTestFiles,
  verifyTestPartition,
} from "./test-batches.mjs";
import { repositoryRelativeTestPath, repositoryRoot } from "./test-files.mjs";
import { declaredTestNamePatterns } from "./test-name-patterns.mjs";

const TEST_CASE_SPLIT_PATHS = new Set([
  "tests/web/pane-authority.test.ts",
]);
const TEST_CASES_PER_PROCESS = 1;

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
}

function invocationGroups(paths) {
  return paths.flatMap((path) => {
    const relative = repositoryRelativeTestPath(path);
    if (!TEST_CASE_SPLIT_PATHS.has(relative)) return [{ path, names: null }];
    const names = declaredTestNamePatterns(path);
    const groups = [];
    for (let index = 0; index < names.length; index += TEST_CASES_PER_PROCESS)
      groups.push({ path, names: names.slice(index, index + TEST_CASES_PER_PROCESS) });
    return groups;
  });
}

function invocationArguments(invocation) {
  const args = ["--file", repositoryRelativeTestPath(invocation.path)];
  if (invocation.names)
    args.push("--test-name-pattern", `^(?:${invocation.names.map(regexEscape).join("|")})$`);
  return args;
}

export function runProcess(command, args, { cwd = repositoryRoot, env = process.env } = {}) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
      windowsHide: true,
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} exited from signal ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
}

export async function runTestBatches({
  suite = "source",
  batchCount = suite === "benchmark" ? DEFAULT_BENCHMARK_BATCH_COUNT : DEFAULT_SOURCE_BATCH_COUNT,
  batchIndex,
  files,
  execute = runProcess,
  environment = process.env,
  log = console,
  dryRun = false,
} = {}) {
  const selectedFiles = files || (suite === "benchmark" ? benchmarkTestFiles() : sourceTestFiles());
  const batches = suite === "benchmark"
    ? partitionBenchmarkTests(selectedFiles, batchCount)
    : partitionSourceTests(selectedFiles, batchCount);
  verifyTestPartition(batches.flat(), selectedFiles, suite);
  const summaries = batchSummary(batches);
  const selectedSummaries = batchIndex === undefined
    ? summaries
    : summaries.filter((summary) => summary.index === batchIndex);
  if (!selectedSummaries.length)
    throw new Error(`batchIndex must be between 1 and ${batches.length}`);
  if (dryRun) return { ok: true, completed: selectedSummaries };

  const completed = [];
  for (const summary of selectedSummaries) {
    const paths = batches[summary.index - 1];
    const invocations = invocationGroups(paths);
    log.error(`[Pi Chat] Running ${suite} batch ${summary.index}/${batches.length}: ${summary.files} files, ${summary.tests} tests${invocations.length > 1 ? ` in ${invocations.length} fresh processes` : ""}`);
    for (const [invocationIndex, invocation] of invocations.entries()) {
      const code = await execute(
        process.execPath,
        [resolve(repositoryRoot, "scripts", "run-tests.mjs"), ...invocationArguments(invocation)],
        { cwd: repositoryRoot, env: environment },
      );
      if (code !== 0) {
        completed.push({ ...summary, code, invocation: invocationIndex + 1 });
        return { ok: false, completed, failed: summary.index };
      }
    }
    completed.push({ ...summary, code: 0, processes: invocations.length });
  }
  return { ok: true, completed };
}

// Kept as a named compatibility wrapper for callers that only need the source lane.
export function runSourceBatches(options = {}) {
  return runTestBatches({ ...options, suite: "source" });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const suiteValue = args.find((argument) => argument.startsWith("--suite="));
  const suite = suiteValue ? suiteValue.slice("--suite=".length) : "source";
  const dryRun = args.includes("--dry-run");
  const batchIndexValue = args.find((argument) => argument.startsWith("--batch="));
  const batchCountValue = args.find((argument) => argument.startsWith("--count="));
  const batchIndex = batchIndexValue ? Number(batchIndexValue.slice("--batch=".length)) : undefined;
  const defaultCount = suite === "benchmark" ? DEFAULT_BENCHMARK_BATCH_COUNT : DEFAULT_SOURCE_BATCH_COUNT;
  const batchCount = batchCountValue
    ? Number(batchCountValue.slice("--count=".length))
    : Number(args.find((argument) => /^\d+$/.test(argument)) || defaultCount);
  runTestBatches({ suite, batchCount, batchIndex, dryRun })
    .then((result) => {
      for (const batch of result.completed)
        console.error(`[Pi Chat] ${suite} batch ${batch.index}/${batchCount}: ${batch.files} files, ${batch.tests} tests${batch.code === undefined ? "" : `, exit ${batch.code}`}`);
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(`[Pi Chat] Test batch runner failed: ${error.message}`);
      process.exitCode = 1;
    });
}
