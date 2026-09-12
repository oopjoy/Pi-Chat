import assert from "node:assert/strict";
import test from "node:test";
import { classifyNativeRetryEvent } from "../src/shared/retry-lifecycle";

test("classifies the documented auto-retry schedule without exposing provider error text", () => {
  assert.deepEqual(
    classifyNativeRetryEvent({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: "529 {provider error body}",
    }),
    { kind: "scheduled", attempt: 1, maxAttempts: 3, delayMs: 2000 },
  );
});

test("classifies successful retry completion separately from exhaustion", () => {
  assert.deepEqual(
    classifyNativeRetryEvent({ type: "auto_retry_end", success: true, attempt: 2 }),
    { kind: "completed", attempt: 2 },
  );
  assert.deepEqual(
    classifyNativeRetryEvent({
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "529 overloaded_error: Overloaded",
    }),
    { kind: "exhausted", attempt: 3 },
  );
});

test("does not guess that a false result without finalError exhausted retries", () => {
  assert.deepEqual(
    classifyNativeRetryEvent({ type: "auto_retry_end", success: false, attempt: 1 }),
    { kind: "inconclusive", attempt: 1 },
  );
});

test("rejects malformed retry envelopes", () => {
  assert.equal(classifyNativeRetryEvent({ type: "auto_retry_start", attempt: 0 }), undefined);
  assert.equal(classifyNativeRetryEvent({ type: "auto_retry_end", success: "false", attempt: 1 }), undefined);
  assert.equal(classifyNativeRetryEvent({ type: "auto_retry_end", success: false }), undefined);
  assert.equal(classifyNativeRetryEvent(null), undefined);
});
