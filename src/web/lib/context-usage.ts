export type ContextUsageTone = "normal" | "warning" | "critical" | "unavailable";

/**
 * Context occupancy risk is deliberately based on Pi's authoritative session
 * stats. Pi does not expose a separate "needs compaction" flag; while it is
 * actively compacting, always surface the critical state regardless of percent.
 */
export function contextUsageTone(percent: number | null | undefined, isCompacting = false): ContextUsageTone {
  if (isCompacting) return "critical";
  if (typeof percent !== "number" || !Number.isFinite(percent)) return "unavailable";
  if (percent >= 90) return "critical";
  if (percent >= 60) return "warning";
  return "normal";
}

/** Prompt-side cache hits: cacheRead / (input + cacheRead + cacheWrite). */
export function cacheHitRatePercent(tokens: {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
} | undefined): number | null {
  if (!tokens) return null;
  const input = Number.isFinite(tokens.input) ? Math.max(0, tokens.input as number) : 0;
  const cacheRead = Number.isFinite(tokens.cacheRead) ? Math.max(0, tokens.cacheRead as number) : 0;
  const cacheWrite = Number.isFinite(tokens.cacheWrite) ? Math.max(0, tokens.cacheWrite as number) : 0;
  const prompt = input + cacheRead + cacheWrite;
  if (prompt <= 0) return null;
  return Math.min(100, (cacheRead / prompt) * 100);
}
