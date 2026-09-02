import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { declaredTestNamePatterns } from "./test-name-patterns.mjs";
import { discoverTestFiles, repositoryRelativeTestPath } from "./test-files.mjs";

export const DEFAULT_SOURCE_BATCH_COUNT = 20;
export const DEFAULT_BENCHMARK_BATCH_COUNT = 5;

// These tests exercise build/runtime/launcher artifacts and remain in the
// artifact gate rather than the source lane.
export const ARTIFACT_TEST_PATHS = new Set([
  "tests/application-restart.test.ts",
  "tests/build-guard.test.ts",
  "tests/e2e-fixtures.test.ts",
  "tests/e2e-runtime-dist.test.ts",
  "tests/pi-runtime-build.test.ts",
  "tests/pi-runtime-bundle.test.ts",
  "tests/startup-smoke.test.ts",
  "tests/web-build-artifacts.test.ts",
  "tests/windows-launcher.test.ts",
]);

// Benchmark implementations are intentionally retained and run in their own
// lane. Their contract tests are still part of source coverage below.
export const BENCHMARK_TEST_PATHS = new Set([
  "tests/browser-fluency-benchmark.test.ts",
  "tests/e2e-streaming-benchmark.test.ts",
  "tests/long-session-benchmark.test.ts",
  "tests/react-render-benchmark.test.ts",
  "tests/streaming-cadence-benchmark.test.ts",
]);

const PROCESS_ISOLATION_PATHS = new Set([
  "tests/rpc-client.test.ts",
  "tests/session-index.test.ts",
  "tests/session-management.test.ts",
]);

function testMetadata(path) {
  const source = readFileSync(path, "utf8");
  return {
    lines: source.split(/\r?\n/).length,
    tests: declaredTestNamePatterns(path).length,
    path: repositoryRelativeTestPath(path),
  };
}

function requiresProcessIsolation(path) {
  const metadata = testMetadata(path);
  // App-level jsdom suites retain React roots, EventSource instances and
  // browser fixtures longer than pure unit tests. Keep the largest ones alone.
  if (
    metadata.path.startsWith("tests/web/") &&
    (metadata.tests >= 14 || metadata.lines >= 1_000)
  ) return true;
  // These suites create real child/process or broad Session fixtures and are
  // safer as independent memory/ownership boundaries as well.
  return PROCESS_ISOLATION_PATHS.has(metadata.path);
}

function testWeight(path) {
  const metadata = testMetadata(path);
  return Math.max(1, metadata.lines + metadata.tests * 80);
}

export function processIsolatedTestFiles(files = sourceTestFiles()) {
  return files.filter(requiresProcessIsolation);
}

export function sourceTestFiles(discovered = discoverTestFiles()) {
  const source = discovered.filter((path) => {
    const relative = repositoryRelativeTestPath(path);
    return !ARTIFACT_TEST_PATHS.has(relative) && !BENCHMARK_TEST_PATHS.has(relative);
  });
  if (!source.length) throw new Error("No source tests remain after artifact/benchmark exclusion");
  return source;
}

export function benchmarkTestFiles(discovered = discoverTestFiles()) {
  const benchmark = discovered.filter((path) => BENCHMARK_TEST_PATHS.has(repositoryRelativeTestPath(path)));
  if (!benchmark.length) throw new Error("No benchmark tests were discovered");
  if (benchmark.length !== BENCHMARK_TEST_PATHS.size)
    throw new Error("The benchmark manifest does not match the discovered benchmark test set");
  return benchmark;
}

/**
 * Partition files exactly once using deterministic weighted greedy bin packing.
 * Each returned batch is later executed in a fresh Node process.
 */
export function partitionTestFiles(
  files,
  batchCount,
  label = "test",
) {
  if (!Number.isInteger(batchCount) || batchCount < 1)
    throw new Error("batchCount must be a positive integer");
  if (batchCount > files.length)
    throw new Error("batchCount cannot exceed the number of test files");
  const batches = Array.from({ length: batchCount }, () => []);
  const totals = Array.from({ length: batchCount }, () => 0);
  const isolated = processIsolatedTestFiles(files)
    .sort((left, right) => testWeight(right) - testWeight(left) || left.localeCompare(right));
  if (isolated.length > batchCount)
    throw new Error(`batchCount ${batchCount} is too small for ${isolated.length} isolated ${label} suites`);
  if (isolated.length === batchCount && files.length > isolated.length)
    throw new Error(`batchCount ${batchCount} must exceed the ${isolated.length} isolated ${label} suites so ordinary suites have a batch`);
  for (const [index, path] of isolated.entries()) {
    batches[index].push(path);
    totals[index] = testWeight(path);
  }
  const weights = files
    .filter((path) => !requiresProcessIsolation(path))
    .map((path) => ({ path, weight: testWeight(path) }))
    .sort((left, right) => right.weight - left.weight || left.path.localeCompare(right.path));
  for (const item of weights) {
    let target = isolated.length;
    for (let index = isolated.length + 1; index < batchCount; index += 1)
      if (totals[index] < totals[target]) target = index;
    batches[target].push(item.path);
    totals[target] += item.weight;
  }
  for (const batch of batches)
    batch.sort((left, right) => repositoryRelativeTestPath(left).localeCompare(repositoryRelativeTestPath(right)));
  verifyTestPartition(batches.flat(), files, label);
  return batches;
}

export function partitionSourceTests(
  files = sourceTestFiles(),
  batchCount = DEFAULT_SOURCE_BATCH_COUNT,
) {
  return partitionTestFiles(files, batchCount, "source");
}

export function partitionBenchmarkTests(
  files = benchmarkTestFiles(),
  batchCount = DEFAULT_BENCHMARK_BATCH_COUNT,
) {
  return partitionTestFiles(files, batchCount, "benchmark");
}

export function verifyTestPartition(actual, expected, label = "test") {
  const expectedKeys = expected.map((path) => resolve(path)).sort();
  const actualKeys = actual.map((path) => resolve(path)).sort();
  if (new Set(actualKeys).size !== actualKeys.length)
    throw new Error(`${label} batches contain a duplicate test file`);
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((path, index) => path !== expectedKeys[index]))
    throw new Error(`${label} batches do not cover exactly the discovered test set`);
  return true;
}

export function verifySourcePartition(actual, expected = sourceTestFiles()) {
  return verifyTestPartition(actual, expected, "Source");
}

export function batchSummary(batches) {
  return batches.map((paths, index) => ({
    index: index + 1,
    files: paths.length,
    tests: paths.reduce((total, path) => total + declaredTestNamePatterns(path).length, 0),
    paths: paths.map((path) => repositoryRelativeTestPath(path)),
  }));
}
