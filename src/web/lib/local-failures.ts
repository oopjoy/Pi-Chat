import type { LocalFailureNotice } from "../../shared/assistant-error";

/** Per-Session cap; the oldest entry of that Session is evicted first. */
export const LOCAL_FAILURE_LIMIT_PER_SESSION = 3;
/** App-wide cap so a long run of failures cannot grow the projection without limit. */
export const LOCAL_FAILURE_LIMIT_TOTAL = 20;
/** The same failure delivered twice inside this window is one entry. */
export const LOCAL_FAILURE_DUPLICATE_WINDOW_MS = 5_000;

/**
 * Bounded set of the Runtime failures kept in the conversation body.
 *
 * Three rules matter and are unit-tested here rather than inline in the App:
 * the same failure delivered twice is one entry; two distinct failures are never
 * collapsed, not even in the same millisecond; and neither cap can be exceeded.
 */
export function recordLocalFailureEntry(
  current: readonly LocalFailureNotice[],
  notice: LocalFailureNotice,
): LocalFailureNotice[] {
  // A resent/redelivered frame describing the same failure at the same time is
  // not a second failure. Text and category must both match: the same wording
  // seconds later is a genuine repeat, which the user needs to see.
  const duplicate = current.some((entry) =>
    entry.sessionId === notice.sessionId &&
    entry.kind === notice.kind &&
    entry.detail === notice.detail &&
    Math.abs(entry.at - notice.at) <= LOCAL_FAILURE_DUPLICATE_WINDOW_MS,
  );
  if (duplicate) return current as LocalFailureNotice[];

  const sameSession = current.filter((entry) => entry.sessionId === notice.sessionId);
  const evicted = sameSession.length >= LOCAL_FAILURE_LIMIT_PER_SESSION
    ? new Set([sameSession[0]!.id])
    : undefined;
  const kept = evicted ? current.filter((entry) => !evicted.has(entry.id)) : current;

  // Distinct failures can still share a content identity, so the id stays a
  // React key and is made unique instead of silently replacing an entry.
  const base = notice.id;
  let id = base;
  for (let ordinal = 2; kept.some((entry) => entry.id === id); ordinal += 1)
    id = `${base}#${ordinal}`;

  return [...kept, { ...notice, id }].slice(-LOCAL_FAILURE_LIMIT_TOTAL);
}

/** Drop every entry of one Session, for example when that conversation is deleted. */
export function forgetLocalFailuresForSession(
  current: readonly LocalFailureNotice[],
  sessionId: string,
): LocalFailureNotice[] {
  const kept = current.filter((entry) => entry.sessionId !== sessionId);
  return kept.length === current.length ? (current as LocalFailureNotice[]) : kept;
}
