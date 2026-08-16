import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const STREAM_BENCHMARK_CONTENT_KINDS = ["plain", "markdown-katex"];

export function parseStreamingBenchmarkConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Streaming benchmark config must be an object");
  if (value.schemaVersion !== 1)
    throw new Error("Streaming benchmark config schemaVersion must be 1");
  if (!STREAM_BENCHMARK_CONTENT_KINDS.includes(value.contentKind))
    throw new Error("Streaming benchmark contentKind is invalid");
  if (!Number.isInteger(value.updateCount) || value.updateCount < 4 || value.updateCount > 500)
    throw new Error("Streaming benchmark updateCount must be an integer from 4 to 500");
  if (!Number.isInteger(value.sourceIntervalMs) || value.sourceIntervalMs < 1 || value.sourceIntervalMs > 100)
    throw new Error("Streaming benchmark sourceIntervalMs must be an integer from 1 to 100");
  if (value.startAt !== null && (!Number.isSafeInteger(value.startAt) || value.startAt < 0))
    throw new Error("Streaming benchmark startAt must be null or a non-negative safe integer");
  if (typeof value.finalMarker !== "string" || !/^PI_CHAT_STREAM_FINAL_[A-Z0-9_-]{8,64}$/.test(value.finalMarker))
    throw new Error("Streaming benchmark finalMarker is invalid");
  return {
    schemaVersion: 1,
    contentKind: value.contentKind,
    updateCount: value.updateCount,
    sourceIntervalMs: value.sourceIntervalMs,
    startAt: value.startAt,
    finalMarker: value.finalMarker,
  };
}

export async function readStreamingBenchmarkConfig(path) {
  if (!path) return null;
  return parseStreamingBenchmarkConfig(JSON.parse(await readFile(path, "utf8")));
}

function plainChunk(index) {
  return `Snapshot ${String(index + 1).padStart(3, "0")}: deterministic alpha beta gamma delta epsilon. `;
}

function markdownKatexChunk(index) {
  const n = index + 1;
  return [
    `\n\n## Deterministic section ${n}`,
    "",
    `- item **${n}** with _streaming_ Markdown`,
    `- inline math $a_${n} = ${n}^2 + 1$`,
    "",
    "| term | value |",
    "| --- | ---: |",
    `| $n$ | ${n} |`,
    "",
    "$$",
    `\\sum_{k=1}^{${n}} k = \\frac{${n}(${n}+1)}{2}`,
    "$$",
    "",
    "```ts",
    `const value${n} = ${n} * (${n} + 1) / 2;`,
    "```",
  ].join("\n");
}

export function streamingBenchmarkDelay(target, now) {
  if (!Number.isFinite(target) || !Number.isFinite(now))
    throw new Error("Streaming benchmark source deadline must be finite");
  const delay = target - now;
  return delay > 0 ? delay : null;
}

export function streamingBenchmarkSnapshots(input) {
  const config = parseStreamingBenchmarkConfig(input);
  let cumulative = "";
  const snapshots = [];
  for (let index = 0; index < config.updateCount; index += 1) {
    cumulative += config.contentKind === "plain"
      ? plainChunk(index)
      : markdownKatexChunk(index);
    if (index === config.updateCount - 1)
      cumulative += `\n\n${config.finalMarker}`;
    snapshots.push(cumulative);
  }
  return snapshots;
}

export function streamingBenchmarkMetadata(input) {
  const config = parseStreamingBenchmarkConfig(input);
  const snapshots = streamingBenchmarkSnapshots(config);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  return {
    contentKind: config.contentKind,
    updateCount: config.updateCount,
    sourceIntervalMs: config.sourceIntervalMs,
    finalBytes: Buffer.byteLength(snapshots.at(-1) || ""),
    contentSha256: hash(snapshots.at(-1) || ""),
    sequenceSha256: hash(snapshots.map((value) => Buffer.byteLength(value)).join(",")),
    finalMarkerSha256: hash(config.finalMarker),
  };
}
