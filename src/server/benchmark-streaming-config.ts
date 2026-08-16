import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

const ALLOWED_INTERVALS = new Set([25, 33, 50]);

function pathKey(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(base: string, target: string): boolean {
  const fromBase = relative(base, target);
  return fromBase !== "" && fromBase !== ".." && !fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase);
}

export function isIsolatedStreamingBenchmarkRuntime(options: {
  configPath: string | undefined;
  declaredRuntimeDist: string | undefined;
  runtimeDist: string;
  liveDist: string;
  port: number;
  temporaryRoot?: string;
}): boolean {
  if (
    !options.configPath
    || !options.declaredRuntimeDist
    || options.port === 30170
    || pathKey(options.declaredRuntimeDist) !== pathKey(options.runtimeDist)
    || pathKey(options.runtimeDist) === pathKey(options.liveDist)
  ) return false;
  try {
    const temporaryRoot = realpathSync.native
      ? realpathSync.native(options.temporaryRoot || tmpdir())
      : realpathSync(options.temporaryRoot || tmpdir());
    const configStat = lstatSync(options.configPath);
    const runtimeStat = lstatSync(options.runtimeDist);
    if (
      !configStat.isFile()
      || configStat.isSymbolicLink()
      || !runtimeStat.isDirectory()
      || runtimeStat.isSymbolicLink()
    ) return false;
    const canonicalConfig = realpathSync.native
      ? realpathSync.native(options.configPath)
      : realpathSync(options.configPath);
    const canonicalRuntime = realpathSync.native
      ? realpathSync.native(options.runtimeDist)
      : realpathSync(options.runtimeDist);
    if (!isWithin(temporaryRoot, canonicalConfig) || !isWithin(temporaryRoot, canonicalRuntime))
      return false;
    const configScope = relative(temporaryRoot, canonicalConfig).split(sep)[0] || "";
    const runtimeScope = relative(temporaryRoot, canonicalRuntime).split(sep)[0] || "";
    return configScope === runtimeScope
      && /^pi-chat-streaming-cadence-[A-Za-z0-9]+$/.test(configScope);
  } catch {
    return false;
  }
}

/**
 * Parses the private benchmark-only SSE cadence seam. Ordinary startup leaves
 * the option undefined so SseHub retains its production 50 ms default.
 */
export function parseBenchmarkSseSnapshotInterval(
  value: string | undefined,
  benchmarkActive = false,
): number | undefined {
  if (value === undefined) return undefined;
  if (!benchmarkActive) {
    throw new Error(
      "PI_CHAT_BENCHMARK_SSE_INTERVAL_MS requires the isolated E2E streaming benchmark",
    );
  }
  if (!/^(25|33|50)$/.test(value)) {
    throw new Error(
      "PI_CHAT_BENCHMARK_SSE_INTERVAL_MS must be exactly 25, 33, or 50",
    );
  }
  const interval = Number(value);
  if (!ALLOWED_INTERVALS.has(interval)) {
    throw new Error("Unsupported streaming benchmark SSE interval");
  }
  return interval;
}
