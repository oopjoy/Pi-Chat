import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { messageWindow } from "../src/server/pi-data.js";
import { SessionIndex, readSessionSnapshot } from "../src/server/session-index.js";
import { FIXTURE_SCENARIOS, generateFixture, type FixtureManifest, type FixtureScenario } from "./long-session-fixtures.mjs";

export interface TimingSummary {
  iterations: number;
  minMs: number;
  medianMs: number;
  meanMs: number;
  maxMs: number;
}

export interface ServerBenchmarkResult {
  schemaVersion: 1;
  benchmark: "pi-chat-long-session";
  generatedAt: string;
  environment: { node: string; platform: NodeJS.Platform; arch: string };
  baselinePolicy: "descriptive-only";
  fixtures: FixtureManifest[];
  measurements: Array<{
    scenario: FixtureScenario;
    fixtureBytes: number;
    recordCount: number;
    messageCount: number;
    userTurns: number;
    discoveryCold: TimingSummary;
    discoveryCached: TimingSummary;
    parseSnapshot: TimingSummary;
    snapshotCold: TimingSummary;
    snapshotHot: TimingSummary;
    windowRecent10: TimingSummary & { returnedMessages: number; visibleTurns: number; truncated: boolean };
    windowEarlier50: TimingSummary & { returnedMessages: number; visibleTurns: number; truncated: boolean };
  }>;
  browserScenarioContract: BrowserScenarioContract;
}

export interface BrowserScenarioContract {
  schemaVersion: 1;
  purpose: string;
  prerequisites: string[];
  scenarios: Array<{
    id: "cold-first-pane" | "hot-switch" | "load-earlier";
    setup: string[];
    action: string;
    completionSignal: string;
    metrics: string[];
  }>;
  metricDefinitions: Record<string, string>;
  thresholds: null;
}

export const browserScenarioContract: BrowserScenarioContract = {
  schemaVersion: 1,
  purpose: "Contract for a future isolated Playwright/Chromium lane; it must consume generated temp fixtures and a disposable benchmark server, never live port 30170 or live dist.",
  prerequisites: [
    "Generate fixtures into a fresh OS temp directory.",
    "Start a disposable benchmark-only server on an ephemeral port with a benchmark-owned web build or dev server.",
    "Collect Chromium metrics in a fresh browser context and delete all temporary artifacts afterwards.",
  ],
  scenarios: [
    {
      id: "cold-first-pane",
      setup: ["Start with empty browser storage and no session-view cache.", "Select a generated long session."],
      action: "Navigate from the sidebar to the target session.",
      completionSignal: "The newest visible message pane commits and reports its pane source.",
      metrics: ["paneCommitMs", "domNodeCount", "longTasks", "heapBytes"],
    },
    {
      id: "hot-switch",
      setup: ["Open generated session A, then generated session B, retaining browser memory caches."],
      action: "Switch back to session A.",
      completionSignal: "The cached pane commit for session A completes.",
      metrics: ["paneCommitMs", "domNodeCount", "longTasks", "heapBytes"],
    },
    {
      id: "load-earlier",
      setup: ["Open a generated 1000-turn session at its newest pane."],
      action: "Request the next earlier message window.",
      completionSignal: "The earlier window is rendered and scroll anchoring is restored.",
      metrics: ["loadEarlierMs", "domNodeCount", "longTasks", "heapBytes"],
    },
  ],
  metricDefinitions: {
    paneCommitMs: "performance.now() elapsed from navigation action to committed target pane.",
    loadEarlierMs: "performance.now() elapsed from load-earlier action to committed expanded window.",
    domNodeCount: "document.getElementsByTagName('*').length immediately after completion.",
    longTasks: "PerformanceObserver entries of type longtask recorded during the action, including count and total duration.",
    heapBytes: "Chromium performance.memory.usedJSHeapSize where available; otherwise null with an unsupported marker.",
  },
  thresholds: null,
};

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function summarizeTimings(samples: number[]): TimingSummary {
  if (!samples.length) throw new Error("At least one timing sample is required");
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { iterations: sorted.length, minMs: round(sorted[0]), medianMs: round(median), meanMs: round(mean), maxMs: round(sorted.at(-1)!) };
}

async function measure<T>(iterations: number, operation: () => Promise<T> | T): Promise<{ summary: TimingSummary; value: T }> {
  const samples: number[] = [];
  let value!: T;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const start = performance.now();
    value = await operation();
    samples.push(performance.now() - start);
  }
  return { summary: summarizeTimings(samples), value };
}

export async function runLongSessionBenchmark(options: { scenarios?: FixtureScenario[]; iterations?: number; outputPath?: string } = {}): Promise<ServerBenchmarkResult> {
  const scenarios = options.scenarios ?? [...FIXTURE_SCENARIOS];
  const iterations = Math.max(1, Math.floor(options.iterations ?? 3));
  const root = await mkdtemp(join(tmpdir(), "pi-chat-long-session-bench-"));
  const fixtureRoot = join(root, "sessions");
  const fixtures: FixtureManifest[] = [];
  try {
    for (const scenario of scenarios) {
      fixtures.push(await generateFixture({ scenario, outputPath: join(fixtureRoot, `${scenario}.jsonl`) }));
    }
    const measurements: ServerBenchmarkResult["measurements"] = [];
    let cacheSequence = 0;
    for (const fixture of fixtures) {
      const isolatedRoot = join(root, `isolated-${fixture.scenario}`);
      const isolatedFixture = await generateFixture({ scenario: fixture.scenario, outputPath: join(isolatedRoot, basename(fixture.path)), targetBytes: fixture.targetBytes ?? undefined });
      const discoveryCold = await measure(iterations, async () => {
        const index = new SessionIndex(isolatedRoot, join(root, `cold-cache-${fixture.scenario}-${cacheSequence++}.json`));
        return index.list();
      });
      const cachedIndex = new SessionIndex(isolatedRoot, join(root, `cached-${fixture.scenario}.json`));
      await cachedIndex.list();
      const discoveryCached = await measure(iterations, () => cachedIndex.list());
      const parseSnapshot = await measure(iterations, () => readSessionSnapshot(isolatedFixture.path));
      const indexForSnapshot = new SessionIndex(isolatedRoot, join(root, `snapshot-${fixture.scenario}.json`));
      const [summary] = await indexForSnapshot.list();
      const snapshotCold = await measure(1, () => indexForSnapshot.snapshotForId(summary.id));
      const snapshotHot = await measure(iterations, () => indexForSnapshot.snapshotForId(summary.id));
      const messages = parseSnapshot.value.messages;
      const recent = await measure(Math.max(iterations, 5), () => messageWindow(messages, 10));
      const earlier = await measure(Math.max(iterations, 5), () => messageWindow(messages, 50));
      measurements.push({
        scenario: fixture.scenario,
        fixtureBytes: fixture.bytes,
        recordCount: fixture.records,
        messageCount: messages.length,
        userTurns: fixture.userTurns,
        discoveryCold: discoveryCold.summary,
        discoveryCached: discoveryCached.summary,
        parseSnapshot: parseSnapshot.summary,
        snapshotCold: snapshotCold.summary,
        snapshotHot: snapshotHot.summary,
        windowRecent10: { ...recent.summary, returnedMessages: recent.value.messages.length, visibleTurns: recent.value.visibleTurns, truncated: recent.value.truncated },
        windowEarlier50: { ...earlier.summary, returnedMessages: earlier.value.messages.length, visibleTurns: earlier.value.visibleTurns, truncated: earlier.value.truncated },
      });
    }
    const result: ServerBenchmarkResult = {
      schemaVersion: 1,
      benchmark: "pi-chat-long-session",
      generatedAt: new Date().toISOString(),
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      baselinePolicy: "descriptive-only",
      fixtures,
      measurements,
      browserScenarioContract,
    };
    if (options.outputPath) {
      const outputPath = resolve(options.outputPath);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, JSON.stringify(result, null, 2) + String.fromCharCode(10), "utf8");
    }
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function printSummary(result: ServerBenchmarkResult): void {
  console.log("Pi Chat long-session benchmark (descriptive baseline; no pass/fail thresholds)");
  console.log("scenario                  MiB   parse p50  snapshot cold  snapshot hot  discovery cold  window10");
  for (const row of result.measurements) {
    const fields = [
      row.scenario.padEnd(25),
      (row.fixtureBytes / 1024 / 1024).toFixed(2).padStart(6),
      `${row.parseSnapshot.medianMs.toFixed(2)} ms`.padStart(11),
      `${row.snapshotCold.medianMs.toFixed(2)} ms`.padStart(14),
      `${row.snapshotHot.medianMs.toFixed(2)} ms`.padStart(13),
      `${row.discoveryCold.medianMs.toFixed(2)} ms`.padStart(16),
      `${row.windowRecent10.medianMs.toFixed(3)} ms`.padStart(11),
    ];
    console.log(fields.join("  "));
  }
}

function parseArgs(argv: string[]): { scenarios?: FixtureScenario[]; iterations?: number; outputPath?: string } {
  const result: { scenarios?: FixtureScenario[]; iterations?: number; outputPath?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") result.outputPath = argv[++index];
    else if (argument === "--iterations") result.iterations = Number(argv[++index]);
    else if (argument === "--scenario") {
      const scenario = argv[++index] as FixtureScenario;
      if (!FIXTURE_SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
      result.scenarios = [...(result.scenarios ?? []), scenario];
    } else if (argument === "--help") {
      console.log("Usage: node --import tsx benchmarks/run-long-session-bench.mts [--scenario NAME] [--iterations N] [--output result.json]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (result.iterations !== undefined && (!Number.isFinite(result.iterations) || result.iterations < 1)) throw new Error("--iterations must be a positive number");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const result = await runLongSessionBenchmark(options);
  printSummary(result);
  if (!options.outputPath) console.log(JSON.stringify(result));
}
