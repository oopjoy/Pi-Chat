import assert from "node:assert/strict";
import test from "node:test";
import {
  DRAFT_FAILURE_SCOPE,
  localFailureNotice,
  type LocalFailureNotice,
} from "../src/shared/assistant-error";
import {
  LOCAL_FAILURE_LIMIT_PER_SESSION,
  LOCAL_FAILURE_LIMIT_TOTAL,
  forgetLocalFailuresForSession,
  recordLocalFailureEntry,
} from "../src/web/lib/local-failures";

function record(
  current: readonly LocalFailureNotice[],
  sessionId: string,
  text: string,
  at: number,
  incidentId?: string,
): LocalFailureNotice[] {
  return recordLocalFailureEntry(
    current,
    localFailureNotice(sessionId, text, incidentId, at),
  );
}

test("the same failure delivered twice is one entry", () => {
  const once = record([], "s", "fetch failed", 1_000);
  assert.equal(once.length, 1);
  // An SSE redelivery arrives milliseconds later, not in the same millisecond.
  const twice = record(once, "s", "fetch failed", 1_004);
  assert.equal(twice.length, 1, "a redelivered frame is not a second failure");
  assert.equal(twice[0]!.id, once[0]!.id);
});

test("two distinct failures in the same millisecond are two entries", () => {
  // Regression: a time-keyed id silently dropped the second reason.
  let entries = record([], "s", "fetch failed", 2_000);
  entries = record(entries, "s", "socket hang up", 2_000);
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0]!.id, entries[1]!.id, "React keys stay unique");
  const details = entries.map((entry) => entry.detail);
  assert.ok(details.some((detail) => /fetch failed/.test(detail)));
  assert.ok(details.some((detail) => /socket hang up/.test(detail)));
});

test("the same wording minutes later is a new failure, not a duplicate", () => {
  let entries = record([], "s", "fetch failed", 3_000);
  entries = record(entries, "s", "fetch failed", 30_000);
  assert.equal(entries.length, 2);
});

test("neither cap can be exceeded and the newest entry always survives", () => {
  let entries: LocalFailureNotice[] = [];
  for (let index = 0; index < 12; index += 1)
    entries = record(entries, "s", `failure ${index}`, 10_000 + index * 10_000);
  assert.equal(entries.length, LOCAL_FAILURE_LIMIT_PER_SESSION);
  assert.equal(entries.at(-1)!.detail.includes("failure 11"), true, "newest kept");
  assert.equal(entries[0]!.detail.includes("failure 9"), true, "oldest of that Session evicted");

  // Ten Sessions x three entries each is more than the app-wide cap, so the global
  // bound has to evict whole Sessions' worth of the oldest entries.
  let many: LocalFailureNotice[] = [];
  for (let index = 0; index < 3; index += 1)
    for (let session = 0; session < 10; session += 1)
      many = record(many, `s${session}`, `failure ${session}-${index}`, 20_000 + index * 10_000 + session);
  assert.equal(many.length, LOCAL_FAILURE_LIMIT_TOTAL);
  assert.equal(
    many.every((entry) => many.filter((other) => other.sessionId === entry.sessionId).length <= LOCAL_FAILURE_LIMIT_PER_SESSION),
    true,
    "the per-Session bound holds under the global bound as well",
  );
  assert.equal(many.at(-1)!.sessionId, "s9", "the newest entries are the ones retained");
  assert.equal(
    many.every((entry) => entry.at >= 30_000),
    true,
    "the globally oldest insertions were evicted first",
  );
});

test("a Session's entries can be forgotten without touching another Session", () => {
  let entries = record([], "a", "fetch failed", 1_000);
  entries = record(entries, "b", "fetch failed", 1_000);
  const forgotten = forgetLocalFailuresForSession(entries, "a");
  assert.deepEqual(forgotten.map((entry) => entry.sessionId), ["b"]);
  assert.equal(forgetLocalFailuresForSession(entries, "missing"), entries, "no needless state churn");
});

test("a draft failure is scoped apart from a Session failure", () => {
  const draft = record([], DRAFT_FAILURE_SCOPE, "OpenAI API error (503): auth_unavailable", 1_000);
  assert.equal(draft[0]!.sessionId, DRAFT_FAILURE_SCOPE);
  const withSession = record(draft, "session", "OpenAI API error (503): auth_unavailable", 1_000);
  assert.equal(withSession.length, 2, "the same wording in another scope is its own entry");
});
