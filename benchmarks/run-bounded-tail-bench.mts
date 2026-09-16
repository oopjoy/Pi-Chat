import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { SessionIndex, type SessionFileSnapshot } from "../src/server/session-index.js";
import { MAX_SESSION_SNAPSHOT_BYTES } from "../src/server/session-projection.js";
import { generateBoundedTailFixture, MAX_TAIL_FIXTURE_BYTES, type TailFixtureManifest } from "./bounded-tail-fixture.mjs";
import { normalizedMaxRssBytes, summarizeTimings, type TimingSummary } from "./run-long-session-bench.mjs";

export interface TailBenchmarkOptions {
  minimumBytes?: number;
  iterations?: number;
  outputPath?: string;
}

export interface TailReadEvidence {
  requestedTurns: number;
  returnedTurns: number;
  returnedMessages: number;
  sourceBytes: number;
  bytesRead: number;
  sourceMessagesTruncated: true;
  usageComplete: false;
}

export interface TailBenchmarkResult {
  schemaVersion: 1;
  benchmark: "pi-chat-bounded-tail";
  baselinePolicy: "descriptive-only";
  generatedAt: string;
  environment: { node: string; platform: NodeJS.Platform; arch: string; runnerPeakRssBytes: number };
  fixture: TailFixtureManifest;
  measurements: {
    discoveryFirst: TimingSummary;
    discoveryRepeat: TimingSummary;
    recent10: TimingSummary & TailReadEvidence;
    recent50: TimingSummary & TailReadEvidence;
    concurrentRecent10: { concurrency: 4; batch: TimingSummary; readsPerBatch: TailReadEvidence[] };
  };
}

export function tailBenchmarkParameters(options: TailBenchmarkOptions): { minimumBytes: number; iterations: number } {
  const minimumBytes = options.minimumBytes ?? 256 * 1024 * 1024;
  const iterations = options.iterations ?? 3;
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes <= MAX_SESSION_SNAPSHOT_BYTES || minimumBytes > MAX_TAIL_FIXTURE_BYTES) {
    throw new Error("Bounded-tail minimumBytes must be an integer above 128 MiB and at most 512 MiB");
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100) {
    throw new Error("iterations must be an integer from 1 through 100");
  }
  return { minimumBytes, iterations };
}

/** Validate semantic evidence, not performance thresholds. Extra read counters come from the production tail reader. */
export function tailReadEvidence(snapshot: SessionFileSnapshot | null, turns: number, fixture: TailFixtureManifest): TailReadEvidence {
  if (!snapshot) throw new Error("Tail snapshot is missing");
  const counters = snapshot as SessionFileSnapshot & { sourceBytes?: number; bytesRead?: number };
  const returnedTurns = snapshot.messages.filter((message) => message.role === "user").length;
  const identitiesMatch = snapshot.messages.every((message, position) => {
    const turn = fixture.userTurns - turns + Math.floor(position / 2);
    const role = position % 2 === 0 ? "user" : "assistant";
    return message.role === role && message.piChatPersistedMessageId === `${role}-${turn}:0`;
  });
  if (!identitiesMatch || snapshot.sourceMessagesTruncated !== true || snapshot.usageComplete !== false ||
      counters.sourceBytes !== fixture.bytes || !Number.isSafeInteger(counters.bytesRead) ||
      counters.bytesRead! <= 0 || counters.bytesRead! > fixture.bytes ||
      returnedTurns !== turns || snapshot.messages.length !== turns * 2 ||
      snapshot.sourceMessageTotal !== fixture.messages || snapshot.sourceTurnTotal !== fixture.userTurns) {
    throw new Error("Tail snapshot does not match the fixture or bounded-tail production contract");
  }
  return { requestedTurns: turns, returnedTurns, returnedMessages: snapshot.messages.length,
    sourceBytes: counters.sourceBytes, bytesRead: counters.bytesRead!, sourceMessagesTruncated: true, usageComplete: false };
}

async function measure<T>(iterations: number, operation: () => Promise<T>): Promise<{ timing: TimingSummary; value: T }> {
  const samples: number[] = [];
  let value!: T;
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    value = await operation();
    samples.push(performance.now() - start);
  }
  return { timing: summarizeTimings(samples), value };
}

export async function runBoundedTailBenchmark(options: TailBenchmarkOptions = {}): Promise<TailBenchmarkResult> {
  const { minimumBytes, iterations } = tailBenchmarkParameters(options);
  const root = await mkdtemp(join(tmpdir(), "pi-chat-bounded-tail-"));
  let result: TailBenchmarkResult;
  try {
    const sessions = join(root, "sessions");
    const fixture = await generateBoundedTailFixture(join(sessions, "bounded-tail.jsonl"), minimumBytes);
    const index = new SessionIndex(sessions, join(root, "index.json"));
    const first = await measure(1, () => index.list());
    if (first.value.length !== 1) throw new Error("Expected one synthetic Session");
    const id = first.value[0].id;
    const repeat = await measure(iterations, () => index.list());
    const read = async (turns: number) => tailReadEvidence(await index.recentSnapshotForId(id, turns), turns, fixture);
    const recent10 = await measure(iterations, () => read(10));
    const recent50 = await measure(iterations, () => read(50));
    const concurrent = await measure(iterations, () => Promise.all(Array.from({ length: 4 }, () => read(10))));
    result = {
      schemaVersion: 1, benchmark: "pi-chat-bounded-tail", baselinePolicy: "descriptive-only",
      generatedAt: new Date().toISOString(),
      environment: { node: process.version, platform: process.platform, arch: process.arch,
        runnerPeakRssBytes: normalizedMaxRssBytes(process.resourceUsage().maxRSS) },
      fixture,
      measurements: {
        discoveryFirst: first.timing, discoveryRepeat: repeat.timing,
        recent10: { ...recent10.timing, ...recent10.value },
        recent50: { ...recent50.timing, ...recent50.value },
        concurrentRecent10: { concurrency: 4, batch: concurrent.timing, readsPerBatch: concurrent.value },
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  if (options.outputPath) {
    const path = resolve(options.outputPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(result, null, 2) + String.fromCharCode(10), "utf8");
  }
  return result;
}

export function parseTailBenchmarkArgs(argv: string[]): TailBenchmarkOptions {
  const options: TailBenchmarkOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--minimum-bytes", "--iterations", "--output"].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--minimum-bytes") options.minimumBytes = Number(value);
    else if (flag === "--iterations") options.iterations = Number(value);
    else options.outputPath = value;
  }
  tailBenchmarkParameters(options);
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).includes("--help")) {
    console.log("Usage: node --import tsx benchmarks/run-bounded-tail-bench.mts [--minimum-bytes N] [--iterations N] [--output result.json]");
  } else {
    const result = await runBoundedTailBenchmark(parseTailBenchmarkArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  }
}
