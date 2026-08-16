import { summarizeValues, type DescriptiveSummary } from "./browser-fluency.mjs";

export const STREAMING_CADENCE_POLICIES = [
  { key: "A", serverIntervalMs: 50, browserPolicy: "timeout-50", stage: "baseline" },
  { key: "B", serverIntervalMs: 33, browserPolicy: "animation-frame", stage: "frame" },
  { key: "C", serverIntervalMs: 25, browserPolicy: "animation-frame", stage: "frame" },
] as const;

export const STREAMING_CADENCE_CONCURRENCIES = [1, 4] as const;
export const STREAMING_CADENCE_CONTENT_KINDS = ["plain", "markdown-katex"] as const;

export type StreamingCadencePolicy = typeof STREAMING_CADENCE_POLICIES[number];
export type StreamingCadenceConcurrency = typeof STREAMING_CADENCE_CONCURRENCIES[number];
export type StreamingCadenceContentKind = typeof STREAMING_CADENCE_CONTENT_KINDS[number];

export interface StreamingCadenceCell extends StreamingCadencePolicy {
  concurrency: StreamingCadenceConcurrency;
  contentKind: StreamingCadenceContentKind;
  concurrencyShape: "one-visible-pane" | "one-visible-pane-plus-three-offscreen-cache-streams";
}

export interface StreamingCadenceSample {
  iteration: number;
  executionOrdinal: number;
  cell: StreamingCadenceCell;
  attestation: {
    browserPolicy: "timeout-50" | "animation-frame";
    webEntrySha256: string;
    serverIntervalMs: number;
  };
  source: {
    contentKind: "plain" | "markdown-katex";
    updateCount: number;
    sourceIntervalMs: number;
    finalBytes: number;
    contentSha256: string;
    sequenceSha256: string;
    finalMarkerSha256: string;
    emittedUpdates: number;
    actualDurationMs: number;
    actualMeanIntervalMs: number;
    actualP95IntervalMs: number;
    actualMaxIntervalMs: number;
    actualMaxLatenessMs: number;
    startSkewMs: number;
  };
  browser: {
    firstVisibleDomObservationMs: number;
    firstVisibleDomObservationPaintOpportunityMs: number;
    messageEndPaintOpportunityMs: number;
    visibleDomObservationCount: number;
    receivedUpdateFrames: number;
    receivedUpdateBytes: number;
    visibleReceivedUpdateFrames: number;
    allExpectedSessionsSettled: boolean;
    settledSessions: number;
    startSkewMs: number;
    finalMarkerVisible: boolean;
    allSessionsReceivedUpdates: boolean;
    allSessionsReceivedMessageEnd: boolean;
    allSessionsReceivedFinalMarker: boolean;
    parseErrors: number;
    offscreenTerminalCachesVerified: number;
    fontsReady: boolean;
    renderedStructure: null | {
      headings: number;
      tables: number;
      codeBlocks: number;
      katexNodes: number;
      katexErrors: number;
    };
    frameGaps: {
      count: number;
      p50Ms: number;
      p95Ms: number;
      p99Ms: number;
      maxMs: number;
      over25Ms: number;
      over50Ms: number;
    };
    longTasks: {
      supported: boolean;
      count: number | null;
      totalDurationMs: number | null;
      maxDurationMs: number | null;
    };
  };
  server: {
    summaryCount: number;
    snapshotsWritten: number;
    snapshotsBackpressured: number;
    snapshotsScheduled: number;
    snapshotsReplaced: number;
    snapshotsQueued: number;
    snapshotsQueueReplaced: number;
    snapshotsOversized: number;
    snapshotsNoClients: number;
    snapshotsWriteErrors: number;
  };
}

export function streamingCadenceMatrix(): StreamingCadenceCell[] {
  return STREAMING_CADENCE_POLICIES.flatMap((policy) =>
    STREAMING_CADENCE_CONCURRENCIES.flatMap((concurrency) =>
      STREAMING_CADENCE_CONTENT_KINDS.map((contentKind) => ({
        ...policy,
        concurrency,
        contentKind,
        concurrencyShape: concurrency === 1
          ? "one-visible-pane" as const
          : "one-visible-pane-plus-three-offscreen-cache-streams" as const,
      })),
    ),
  );
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Math.round(sorted[index] * 1_000) / 1_000;
}

export function summarizeFrameGaps(values: number[]) {
  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: percentile(values, 1),
    over25Ms: values.filter((value) => value > 25).length,
    over50Ms: values.filter((value) => value > 50).length,
  };
}

export function aggregateStreamingCadence(samples: StreamingCadenceSample[]) {
  return streamingCadenceMatrix().map((cell) => {
    const selected = samples.filter((sample) =>
      sample.cell.key === cell.key
      && sample.cell.concurrency === cell.concurrency
      && sample.cell.contentKind === cell.contentKind
    );
    if (!selected.length)
      throw new Error(`Missing streaming cadence samples for ${cell.key}/${cell.concurrency}/${cell.contentKind}`);
    const summary = (select: (sample: StreamingCadenceSample) => number): DescriptiveSummary =>
      summarizeValues(selected.map(select));
    return {
      cell,
      iterations: selected.length,
      firstVisibleDomObservationMs: summary((sample) => sample.browser.firstVisibleDomObservationMs),
      firstVisibleDomObservationPaintOpportunityMs: summary((sample) => sample.browser.firstVisibleDomObservationPaintOpportunityMs),
      messageEndPaintOpportunityMs: summary((sample) => sample.browser.messageEndPaintOpportunityMs),
      visibleDomObservationCount: summary((sample) => sample.browser.visibleDomObservationCount),
      receivedUpdateFrames: summary((sample) => sample.browser.receivedUpdateFrames),
      receivedUpdateBytes: summary((sample) => sample.browser.receivedUpdateBytes),
      browserStartSkewMs: summary((sample) => sample.browser.startSkewMs),
      sourceStartSkewMs: summary((sample) => sample.source.startSkewMs),
      actualSourceDurationMs: summary((sample) => sample.source.actualDurationMs),
      maxFrameGapMs: summary((sample) => sample.browser.frameGaps.maxMs),
      serverSnapshotsWritten: summary((sample) => sample.server.snapshotsWritten),
      serverSnapshotsReplaced: summary((sample) => sample.server.snapshotsReplaced),
    };
  });
}

function asRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Streaming cadence ${label} must be an object`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Streaming cadence ${label} contains unknown key: ${key}`);
  }
  for (const key of keys) {
    if (!(key in record)) throw new Error(`Streaming cadence ${label} is missing key: ${key}`);
  }
  return record;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Streaming cadence ${label} must be a finite number`);
  return value;
}

function exactString(value: unknown, expected: string | readonly string[], label: string): string {
  if (typeof value !== "string") throw new Error(`Streaming cadence ${label} must be a string`);
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(value)) throw new Error(`Streaming cadence ${label} is invalid`);
  return value;
}

function safeString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Streaming cadence ${label} must be a string`);
  if (/https?:\/\//i.test(value)) throw new Error("Streaming cadence result contains a URL");
  if (/(?:[A-Za-z]:[\\/]|\/(?:tmp|var|home|Users)\/)/.test(value))
    throw new Error("Streaming cadence result contains a filesystem path");
  if (/^[a-f0-9]{20}$/.test(value))
    throw new Error("Streaming cadence result contains a raw Session identifier");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new Error("Streaming cadence result contains a UUID authority value");
  return value;
}

function assertBuildIdentity(value: unknown, label: string): void {
  const record = asRecord(value, ["schemaVersion", "packageVersion", "revision", "fingerprint", "builtAt"], label);
  if (record.schemaVersion !== 1) throw new Error(`Streaming cadence ${label} schema is invalid`);
  if (typeof record.packageVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(record.packageVersion))
    throw new Error(`Streaming cadence ${label} package version is invalid`);
  if (typeof record.revision !== "string" || !/^(?:unknown|[a-f0-9]{7,64})$/.test(record.revision))
    throw new Error(`Streaming cadence ${label} revision is invalid`);
  if (typeof record.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.fingerprint))
    throw new Error(`Streaming cadence ${label} fingerprint is invalid`);
  if (typeof record.builtAt !== "string" || !Number.isFinite(Date.parse(record.builtAt)))
    throw new Error(`Streaming cadence ${label} timestamp is invalid`);
}

const CELL_KEYS = [
  "key", "serverIntervalMs", "browserPolicy", "stage", "concurrency",
  "concurrencyShape", "contentKind",
] as const;

function assertCell(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value, CELL_KEYS, label);
  exactString(record.key, ["A", "B", "C"], `${label}.key`);
  if (![25, 33, 50].includes(finiteNumber(record.serverIntervalMs, `${label}.serverIntervalMs`)))
    throw new Error(`Streaming cadence ${label} interval is invalid`);
  exactString(record.browserPolicy, ["timeout-50", "animation-frame"], `${label}.browserPolicy`);
  exactString(record.stage, ["baseline", "frame"], `${label}.stage`);
  if (![1, 4].includes(finiteNumber(record.concurrency, `${label}.concurrency`)))
    throw new Error(`Streaming cadence ${label} concurrency is invalid`);
  exactString(
    record.concurrencyShape,
    ["one-visible-pane", "one-visible-pane-plus-three-offscreen-cache-streams"],
    `${label}.concurrencyShape`,
  );
  exactString(record.contentKind, ["plain", "markdown-katex"], `${label}.contentKind`);
  return record;
}

const SUMMARY_VALUE_KEYS = ["iterations", "min", "median", "mean", "max"] as const;
function assertSummaryValue(value: unknown, label: string): void {
  const record = asRecord(value, SUMMARY_VALUE_KEYS, label);
  for (const key of SUMMARY_VALUE_KEYS) finiteNumber(record[key], `${label}.${key}`);
}

const SERVER_KEYS = [
  "summaryCount", "snapshotsWritten", "snapshotsBackpressured", "snapshotsScheduled",
  "snapshotsReplaced", "snapshotsQueued", "snapshotsQueueReplaced", "snapshotsOversized",
  "snapshotsNoClients", "snapshotsWriteErrors",
] as const;

const SOURCE_KEYS = [
  "contentKind", "updateCount", "sourceIntervalMs", "finalBytes", "contentSha256",
  "sequenceSha256", "finalMarkerSha256", "emittedUpdates", "actualDurationMs",
  "actualMeanIntervalMs", "actualP95IntervalMs", "actualMaxIntervalMs",
  "actualMaxLatenessMs", "startSkewMs",
] as const;

const BROWSER_KEYS = [
  "firstVisibleDomObservationMs", "firstVisibleDomObservationPaintOpportunityMs",
  "messageEndPaintOpportunityMs", "visibleDomObservationCount", "receivedUpdateFrames",
  "receivedUpdateBytes", "visibleReceivedUpdateFrames", "allExpectedSessionsSettled",
  "settledSessions", "startSkewMs", "finalMarkerVisible", "allSessionsReceivedUpdates",
  "allSessionsReceivedMessageEnd", "allSessionsReceivedFinalMarker", "parseErrors",
  "offscreenTerminalCachesVerified", "fontsReady", "renderedStructure", "frameGaps",
  "longTasks",
] as const;

function assertSample(value: unknown, label: string): void {
  const record = asRecord(value, ["iteration", "executionOrdinal", "cell", "attestation", "source", "browser", "server"], label);
  finiteNumber(record.iteration, `${label}.iteration`);
  finiteNumber(record.executionOrdinal, `${label}.executionOrdinal`);
  const cell = assertCell(record.cell, `${label}.cell`);
  const attestation = asRecord(record.attestation, ["browserPolicy", "webEntrySha256", "serverIntervalMs"], `${label}.attestation`);
  exactString(attestation.browserPolicy, ["timeout-50", "animation-frame"], `${label}.attestation.browserPolicy`);
  if (attestation.browserPolicy !== cell.browserPolicy)
    throw new Error(`Streaming cadence ${label} browser attestation mismatch`);
  if (typeof attestation.webEntrySha256 !== "string" || !/^[a-f0-9]{64}$/.test(attestation.webEntrySha256))
    throw new Error(`Streaming cadence ${label} Web entry hash is invalid`);
  if (finiteNumber(attestation.serverIntervalMs, `${label}.attestation.serverIntervalMs`) !== cell.serverIntervalMs)
    throw new Error(`Streaming cadence ${label} server attestation mismatch`);

  const source = asRecord(record.source, SOURCE_KEYS, `${label}.source`);
  exactString(source.contentKind, ["plain", "markdown-katex"], `${label}.source.contentKind`);
  if (source.contentKind !== cell.contentKind)
    throw new Error(`Streaming cadence ${label} source content kind mismatch`);
  for (const key of SOURCE_KEYS) {
    if (["contentKind", "contentSha256", "sequenceSha256", "finalMarkerSha256"].includes(key)) continue;
    finiteNumber(source[key], `${label}.source.${key}`);
  }
  for (const key of ["contentSha256", "sequenceSha256", "finalMarkerSha256"] as const) {
    if (typeof source[key] !== "string" || !/^[a-f0-9]{64}$/.test(source[key]))
      throw new Error(`Streaming cadence ${label} source hash is invalid`);
  }

  const browser = asRecord(record.browser, BROWSER_KEYS, `${label}.browser`);
  for (const key of [
    "firstVisibleDomObservationMs", "firstVisibleDomObservationPaintOpportunityMs",
    "messageEndPaintOpportunityMs", "visibleDomObservationCount", "receivedUpdateFrames",
    "receivedUpdateBytes", "visibleReceivedUpdateFrames", "settledSessions", "startSkewMs",
    "parseErrors", "offscreenTerminalCachesVerified",
  ] as const) finiteNumber(browser[key], `${label}.browser.${key}`);
  for (const key of [
    "allExpectedSessionsSettled", "finalMarkerVisible", "allSessionsReceivedUpdates",
    "allSessionsReceivedMessageEnd", "allSessionsReceivedFinalMarker", "fontsReady",
  ] as const) {
    if (typeof browser[key] !== "boolean")
      throw new Error(`Streaming cadence ${label}.browser.${key} must be boolean`);
  }
  if (browser.renderedStructure !== null) {
    const structure = asRecord(browser.renderedStructure, ["headings", "tables", "codeBlocks", "katexNodes", "katexErrors"], `${label}.browser.renderedStructure`);
    for (const key of Object.keys(structure)) finiteNumber(structure[key], `${label}.browser.renderedStructure.${key}`);
  }
  const gaps = asRecord(browser.frameGaps, ["count", "p50Ms", "p95Ms", "p99Ms", "maxMs", "over25Ms", "over50Ms"], `${label}.browser.frameGaps`);
  for (const key of Object.keys(gaps)) finiteNumber(gaps[key], `${label}.browser.frameGaps.${key}`);
  const tasks = asRecord(browser.longTasks, ["supported", "count", "totalDurationMs", "maxDurationMs"], `${label}.browser.longTasks`);
  if (typeof tasks.supported !== "boolean") throw new Error(`Streaming cadence ${label}.browser.longTasks.supported must be boolean`);
  for (const key of ["count", "totalDurationMs", "maxDurationMs"] as const) {
    if (tasks[key] !== null) finiteNumber(tasks[key], `${label}.browser.longTasks.${key}`);
  }

  const server = asRecord(record.server, SERVER_KEYS, `${label}.server`);
  for (const key of SERVER_KEYS) finiteNumber(server[key], `${label}.server.${key}`);
}

const AGGREGATE_KEYS = [
  "firstVisibleDomObservationMs", "firstVisibleDomObservationPaintOpportunityMs",
  "messageEndPaintOpportunityMs", "visibleDomObservationCount", "receivedUpdateFrames",
  "receivedUpdateBytes", "browserStartSkewMs", "sourceStartSkewMs",
  "actualSourceDurationMs", "maxFrameGapMs", "serverSnapshotsWritten",
  "serverSnapshotsReplaced",
] as const;

export function assertStreamingCadenceResultPrivacy(value: unknown): void {
  const result = asRecord(value, [
    "schemaVersion", "benchmark", "generatedAt", "benchmarkHarnessSha256", "baselinePolicy", "comparisonReady",
    "thresholds", "environment", "isolation", "variants", "metrics", "iterations",
    "samples", "summaries",
  ], "result");
  if (result.schemaVersion !== 1) throw new Error("Streaming cadence result schema is invalid");
  exactString(result.benchmark, "pi-chat-streaming-cadence", "result.benchmark");
  if (typeof result.generatedAt !== "string" || !Number.isFinite(Date.parse(result.generatedAt)))
    throw new Error("Streaming cadence result timestamp is invalid");
  if (typeof result.benchmarkHarnessSha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.benchmarkHarnessSha256))
    throw new Error("Streaming cadence benchmark harness hash is invalid");
  exactString(result.baselinePolicy, "descriptive-only", "result.baselinePolicy");
  if (typeof result.comparisonReady !== "boolean") throw new Error("Streaming cadence comparisonReady must be boolean");
  if (result.thresholds !== null) throw new Error("Streaming cadence thresholds must remain null");
  finiteNumber(result.iterations, "result.iterations");

  const environment = asRecord(result.environment, ["node", "platform", "arch", "chromiumVersion", "headless", "viewport"], "environment");
  for (const key of ["node", "platform", "arch", "chromiumVersion"] as const)
    safeString(environment[key], `environment.${key}`);
  if (environment.headless !== true) throw new Error("Streaming cadence environment must be headless");
  const viewport = asRecord(environment.viewport, ["width", "height"], "environment.viewport");
  finiteNumber(viewport.width, "environment.viewport.width");
  finiteNumber(viewport.height, "environment.viewport.height");

  const isolation = asRecord(result.isolation, [
    "privateOsTempStaging", "freshBenchmarkServerPerSample", "freshBrowserContextPerSample",
    "generatedTemporarySessionsOnly", "avoidsLiveServiceEndpoint",
    "browserProcessReusedAcrossSamples", "executionOrder", "cleanupConfirmed",
    "fourSessionShape",
  ], "isolation");
  for (const key of [
    "privateOsTempStaging", "freshBenchmarkServerPerSample", "freshBrowserContextPerSample",
    "generatedTemporarySessionsOnly", "avoidsLiveServiceEndpoint",
    "browserProcessReusedAcrossSamples", "cleanupConfirmed",
  ] as const) {
    if (isolation[key] !== true) throw new Error(`Streaming cadence isolation.${key} must be true`);
  }
  exactString(isolation.executionOrder, "policy-latin-square-v1", "isolation.executionOrder");
  exactString(isolation.fourSessionShape, "one-visible-pane-plus-three-offscreen-cache-streams", "isolation.fourSessionShape");

  const variants = asRecord(result.variants, ["baseline", "frameAligned"], "variants");
  for (const [key, expected] of [["baseline", "timeout-50"], ["frameAligned", "animation-frame"]] as const) {
    const variant = asRecord(variants[key], ["build", "browserPolicy", "entrySha256"], `variants.${key}`);
    assertBuildIdentity(variant.build, `variants.${key}.build`);
    exactString(variant.browserPolicy, expected, `variants.${key}.browserPolicy`);
    if (typeof variant.entrySha256 !== "string" || !/^[a-f0-9]{64}$/.test(variant.entrySha256))
      throw new Error(`Streaming cadence variants.${key}.entrySha256 is invalid`);
  }

  const metrics = asRecord(result.metrics, [
    "firstVisibleDomObservationMs", "firstVisibleDomObservationPaintOpportunityMs",
    "messageEndPaintOpportunityMs", "browserStartSkewMs", "sourceTiming", "frameGaps",
    "longTasks",
  ], "metrics");
  for (const [key, description] of Object.entries(metrics)) safeString(description, `metrics.${key}`);

  if (!Array.isArray(result.samples)) throw new Error("Streaming cadence samples must be an array");
  result.samples.forEach((sample, index) => assertSample(sample, `samples[${index}]`));
  if (!Array.isArray(result.summaries)) throw new Error("Streaming cadence summaries must be an array");
  result.summaries.forEach((summary, index) => {
    const record = asRecord(summary, ["cell", "iterations", ...AGGREGATE_KEYS], `summaries[${index}]`);
    assertCell(record.cell, `summaries[${index}].cell`);
    finiteNumber(record.iterations, `summaries[${index}].iterations`);
    for (const key of AGGREGATE_KEYS) assertSummaryValue(record[key], `summaries[${index}].${key}`);
  });
}
