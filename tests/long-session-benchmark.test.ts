import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionIndex, readSessionSnapshot } from "../src/server/session-index";
import { generateFixture, validateFixture } from "../benchmarks/long-session-fixtures.mts";
import { browserScenarioContract, runLongSessionBenchmark, summarizeTimings } from "../benchmarks/run-long-session-bench.mts";

test("long-session generator emits deterministic scenario shape and valid JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-benchmark-shape-"));
  try {
    const firstPath = join(root, "first.jsonl");
    const secondPath = join(root, "second.jsonl");
    const first = await generateFixture({ scenario: "tool-process-heavy", outputPath: firstPath, targetBytes: 300_000 });
    const second = await generateFixture({ scenario: "tool-process-heavy", outputPath: secondPath, targetBytes: 300_000 });
    assert.equal(first.userTurns, 1);
    assert.equal(first.toolCalls, 240);
    assert.equal(first.messages, second.messages);
    assert.equal(first.bytes, second.bytes);
    assert.equal(first.sha256Seed, second.sha256Seed);
    assert.equal(await readFile(firstPath, "utf8"), await readFile(secondPath, "utf8"));
    assert.deepEqual(await validateFixture(firstPath), { records: first.records, sessionHeaders: 1, invalidLines: 0 });
    const snapshot = await readSessionSnapshot(firstPath);
    assert.equal(snapshot.messages.filter((message) => message.role === "user").length, 1);
    assert.equal(snapshot.messages.filter((message) => message.role === "toolResult").length, 240);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("long-session generator honors requested approximate size without a committed fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-benchmark-size-"));
  try {
    const targetBytes = 1_100_000;
    const fixture = await generateFixture({ scenario: "ordinary-10mib", outputPath: join(root, "sized.jsonl"), targetBytes });
    assert.ok(fixture.bytes >= targetBytes);
    assert.ok(fixture.bytes <= targetBytes + 270_000, `fixture exceeded bounded padding chunk: ${fixture.bytes}`);
    const validation = await validateFixture(fixture.path);
    assert.equal(validation.invalidLines, 0);
    const index = new SessionIndex(root, join(root, "index.json"));
    const sessions = await index.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, fixture.sessionId);
    assert.equal(sessions[0].turnCount, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("1000-turn and content scenarios expose their requested benchmark dimensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-benchmark-dimensions-"));
  try {
    const thousand = await generateFixture({ scenario: "thousand-user-turns", outputPath: join(root, "turns.jsonl") });
    const markdown = await generateFixture({ scenario: "markdown-katex-heavy", outputPath: join(root, "markdown.jsonl"), targetBytes: 500_000 });
    const images = await generateFixture({ scenario: "image-metadata-heavy", outputPath: join(root, "images.jsonl"), targetBytes: 500_000 });
    const imageContent = await generateFixture({ scenario: "image-content-heavy", outputPath: join(root, "image-content.jsonl"), targetBytes: 500_000 });
    assert.equal(thousand.userTurns, 1_000);
    assert.equal(markdown.userTurns, 80);
    assert.ok(images.imageBlocks >= 900);
    assert.equal(imageContent.imageBlocks, 24);
    const markdownText = await readFile(markdown.path, "utf8");
    assert.match(markdownText, /\\sum_/);
    assert.match(markdownText, /```ts/);
    const imageText = await readFile(images.path, "utf8");
    assert.match(imageText, /"type":"image"/);
    assert.match(imageText, /"width":640/);
    const imageContentText = await readFile(imageContent.path, "utf8");
    assert.ok(imageContentText.includes("QUJD".repeat(1_000)), "encoded image-content fixture retains substantial deterministic data");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("benchmark output schema is machine-readable and descriptive-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-benchmark-output-"));
  try {
    const outputPath = join(root, "result.json");
    const result = await runLongSessionBenchmark({ scenarios: ["thousand-user-turns"], iterations: 1, outputPath });
    const stored = JSON.parse(await readFile(outputPath, "utf8")) as typeof result;
    assert.equal(stored.schemaVersion, 1);
    assert.equal(stored.benchmark, "pi-chat-long-session");
    assert.equal(stored.baselinePolicy, "descriptive-only");
    assert.equal(stored.measurements.length, 1);
    assert.equal(stored.measurements[0].scenario, "thousand-user-turns");
    assert.equal(stored.measurements[0].userTurns, 1_000);
    assert.equal(stored.measurements[0].windowRecent10.visibleTurns, 10);
    assert.equal(stored.measurements[0].windowEarlier50.visibleTurns, 50);
    assert.ok(stored.measurements[0].parseSnapshot.medianMs >= 0);
    assert.equal(stored.browserScenarioContract.thresholds, null);
    assert.deepEqual(stored.browserScenarioContract.scenarios.map((scenario) => scenario.id), ["cold-first-pane", "hot-switch", "load-earlier"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timing summary and browser metric contract remain stable", () => {
  assert.deepEqual(summarizeTimings([3, 1, 2, 4]), { iterations: 4, minMs: 1, medianMs: 2.5, meanMs: 2.5, maxMs: 4 });
  assert.equal(browserScenarioContract.metricDefinitions.domNodeCount.includes("getElementsByTagName"), true);
  assert.equal(browserScenarioContract.metricDefinitions.longTasks.includes("PerformanceObserver"), true);
  assert.equal(browserScenarioContract.metricDefinitions.heapBytes.includes("usedJSHeapSize"), true);
});
