import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  aggregateStreamingCadence,
  assertStreamingCadenceResultPrivacy,
  streamingCadenceMatrix,
  summarizeFrameGaps,
  type StreamingCadenceSample,
} from "../benchmarks/lib/streaming-cadence.mts";
import {
  readStreamingSourceTiming,
  streamingCadenceComparisonReady,
  streamingCadenceOrder,
  validateStreamingCadenceOutputPath,
} from "../benchmarks/run-streaming-cadence-bench.mts";

function sample(cell: ReturnType<typeof streamingCadenceMatrix>[number]): StreamingCadenceSample {
  return {
    iteration: 1,
    executionOrdinal: 1,
    cell,
    attestation: {
      browserPolicy: cell.browserPolicy,
      webEntrySha256: "d".repeat(64),
      serverIntervalMs: cell.serverIntervalMs,
    },
    source: {
      contentKind: cell.contentKind,
      updateCount: 60,
      sourceIntervalMs: 5,
      finalBytes: 4096,
      contentSha256: "a".repeat(64),
      sequenceSha256: "b".repeat(64),
      finalMarkerSha256: "c".repeat(64),
      emittedUpdates: 60,
      actualDurationMs: 1180,
      actualMeanIntervalMs: 20,
      actualP95IntervalMs: 21,
      actualMaxIntervalMs: 22,
      actualMaxLatenessMs: 4,
      startSkewMs: 2,
    },
    browser: {
      firstVisibleDomObservationMs: 10,
      firstVisibleDomObservationPaintOpportunityMs: 20,
      messageEndPaintOpportunityMs: 300,
      visibleDomObservationCount: 6,
      receivedUpdateFrames: 12,
      receivedUpdateBytes: 8192,
      visibleReceivedUpdateFrames: 6,
      allExpectedSessionsSettled: true,
      settledSessions: cell.concurrency,
      startSkewMs: 2,
      finalMarkerVisible: true,
      allSessionsReceivedUpdates: true,
      allSessionsReceivedMessageEnd: true,
      allSessionsReceivedFinalMarker: true,
      parseErrors: 0,
      offscreenTerminalCachesVerified: Math.max(0, cell.concurrency - 1),
      fontsReady: true,
      renderedStructure: cell.contentKind === "markdown-katex"
        ? { headings: 1, tables: 1, codeBlocks: 1, katexNodes: 2, katexErrors: 0 }
        : null,
      frameGaps: summarizeFrameGaps([16, 17, 40]),
      longTasks: { supported: true, count: 1, totalDurationMs: 55, maxDurationMs: 55 },
    },
    server: {
      summaryCount: cell.concurrency,
      snapshotsWritten: 12,
      snapshotsBackpressured: 0,
      snapshotsScheduled: 6,
      snapshotsReplaced: 48,
      snapshotsQueued: 0,
      snapshotsQueueReplaced: 0,
      snapshotsOversized: 0,
      snapshotsNoClients: 0,
      snapshotsWriteErrors: 0,
    },
  };
}

function validResult() {
  const samples = streamingCadenceMatrix().map(sample);
  const build = {
    schemaVersion: 1,
    packageVersion: "0.4.3",
    revision: "65a79fb",
    fingerprint: "e".repeat(64),
    builtAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    schemaVersion: 1,
    benchmark: "pi-chat-streaming-cadence",
    generatedAt: "2026-01-01T00:00:00.000Z",
    benchmarkHarnessSha256: "f".repeat(64),
    baselinePolicy: "descriptive-only",
    comparisonReady: false,
    thresholds: null,
    environment: {
      node: "v24.0.0",
      platform: "win32",
      arch: "x64",
      chromiumVersion: "151.0.0.0",
      headless: true,
      viewport: { width: 1_360, height: 900 },
    },
    isolation: {
      privateOsTempStaging: true,
      freshBenchmarkServerPerSample: true,
      freshBrowserContextPerSample: true,
      generatedTemporarySessionsOnly: true,
      avoidsLiveServiceEndpoint: true,
      browserProcessReusedAcrossSamples: true,
      executionOrder: "policy-latin-square-v1",
      cleanupConfirmed: true,
      fourSessionShape: "one-visible-pane-plus-three-offscreen-cache-streams",
    },
    variants: {
      baseline: { build, browserPolicy: "timeout-50", entrySha256: "a".repeat(64) },
      frameAligned: { build, browserPolicy: "animation-frame", entrySha256: "b".repeat(64) },
    },
    metrics: {
      firstVisibleDomObservationMs: "safe metric",
      firstVisibleDomObservationPaintOpportunityMs: "safe metric",
      messageEndPaintOpportunityMs: "safe metric",
      browserStartSkewMs: "safe metric",
      sourceTiming: "safe metric",
      frameGaps: "safe metric",
      longTasks: "safe metric",
    },
    iterations: 1,
    samples,
    summaries: aggregateStreamingCadence(samples),
  };
}

test("streaming cadence matrix has exactly the requested twelve unique cells", () => {
  const matrix = streamingCadenceMatrix();
  assert.equal(matrix.length, 12);
  assert.equal(new Set(matrix.map((cell) => `${cell.key}/${cell.concurrency}/${cell.contentKind}`)).size, 12);
  assert.deepEqual(matrix.filter((cell) => cell.key === "A").map((cell) => [cell.serverIntervalMs, cell.browserPolicy]), Array(4).fill([50, "timeout-50"]));
  assert.equal(matrix.filter((cell) => cell.concurrency === 4).every((cell) => cell.concurrencyShape === "one-visible-pane-plus-three-offscreen-cache-streams"), true);
});

test("streaming cadence comparison readiness requires complete counterbalance cycles", () => {
  assert.equal(streamingCadenceComparisonReady(1), false);
  assert.equal(streamingCadenceComparisonReady(3), true);
  assert.equal(streamingCadenceComparisonReady(4), false);
  assert.equal(streamingCadenceComparisonReady(6), true);
});

test("streaming cadence counterbalances policy order deterministically", () => {
  assert.equal(streamingCadenceOrder(1)[0].key, "A");
  assert.equal(streamingCadenceOrder(2)[0].key, "B");
  assert.equal(streamingCadenceOrder(3)[0].key, "C");
  assert.equal(new Set(streamingCadenceOrder(2).map((cell) => `${cell.key}/${cell.concurrency}/${cell.contentKind}`)).size, 12);
});

test("streaming cadence aggregates every cell descriptively", () => {
  const samples = streamingCadenceMatrix().map(sample);
  const summaries = aggregateStreamingCadence(samples);
  assert.equal(summaries.length, 12);
  assert.equal(summaries[0].firstVisibleDomObservationMs.median, 10);
  assert.equal(summaries[0].maxFrameGapMs.median, 40);
});

test("streaming cadence rejects deadline lateness from an offscreen source", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-stream-source-test-"));
  try {
    await writeFile(join(root, "source-stream-1.json"), JSON.stringify({ sourceTimes: [1_000, 1_020, 1_040, 1_060] }), "utf8");
    await writeFile(join(root, "source-stream-2.json"), JSON.stringify({ sourceTimes: [1_300, 1_320, 1_340, 1_360] }), "utf8");
    await assert.rejects(() => readStreamingSourceTiming(root, ["stream-1.jsonl", "stream-2.jsonl"], {
      schemaVersion: 1,
      contentKind: "plain",
      updateCount: 4,
      sourceIntervalMs: 20,
      startAt: 1_000,
      finalMarker: "PI_CHAT_STREAM_FINAL_TEST_MARKER",
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming cadence rejects interval drift from an offscreen source", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-stream-source-test-"));
  try {
    await writeFile(join(root, "source-stream-1.json"), JSON.stringify({ sourceTimes: [1_000, 1_020, 1_040, 1_060] }), "utf8");
    await writeFile(join(root, "source-stream-2.json"), JSON.stringify({ sourceTimes: [1_000, 1_000, 1_000, 1_060] }), "utf8");
    await assert.rejects(() => readStreamingSourceTiming(root, ["stream-1.jsonl", "stream-2.jsonl"], {
      schemaVersion: 1,
      contentKind: "plain",
      updateCount: 4,
      sourceIntervalMs: 20,
      startAt: 1_000,
      finalMarker: "PI_CHAT_STREAM_FINAL_TEST_MARKER",
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming cadence output cannot target live dist", async (context) => {
  await assert.rejects(() => validateStreamingCadenceOutputPath(resolve("dist", "result.json")));
  if (process.platform === "win32")
    await assert.rejects(() => validateStreamingCadenceOutputPath(resolve("DIST", "build-identity.json")));
  const root = await mkdtemp(join(tmpdir(), "pi-chat-stream-output-test-"));
  const linked = join(root, "linked-dist");
  try {
    try {
      await symlink(resolve("dist"), linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("filesystem link creation unavailable");
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => validateStreamingCadenceOutputPath(join(linked, "result.json")),
      /filesystem link/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming cadence output cannot target the active staged dist through chained links", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-stream-active-output-test-"));
  const previousDist = process.env.PI_CHAT_DIST_DIR;
  const stagedDist = join(root, "staged-dist");
  const inner = join(root, "inner");
  const outer = join(root, "outer");
  try {
    process.env.PI_CHAT_DIST_DIR = stagedDist;
    await assert.rejects(
      () => validateStreamingCadenceOutputPath(join(stagedDist, "result.json")),
      /live dist tree/,
    );
    try {
      await symlink(stagedDist, inner, process.platform === "win32" ? "junction" : "dir");
      await symlink(inner, outer, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("filesystem link creation unavailable");
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => validateStreamingCadenceOutputPath(join(outer, "result.json")),
      /filesystem link/,
    );
  } finally {
    if (previousDist === undefined) delete process.env.PI_CHAT_DIST_DIR;
    else process.env.PI_CHAT_DIST_DIR = previousDist;
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming cadence privacy validator enforces a closed schema", () => {
  const valid = validResult();
  assert.doesNotThrow(() => assertStreamingCadenceResultPrivacy(valid));
  for (const key of ["secret", "apiKey", "client", "page", "token", "path"]) {
    assert.throws(() => assertStreamingCadenceResultPrivacy({ ...valid, [key]: "private-value" }));
    assert.throws(() => assertStreamingCadenceResultPrivacy({
      ...valid,
      environment: { ...valid.environment, [key]: "private-value" },
    }));
  }
  assert.throws(() => assertStreamingCadenceResultPrivacy({
    ...valid,
    metrics: { ...valid.metrics, sourceTiming: "C:/Users/private/file" },
  }));
  assert.throws(() => assertStreamingCadenceResultPrivacy({
    ...valid,
    environment: { ...valid.environment, chromiumVersion: "http://127.0.0.1:1234" },
  }));
});
