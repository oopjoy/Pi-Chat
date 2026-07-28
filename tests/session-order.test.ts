import assert from "node:assert/strict";
import test from "node:test";
import { compareSessionsByLastUserPrompt, sessionPromptRecency } from "../src/shared/session-order";
import type { SessionSummary } from "../src/shared/types";

function session(id: string, updatedAt: number, lastUserPromptAt?: number): SessionSummary {
  return { id, sessionId: id, name: id, preview: id, cwd: "C:/work", updatedAt, ...(lastUserPromptAt === undefined ? {} : { lastUserPromptAt }), messageCount: 1, active: false };
}

test("sidebar recency follows the last user instruction instead of streamed file activity", () => {
  const promptedEarlierButStreamingLater = session("a", 9_000, 1_000);
  const promptedLaterButQuiet = session("b", 2_000, 2_000);
  assert.deepEqual([promptedEarlierButStreamingLater, promptedLaterButQuiet].sort(compareSessionsByLastUserPrompt).map((item) => item.id), ["b", "a"]);
  assert.equal(sessionPromptRecency(promptedEarlierButStreamingLater), 1_000);
});

test("legacy histories fall back to file activity and equal prompt times remain stable", () => {
  const legacy = session("b", 3_000);
  const equalFirst = session("a", 2_000, 5_000);
  const equalSecond = session("c", 9_000, 5_000);
  assert.equal(sessionPromptRecency(legacy), 3_000);
  assert.deepEqual([equalSecond, equalFirst].sort(compareSessionsByLastUserPrompt).map((item) => item.id), ["a", "c"]);
});
