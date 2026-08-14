import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  aggregateBrowserFluency,
  publicFixtureMetadata,
  summarizeValues,
  type BrowserFluencySample,
} from "../benchmarks/lib/browser-fluency.mts";
import {
  benchmarkChildEnvironment,
  BROWSER_FLUENCY_FIXTURE_SCENARIO,
  finalizeBrowserBenchmarkRoot,
  validateStagingDist,
} from "../benchmarks/run-browser-fluency-bench.mts";

function sample(scenario: BrowserFluencySample["scenario"], value: number): BrowserFluencySample {
  return {
    iteration: 1,
    scenario,
    fixture: `${scenario}.jsonl`,
    source: scenario === "cold-first-pane"
      ? "cold-jsonl"
      : scenario === "hot-switch"
        ? "browser-cache"
        : "history-window",
    actionToSettledFrameMs: value,
    paneCommitMs: scenario === "load-earlier" ? null : value / 2,
    domNodeCount: 500 + value,
    longTasks: {
      supported: true,
      count: 1,
      totalDurationMs: value / 3,
      maxDurationMs: value / 3,
    },
    heap: {
      supported: true,
      collectionApi: "performance.memory",
      beforeBytes: 1_000,
      afterBytes: 1_500,
      deltaBytes: 500,
    },
    anchorErrorCssPx: scenario === "load-earlier" ? -0.25 : null,
    anchorAbsoluteErrorCssPx: scenario === "load-earlier" ? 0.25 : null,
  };
}

test("browser fluency uses the natural many-turn fixture instead of size padding", () => {
  assert.equal(BROWSER_FLUENCY_FIXTURE_SCENARIO, "thousand-user-turns");
});

test("browser fluency summaries stay descriptive and scenario-specific", () => {
  assert.deepEqual(summarizeValues([4, 1, 3, 2]), {
    iterations: 4,
    min: 1,
    median: 2.5,
    mean: 2.5,
    max: 4,
  });
  const summaries = aggregateBrowserFluency([
    sample("cold-first-pane", 30),
    sample("hot-switch", 20),
    sample("load-earlier", 10),
  ]);
  assert.deepEqual(summaries.map((summary) => summary.scenario), [
    "cold-first-pane",
    "hot-switch",
    "load-earlier",
  ]);
  assert.equal(summaries[0].paneCommitMs?.median, 15);
  assert.equal(summaries[2].paneCommitMs, null);
  assert.equal(summaries[2].anchorAbsoluteErrorCssPx?.median, 0.25);
});

test("browser fluency fixture metadata never exposes temporary paths", () => {
  assert.deepEqual(publicFixtureMetadata({
    fixtureName: "ordinary.jsonl",
    bytes: 100,
    records: 4,
    messages: 2,
    userTurns: 1,
    toolCalls: 0,
    imageBlocks: 0,
    contentSha256: "a".repeat(64),
    outputPath: "C:/private/temp/ordinary.jsonl",
  }), {
    fixtureName: "ordinary.jsonl",
    bytes: 100,
    records: 4,
    messages: 2,
    userTurns: 1,
    toolCalls: 0,
    imageBlocks: 0,
    contentSha256: "a".repeat(64),
  });
});

test("browser benchmark child environment forces staging and scrubs inherited roots", () => {
  const environment = benchmarkChildEnvironment({
    stagingDist: "C:/stage/dist",
    fixtureDirectory: "C:/stage/fixtures",
    manifestPath: "C:/stage/manifest.json",
    stateDirectory: "C:/stage/state",
  }, {
    PI_CHAT_DIST_DIR: "C:/live/dist",
    PI_CHAT_RUNTIME_DIST: "C:/live/dist",
    PI_CODING_AGENT_SESSION_DIR: "C:/user/sessions",
    PI_CHAT_E2E_FIXTURE_DIR: "C:/inherited/fixtures",
    PI_CHAT_E2E_MANIFEST_PATH: "C:/inherited/manifest.json",
  });
  assert.equal(environment.PI_CHAT_DIST_DIR, undefined);
  assert.equal(environment.PI_CHAT_RUNTIME_DIST, undefined);
  assert.equal(environment.PI_CODING_AGENT_SESSION_DIR, undefined);
  assert.equal(environment.PI_CHAT_E2E_DIST, "C:/stage/dist");
  assert.equal(environment.PI_CHAT_E2E_SERVER_DIST, "C:/stage/dist");
  assert.equal(environment.PI_CHAT_E2E_IMPORT_FIXTURES, undefined);
  assert.equal(environment.PI_CHAT_E2E_FIXTURE_DIR, undefined);
  assert.equal(environment.PI_CHAT_E2E_MANIFEST_PATH, undefined);
  assert.equal(environment.LOCALAPPDATA, join("C:/stage/state", "local-app-data"));
});

test("browser benchmark retains its root when browser teardown is unconfirmed", async () => {
  const closeError = new Error("browser close failed");
  let removed = false;
  const cleanupErrors = await finalizeBrowserBenchmarkRoot({
    root: "C:/Temp/pi-chat-browser-fluency-retained",
    browser: { close: async () => { throw closeError; } },
    completed: true,
    removeRoot: async () => { removed = true; },
  });
  assert.equal(removed, false);
  assert.equal(cleanupErrors[0], closeError);
  assert.match(String(cleanupErrors[1]), /root retained after failure/);
});

test("browser benchmark refuses repository live dist before artifact checks", async () => {
  await assert.rejects(
    validateStagingDist(resolve("dist")),
    /refuses the repository live dist/,
  );
  const missing = await mkdtemp(join(tmpdir(), "pi-chat-missing-browser-stage-"));
  try {
    await assert.rejects(
      validateStagingDist(missing),
      /missing required artifact/,
    );
  } finally {
    await rm(missing, { recursive: true, force: true });
  }
});
