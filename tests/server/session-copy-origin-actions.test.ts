import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  createSessionCopyOriginActions,
  type SessionCopyOriginInput,
  type SessionCopyOriginPorts,
} from "../../src/server/services/session-copy-origin-actions";
import { idForPath } from "../../src/server/session-index";
import { PiChatApp } from "../../src/server/app";
import type { PiRpcClient } from "../../src/server/rpc-client";
import type { SessionIndex } from "../../src/server/session-index";
import type { ResourceManager } from "../../src/server/resource-manager";
import type { SecondaryRuntime } from "../../src/server/runtime-pool";
import { FakeRpc } from "../helpers/server-app-fixture";

function fixture(overrides: Partial<SessionCopyOriginPorts> = {}) {
  const sourcePath = resolve("source-fixture.jsonl");
  const destination = resolve("destination-fixture.jsonl");
  const input: SessionCopyOriginInput = Object.freeze({ id: idForPath(sourcePath), sourcePath, mode: "fork", entryId: "user-entry", knownSessionIds: new Set<string>() });
  const events: string[] = [];
  const ports: SessionCopyOriginPorts = {
    readOrigin: async () => null,
    sourceSummary: () => undefined,
    cachedSourceSummary: async () => undefined,
    executeCopy: async received => {
      assert.equal(received, input);
      events.push("execute");
      return { state: { model: null, isStreaming: false, sessionFile: destination, sessionId: "destination" }, cancelled: false, mutationOutcomeUnknown: false, copyMayHaveCommitted: true, outcomeToken: "token" };
    },
    activeSessionId: () => input.id,
    liveRuntimeIds: () => new Set(),
    setCopying: (id, copying) => { assert.equal(id, input.id); events.push(`copying:${copying}`); },
    recoverSource: async received => { assert.equal(received, input); events.push("recover"); },
    recordCommittedRecoveryFailure: received => { assert.equal(received, input); events.push("record-failure"); },
    installOutcomeFence: (id, token) => { assert.equal(id, input.id); assert.equal(token, "token"); events.push("fence"); },
    ...overrides,
  };
  return { input, destination, events, ports, actions: createSessionCopyOriginActions(ports) };
}

test("copy origin service works with only its finite ports and restores the source before returning", async () => {
  const f = fixture();
  const result = await f.actions.runBoundSessionCopy(f.input);
  assert.deepEqual(result, { sessionId: idForPath(f.destination), sessionPath: f.destination, piSessionId: "destination" });
  assert.deepEqual(f.events, ["copying:true", "execute", "copying:false", "recover"]);
  assert.equal("options" in f.ports, false);
  assert.equal("runtimePool" in f.ports, false);
});

test("copy origin rechecks live identity getters after asynchronous RPC completion", async () => {
  let active = "old";
  const f = fixture({ activeSessionId: () => active });
  const original = f.ports.executeCopy;
  f.ports.executeCopy = async input => { const result = await original(input); active = idForPath(f.destination); return result; };
  await assert.rejects(f.actions.runBoundSessionCopy(f.input), /身份.*冲突/);
  assert.deepEqual(f.events, ["copying:true", "execute", "copying:false", "recover"]);
});

test("a Runtime that appears during copy is considered by the post-RPC collision check", async () => {
  const ids = new Set<string>();
  const f = fixture({ liveRuntimeIds: () => ids });
  const original = f.ports.executeCopy;
  f.ports.executeCopy = async input => { const result = await original(input); ids.add(idForPath(f.destination)); return result; };
  await assert.rejects(f.actions.runBoundSessionCopy(f.input), /身份.*冲突/);
  assert.equal(f.events.at(-1), "recover");
});

test("unverified copy results retain the outcome fence and still restore the source", async () => {
  const f = fixture();
  f.ports.executeCopy = async () => ({ state: { model: null, isStreaming: false, sessionFile: f.input.sourcePath, sessionId: "source" }, cancelled: false, mutationOutcomeUnknown: false, copyMayHaveCommitted: true, outcomeToken: "token" });
  await assert.rejects(f.actions.runBoundSessionCopy(f.input), /复制结果尚未确认/);
  assert.deepEqual(f.events, ["copying:true", "fence", "copying:false", "recover"]);
});

test("copy rejection and cancellation both release copying state and recover the original writer", async () => {
  const failed = fixture({ executeCopy: async () => { throw new Error("RPC rejected"); } });
  await assert.rejects(failed.actions.runBoundSessionCopy(failed.input), /RPC rejected/);
  assert.deepEqual(failed.events, ["copying:true", "copying:false", "recover"]);
  const cancelled = fixture();
  cancelled.ports.executeCopy = async () => ({ state: { model: null, isStreaming: false, sessionFile: cancelled.input.sourcePath, sessionId: "source" }, cancelled: true, mutationOutcomeUnknown: false, copyMayHaveCommitted: false, outcomeToken: "token" });
  await assert.rejects(cancelled.actions.runBoundSessionCopy(cancelled.input), /取消/);
  assert.deepEqual(cancelled.events, ["copying:true", "copying:false", "recover"]);
});

test("a committed destination remains committed when recovery fails and forbids blind retry", async t => {
  t.mock.method(console, "error", () => {});
  const f = fixture({ recoverSource: async () => { throw new Error("exit unconfirmed"); } });
  const result = await f.actions.runBoundSessionCopy(f.input);
  assert.equal(result?.sessionId, idForPath(f.destination));
  assert.match(result?.warning || "", /已创建.*请勿重复操作/);
  assert.deepEqual(f.events, ["copying:true", "execute", "copying:false", "record-failure"]);
});

test("failed source recovery before a verified destination remains a hard failure", async () => {
  const f = fixture({ executeCopy: async () => { throw new Error("copy failed"); }, recoverSource: async () => { throw new Error("source recovery failed"); } });
  await assert.rejects(f.actions.runBoundSessionCopy(f.input), /source recovery failed/);
  assert.deepEqual(f.events, ["copying:true", "copying:false"]);
});

test("fork provenance reads only summary projections and tolerates unavailable source history", async t => {
  t.mock.method(console, "error", () => {});
  const relation = { sourceSessionId: "source", sourceName: "saved name", sourcePersistedMessageId: "entry", createdAt: 1 };
  const f = fixture({ readOrigin: async () => relation, sourceSummary: () => ({ name: "current name" }) });
  assert.deepEqual(await f.actions.forkOriginForSession("destination"), { ...relation, sourceName: "current name", sourceAvailable: true });
  f.ports.sourceSummary = () => undefined;
  f.ports.cachedSourceSummary = async () => ({ name: "cold name" });
  assert.equal((await f.actions.forkOriginForSession("destination"))?.sourceName, "cold name");
  f.ports.cachedSourceSummary = async () => { throw new Error("missing history"); };
  assert.deepEqual(await f.actions.forkOriginForSession("destination"), { ...relation, sourceAvailable: false });
  f.ports.readOrigin = async () => { throw new Error("invalid sidecar"); };
  assert.equal(await f.actions.forkOriginForSession("destination"), undefined);
  assert.deepEqual(f.events, [], "read-only provenance must not invoke copy or recovery capabilities");
});

test("the App adapter rejects a stale Runtime handle instead of selecting its replacement or Primary", async () => {
  const rpc = new FakeRpc("source", "source");
  const app = new PiChatApp({ rpc: rpc as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const internals = app as unknown as { runtimes: Map<string, SecondaryRuntime>; copyingSessionIds: Set<string>; runBoundSessionCopy(input: SessionCopyOriginInput): Promise<unknown> };
  // The two handles have the same id, but they are not the same Runtime owner.
  const oldHandle = Object.freeze({ id: "source" });
  internals.runtimes.set("source", { id: "source", rpc } as unknown as SecondaryRuntime);
  try {
    await assert.rejects(internals.runBoundSessionCopy({ id: "source", sourcePath: "source.jsonl", mode: "clone", runtime: oldHandle, knownSessionIds: new Set() }), /过期 writer/);
    assert.equal(rpc.commands.length, 0);
    assert.equal(rpc.restartCount, 0);
    assert.equal(internals.copyingSessionIds.size, 0);
  } finally { internals.runtimes.clear(); await app.close(); }
});
