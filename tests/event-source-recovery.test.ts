import assert from "node:assert/strict";
import test from "node:test";
import { isIgnoredEventSourceFrame, isOversizedEventSourceFrame, shouldReconnectEventSource } from "../src/web/hooks/use-pi-event-source";

test("standalone PWA resume replaces a potentially half-open EventSource", () => {
  const now = 100_000;
  assert.equal(shouldReconnectEventSource("visibilitychange", "visible", now - 1_000, now), true);
  assert.equal(shouldReconnectEventSource("pageshow", "visible", now - 1_000, now), true);
  assert.equal(shouldReconnectEventSource("visibilitychange", "hidden", now - 100_000, now), false);
});

test("foreground watchdog reconnects only after a missed heartbeat window", () => {
  const now = 100_000;
  assert.equal(shouldReconnectEventSource(undefined, "visible", now - 44_999, now), false);
  assert.equal(shouldReconnectEventSource(undefined, "visible", now - 45_000, now), true);
  assert.equal(shouldReconnectEventSource("focus", "visible", now - 60_000, now), true);
  assert.equal(shouldReconnectEventSource("online", "hidden", now - 60_000, now), false);
});

test("cumulative tool snapshots are rejected before JSON parsing and huge unknown frames trigger recovery", () => {
  const toolUpdate = JSON.stringify({ type: "tool_execution_update", partialResult: { content: "x".repeat(100_000) } });
  assert.equal(isIgnoredEventSourceFrame(toolUpdate), true);
  assert.equal(isIgnoredEventSourceFrame(JSON.stringify({ type: "message_update", message: { role: "assistant", content: "mentions tool_execution_update" } })), false);
  assert.equal(isOversizedEventSourceFrame("x".repeat(1_000_001)), true);
  assert.equal(isOversizedEventSourceFrame("x".repeat(1_000_000)), false);
});
