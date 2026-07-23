import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SseHub } from "../src/server/sse-hub.ts";

function stubClient(writeResult = true) {
  const frames: string[] = [];
  const client = new EventEmitter() as EventEmitter & { frames: string[]; write(frame: string): boolean; end(): void };
  client.frames = frames;
  client.write = (frame: string) => { frames.push(frame); return writeResult; };
  client.end = () => { frames.push("END"); };
  return client;
}

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

test("backpressured sockets drop intermediate frames and request authoritative resync after drain", () => {
  const hub = new SseHub();
  const client = stubClient(false);
  hub.add(client as never, "client-a");
  hub.broadcast({ type: "message_update", n: 1 });
  hub.broadcast({ type: "message_update", n: 2 });
  assert.equal(client.frames.length, 1);
  client.emit("drain");
  assert.equal(client.frames.length, 2);
  assert.match(client.frames[1], /pi_chat_sse_resync/);
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
