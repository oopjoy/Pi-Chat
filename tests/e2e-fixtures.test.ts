import assert from "node:assert/strict";
import test from "node:test";
import { BoundedStreamCapture, combinedFixtureError } from "../e2e/fixtures.ts";

test("bounded server capture copies a truncated tail out of a giant input allocation", () => {
  const capture = new BoundedStreamCapture();
  const giant = Buffer.alloc(1024 * 1024, 0x61);
  capture.append(giant);
  const snapshot = capture.snapshot();
  assert.equal(snapshot.length, 256 * 1024);
  assert.notEqual(snapshot.buffer, giant.buffer);
  assert.deepEqual(capture.metadata(), { totalBytes: giant.length, retainedBytes: snapshot.length, truncated: true });
});

test("fixture error aggregation preserves the primary error and every secondary error", () => {
  const primary = new Error("use failed");
  const shutdown = new Error("shutdown failed");
  const attachment = new Error("attachment failed");
  const result = combinedFixtureError(primary, [shutdown, attachment], "fixture failed");
  assert.ok(result instanceof AggregateError);
  assert.equal(result.cause, primary);
  assert.deepEqual(result.errors, [primary, shutdown, attachment]);
});

test("a lone primary fixture error is rethrown unchanged", () => {
  const primary = new Error("setup failed");
  assert.equal(combinedFixtureError(primary, [], "fixture failed"), primary);
});
