import type { LiveMessageSchedulePolicy } from "../hooks/use-live-message";

export type BrowserStreamingBenchmarkPolicy =
  | "timeout-50"
  | "animation-frame";

declare const __PI_CHAT_BENCHMARK_BROWSER_STREAMING_POLICY__:
  | BrowserStreamingBenchmarkPolicy
  | undefined;

export function parseBrowserStreamingBenchmarkPolicy(
  value: unknown,
): LiveMessageSchedulePolicy {
  if (value === undefined || value === "timeout-50") return 50;
  if (value === "animation-frame") return { mode: "animation-frame" };
  throw new Error("Unsupported benchmark browser streaming policy");
}

export const liveMessageSchedulePolicy =
  parseBrowserStreamingBenchmarkPolicy(
    typeof __PI_CHAT_BENCHMARK_BROWSER_STREAMING_POLICY__ === "undefined"
      ? undefined
      : __PI_CHAT_BENCHMARK_BROWSER_STREAMING_POLICY__,
  );
