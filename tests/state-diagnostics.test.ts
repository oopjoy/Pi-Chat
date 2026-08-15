import assert from "node:assert/strict";
import test from "node:test";
import { StateDiagnosticsRecorder, sanitizeDiagnosticDetails } from "../src/server/state-diagnostics";

const SESSION_ID = "0123456789abcdefabcd";

test("state diagnostics is always-on, bounded, ordered, and age-limited", () => {
  let now = Date.parse("2026-08-14T12:00:00.000Z");
  const recorder = new StateDiagnosticsRecorder({
    runEpoch: "run",
    buildFingerprint: "a".repeat(64),
    now: () => now,
    windowMs: 10_000,
    maximumEntries: 100,
    maximumBytes: 64 * 1024,
  });

  for (let index = 0; index < 180; index += 1) {
    recorder.record({
      category: "projection",
      name: "ui-state",
      sessionId: SESSION_ID,
      runGeneration: index,
      details: { durationMs: index, running: index % 2 === 0 },
    });
  }
  const bounded = recorder.snapshot();
  assert.equal(bounded.schemaVersion, 2);
  assert.ok(bounded.entries.length <= 100);
  assert.ok(bounded.status.approximateBytes <= bounded.status.maximumBytes);
  assert.ok(
    bounded.entries.every((entry, index, entries) =>
      index === 0 || entry.sequence > entries[index - 1].sequence,
    ),
  );

  now += 11_000;
  recorder.record({ category: "sse", name: "connected" });
  const expired = recorder.snapshot();
  assert.deepEqual(expired.entries.map((entry) => entry.name), ["connected"]);
});

test("state diagnostics keeps only closed-schema values and rejects adversarial strings", () => {
  const safe = sanitizeDiagnosticDetails({
    eventType: "tool_execution_start",
    originalEventType: "secret-token C:\\private\\key.txt",
    errorType: "Bearer private",
    route: "/api/sessions/0123456789abcdefabcd/view?token=secret",
    running: true,
    queueLength: 2,
    requestToken: "secret-token",
    authorization: "Bearer secret",
    message: "private prompt",
    content: "private answer",
    cwd: "C:\\private",
    filePath: "C:\\private\\file.txt",
    imageData: "base64",
    stack: "private stack",
    longValue: "x".repeat(500),
    nested: { secret: true },
  });
  assert.deepEqual(Object.keys(safe).sort(), [
    "errorType",
    "eventType",
    "originalEventType",
    "queueLength",
    "route",
    "running",
  ]);
  assert.equal(safe.originalEventType, "unknown");
  assert.equal(safe.errorType, "unknown");
  assert.equal(safe.route, "/api/unknown");
  assert.equal(
    sanitizeDiagnosticDetails({ route: "/api/sessions/0123456789abcdefabcd/view" }).route,
    "/api/sessions/:sessionId/view",
  );
  assert.equal(
    sanitizeDiagnosticDetails({ route: "/api/chat/queue/01234567-89ab-cdef-0123-456789abcdef" }).route,
    "/api/chat/queue/:queueId",
  );
  for (const route of [
    "/api/C:/Users/alice/private-token",
    "/api/client/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "/api/private-token",
  ]) assert.equal(sanitizeDiagnosticDetails({ route }).route, "/api/unknown");
  const raw = JSON.stringify(safe);
  for (const forbidden of [
    "secret-token",
    "Bearer secret",
    "private prompt",
    "private answer",
    "C:\\\\private",
    "base64",
    "private stack",
  ]) assert.equal(raw.includes(forbidden), false, forbidden);
});

test("state diagnostics applies an approximate byte ceiling independently of count", () => {
  const recorder = new StateDiagnosticsRecorder({
    runEpoch: "run",
    buildFingerprint: "a".repeat(64),
    maximumEntries: 1_000,
    maximumBytes: 64 * 1024,
  });
  for (let index = 0; index < 400; index += 1) {
    recorder.record({
      category: "projection",
      name: "ui-state",
      details: {
        durationMs: index,
        queueLength: index,
        transcriptCount: index,
        sidebarRows: index,
        sidebarRunningCount: index,
        sidebarQueuedCount: index,
        sidebarFailedCount: index,
        sidebarPausedCount: index,
        sidebarConfirmationCount: index,
        sidebarForeignOwnerCount: index,
        navigationEpoch: index,
        sourceGeneration: index,
        size: index,
        transportClients: index,
        running: true,
        hasLive: true,
        toolActive: true,
        dispatching: true,
        queuePaused: true,
        failed: true,
        stateStreaming: true,
        viewStreaming: true,
        sessionRunning: true,
        observing: true,
        controlledByThisWindow: false,
        foreignOwnerPresent: true,
        composerDisabled: true,
        composerStopVisible: true,
        eventType: "agent_start",
        execution: "running",
        runtimeStatus: "active",
        route: "/api/bootstrap",
      },
    });
  }
  const snapshot = recorder.snapshot();
  assert.ok(snapshot.entries.length < 400);
  assert.ok(snapshot.status.approximateBytes <= snapshot.status.maximumBytes);
});

test("state diagnostics drops open event names and cumulative update noise", () => {
  const recorder = new StateDiagnosticsRecorder({ runEpoch: "run", buildFingerprint: "a".repeat(64) });
  recorder.record({ category: "private", name: "user-controlled" });
  for (let index = 0; index < 10_000; index += 1)
    recorder.record({
      category: "rpc-event",
      name: "received",
      details: { eventType: "message_update", durationMs: index },
    });
  recorder.record({
    category: "sse",
    name: "rejected",
    details: { eventType: "message_update", decisionReason: "stale-run-generation" },
  });
  recorder.record({
    category: "rpc-event",
    name: "received",
    details: { eventType: "agent_settled" },
  });
  const snapshot = recorder.snapshot();
  assert.deepEqual(snapshot.entries.map((entry) => entry.details.eventType), [
    "message_update",
    "agent_settled",
  ]);
});

test("state diagnostic recorder failures are fail-open", () => {
  const recorder = new StateDiagnosticsRecorder({
    runEpoch: "run",
    buildFingerprint: "a".repeat(64),
    encodeBytes: () => { throw new Error("diagnostic encoder failed"); },
  });
  assert.doesNotThrow(() => recorder.record({
    category: "projection",
    name: "ui-state",
    details: { running: true },
  }));
  assert.equal(recorder.snapshot().entries.length, 0);
});
