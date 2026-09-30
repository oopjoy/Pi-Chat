import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { handleQueueControlRoute } from "../../src/server/routes/queue-control";
import type { QueuedPrompt } from "../../src/shared/types";
import type { InternalQueuedPrompt } from "../../src/server/prompt-scheduler";

function request(method: string, body: Record<string, unknown> = {}) {
  const input = new EventEmitter() as EventEmitter & { method: string; on: EventEmitter["on"]; headers: Record<string, string> };
  input.method = method;
  input.headers = { "content-type": "application/json" };
  queueMicrotask(() => {
    input.emit("data", JSON.stringify(body));
    input.emit("end");
  });
  return input;
}

function response() {
  const value: { status?: number; body?: string } = {};
  return {
    value,
    writeHead: (status: number) => { value.status = status; },
    end: (body?: string) => { value.body = body; },
    setHeader: () => {},
  } as never;
}

function item(id: string): InternalQueuedPrompt {
  return { id, message: id, createdAt: 1, imageCount: 0, images: [] };
}

test("queue cancel removes one item and clears pause only when the target queue is empty", async () => {
  const queue = [item("11111111-1111-4111-8111-111111111111")];
  const calls: string[] = [];
  let paused = true;
  const target = {
    queue,
    getPaused: () => paused,
    setPaused: (next: boolean) => { paused = next; calls.push(`paused:${next}`); },
    touch: () => calls.push("touch"),
    dispatch: () => calls.push("dispatch"),
  };
  const res = response();
  const handled = await handleQueueControlRoute({
    target: () => target,
    publicQueue: (current) => current.map((entry) => ({ ...entry })),
    traceCancelled: (_, id) => calls.push(`cancel:${id}`),
    broadcastQueue: (id) => calls.push(`broadcast:${id}`),
  }, request("DELETE"), res, new URL("http://localhost/api/chat/queue/11111111-1111-4111-8111-111111111111"), { sessionId: "aaaaaaaaaaaaaaaaaaaa" });
  assert.equal(handled, true);
  assert.deepEqual(queue, []);
  assert.deepEqual(calls, [
    "touch",
    "cancel:11111111-1111-4111-8111-111111111111",
    "paused:false",
    "broadcast:aaaaaaaaaaaaaaaaaaaa",
  ]);
  assert.equal(res.value.status, 200);
  assert.deepEqual(JSON.parse(res.value.body || "{}"), { queue: [], paused: false });
});

test("queue resume recovers a Secondary before dispatching and returning the authoritative queue", async () => {
  const queue = [item("22222222-2222-4222-8222-222222222222")];
  const calls: string[] = [];
  const res = response();
  const handled = await handleQueueControlRoute({
    target: () => ({
      queue,
      getPaused: () => true,
      setPaused: (paused) => calls.push(`paused:${paused}`),
      touch: () => calls.push("touch"),
      recover: async () => calls.push("recover"),
      dispatch: () => calls.push("dispatch"),
    }),
    publicQueue: (current) => current,
    traceCancelled: () => {},
    broadcastQueue: () => calls.push("broadcast"),
  }, request("POST"), res, new URL("http://localhost/api/chat/queue/resume"), { sessionId: "bbbbbbbbbbbbbbbbbbbb" });
  assert.equal(handled, true);
  assert.deepEqual(calls, ["touch", "recover", "paused:false", "broadcast", "dispatch"]);
  assert.deepEqual(JSON.parse(res.value.body || "{}"), { queue, paused: false });
});

test("queue control rejects an unloaded Session without creating Runtime state", async () => {
  const res = response();
  const handled = await handleQueueControlRoute({
    target: () => null,
    publicQueue: (queue) => queue,
    traceCancelled: () => assert.fail("must not trace"),
    broadcastQueue: () => assert.fail("must not broadcast"),
  }, request("POST"), res, new URL("http://localhost/api/chat/queue/resume"), { sessionId: "cccccccccccccccccccc" });
  assert.equal(handled, true);
  assert.equal(res.value.status, 409);
  assert.deepEqual(JSON.parse(res.value.body || "{}"), {
    error: "该会话尚未恢复运行，请刷新页面后重试",
  });
});
