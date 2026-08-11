import type { SessionSummary } from "../../shared/types";

function workspaceKey(cwd: string): string {
  return cwd.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLocaleLowerCase();
}

/** Most recently used, distinct Session working directories for New drafts. */
export function recentSessionWorkspaces(
  sessions: Array<Pick<SessionSummary, "cwd" | "updatedAt" | "lastUserPromptAt">>,
  limit = 12,
): string[] {
  const maximum = Math.max(0, Math.floor(limit));
  if (!maximum) return [];
  const seen = new Set<string>();
  const paths: string[] = [];
  const recent = [...sessions].sort((left, right) =>
    (right.lastUserPromptAt ?? right.updatedAt) -
      (left.lastUserPromptAt ?? left.updatedAt) ||
    right.updatedAt - left.updatedAt,
  );
  for (const session of recent) {
    const cwd = session.cwd.trim();
    const key = workspaceKey(cwd);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    paths.push(cwd);
    if (paths.length >= maximum) break;
  }
  return paths;
}
