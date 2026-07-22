import type { SessionSummary } from "../../shared/types";

export function activeSessionIdsFromEvent(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export function applyActiveSessionIds(sessions: SessionSummary[], ids: string[]): SessionSummary[] {
  const active = new Set(ids);
  return sessions.map((session) => ({ ...session, writable: active.has(session.id) }));
}
