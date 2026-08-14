import { lstat, readdir } from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
  toNamespacedPath,
} from "node:path";

const DEFAULT_MIN_AGE_HOURS = 24;
const RESTART_OWNED = /^\.pi-chat-dist-(?:staging|previous|failed)-(\d+)(?:-|$)/;
const CLEANUP_QUARANTINE = /^\.pi-chat-cleanup-quarantine-/;

function literalPath(path) {
  return process.platform === "win32" ? toNamespacedPath(path) : path;
}

function sameOrWithin(base, target) {
  const fromBase = relative(base, target);
  return (
    fromBase === "" ||
    (fromBase !== ".." &&
      !fromBase.startsWith(`..${sep}`) &&
      !isAbsolute(fromBase))
  );
}

async function directoryBytes(path) {
  let total = 0;
  const entries = await readdir(literalPath(path));
  for (const name of entries) {
    const child = resolve(path, name);
    const metadata = await lstat(literalPath(child)).catch(() => null);
    if (!metadata || metadata.isSymbolicLink()) continue;
    if (metadata.isDirectory()) total += await directoryBytes(child);
    else if (metadata.isFile()) total += metadata.size;
  }
  return total;
}

export function classifyWorkspaceArtifact(name, directory) {
  if (directory) {
    if (!name.startsWith(".pi-chat-")) return null;
    if (RESTART_OWNED.test(name) || CLEANUP_QUARANTINE.test(name)) return null;
    return "legacy-stage";
  }
  return process.platform === "win32" && name.toLowerCase() === "nul"
    ? "windows-nul"
    : null;
}

export async function scanWorkspaceArtifacts(
  root,
  {
    now = Date.now(),
    minAgeHours = DEFAULT_MIN_AGE_HOURS,
    protectedPaths = [],
  } = {},
) {
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0)
    throw new Error("minAgeHours must be a non-negative number");
  const absoluteRoot = resolve(root);
  const protectedTargets = protectedPaths.map((path) => resolve(path));
  const minimumAgeMs = minAgeHours * 60 * 60 * 1000;
  const candidates = [];
  const entries = await readdir(literalPath(absoluteRoot), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const kind = classifyWorkspaceArtifact(entry.name, entry.isDirectory());
    if (!kind || entry.isSymbolicLink()) continue;
    const path = resolve(absoluteRoot, entry.name);
    if (protectedTargets.some((target) => sameOrWithin(path, target))) continue;
    const metadata = await lstat(literalPath(path));
    if (metadata.isSymbolicLink()) continue;
    if (kind === "legacy-stage" && !metadata.isDirectory()) continue;
    if (kind === "windows-nul" && !metadata.isFile()) continue;
    const ageMs = Math.max(0, now - metadata.mtimeMs);
    if (ageMs < minimumAgeMs) continue;
    candidates.push({
      name: entry.name,
      path,
      kind,
      ageMs,
      mtimeMs: metadata.mtimeMs,
      bytes: metadata.isDirectory() ? await directoryBytes(path) : metadata.size,
    });
  }
  return candidates.sort((left, right) => left.name.localeCompare(right.name));
}

function parseArguments(argv) {
  let minAgeHours = DEFAULT_MIN_AGE_HOURS;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--min-age-hours") {
      minAgeHours = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (argument.startsWith("--min-age-hours=")) {
      minAgeHours = Number(argument.slice("--min-age-hours=".length));
      continue;
    }
    throw new Error(`Unsupported argument: ${argument}`);
  }
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0)
    throw new Error("--min-age-hours must be a non-negative number");
  return { minAgeHours };
}

function formatMegabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const projectRoot = resolve(import.meta.dirname, "..");
  const { minAgeHours } = parseArguments(process.argv.slice(2));
  const protectedPaths = process.env.PI_CHAT_DIST_DIR
    ? [resolve(projectRoot, process.env.PI_CHAT_DIST_DIR)]
    : [];
  const candidates = await scanWorkspaceArtifacts(projectRoot, {
    minAgeHours,
    protectedPaths,
  });
  const totalBytes = candidates.reduce(
    (sum, candidate) => sum + candidate.bytes,
    0,
  );
  console.log(
    `[Pi Chat] ${candidates.length} stale workspace artifact(s), ${formatMegabytes(totalBytes)}, minimum age ${minAgeHours}h`,
  );
  for (const candidate of candidates) {
    console.log(
      `- ${candidate.name} (${candidate.kind}, ${formatMegabytes(candidate.bytes)})`,
    );
  }
  console.log(
    "[Pi Chat] Report only: legacy stages have no durable lease. Verify owners before deleting exact paths.",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(`[Pi Chat] Workspace artifact scan failed: ${error.message}`);
    process.exitCode = 1;
  });
}
