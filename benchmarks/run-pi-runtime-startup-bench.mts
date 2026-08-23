import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IncidentDiagnostics, IncidentFields } from "../src/server/incident-diagnostics";
import { resolvePiRuntimeLaunch } from "../src/server/pi-runtime-bundle";
import { PiRpcClient, resolvePiEntry } from "../src/server/rpc-client";

interface Options {
  session: string;
  iterations: number;
  backend: "direct" | "bundle" | "both";
  profile: "core" | "installed-profile";
  runtimeDist: string;
}

function parseArgs(argv: string[]): Options {
  let session = "";
  let iterations = 5;
  let backend: Options["backend"] = "both";
  let profile: Options["profile"] = "core";
  let runtimeDist = resolve("dist");
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--session" && value) { session = resolve(value); index += 1; }
    else if (argument === "--iterations" && value) { iterations = Number(value); index += 1; }
    else if (argument === "--backend" && (value === "direct" || value === "bundle" || value === "both")) { backend = value; index += 1; }
    else if (argument === "--profile" && (value === "core" || value === "installed-profile")) { profile = value; index += 1; }
    else if (argument === "--runtime-dist" && value) { runtimeDist = resolve(value); index += 1; }
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  if (!session) throw new Error("--session requires an offline Session JSONL snapshot");
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 30)
    throw new Error("--iterations must be an integer from 1 to 30");
  return { session, iterations, backend, profile, runtimeDist };
}

function collector() {
  const records: IncidentFields[] = [];
  const diagnostics: IncidentDiagnostics = {
    directory: null,
    hostId: "benchmark",
    record(fields) { records.push(fields); return { incidentId: "PC-BENCH001" }; },
    async flush() {},
    async close() {},
  };
  return { records, diagnostics };
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0;
}

function summary(values: number[]) {
  return {
    minimumMs: Math.round(Math.min(...values)),
    medianMs: Math.round(percentile(values, 0.5)),
    p95Ms: Math.round(percentile(values, 0.95)),
    maximumMs: Math.round(Math.max(...values)),
  };
}

const options = parseArgs(process.argv.slice(2));
const sourceLink = await lstat(options.session);
if (!sourceLink.isFile() || sourceLink.isSymbolicLink()) throw new Error("Session snapshot must be a regular non-symlink file");
const canonicalSource = await realpath(options.session);
const sourceStat = await stat(canonicalSource);
if (!sourceStat.isFile()) throw new Error("Session snapshot is not a regular file");
const sessionBytes = await readFile(canonicalSource);
const directEntry = resolvePiEntry();
if (!directEntry) throw new Error("Global Pi RPC entry is unavailable");
const bundledPlan = await resolvePiRuntimeLaunch({ runtimeDist: options.runtimeDist });
const backends = options.backend === "both" ? ["direct", "bundle"] as const : [options.backend] as const;
const startupProbe = resolve("resources", "runtime", "pi-chat-startup-probe.mjs");
const results: Record<string, unknown> = {};

for (const backend of backends) {
  if (backend === "bundle" && (!bundledPlan.bundled || !bundledPlan.piEntry))
    throw new Error(`Bundled Runtime is unavailable: ${bundledPlan.diagnostic}`);
  const samples: Array<{ totalMs: number; phases: Record<string, number> }> = [];
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const root = await mkdtemp(join(tmpdir(), `pi-chat-startup-${backend}-`));
    const sessionCopy = join(root, "session.jsonl");
    await writeFile(sessionCopy, sessionBytes, { flag: "wx" });
    const observed = collector();
    const client = new PiRpcClient({
      cwd: root,
      piEntry: backend === "bundle" ? bundledPlan.piEntry! : directEntry,
      childEnvironment: backend === "bundle" ? bundledPlan.childEnvironment : {},
      startupProbe,
      diagnostics: observed.diagnostics,
      runtimeKind: "secondary",
      args: options.profile === "core"
        ? ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"]
        : [],
    });
    const startedAt = performance.now();
    let stopped = false;
    try {
      await client.start(["--session", sessionCopy]);
      const totalMs = performance.now() - startedAt;
      const phases = Object.fromEntries(
        observed.records
          .filter((record) => record.startupPhase && typeof record.durationMs === "number")
          .map((record) => [record.startupPhase as string, Math.round(record.durationMs as number)]),
      );
      await client.stop();
      stopped = true;
      samples.push({ totalMs: Math.round(totalMs), phases });
    } finally {
      if (!stopped) await client.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
  results[backend] = {
    summary: summary(samples.map((sample) => sample.totalMs)),
    samples,
  };
}

console.log(JSON.stringify({
  schemaVersion: 1,
  benchmark: "pi-rpc-persisted-session-startup",
  coldDefinition: "fresh-process",
  warning: "Fresh processes do not guarantee an OS- or Defender-cold file cache.",
  nodeVersion: process.versions.node,
  platform: process.platform,
  architecture: process.arch,
  profile: options.profile,
  iterations: options.iterations,
  sessionBytes: sessionBytes.length,
  sourceLabel: "offline-snapshot",
  results,
}, null, 2));
