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
