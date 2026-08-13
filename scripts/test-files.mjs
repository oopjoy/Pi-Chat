import { readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const testsRoot = resolve(repositoryRoot, "tests");

function portablePath(path) {
  return path.split(sep).join("/");
}

function walk(directory, files) {
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(path, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path);
  }
}

export function discoverTestFiles(root = testsRoot) {
  const files = [];
  walk(root, files);
  return files.sort((left, right) => portablePath(left).localeCompare(portablePath(right)));
}

export function repositoryRelativeTestPath(path, root = repositoryRoot) {
  return portablePath(relative(root, path));
}

function selectionKey(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function normalizedSelection(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

const NODE_OPTIONS_WITH_SEPARATE_VALUE = new Set([
  "--test-concurrency",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-skip-pattern",
  "--test-timeout",
]);

export class TestHarnessArgumentError extends Error {}

export function parseTestArguments(argv, discovered = discoverTestFiles()) {
  const nodeArguments = [];
  const requested = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--file") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-"))
        throw new TestHarnessArgumentError("--file requires a repository-relative tests/**/*.test.ts path");
      requested.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--file=")) {
      const value = argument.slice("--file=".length);
      if (!value)
        throw new TestHarnessArgumentError("--file requires a repository-relative tests/**/*.test.ts path");
      requested.push(value);
      continue;
    }
    if (!argument.startsWith("-"))
      throw new TestHarnessArgumentError(`Unexpected positional argument: ${argument}. Use --file for test selection.`);
    if (!argument.startsWith("--test-"))
      throw new TestHarnessArgumentError(`Unsupported harness argument: ${argument}. Only --file and Node --test-* options are accepted.`);
    nodeArguments.push(argument);
    if (NODE_OPTIONS_WITH_SEPARATE_VALUE.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("-"))
        throw new TestHarnessArgumentError(`${argument} requires a value`);
      nodeArguments.push(value);
      index += 1;
    }
  }

  if (!discovered.length) throw new TestHarnessArgumentError("No tests/**/*.test.ts files were discovered");
  if (!requested.length) return { nodeArguments, selectedFiles: discovered };

  const discoveredByName = new Map(
    discovered.map((path) => [selectionKey(repositoryRelativeTestPath(path)), path]),
  );
  const selectedFiles = [];
  const selected = new Set();
  for (const raw of requested) {
    if (raw.includes("\0") || isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith("//") || raw.startsWith("\\\\"))
      throw new TestHarnessArgumentError(`Selected test must be repository-relative under tests/: ${raw}`);
    const name = normalizedSelection(raw);
    const path = discoveredByName.get(selectionKey(name));
    if (!path)
      throw new TestHarnessArgumentError(`Unknown test file: ${raw}. Select a discovered tests/**/*.test.ts file.`);
    const key = selectionKey(path);
    if (selected.has(key)) continue;
    selected.add(key);
    selectedFiles.push(path);
  }
  return { nodeArguments, selectedFiles };
}
