import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { IncidentDiagnostics, IncidentFields } from "../src/server/incident-diagnostics";
import { PiRpcClient, resolvePiEntry } from "../src/server/rpc-client";

interface Options {
  session: string;
  iterations: number;
  profile: "core" | "installed-profile";
}

function parseArgs(argv: string[]): Options {
  let session = "";
  let iterations = 5;
  let profile: Options["profile"] = "core";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--session" && value) { session = resolve(value); index += 1; }
    else if (argument === "--iterations" && value) { iterations = Number(value); index += 1; }
    else if (argument === "--profile" && (value === "core" || value === "installed-profile")) { profile = value; index += 1; }
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  if (!session) throw new Error("--session requires an offline Session JSONL snapshot");
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 30)
    throw new Error("--iterations must be an integer from 1 to 30");
  return { session, iterations, profile };
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

function optionalSummary(values: number[]) {
  return values.length ? summary(values) : null;
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
const piPackage = JSON.parse(await readFile(resolve(dirname(directEntry), "..", "package.json"), "utf8")) as { version?: string };
const startupProbe = resolve("resources", "runtime", "pi-chat-startup-probe.mjs");
const rpcRegister = resolve("resources", "runtime", "pi-chat-rpc-register.mjs");
if (options.profile === "installed-profile")
  console.error("WARNING: installed-profile explicitly loads your real extensions/settings; use core for isolated, offline measurement.");
const samples: Array<{
  transportReadyMs: number;
  capabilityReadyMs: number;
  totalMs: number;
  phases: Record<string, number>;
  extensionImportMs: number[];
  extensionFactoryMs: number[];
}> = [];
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const root = await mkdtemp(join(tmpdir(), "pi-chat-startup-direct-"));
    const sessionCopy = join(root, "session.jsonl");
    for (const name of ["agent", "sessions", "appdata"]) await mkdir(join(root, name));
    await writeFile(sessionCopy, sessionBytes, { flag: "wx" });
    const observed = collector();
    const client = new PiRpcClient({
      cwd: root,
      piEntry: directEntry,
      childEnvironment: options.profile === "core" ? {
        HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "appdata"),
        PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
        PI_OFFLINE: "1", PI_SESSION_ID: undefined, PI_SESSION_FILE: undefined,
      } : {},
      startupProbe,
      rpcRegister,
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
      const transportReadyMs = performance.now() - startedAt;
      const compatibility = await client.probeCompatibility();
      if (!compatibility.compatible) throw new Error(`Pi RPC capability probe failed: ${compatibility.diagnostics.join("; ")}`);
      const capabilityReadyMs = performance.now() - startedAt;
      const startupRecords = observed.records.filter((record) => record.startupPhase);
      const phases = Object.fromEntries(
        startupRecords
          .filter((record) =>
            record.startupPhase !== "extension-import-end"
            && record.startupPhase !== "extension-factory-end"
            && typeof record.durationMs === "number",
          )
          .map((record) => [record.startupPhase as string, Math.round(record.durationMs as number)]),
      );
      const extensionImportMs = startupRecords
        .map((record) => record.extensionImportDurationMs)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        .map((value) => Math.round(value));
      const extensionFactoryMs = startupRecords
        .map((record) => record.extensionFactoryDurationMs)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        .map((value) => Math.round(value));
      await client.stop();
      stopped = true;
      samples.push({
        transportReadyMs: Math.round(transportReadyMs),
        capabilityReadyMs: Math.round(capabilityReadyMs),
        totalMs: Math.round(capabilityReadyMs),
        phases,
        extensionImportMs,
        extensionFactoryMs,
      });
    } finally {
      // Never delete a diagnostic tree while its child may still own files.
      if (!stopped) {
        try { await client.stop(); }
        catch (error) {
          console.error(`Startup probe retained after unconfirmed child exit: ${root}`);
          throw error;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }
const results = {
  direct: {
    summary: summary(samples.map((sample) => sample.totalMs)),
    transportReadySummary: summary(samples.map((sample) => sample.transportReadyMs)),
    capabilityReadySummary: summary(samples.map((sample) => sample.capabilityReadyMs)),
    extensionImportSummary: optionalSummary(samples.flatMap((sample) => sample.extensionImportMs)),
    extensionFactorySummary: optionalSummary(samples.flatMap((sample) => sample.extensionFactoryMs)),
    samples,
  },
};

console.log(JSON.stringify({
  schemaVersion: 1,
  benchmark: "pi-rpc-persisted-session-startup",
  coldDefinition: "fresh-process",
  warning: "Fresh processes do not guarantee an OS- or Defender-cold file cache.",
  nodeVersion: process.versions.node,
  piVersion: piPackage.version ?? "unknown",
  platform: process.platform,
  architecture: process.arch,
  profile: options.profile,
  adapter: "production-rpc-register",
  isolatedOfflineProfile: options.profile === "core",
  iterations: options.iterations,
  sessionBytes: sessionBytes.length,
  sourceLabel: "offline-snapshot",
  results,
}, null, 2));
