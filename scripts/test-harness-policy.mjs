import { resolve } from "node:path";

// These limits belong exclusively to the official development-test harness and
// its descendants. They are deliberately not read by the production server or
// the Pi RPC launcher.
export const TEST_NODE_CONCURRENCY = 1;
export const TEST_TIMEOUT_MS = 45_000;
export const TEST_MAX_OLD_SPACE_MIB = 2_048;
export const TEST_JOB_MEMORY_MIB = 3_072;

const FORCED_TEST_OPTION_NAMES = new Set([
  "--test-concurrency",
  "--test-timeout",
]);

export function isHarnessControlledTestOption(argument) {
  for (const name of FORCED_TEST_OPTION_NAMES) {
    if (argument === name || argument.startsWith(`${name}=`)) return true;
  }
  return false;
}

export function controlledTestEnvironment(environment = process.env) {
  const {
    NODE_OPTIONS: _ignoredNodeOptions,
    PI_CHAT_TEST_JOB_ACTIVE: _ignoredLegacyJobMarker,
    PI_CHAT_TEST_JOB_MEMORY_MIB: _ignoredJobMemoryMarker,
    ...safeEnvironment
  } = environment;
  return {
    ...safeEnvironment,
    NODE_ENV: "test",
    // Do not merge NODE_OPTIONS from the calling shell. An inherited --require,
    // --import, or second heap setting would make the test execution contract
    // non-deterministic and could evade the intended V8 cap.
    NODE_OPTIONS: `--max-old-space-size=${TEST_MAX_OLD_SPACE_MIB}`,
  };
}

export function testRunnerArguments(nodeArguments, selectedFiles) {
  return [
    "--test",
    "--import",
    "tsx",
    `--test-concurrency=${TEST_NODE_CONCURRENCY}`,
    `--test-timeout=${TEST_TIMEOUT_MS}`,
    ...nodeArguments,
    "--",
    ...selectedFiles,
  ];
}

export function windowsTestJobInvocation({
  nodePath,
  workingDirectory,
  nodeArguments,
  powershellPath = "powershell.exe",
}) {
  const encodedArguments = Buffer.from(JSON.stringify(nodeArguments), "utf8").toString("base64");
  return {
    command: powershellPath,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(workingDirectory, "scripts", "windows-test-job.ps1"),
      "-NodePath",
      resolve(nodePath),
      "-WorkingDirectory",
      resolve(workingDirectory),
      "-NodeArgumentsBase64",
      encodedArguments,
      "-MemoryLimitMiB",
      String(TEST_JOB_MEMORY_MIB),
    ],
    environment: {},
  };
}
