export function parseReactRenderBenchmarkEnabled(value) {
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error(
    "PI_CHAT_BENCHMARK_REACT_PROFILER must be 0 or 1",
  );
}

export function assertReactRenderBenchmarkStaging(
  enabled,
  distRoot,
  liveDist,
  platform = process.platform,
) {
  if (!enabled) return;
  const samePath = platform === "win32"
    ? distRoot.toLowerCase() === liveDist.toLowerCase()
    : distRoot === liveDist;
  if (samePath) {
    throw new Error(
      "React render benchmark profiling requires an explicit non-live PI_CHAT_DIST_DIR staging root",
    );
  }
}
