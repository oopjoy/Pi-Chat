import type { ProfilerOnRenderCallback } from "react";

declare const __PI_CHAT_BENCHMARK_REACT_PROFILER__: boolean | undefined;

export type ReactRenderBenchmarkCommit = {
  id: string;
  phase: "mount" | "update" | "nested-update";
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
};

type ReactRenderBenchmarkWindow = Window & {
  __piChatReactRenderBenchmark?: {
    commits: ReactRenderBenchmarkCommit[];
  };
};

/**
 * React Profiler is compiled into the isolated maintenance benchmark build only.
 * The normal Web build passes false as a compile-time constant, so production
 * rendering keeps no profiler callbacks or browser-visible benchmark sink.
 */
export const reactRenderBenchmarkEnabled = typeof __PI_CHAT_BENCHMARK_REACT_PROFILER__ !== "undefined"
  && __PI_CHAT_BENCHMARK_REACT_PROFILER__;

export const recordReactRenderBenchmarkCommit: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  if (typeof window === "undefined") return;
  const benchmarkWindow = window as ReactRenderBenchmarkWindow;
  const sink = benchmarkWindow.__piChatReactRenderBenchmark ??= { commits: [] };
  sink.commits.push({
    id,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
  });
};
