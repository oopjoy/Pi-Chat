import assert from "node:assert/strict";
import test from "node:test";
import { acceptPrimaryReadiness } from "../../src/web/application/runtime-readiness";
import type { PrimaryRuntimeReadiness } from "../../src/shared/types";

function readiness(patch: Partial<PrimaryRuntimeReadiness> = {}): PrimaryRuntimeReadiness {
  return {
    status: "starting",
    generation: 1,
    ...patch,
  };
}

test("Primary readiness rejects older generations", () => {
  const current = readiness({ status: "ready", thinkingLevel: "high" });
  assert.deepEqual(
    acceptPrimaryReadiness(current, readiness({ generation: 0, status: "failed", thinkingLevel: "old" })),
    current,
  );
});

test("Primary readiness accepts a newer generation atomically", () => {
  const incoming = readiness({ generation: 2, status: "ready", thinkingLevel: "high" });
  assert.deepEqual(acceptPrimaryReadiness(readiness({ status: "failed" }), incoming), incoming);
});

test("equal-generation starting cannot erase a terminal readiness", () => {
  const current = readiness({ status: "failed", error: "provider unavailable" });
  assert.deepEqual(
    acceptPrimaryReadiness(current, readiness({ status: "starting" })),
    current,
  );
});

test("equal-generation observations refine without erasing omitted facts", () => {
  const current = readiness({ status: "ready", thinkingLevel: "high" });
  assert.deepEqual(
    acceptPrimaryReadiness(current, readiness({ status: "ready", sessionId: "session-a" })),
    readiness({ status: "ready", thinkingLevel: "high", sessionId: "session-a" }),
  );
});
