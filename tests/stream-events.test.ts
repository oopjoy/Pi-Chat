import assert from "node:assert/strict";
import test from "node:test";
import { admitStreamEvent, invalidatesSessionViewVersion, isSessionScopedEvent } from "../src/web/application/stream-events";

function frame(value: unknown): Event {
  return { data: JSON.stringify(value) } as Event;
}

test("stream admission normalizes Session and Runtime provenance without mutating state", () => {
  const result = admitStreamEvent(frame({
    type: "agent_start",
    piChatSessionId: "session-a",
    piChatRunEpoch: "epoch-a",
    piChatRunGeneration: 3,
  }), "epoch-a");
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.equal(result.value.type, "agent_start");
  assert.equal(result.value.sessionId, "session-a");
  assert.equal(result.value.runEpoch, "epoch-a");
  assert.equal(result.value.runGeneration, 3);
  assert.equal(result.value.terminalEvent, null);
});

test("stream admission rejects malformed, stale, and unaddressed Session frames", () => {
  assert.deepEqual(admitStreamEvent({ data: "{" } as Event, ""), {
    accepted: false,
    eventType: "unknown",
    reason: "malformed-json",
  });
  assert.equal(admitStreamEvent(frame({ type: "agent_start", piChatSessionId: "session-a", piChatRunEpoch: "old" }), "new").accepted, false);
  const missing = admitStreamEvent(frame({ type: "agent_start" }), "");
  assert.equal(missing.accepted, false);
  if (!missing.accepted) assert.equal(missing.reason, "missing-session");
});

test("global stream frames remain unscoped while lifecycle frames invalidate Session views", () => {
  assert.equal(isSessionScopedEvent("pi_chat_heartbeat"), false);
  assert.equal(isSessionScopedEvent("pi_chat_application_lifecycle"), false);
  assert.equal(isSessionScopedEvent("message_update"), true);
  assert.equal(invalidatesSessionViewVersion("message_delta"), true);
  assert.equal(invalidatesSessionViewVersion("pi_chat_heartbeat"), false);
});
