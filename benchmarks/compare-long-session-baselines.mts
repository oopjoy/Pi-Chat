import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ServerBenchmarkResult } from "./run-long-session-bench.mts";

type Metric =
  | "parseSnapshot"
  | "sessionIndexDiscoveryCacheMiss"
  | "sessionIndexDiscoveryCacheHit"
  | "sessionIndexSnapshotCacheMiss"
  | "sessionIndexSnapshotCacheHit"
  | "windowRecent10"
  | "windowEarlier50";

const metrics: Metric[] = [
  "parseSnapshot",
  "sessionIndexDiscoveryCacheMiss",
  "sessionIndexDiscoveryCacheHit",
  "sessionIndexSnapshotCacheMiss",
  "sessionIndexSnapshotCacheHit",
  "windowRecent10",
  "windowEarlier50",
];

export interface LongSessionBaselineComparison {
  schemaVersion: 1;
  benchmark: "pi-chat-long-session-comparison";
  baselinePolicy: "descriptive-only";
  baseline: { generatedAt: string; environment: ServerBenchmarkResult["environment"] };
  candidate: { generatedAt: string; environment: ServerBenchmarkResult["environment"] };
  runnerPeakRssBytesDelta: number;
  scenarios: Array<{
    scenario: string;
    fixtureBytes: { baseline: number; candidate: number };
    medianMs: Record<Metric, { baseline: number; candidate: number; delta: number }>;
  }>;
}

function isResult(value: unknown): value is ServerBenchmarkResult {
  return Boolean(
    value && typeof value === "object"
      && (value as { benchmark?: unknown }).benchmark === "pi-chat-long-session"
      && (value as { baselinePolicy?: unknown }).baselinePolicy === "descriptive-only"
      && Array.isArray((value as { measurements?: unknown }).measurements),
  );
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function compareLongSessionBaselines(
  baseline: ServerBenchmarkResult,
  candidate: ServerBenchmarkResult,
): LongSessionBaselineComparison {
  const candidateRows = new Map(candidate.measurements.map((row) => [row.scenario, row]));
  const scenarios = baseline.measurements.flatMap((baselineRow) => {
    const candidateRow = candidateRows.get(baselineRow.scenario);
    if (!candidateRow || baselineRow.fixtureBytes !== candidateRow.fixtureBytes) return [];
    const medianMs = Object.fromEntries(metrics.map((metric) => {
      const before = baselineRow[metric].medianMs;
      const after = candidateRow[metric].medianMs;
      return [metric, { baseline: before, candidate: after, delta: rounded(after - before) }];
    })) as LongSessionBaselineComparison["scenarios"][number]["medianMs"];
    return [{
      scenario: baselineRow.scenario,
      fixtureBytes: { baseline: baselineRow.fixtureBytes, candidate: candidateRow.fixtureBytes },
      medianMs,
    }];
  });
  return {
    schemaVersion: 1,
    benchmark: "pi-chat-long-session-comparison",
    baselinePolicy: "descriptive-only",
    baseline: { generatedAt: baseline.generatedAt, environment: baseline.environment },
    candidate: { generatedAt: candidate.generatedAt, environment: candidate.environment },
    runnerPeakRssBytesDelta: candidate.environment.runnerPeakRssBytes - baseline.environment.runnerPeakRssBytes,
    scenarios,
  };
}

function parseArgs(argv: string[]): { baseline: string; candidate: string; output?: string } {
  let baseline = "";
  let candidate = "";
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--baseline") baseline = argv[++index] || "";
    else if (argument === "--candidate") candidate = argv[++index] || "";
    else if (argument === "--output") output = argv[++index];
    else if (argument === "--help") {
      console.log("Usage: node --import tsx benchmarks/compare-long-session-baselines.mts --baseline before.json --candidate after.json [--output comparison.json]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!baseline || !candidate) throw new Error("--baseline and --candidate are required");
  return { baseline, candidate, output };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const options = parseArgs(process.argv.slice(2));
  const [before, after] = await Promise.all([options.baseline, options.candidate].map(async (path) => {
    const value: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
    if (!isResult(value)) throw new Error(`Not a descriptive pi-chat-long-session result: ${path}`);
    return value;
  }));
  const comparison = compareLongSessionBaselines(before, after);
  const text = JSON.stringify(comparison, null, 2) + "\n";
  if (options.output) await writeFile(resolve(options.output), text, "utf8");
  else console.log(text);
}
