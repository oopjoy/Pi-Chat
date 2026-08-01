import type { SessionSummary } from "../../shared/types";

/**
 * Sidebar rows are identified solely by the stable Session ID. A stale merged
 * snapshot may repeat an ID; preserve its first position and take the newest
 * fields so it cannot become a ghost row that navigates to a missing Session.
 */
export function uniqueSessionSummaries(
  sessions: SessionSummary[],
): SessionSummary[] {
  const indexById = new Map<string, number>();
  const unique: SessionSummary[] = [];
  for (const session of sessions) {
    const previous = indexById.get(session.id);
    if (previous === undefined) {
      indexById.set(session.id, unique.length);
      unique.push(session);
    } else {
      unique[previous] = { ...unique[previous], ...session };
    }
  }
  return unique;
}
