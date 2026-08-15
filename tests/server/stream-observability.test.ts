import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ServerStreamDiagnosticsAggregator } from "../../src/server/stream-observability";
import { SseHub, type SseTransportDiagnostic } from "../../src/server/sse-hub";

const A = "0123456789abcdefabcd";
const B = "fedcba9876543210abcd";

function event(
  sessionId: string,
  runGeneration: number,
  outcome: SseTransportDiagnostic["outcome"],
): SseTransportDiagnostic {
  return {
    eventType: "message_update",
    sessionId,
    runGeneration,
    outcome,
    transportClients: 1,
  };
}

test("server stream diagnostics aggregates transport outcomes per Session run", () => {
  const summaries: unknown[] = [];
  const diagnostics = new ServerStreamDiagnosticsAggregator((summary) => summaries.push(summary));
  for (const outcome of [
    "written",
    "written-backpressured",
    "scheduled",
    "scheduled-replaced",
    "queued",
    "queue-replaced",
  ] as const) diagnostics.observe(event(A, 4, outcome));
  diagnostics.observe(event(B, 5, "written"));
  assert.equal(diagnostics.observe({
    eventType: "agent_settled",
    outcome: "written",
    transportClients: 1,
  }), false);
  assert.equal(diagnostics.flush(A, 4), true);
  assert.equal(diagnostics.flush(A, 4), false);
  assert.deepEqual(summaries, [{
    sessionId: A,
    runGeneration: 4,
    details: {
      snapshotsWritten: 2,
      snapshotsBackpressured: 1,
      snapshotsScheduled: 1,
      snapshotsReplaced: 1,
      snapshotsQueued: 1,
      snapshotsQueueReplaced: 1,
      snapshotsOversized: 0,
      snapshotsNoClients: 0,
      snapshotsWriteErrors: 0,
    },
  }]);
  assert.equal(diagnostics.size, 1);
  diagnostics.checkpoint();
  assert.equal(diagnostics.size, 0);
  assert.equal(summaries.length, 2);
});

test("server stream diagnostics bounds active runs and remains fail-open", () => {
  const summaries: unknown[] = [];
  const diagnostics = new ServerStreamDiagnosticsAggregator((summary) => {
    summaries.push(summary);
    if (summaries.length === 1) throw new Error("recorder failed");
  }, 2);
  assert.equal(diagnostics.observe(event(A, 1, "written")), true);
  diagnostics.observe(event(A, 2, "scheduled"));
  assert.doesNotThrow(() => diagnostics.observe(event(B, 3, "queued")));
  assert.equal(diagnostics.size, 2);
  assert.equal(summaries.length, 1, "oldest run is summarized during bounded eviction");
});


test("SseHub aggregation retains terminal flush order and backpressure counters", () => {
  const summaries: Array<{ details: Record<string, number> }> = [];
  const diagnostics = new ServerStreamDiagnosticsAggregator((summary) => summaries.push(summary));
  const hub = new SseHub(1_000, (transport) => diagnostics.observe(transport));
  const frames: string[] = [];
  const client = new EventEmitter() as EventEmitter & {
    write(frame: string): boolean;
    end(): void;
  };
  client.write = (frame) => { frames.push(frame); return true; };
  client.end = () => undefined;
  hub.add(client as never, "client");
  hub.broadcast({ type: "message_update", piChatSessionId: A, piChatRunGeneration: 8, n: 1 });
  hub.broadcast({ type: "message_update", piChatSessionId: A, piChatRunGeneration: 8, n: 2 });
  hub.broadcast({ type: "message_update", piChatSessionId: A, piChatRunGeneration: 8, n: 3 });
  hub.broadcast({ type: "agent_settled", piChatSessionId: A, piChatRunGeneration: 8 });
  diagnostics.flush(A, 8);
  assert.equal(frames.length, 3);
  assert.match(frames[1], /"message_update".*"n":3/);
  assert.match(frames[2], /"agent_settled"/);
  assert.deepEqual(summaries[0].details, {
    snapshotsWritten: 2,
    snapshotsBackpressured: 0,
    snapshotsScheduled: 1,
    snapshotsReplaced: 1,
    snapshotsQueued: 0,
    snapshotsQueueReplaced: 0,
    snapshotsOversized: 0,
    snapshotsNoClients: 0,
    snapshotsWriteErrors: 0,
  });
  hub.closeAll();

  const pressureSummaries: Array<{ details: Record<string, number> }> = [];
  const pressure = new ServerStreamDiagnosticsAggregator((summary) => pressureSummaries.push(summary));
  const pressuredHub = new SseHub(0, (transport) => pressure.observe(transport));
  const pressured = new EventEmitter() as EventEmitter & {
    write(frame: string): boolean;
    end(): void;
  };
  pressured.write = () => false;
  pressured.end = () => undefined;
  pressuredHub.add(pressured as never, "pressured");
  pressuredHub.broadcast({ type: "message_update", piChatSessionId: B, piChatRunGeneration: 9, n: 1 });
  pressuredHub.broadcast({ type: "message_update", piChatSessionId: B, piChatRunGeneration: 9, n: 2 });
  pressuredHub.broadcast({ type: "message_update", piChatSessionId: B, piChatRunGeneration: 9, n: 3 });
  pressure.flush(B, 9);
  assert.deepEqual(pressureSummaries[0].details, {
    snapshotsWritten: 1,
    snapshotsBackpressured: 1,
    snapshotsScheduled: 0,
    snapshotsReplaced: 0,
    snapshotsQueued: 1,
    snapshotsQueueReplaced: 1,
    snapshotsOversized: 0,
    snapshotsNoClients: 0,
    snapshotsWriteErrors: 0,
  });
  pressuredHub.closeAll();
});

test("server stream diagnostics consumes oversized, no-client, and write-error hot outcomes", () => {
  const summaries: Array<{ details: Record<string, number> }> = [];
  const diagnostics = new ServerStreamDiagnosticsAggregator((summary) => summaries.push(summary));
  const base = {
    eventType: "pi_chat_oversized_event",
    originalEventType: "message_update",
    sessionId: A,
    runGeneration: 17,
    transportClients: 0,
  } as const;
  assert.equal(diagnostics.observe({ ...base, outcome: "oversized-substitute" }), true);
  assert.equal(diagnostics.observe({ ...base, outcome: "no-clients" }), true);
  assert.equal(diagnostics.observe({ ...base, outcome: "write-error" }), true);
  diagnostics.flush(A, 17);
  assert.deepEqual(summaries[0].details, {
    snapshotsWritten: 0,
    snapshotsBackpressured: 0,
    snapshotsScheduled: 0,
    snapshotsReplaced: 0,
    snapshotsQueued: 0,
    snapshotsQueueReplaced: 0,
    snapshotsOversized: 1,
    snapshotsNoClients: 1,
    snapshotsWriteErrors: 1,
  });
});

test("SseHub no-client and write failures stay in aggregate counters", () => {
  const noClientSummaries: Array<{ details: Record<string, number> }> = [];
  const noClient = new ServerStreamDiagnosticsAggregator((summary) => noClientSummaries.push(summary));
  const emptyHub = new SseHub(50, (transport) => noClient.observe(transport));
  emptyHub.broadcast({
    type: "message_update",
    piChatSessionId: A,
    piChatRunGeneration: 18,
  });
  noClient.flush(A, 18);
  assert.equal(noClientSummaries[0].details.snapshotsNoClients, 1);

  const failureSummaries: Array<{ details: Record<string, number> }> = [];
  const failures = new ServerStreamDiagnosticsAggregator((summary) => failureSummaries.push(summary));
  const failingHub = new SseHub(0, (transport) => failures.observe(transport));
  const client = new EventEmitter() as EventEmitter & {
    write(frame: string): boolean;
    end(): void;
  };
  client.write = () => { throw new Error("socket failed"); };
  client.end = () => undefined;
  failingHub.add(client as never, "failing");
  failingHub.broadcast({
    type: "message_update",
    piChatSessionId: B,
    piChatRunGeneration: 19,
  });
  failures.flush(B, 19);
  assert.equal(failureSummaries[0].details.snapshotsWriteErrors, 1);
});
