import assert from "node:assert/strict";
import test from "node:test";
import { SseHub } from "../src/server/sse-hub.ts";

function stubClient() {
  const frames: string[] = [];
  return {
    frames,
    write(frame: string) { frames.push(frame); },
    end() { frames.push("END"); },
  };
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
