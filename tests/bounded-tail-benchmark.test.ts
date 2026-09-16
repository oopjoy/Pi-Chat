import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateBoundedTailFixture, RECENT_FIXTURE_TURNS } from "../benchmarks/bounded-tail-fixture.mts";
import { parseTailBenchmarkArgs, runBoundedTailBenchmark, tailBenchmarkParameters, tailReadEvidence } from "../benchmarks/run-bounded-tail-bench.mts";
import { validateFixture } from "../benchmarks/long-session-fixtures.mts";
import { readSessionSnapshot } from "../src/server/session-index";
import { MAX_SESSION_SNAPSHOT_BYTES } from "../src/server/session-projection";

 test("tail benchmark validates bounded integer inputs before fixture creation", async () => {
  assert.deepEqual(tailBenchmarkParameters({}), { minimumBytes: 256 * 1024 * 1024, iterations: 3 });
  assert.equal(tailBenchmarkParameters({ minimumBytes: 512 * 1024 * 1024 }).minimumBytes, 512 * 1024 * 1024);
  for (const minimumBytes of [0, -1, NaN, Infinity, MAX_SESSION_SNAPSHOT_BYTES, 512 * 1024 * 1024 + 1, MAX_SESSION_SNAPSHOT_BYTES + 0.5]) {
    await assert.rejects(runBoundedTailBenchmark({ minimumBytes }), /Bounded-tail minimumBytes/);
  }
  for (const iterations of [0, -1, NaN, Infinity, 1.5, 101]) {
    assert.throws(() => tailBenchmarkParameters({ iterations }), /iterations must/);
  }
  assert.deepEqual(parseTailBenchmarkArgs(["--minimum-bytes", "268435456", "--iterations", "1", "--output", "result.json"]),
    { minimumBytes: 268435456, iterations: 1, outputPath: "result.json" });
  for (const argv of [["--output"], ["--iterations", "--output"], ["--unknown", "1"], ["--iterations", "NaN"]]) {
    assert.throws(() => parseTailBenchmarkArgs(argv));
  }
});

test("tail fixture is deterministic with valid ancestry and small recent turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-tail-fixture-test-"));
  try {
    const path = join(root, "fixture.jsonl");
    const fixture = await generateBoundedTailFixture(path, 300_000);
    const other = await generateBoundedTailFixture(join(root, "other.jsonl"), 300_000);
    assert.deepEqual(fixture, other);
    const content = await readFile(path);
    assert.equal(fixture.bytes, content.length);
    assert.equal(fixture.contentSha256, createHash("sha256").update(content).digest("hex"));
    assert.ok(fixture.bytes >= fixture.minimumBytes);
    assert.equal(fixture.recentTurns, RECENT_FIXTURE_TURNS);
    assert.deepEqual(await validateFixture(path), { records: fixture.records, sessionHeaders: 1,
      invalidLines: 0, duplicateIds: [], unresolvedParentIds: [], cyclicParentChains: [] });
    const snapshot = await readSessionSnapshot(path);
    assert.equal(snapshot.messages.length, fixture.messages);
    assert.ok(snapshot.messages.slice(-RECENT_FIXTURE_TURNS * 2).every((message) =>
      typeof message.content === "string" && message.content.length < 100));
    assert.throws(() => tailReadEvidence(snapshot, 10, fixture), /bounded-tail production contract/);
    assert.throws(() => tailReadEvidence(null, 10, fixture), /missing/);
    const tail = { ...snapshot, messages: snapshot.messages.slice(-20), sourceMessagesTruncated: true,
      usageComplete: false, sourceMessageTotal: fixture.messages, sourceTurnTotal: fixture.userTurns,
      sourceBytes: fixture.bytes, bytesRead: 256 * 1024 };
    assert.equal(tailReadEvidence(tail, 10, fixture).returnedTurns, 10);
    assert.throws(() => tailReadEvidence({ ...tail, messages: snapshot.messages.slice(0, 20) }, 10, fixture), /bounded-tail production contract/);
    assert.throws(() => tailReadEvidence({ ...tail, usageComplete: true }, 10, fixture), /bounded-tail production contract/);
    assert.throws(() => tailReadEvidence({ ...tail, bytesRead: NaN } as typeof tail, 10, fixture), /bounded-tail production contract/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tail runner exercises production oversized reads and concurrent access without full snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-tail-output-test-"));
  try {
    const outputPath = join(root, "result.json");
    const result = await runBoundedTailBenchmark({ minimumBytes: MAX_SESSION_SNAPSHOT_BYTES + 1, iterations: 1, outputPath });
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), result);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.benchmark, "pi-chat-bounded-tail");
    assert.equal(result.baselinePolicy, "descriptive-only");
    assert.ok(result.fixture.bytes > MAX_SESSION_SNAPSHOT_BYTES);
    assert.ok(result.environment.runnerPeakRssBytes > 0);
    assert.equal(result.measurements.recent10.returnedTurns, 10);
    assert.equal(result.measurements.recent50.returnedTurns, 50);
    assert.equal(result.measurements.concurrentRecent10.readsPerBatch.length, 4);
    for (const evidence of [result.measurements.recent10, result.measurements.recent50, ...result.measurements.concurrentRecent10.readsPerBatch]) {
      assert.equal(evidence.bytesRead, 256 * 1024, "fixed small suffix needs only one production tail chunk");
      assert.equal(evidence.sourceMessagesTruncated, true);
      assert.equal(evidence.usageComplete, false);
    }
    assert.equal(JSON.stringify(result).includes(root), false);
    assert.equal(JSON.stringify(result).includes("pi-chat-bounded-tail-"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
