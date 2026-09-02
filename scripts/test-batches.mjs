import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { declaredTestNamePatterns } from "./test-name-patterns.mjs";
import { discoverTestFiles, repositoryRelativeTestPath, repositoryRoot } from "./test-files.mjs";

export const DEFAULT_SOURCE_BATCH_COUNT = 20;

// Keep the artifact boundary in one executable manifest. Source batching must
// never silently absorb build/runtime/launcher tests, and artifact tests must
// remain available to the separate artifact gate.
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
  // browser fixtures longer than pure unit tests. Keep the largest ones alone
  // so a batch cannot reproduce the old process-wide memory accumulation.
  if (
    metadata.path.startsWith("tests/web/") &&
    (metadata.tests >= 14 || metadata.lines >= 1_000)
  ) return true;
  // These suites create real child/process or broad Session fixtures and are
  // safer as independent memory/ownership boundaries as well.
  return new Set([
    "tests/rpc-client.test.ts",
    "tests/session-index.test.ts",
    "tests/session-management.test.ts",
  ]).has(metadata.path);
}

function testWeight(path) {
  const metadata = testMetadata(path);
  return Math.max(1, metadata.lines + metadata.tests * 80);
}

export function sourceTestFiles(discovered = discoverTestFiles()) {
  const source = discovered.filter(
    (path) => !ARTIFACT_TEST_PATHS.has(repositoryRelativeTestPath(path)),
  );
  if (!source.length) throw new Error("No source tests remain after artifact exclusion");
  return source;
}

/**
 * Partition every source file exactly once using a deterministic weighted
 * greedy bin-packing pass. Each returned batch is later executed in a fresh
 * Node process, so module/jsdom/fixture memory cannot accumulate forever.
 */
export function partitionSourceTests(
  files = sourceTestFiles(),
  batchCount = DEFAULT_SOURCE_BATCH_COUNT,
) {
  if (!Number.isInteger(batchCount) || batchCount < 1)
    throw new Error("batchCount must be a positive integer");
  if (batchCount > files.length)
    throw new Error("batchCount cannot exceed the number of source test files");
  const batches = Array.from({ length: batchCount }, () => []);
  const totals = Array.from({ length: batchCount }, () => 0);
  const isolated = files.filter(requiresProcessIsolation)
    .sort((left, right) => testWeight(right) - testWeight(left) || left.localeCompare(right));
  if (isolated.length > batchCount)
    throw new Error(`batchCount ${batchCount} is too small for ${isolated.length} isolated source suites`);
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
  verifySourcePartition(batches.flat(), files);
  return batches;
}

export function verifySourcePartition(actual, expected = sourceTestFiles()) {
  const expectedKeys = expected.map((path) => resolve(path)).sort();
  const actualKeys = actual.map((path) => resolve(path)).sort();
  if (new Set(actualKeys).size !== actualKeys.length)
    throw new Error("Source test batches contain a duplicate test file");
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((path, index) => path !== expectedKeys[index]))
    throw new Error("Source test batches do not cover exactly the discovered source test set");
  return true;
}

export function batchSummary(batches) {
  return batches.map((paths, index) => ({
    index: index + 1,
    files: paths.length,
    tests: paths.reduce((total, path) => total + declaredTestNamePatterns(path).length, 0),
    paths: paths.map((path) => repositoryRelativeTestPath(path)),
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const batches = partitionSourceTests(
    sourceTestFiles(),
    Number(process.argv[2] || DEFAULT_SOURCE_BATCH_COUNT),
  );
  for (const summary of batchSummary(batches))
    console.log(`${summary.index}: ${summary.files} files, ${summary.tests} tests`);
}
