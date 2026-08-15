import assert from "node:assert/strict";
import test from "node:test";
import { BrowserStreamDiagnosticsAggregator } from "../../src/web/lib/stream-observability";

const A = "0123456789abcdefabcd";
const B = "fedcba9876543210abcd";

test("browser stream diagnostics aggregates exact counters and one paint", () => {
  const entries: Array<{ category: string; name: string; input: Record<string, unknown> }> = [];
  let now = 10;
  const diagnostics = new BrowserStreamDiagnosticsAggregator(
    (category, name, input) => entries.push({ category, name, input }),
    () => now,
  );
  const identity = { sessionId: A, runGeneration: 7 };
  diagnostics.receive(identity, true);
  diagnostics.receive(identity, true);
  diagnostics.receive(identity, false);
  diagnostics.scheduler("scheduled", identity);
  diagnostics.scheduler("replaced", identity);
  diagnostics.scheduler("committed", identity);
  diagnostics.scheduler("drained", identity);
  diagnostics.scheduler("cleared", identity);
  now = 34;
  assert.equal(diagnostics.paint(identity), true);
  assert.equal(diagnostics.paint(identity), false);
  diagnostics.terminal(identity);
  diagnostics.terminal(identity);

  assert.deepEqual(entries.map((entry) => `${entry.category}:${entry.name}`), [
    "render:first-assistant-paint-opportunity",
    "render:stream-summary",
  ]);
  assert.deepEqual(entries[0].input, {
    sessionId: A,
    runGeneration: 7,
    details: { paintDelayMs: 24, visible: true },
  });
  assert.deepEqual(entries[1].input, {
    sessionId: A,
    runGeneration: 7,
    details: {
      snapshotsReceived: 3,
      snapshotsAdmitted: 2,
      snapshotsOffscreen: 1,
      snapshotsScheduled: 1,
      snapshotsReplaced: 1,
      snapshotsCommitted: 1,
      snapshotsDrained: 1,
      snapshotsCleared: 1,
      terminal: true,
    },
  });
  assert.equal(diagnostics.size, 0);
  assert.equal(JSON.stringify(entries).includes("content"), false);
});

test("browser stream diagnostics is bounded and stale cleanup prevents paint", () => {
  const entries: unknown[] = [];
  const diagnostics = new BrowserStreamDiagnosticsAggregator(
    (...args) => entries.push(args),
    () => 0,
    2,
  );
  diagnostics.receive({ sessionId: A, runGeneration: 1 }, true);
  diagnostics.scheduler("committed", { sessionId: A, runGeneration: 1 });
  diagnostics.receive({ sessionId: A, runGeneration: 2 }, false);
  diagnostics.receive({ sessionId: B, runGeneration: 3 }, false);
  assert.equal(diagnostics.size, 2);
  assert.equal(diagnostics.paint({ sessionId: A, runGeneration: 1 }), false);
  diagnostics.deleteSession(A);
  assert.equal(diagnostics.paint({ sessionId: A, runGeneration: 2 }), false);
  diagnostics.clear();
  assert.equal(diagnostics.size, 0);
  assert.deepEqual(entries, []);
});


test("browser stream diagnostics retains a terminal run only until its pending paint", () => {
  const entries: Array<{ name: string }> = [];
  const diagnostics = new BrowserStreamDiagnosticsAggregator(
    (_category, name) => entries.push({ name }),
    () => 5,
  );
  const identity = { sessionId: A, runGeneration: 8 };
  diagnostics.receive(identity, true);
  diagnostics.scheduler("committed", identity);
  assert.equal(diagnostics.hasPaintCandidate(identity), true);
  diagnostics.terminal(identity);
  assert.equal(diagnostics.size, 1);
  assert.equal(diagnostics.paint(identity), true);
  assert.equal(diagnostics.size, 0);
  assert.deepEqual(entries.map((entry) => entry.name), [
    "stream-summary",
    "first-assistant-paint-opportunity",
  ]);
});


test("browser stream diagnostics does not guess a hidden selected-pane paint", () => {
  const entries: unknown[] = [];
  const diagnostics = new BrowserStreamDiagnosticsAggregator((...args) => entries.push(args));
  const identity = { sessionId: A, runGeneration: 10 };
  diagnostics.receive(identity, true, false);
  diagnostics.scheduler("committed", identity);
  assert.equal(diagnostics.hasPaintCandidate(identity), false);
  assert.equal(diagnostics.paint(identity), false);
  diagnostics.terminal(identity);
  assert.equal(entries.length, 1, "only the aggregate summary is emitted");
});

test("a navigation-only drain cannot become a restored-cache paint candidate", () => {
  const entries: unknown[] = [];
  const diagnostics = new BrowserStreamDiagnosticsAggregator((...args) => entries.push(args));
  const identity = { sessionId: A, runGeneration: 13 };
  diagnostics.receive(identity, true);
  diagnostics.scheduler("scheduled", identity);
  diagnostics.scheduler("drained", identity);
  assert.equal(diagnostics.hasPaintCandidate(identity), false);
  assert.equal(diagnostics.paint(identity), false);
  diagnostics.terminal(identity);
  assert.equal(entries.length, 1);
  assert.equal((entries[0] as unknown[])[1], "stream-summary");
});

test("a viewing terminal assistant explicitly enables one pending paint", () => {
  const entries: Array<{ name: string }> = [];
  const diagnostics = new BrowserStreamDiagnosticsAggregator(
    (_category, name) => entries.push({ name }),
    () => 15,
  );
  const identity = { sessionId: A, runGeneration: 14 };
  diagnostics.receive(identity, true);
  diagnostics.scheduler("scheduled", identity);
  diagnostics.scheduler("drained", identity);
  diagnostics.terminalAssistantCommitted(identity);
  assert.equal(diagnostics.hasPaintCandidate(identity), true);
  assert.equal(diagnostics.paint(identity), true);
  assert.deepEqual(entries.map((entry) => entry.name), [
    "first-assistant-paint-opportunity",
  ]);
});

test("browser stream checkpoint emits only new counter segments and preserves paint state", () => {
  const entries: Array<{ name: string; input: { details?: Record<string, unknown> } }> = [];
  let now = 4;
  const diagnostics = new BrowserStreamDiagnosticsAggregator(
    (_category, name, input) => entries.push({ name, input }),
    () => now,
  );
  const identity = { sessionId: A, runGeneration: 15 };
  diagnostics.receive(identity, true);
  diagnostics.scheduler("committed", identity);
  diagnostics.checkpoint();
  diagnostics.checkpoint();
  assert.equal(entries.length, 1, "a repeated checkpoint cannot duplicate cumulative counters");
  assert.equal(entries[0].input.details?.terminal, false);
  assert.equal(entries[0].input.details?.snapshotsReceived, 1);
  assert.equal(entries[0].input.details?.snapshotsCommitted, 1);
  assert.equal(diagnostics.hasPaintCandidate(identity), true);
  now = 9;
  assert.equal(diagnostics.paint(identity), true);
  diagnostics.receive(identity, true);
  diagnostics.terminal(identity);
  assert.equal(entries.length, 3);
  assert.equal(entries[2].input.details?.terminal, true);
  assert.equal(entries[2].input.details?.snapshotsReceived, 1);
  assert.equal(entries[2].input.details?.snapshotsCommitted, 0);
});

test("browser stream diagnostics contains record and clock failures", () => {
  let clockCalls = 0;
  const diagnostics = new BrowserStreamDiagnosticsAggregator(
    () => { throw new Error("recorder failed"); },
    () => {
      clockCalls += 1;
      throw new Error("clock failed");
    },
  );
  const identity = { sessionId: A, runGeneration: 16 };
  assert.doesNotThrow(() => diagnostics.receive(identity, true));
  assert.doesNotThrow(() => diagnostics.scheduler("committed", identity));
  assert.equal(diagnostics.hasPaintCandidate(identity), false);
  assert.doesNotThrow(() => diagnostics.checkpoint());
  assert.doesNotThrow(() => diagnostics.terminal(identity));
  assert.equal(diagnostics.paint(identity), false);
  assert.ok(clockCalls >= 1);
});
