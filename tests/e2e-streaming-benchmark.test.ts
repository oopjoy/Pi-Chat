import assert from "node:assert/strict";
import test from "node:test";
import {
  parseStreamingBenchmarkConfig,
  streamingBenchmarkDelay,
  streamingBenchmarkMetadata,
  streamingBenchmarkSnapshots,
} from "../scripts/e2e-streaming-benchmark.mjs";

const base = {
  schemaVersion: 1,
  contentKind: "plain",
  updateCount: 8,
  sourceIntervalMs: 5,
  startAt: null,
  finalMarker: "PI_CHAT_STREAM_FINAL_DETERMINISTIC",
};

test("stream benchmark missed deadlines catch up without another timer turn", () => {
  assert.equal(streamingBenchmarkDelay(1_000, 999), 1);
  assert.equal(streamingBenchmarkDelay(1_000, 1_000), null);
  assert.equal(streamingBenchmarkDelay(1_000, 1_025), null);
});

test("stream benchmark builds monotonic cumulative snapshots with one final marker", () => {
  const snapshots = streamingBenchmarkSnapshots(base);
  assert.equal(snapshots.length, 8);
  for (let index = 1; index < snapshots.length; index += 1)
    assert.ok(snapshots[index].startsWith(snapshots[index - 1]));
  assert.equal(snapshots.slice(0, -1).some((value) => value.includes(base.finalMarker)), false);
  assert.equal(snapshots.at(-1)?.includes(base.finalMarker), true);
  const metadata = streamingBenchmarkMetadata(base);
  assert.equal(metadata.updateCount, 8);
  assert.match(metadata.contentSha256, /^[a-f0-9]{64}$/);
  assert.match(metadata.sequenceSha256, /^[a-f0-9]{64}$/);
  assert.match(metadata.finalMarkerSha256, /^[a-f0-9]{64}$/);
});

test("Markdown and KaTeX stream snapshots retain complete deterministic syntax", () => {
  const snapshots = streamingBenchmarkSnapshots({
    ...base,
    contentKind: "markdown-katex",
    updateCount: 10,
  });
  assert.match(snapshots[4], /```ts\nconst unfinished5 = $/, "the fifth cumulative snapshot ends inside a code fence");
  assert.match(snapshots[5], /const unfinished5 = \n```/, "the following snapshot closes that code fence");
  assert.match(snapshots[8], /\$\$\n\\sum_\{k=1\}\^\{9\} k$/, "the ninth cumulative snapshot ends inside display math");
  assert.match(snapshots[9], /\\sum_\{k=1\}\^\{9\} k\n\$\$/, "the following snapshot closes that display math");
  const final = snapshots.at(-1) || "";
  assert.match(final, /## Deterministic section 10/);
  assert.match(final, /\$a_10 = 10\^2 \+ 1\$/);
  assert.match(final, /\\sum_\{k=1\}\^\{10\}/);
  assert.match(final, /```ts/);
  assert.match(final, /const unfinished5 = \n```/, "the fixture closes a code fence that was intentionally incomplete in an earlier snapshot");
  assert.match(final, /\\sum_\{k=1\}\^\{9\} k\n\$\$/, "the fixture closes display math that was intentionally incomplete in an earlier snapshot");
  assert.equal(final.includes("PI_CHAT_STREAM_FINAL"), true);
});

test("stream benchmark configuration rejects ambiguous or unsafe values", () => {
  assert.throws(() => parseStreamingBenchmarkConfig({ ...base, schemaVersion: 2 }));
  assert.throws(() => parseStreamingBenchmarkConfig({ ...base, contentKind: "html" }));
  assert.throws(() => parseStreamingBenchmarkConfig({ ...base, updateCount: 3 }));
  assert.throws(() => parseStreamingBenchmarkConfig({ ...base, sourceIntervalMs: 0 }));
  assert.throws(() => parseStreamingBenchmarkConfig({ ...base, startAt: -1 }));
  assert.throws(() => parseStreamingBenchmarkConfig({ ...base, finalMarker: "private content" }));
});
