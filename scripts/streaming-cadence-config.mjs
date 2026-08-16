export const BROWSER_STREAMING_BENCHMARK_POLICIES = [
  "timeout-50",
  "animation-frame",
];

export function parseBrowserStreamingBenchmarkPolicy(value) {
  if (value === undefined || value === "") return "timeout-50";
  if (BROWSER_STREAMING_BENCHMARK_POLICIES.includes(value)) return value;
  throw new Error(
    "PI_CHAT_BENCHMARK_BROWSER_STREAMING_POLICY must be timeout-50 or animation-frame",
  );
}

export function assertBrowserStreamingBenchmarkStaging(
  policy,
  distRoot,
  liveDist,
  platform = process.platform,
) {
  const samePath = platform === "win32"
    ? distRoot.toLowerCase() === liveDist.toLowerCase()
    : distRoot === liveDist;
  if (policy !== "timeout-50" && samePath) {
    throw new Error(
      "Experimental browser streaming policy requires an explicit non-live PI_CHAT_DIST_DIR staging root",
    );
  }
}
