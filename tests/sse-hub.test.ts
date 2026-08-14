import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SseHub, type SseTransportDiagnostic } from "../src/server/sse-hub.ts";

function stubClient(writeResult = true) {
  const frames: string[] = [];
  const client = new EventEmitter() as EventEmitter & { frames: string[]; write(frame: string): boolean; end(): void };
  client.frames = frames;
  client.write = (frame: string) => { frames.push(frame); return writeResult; };
  client.end = () => { frames.push("END"); };
  return client;
}

test("diagnostic observer failures never perturb SSE delivery", () => {
  const hub = new SseHub(0, () => { throw new Error("diagnostic failure"); });
  const client = stubClient();
  hub.add(client as never, "client-a");
  assert.doesNotThrow(() => hub.broadcast({ type: "agent_start" }));
  assert.match(client.frames[0], /"type":"agent_start"/);
  hub.closeAll();
});

test("SseHub broadcasts the same frame to every client", () => {
  const hub = new SseHub();
  const a = stubClient();
  const b = stubClient();
  hub.add(a as never, "client-a");
  hub.add(b as never, "client-b");
  hub.broadcast({ type: "ping", n: 1 });
  assert.equal(a.frames.length, 1);
  assert.equal(b.frames.length, 1);
  assert.match(a.frames[0], /"type":"ping"/);
});

test("heartbeat is an independently parseable SSE frame", () => {
  const hub = new SseHub();
  const client = stubClient();
  hub.add(client as never, "client-a");
  hub.heartbeat(client as never, 123);
  hub.broadcast({ type: "after-heartbeat" });
  assert.equal(client.frames[0], "event: pi\ndata: {\"type\":\"pi_chat_heartbeat\",\"at\":123}\n\n");
  assert.ok(client.frames[0].includes("\n\n"));
  assert.match(client.frames.join(""), /\n\nevent: pi\ndata: \{\"type\":\"after-heartbeat\"\}\n\n$/);
});

test("oversized events are replaced with a bounded diagnostic frame", () => {
  const hub = new SseHub();
  const client = stubClient();
  hub.add(client as never, "client-a");
  hub.broadcast({ type: "extension_event", payload: "x".repeat(600_000), piChatSessionId: "0123456789abcdefabcd" });
  assert.equal(client.frames.length, 1);
  assert.ok(client.frames[0].length < 1_000);
  assert.match(client.frames[0], /pi_chat_oversized_event/);
  assert.match(client.frames[0], /extension_event/);
});

test("healthy sockets coalesce rapid assistant snapshots at the browser render cadence", async () => {
  const hub = new SseHub(20);
  const client = stubClient();
  hub.add(client as never, "client-a");

  hub.broadcast({ type: "message_update", piChatSessionId: "session-a", n: 1 });
  hub.broadcast({ type: "message_update", piChatSessionId: "session-a", n: 2 });
  hub.broadcast({ type: "message_update", piChatSessionId: "session-a", n: 3 });
  // A parallel Session has an independent cadence and must not be starved by A.
  hub.broadcast({ type: "message_update", piChatSessionId: "session-b", n: 4 });
  assert.equal(client.frames.length, 2);
  assert.match(client.frames[0], /"piChatSessionId":"session-a","n":1/);
  assert.match(client.frames[1], /"piChatSessionId":"session-b","n":4/);

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(client.frames.length, 3);
  assert.match(client.frames[2], /"piChatSessionId":"session-a","n":3/);
  assert.doesNotMatch(client.frames.join("\n"), /"n":2/);
  hub.closeAll();
});

test("ordered Session events flush the latest throttled snapshot before themselves", () => {
  const hub = new SseHub(1_000);
  const client = stubClient();
  hub.add(client as never, "client-a");

  hub.broadcast({ type: "message_update", piChatSessionId: "session-a", n: 1 });
  hub.broadcast({ type: "message_update", piChatSessionId: "session-a", n: 2 });
  assert.equal(client.frames.length, 1);
  hub.broadcast({ type: "tool_execution_end", piChatSessionId: "session-a", toolCallId: "done" });

  assert.equal(client.frames.length, 3);
  assert.match(client.frames[1], /"type":"message_update".*"n":2/);
  assert.match(client.frames[2], /"type":"tool_execution_end".*"toolCallId":"done"/);
  hub.closeAll();
});

test("removing a client cancels its delayed healthy-socket snapshot", () => {
  const hub = new SseHub(1_000);
  const client = stubClient();
  hub.add(client as never, "client-a");
  hub.broadcast({ type: "message_update", n: 1 });
  hub.broadcast({ type: "message_update", n: 2 });
  assert.equal(client.frames.length, 1);
  hub.remove(client as never);
  assert.equal(client.frames.length, 1);
});

test("backpressured sockets coalesce adjacent assistant snapshots but retain terminal tool events in order", () => {
  const hub = new SseHub();
  const client = stubClient(false);
  hub.add(client as never, "client-a");
  hub.broadcast({ type: "message_update", n: 1 });
  hub.broadcast({ type: "message_update", n: 2 });
  hub.broadcast({ type: "message_update", n: 3 });
  hub.broadcast({ type: "tool_execution_end", toolCallId: "retained" });
  assert.equal(client.frames.length, 1);

  client.write = (frame: string) => { client.frames.push(frame); return true; };
  client.emit("drain");
  assert.equal(client.frames.length, 3);
  assert.match(client.frames[1], /"type":"message_update","n":3/);
  assert.match(client.frames[2], /"type":"tool_execution_end","toolCallId":"retained"/);
  assert.doesNotMatch(client.frames.join("\n"), /pi_chat_sse_resync/);
});

test("a retained assistant snapshot stays bounded if it causes backpressure again", () => {
  const hub = new SseHub();
  const client = stubClient(false);
  hub.add(client as never, "client-a");
  hub.broadcast({ type: "message_update", n: 1 });
  hub.broadcast({ type: "message_update", n: 2 });
  client.emit("drain");
  assert.equal(client.frames.length, 2);
  assert.match(client.frames[1], /"n":2/);

  hub.broadcast({ type: "message_update", n: 3 });
  client.write = (frame: string) => { client.frames.push(frame); return true; };
  client.emit("drain");
  assert.equal(client.frames.length, 3);
  assert.match(client.frames[2], /"n":3/);
  assert.doesNotMatch(client.frames.join("\n"), /pi_chat_sse_resync/);
});

test("retained snapshots for other Sessions survive repeated replay backpressure", () => {
  const hub = new SseHub();
  const client = stubClient(false);
  hub.add(client as never, "client-a");
  hub.broadcast({ type: "message_update", piChatSessionId: "session-a", n: 1 });
  hub.broadcast({ type: "message_update", piChatSessionId: "session-a", n: 2 });
  hub.broadcast({ type: "message_update", piChatSessionId: "session-b", n: 3 });

  client.emit("drain");
  assert.equal(client.frames.length, 2);
  assert.match(client.frames[1], /"piChatSessionId":"session-a","n":2/);

  client.write = (frame: string) => { client.frames.push(frame); return true; };
  client.emit("drain");
  assert.equal(client.frames.length, 3);
  assert.match(client.frames[2], /"piChatSessionId":"session-b","n":3/);
  assert.doesNotMatch(client.frames.join("\n"), /pi_chat_sse_resync/);
});

test("removing a congested client prevents retained replay on its old drain", () => {
  const hub = new SseHub();
  const client = stubClient(false);
  hub.add(client as never, "client-a");
  hub.broadcast({ type: "message_update", n: 1 });
  hub.broadcast({ type: "message_update", n: 2 });
  hub.remove(client as never);
  client.write = (frame: string) => { client.frames.push(frame); return true; };
  client.emit("drain");
  assert.equal(client.frames.length, 1);
});

test("transport diagnostics distinguish intent-free delivery, throttling, replacement, and oversized substitution", async () => {
  const diagnostics: SseTransportDiagnostic[] = [];
  const hub = new SseHub(20, (event) => diagnostics.push(event));
  hub.broadcast({ type: "agent_start", piChatSessionId: "0123456789abcdefabcd", piChatRunGeneration: 4 });
  assert.equal(diagnostics.at(-1)?.outcome, "no-clients");

  const client = stubClient();
  hub.add(client as never, "client-a");
  hub.broadcast({ type: "message_update", piChatSessionId: "0123456789abcdefabcd", n: 1 });
  hub.broadcast({ type: "message_update", piChatSessionId: "0123456789abcdefabcd", n: 2 });
  hub.broadcast({ type: "message_update", piChatSessionId: "0123456789abcdefabcd", n: 3 });
  assert.ok(diagnostics.some((event) => event.outcome === "written" && event.eventType === "message_update"));
  assert.ok(diagnostics.some((event) => event.outcome === "scheduled"));
  assert.ok(diagnostics.some((event) => event.outcome === "scheduled-replaced"));
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(client.frames.some((frame) => frame.includes('"n":2')), false);
  assert.equal(client.frames.some((frame) => frame.includes('"n":3')), true);

  hub.broadcast({
    type: "extension_event",
    payload: "x".repeat(600_000),
    piChatSessionId: "0123456789abcdefabcd",
  });
  assert.ok(diagnostics.some((event) =>
    event.outcome === "oversized-substitute" &&
    event.eventType === "pi_chat_oversized_event" &&
    event.originalEventType === "extension_event",
  ));
  assert.ok(diagnostics.some((event) =>
    event.outcome === "written" && event.eventType === "pi_chat_oversized_event",
  ));
  hub.closeAll();
});

test("transport diagnostics expose backpressure queues, per-window control projection, and bounded disconnect", () => {
  const diagnostics: SseTransportDiagnostic[] = [];
  const hub = new SseHub(0, (event) => diagnostics.push(event));
  const owner = stubClient(false);
  const observer = stubClient();
  hub.add(owner as never, "owner");
  hub.add(observer as never, "observer");
  hub.broadcastEach((clientId) => ({
    type: "pi_chat_session_control_changed",
    piChatSessionId: "0123456789abcdefabcd",
    controlOwner: "owner",
    controlledByThisWindow: clientId === "owner",
  }));
  const controlWrites = diagnostics.filter((event) =>
    event.eventType === "pi_chat_session_control_changed" &&
    (event.outcome === "written" || event.outcome === "written-backpressured"),
  );
  assert.equal(controlWrites.length, 2);
  assert.deepEqual(
    controlWrites.map((event) => event.controlledByThisWindow).sort(),
    [false, true],
  );
  assert.ok(controlWrites.some((event) => event.foreignOwnerPresent === true));

  for (let index = 0; index < 6; index += 1) {
    hub.broadcast({
      type: "message_end",
      piChatSessionId: "0123456789abcdefabcd",
      payload: `${index}${"x".repeat(450_000)}`,
    });
  }
  assert.ok(diagnostics.some((event) => event.outcome === "queued"));
  assert.ok(diagnostics.some((event) =>
    event.outcome === "disconnected" &&
    event.disconnectReason === "pending-buffer-limit" &&
    (event.pendingBytes || 0) > 2 * 1024 * 1024,
  ));
  hub.closeAll();
});

test("broadcastEach personalizes control events and closeAll ends sockets", () => {
  const hub = new SseHub();
  const a = stubClient();
  const b = stubClient();
  hub.add(a as never, "owner");
  hub.add(b as never, "observer");
  hub.broadcastEach((clientId) => ({
    type: "pi_chat_session_control_changed",
    controlOwner: "owner",
    controlledByThisWindow: clientId === "owner",
  }));
  assert.match(a.frames[0], /"controlledByThisWindow":true/);
  assert.match(b.frames[0], /"controlledByThisWindow":false/);
  hub.closeAll();
  assert.equal(hub.size, 0);
  assert.equal(a.frames.at(-1), "END");
  assert.equal(b.frames.at(-1), "END");
});
