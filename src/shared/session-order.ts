import type { SessionSummary } from "./types.js";

/**
 * Sidebar recency is owned by the last user instruction, not by assistant
 * streaming/tool writes. `updatedAt` remains the file activity timestamp used
 * for display and as a legacy fallback when an old JSONL lacks message times.
 */
export function sessionPromptRecency(session: Pick<SessionSummary, "lastUserPromptAt" | "updatedAt">): number {
  return typeof session.lastUserPromptAt === "number" && Number.isFinite(session.lastUserPromptAt)
    ? session.lastUserPromptAt
    : session.updatedAt;
}

/** Stable tie-break prevents two equal-timestamp sessions from visually swapping. */
export function compareSessionsByLastUserPrompt(left: SessionSummary, right: SessionSummary): number {
  const recency = sessionPromptRecency(right) - sessionPromptRecency(left);
  return recency || left.id.localeCompare(right.id);
}
