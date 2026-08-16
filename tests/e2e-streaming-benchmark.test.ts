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
    updateCount: 4,
  });
  const final = snapshots.at(-1) || "";
  assert.match(final, /## Deterministic section 4/);
  assert.match(final, /\$a_4 = 4\^2 \+ 1\$/);
  assert.match(final, /\\sum_\{k=1\}\^\{4\}/);
  assert.match(final, /```ts/);
});

test("stream benchmark configuration rejects ambiguous or unsafe values", () => {
  assert.throws(() => parseStreamingBenchmarkConfig({ ...base, schemaVersion: 2 }));
  assert.throws(() => parseStreamingBenchmarkConfig({ ...base, contentKind: "html" }));
  assert.throws(() => parseStreamingBenchmarkConfig({ ...base, updateCount: 3 }));
  assert.throws(() => parseStreamingBenchmarkConfig({ ...base, sourceIntervalMs: 0 }));
  assert.throws(() => parseStreamingBenchmarkConfig({ ...base, startAt: -1 }));
  assert.throws(() => parseStreamingBenchmarkConfig({ ...base, finalMarker: "private content" }));
});
