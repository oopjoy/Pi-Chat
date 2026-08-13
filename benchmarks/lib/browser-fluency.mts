export interface DescriptiveSummary {
  iterations: number;
  min: number;
  median: number;
  mean: number;
  max: number;
}

export interface BrowserFluencySample {
  iteration: number;
  scenario: "cold-first-pane" | "hot-switch" | "load-earlier";
  fixture: string;
  source: "cold-jsonl" | "browser-cache" | "history-window";
  actionToSettledFrameMs: number;
  paneCommitMs: number | null;
  domNodeCount: number;
  longTasks: {
    supported: boolean;
    count: number | null;
    totalDurationMs: number | null;
    maxDurationMs: number | null;
  };
  heap: {
    supported: boolean;
    collectionApi: "performance.memory" | null;
    beforeBytes: number | null;
    afterBytes: number | null;
    deltaBytes: number | null;
  };
  anchorErrorCssPx: number | null;
  anchorAbsoluteErrorCssPx: number | null;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function summarizeValues(values: number[]): DescriptiveSummary {
  if (!values.length) throw new Error("At least one descriptive sample is required");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    iterations: sorted.length,
    min: round(sorted[0]),
    median: round(median),
    mean: round(sorted.reduce((total, value) => total + value, 0) / sorted.length),
    max: round(sorted.at(-1)!),
  };
}

export function publicFixtureMetadata<T extends { fixtureName: string; bytes: number; records: number; messages: number; userTurns: number; toolCalls: number; imageBlocks: number; contentSha256: string }>(fixture: T) {
  return {
    fixtureName: fixture.fixtureName,
    bytes: fixture.bytes,
    records: fixture.records,
    messages: fixture.messages,
    userTurns: fixture.userTurns,
    toolCalls: fixture.toolCalls,
    imageBlocks: fixture.imageBlocks,
    contentSha256: fixture.contentSha256,
  };
}

export function aggregateBrowserFluency(samples: BrowserFluencySample[]) {
  return ["cold-first-pane", "hot-switch", "load-earlier"].map((scenario) => {
    const selected = samples.filter((sample) => sample.scenario === scenario);
    if (!selected.length) throw new Error(`Missing browser fluency samples for ${scenario}`);
    const paneCommit = selected.flatMap((sample) => sample.paneCommitMs === null ? [] : [sample.paneCommitMs]);
    const longTaskTotal = selected.flatMap((sample) => sample.longTasks.totalDurationMs === null ? [] : [sample.longTasks.totalDurationMs]);
    const anchorAbsoluteError = selected.flatMap((sample) => sample.anchorAbsoluteErrorCssPx === null ? [] : [sample.anchorAbsoluteErrorCssPx]);
    return {
      scenario,
      iterations: selected.length,
      actionToSettledFrameMs: summarizeValues(selected.map((sample) => sample.actionToSettledFrameMs)),
      paneCommitMs: paneCommit.length ? summarizeValues(paneCommit) : null,
      domNodeCount: summarizeValues(selected.map((sample) => sample.domNodeCount)),
      longTaskTotalDurationMs: longTaskTotal.length ? summarizeValues(longTaskTotal) : null,
      anchorAbsoluteErrorCssPx: anchorAbsoluteError.length ? summarizeValues(anchorAbsoluteError) : null,
    };
  });
}
