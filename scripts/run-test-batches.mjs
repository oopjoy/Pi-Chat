import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  DEFAULT_SOURCE_BATCH_COUNT,
  batchSummary,
  partitionSourceTests,
  sourceTestFiles,
  verifySourcePartition,
} from "./test-batches.mjs";
import { repositoryRelativeTestPath, repositoryRoot } from "./test-files.mjs";

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

export async function runSourceBatches({
  batchCount = DEFAULT_SOURCE_BATCH_COUNT,
  batchIndex,
  files = sourceTestFiles(),
  execute = runProcess,
  environment = process.env,
  log = console,
  dryRun = false,
} = {}) {
  const batches = partitionSourceTests(files, batchCount);
  verifySourcePartition(batches.flat(), files);
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
    log.error(`[Pi Chat] Running source batch ${summary.index}/${batches.length}: ${summary.files} files, ${summary.tests} tests`);
    const code = await execute(
      process.execPath,
      [
        resolve(repositoryRoot, "scripts", "run-tests.mjs"),
        ...paths.flatMap((path) => ["--file", repositoryRelativeTestPath(path)]),
      ],
      { cwd: repositoryRoot, env: environment },
    );
    completed.push({ ...summary, code });
    if (code !== 0) return { ok: false, completed, failed: summary.index };
  }
  return { ok: true, completed };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const batchIndexValue = args.find((argument) => argument.startsWith("--batch="));
  const batchCountValue = args.find((argument) => argument.startsWith("--count="));
  const batchIndex = batchIndexValue ? Number(batchIndexValue.slice("--batch=".length)) : undefined;
  const batchCount = batchCountValue
    ? Number(batchCountValue.slice("--count=".length))
    : Number(args.find((argument) => /^\\d+$/.test(argument)) || DEFAULT_SOURCE_BATCH_COUNT);
  runSourceBatches({ batchCount, batchIndex, dryRun })
    .then((result) => {
      for (const batch of result.completed)
        console.error(`[Pi Chat] Source batch ${batch.index}/${batchCount}: ${batch.files} files, ${batch.tests} tests${batch.code === undefined ? "" : `, exit ${batch.code}`}`);
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(`[Pi Chat] Source batch runner failed: ${error.message}`);
      process.exitCode = 1;
    });
}
