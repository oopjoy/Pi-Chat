import assert from "node:assert/strict";
import test from "node:test";
import { admitNativeSteering, type NativeSteeringAdmissions } from "../../src/server/services/native-steering-admission";
import { RpcRequestTimeoutError } from "../../src/server/rpc-client";

function makePorts(overrides: Partial<Parameters<typeof admitNativeSteering>[0]> = {}) {
  let admissions: NativeSteeringAdmissions | undefined;
  const calls: string[] = [];
  return {
    calls,
    ports: {
      getAdmissions: () => admissions,
      setAdmissions: (value: NativeSteeringAdmissions | undefined) => {
        admissions = value;
        calls.push(`admissions:${value?.items.length || 0}`);
      },
      advanceProjection: () => calls.push("projection"),
      persistedMessages: () => [],
      send: async () => calls.push("send"),
      readStreaming: async () => false,
      clearOnProcessError: () => calls.push("clear-process"),
      hasPending: () => true,
      reset: async () => calls.push("reset"),
      afterReset: () => calls.push("after-reset"),
      ...overrides,
    },
  };
}

const base = {
  generation: 3,
  message: "continue with the current file",
  images: [],
  promptAt: 10,
  maxPending: 20,
  maxImageChars: 100,
  maxBaselineIds: 10,
};

test("native Steer admission bounds before mutating the owner map", async () => {
  const { ports } = makePorts({
    getAdmissions: () => ({ generation: 3, items: Array.from({ length: 20 }, (_, index) => ({
      id: String(index),
      message: "x",
      promptAt: 1,
      imageChars: 0,
      baselinePersistedUserIds: new Set<string>(),
    })) }),
  });
  const result = await admitNativeSteering(ports, base);
  assert.equal(result.status, 409);
  assert.match(String(result.body.error), /队列已满/);
});

test("unknown Steer write keeps the admission for authoritative dequeue or clear", async () => {
  const { ports, calls } = makePorts({
    send: async () => { throw new RpcRequestTimeoutError("steer"); },
    readStreaming: async () => true,
  });
  const result = await admitNativeSteering(ports, { ...base, requestedSteerId: "steer-id" });
  assert.equal(result.status, 202);
  assert.equal(result.body.deliveryUncertain, true);
  assert.match(calls.join(","), /admissions:1/);
  assert.equal(calls.includes("reset"), false);
});

test("definite Steer write failure rolls back only its generation admission", async () => {
  const { ports, calls } = makePorts({
    send: async () => { throw new Error("closed"); },
  });
  await assert.rejects(() => admitNativeSteering(ports, base), /closed/);
  assert.deepEqual(calls, ["admissions:1", "projection", "admissions:0", "projection"]);
});

test("idle probe clears a Steer that reached a settled Runtime", async () => {
  const { ports, calls } = makePorts({
    readStreaming: async () => false,
    hasPending: () => true,
  });
  const result = await admitNativeSteering(ports, base);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "STEER_ALREADY_SETTLED");
  assert.deepEqual(calls, [
    "admissions:1",
    "projection",
    "send",
    "reset",
    "after-reset",
  ]);
});

test("slash and settings validation happen before native admission", async () => {
  const { ports, calls } = makePorts();
  const slash = await admitNativeSteering(ports, { ...base, message: "/compact" });
  const settings = await admitNativeSteering(ports, { ...base, hasSettings: true });
  assert.equal(slash.status, 400);
  assert.equal(settings.status, 400);
  assert.deepEqual(calls, []);
});
