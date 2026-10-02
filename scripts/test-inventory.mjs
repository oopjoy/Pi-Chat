import { declaredTestNamePatterns } from "./test-name-patterns.mjs";
import {
  artifactTestFiles,
  benchmarkTestFiles,
  processIsolatedTestFiles,
  sourceTestFiles,
  testFilesForSuite,
} from "./test-batches.mjs";
import { discoverTestFiles, repositoryRelativeTestPath } from "./test-files.mjs";

function summarize(files) {
  return {
    files: files.length,
    tests: files.reduce((total, file) => total + declaredTestNamePatterns(file).length, 0),
  };
}

const discovered = discoverTestFiles();
const source = sourceTestFiles(discovered);
const benchmark = benchmarkTestFiles(discovered);
const artifact = artifactTestFiles(discovered);
const inventory = {
  generatedAt: new Date().toISOString(),
  repositoryTestFiles: discovered.length,
  source: summarize(source),
  benchmark: summarize(benchmark),
  artifact: summarize(artifact),
  processIsolatedSourceFiles: processIsolatedTestFiles(source)
    .map((file) => repositoryRelativeTestPath(file))
    .sort(),
  lanesCoverEveryFileExactlyOnce:
    new Set([...source, ...benchmark, ...artifact].map((file) => repositoryRelativeTestPath(file))).size === discovered.length,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(inventory, null, 2));
} else {
  console.log(`Repository test files: ${inventory.repositoryTestFiles}`);
  for (const lane of ["source", "benchmark", "artifact"])
    console.log(`${lane}: ${inventory[lane].files} files, ${inventory[lane].tests} declared tests`);
  console.log(`Process-isolated source files: ${inventory.processIsolatedSourceFiles.length}`);
  console.log(`Lane coverage exact: ${inventory.lanesCoverEveryFileExactlyOnce ? "yes" : "no"}`);
}

if (!inventory.lanesCoverEveryFileExactlyOnce) process.exitCode = 1;
