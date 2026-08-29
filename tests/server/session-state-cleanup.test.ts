import assert from "node:assert/strict";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import type { PiRpcClient } from "../../src/server/rpc-client";
import type { ResourceManager } from "../../src/server/resource-manager";
import { FakeRpc } from "../helpers/server-app-fixture";
import type { SessionIndex } from "../../src/server/session-index";

const SESSION_ID = "0123456789abcdefabcd";

function appForTest(): PiChatApp {
  const rpc = {
    onEvent: () => () => undefined,
    send: async () => ({
      type: "response",
      success: true,
      data: { model: null, isStreaming: false },
    }),
  } as unknown as PiRpcClient;
  return new PiChatApp({
    rpc,
    sessions: {} as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    runEpoch: "cleanup-test",
  });
}

test("resource reload clears transient Primary state while retaining the Gate preference", async () => {
  const rpc = new FakeRpc("C:\\sessions\\reload.jsonl", "reload");
  const app = new PiChatApp({
    rpc: rpc as unknown as PiRpcClient,
    sessions: {} as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const internals = app as unknown as {
    ensurePrimaryIdentity: () => Promise<void>;
    reloadRpc: (state?: { model: null; isStreaming: boolean; sessionFile?: string }) => Promise<void>;
    activeSessionId: string;
    runGenerationsBySession: Map<string, number>;
    gateModesBySession: Map<string, string>;
    fastModeBySession: Map<string, boolean>;
    pendingNativeSteeringBySession: Map<string, unknown>;
    contextUsagePendingRefresh: Set<string>;
  };
  try {
    await internals.ensurePrimaryIdentity();
    const id = internals.activeSessionId;
    internals.runGenerationsBySession.set(id, 2);
    internals.gateModesBySession.set(id, "open");
    internals.fastModeBySession.set(id, true);
    internals.pendingNativeSteeringBySession.set(id, {
      generation: 2,
      messages: ["stale"],
      dequeued: [],
    });
    internals.contextUsagePendingRefresh.add(id);
    await internals.reloadRpc({ model: null, isStreaming: false, sessionFile: rpc.path });
    assert.equal(internals.fastModeBySession.has(id), false);
    assert.equal(internals.pendingNativeSteeringBySession.has(id), false);
    assert.equal(internals.contextUsagePendingRefresh.has(id), false);
    assert.ok((internals.runGenerationsBySession.get(id) || 0) >= 3);
    assert.equal(internals.gateModesBySession.get(id), "open");
    assert.ok(rpc.commands.some((command) => command.type === "prompt" && command.message === "/gate open"));
  } finally {
    await app.close();
  }
});

test("app close waits for an in-flight native Steer reset before stopping workers", async () => {
  const app = appForTest();
  let release!: () => void;
  const reset = new Promise<void>((resolve) => {
    release = resolve;
  });
  const internals = app as unknown as {
    nativeSteeringResets: Map<string, Promise<void>>;
  };
  internals.nativeSteeringResets.set(SESSION_ID, reset);
  let closed = false;
  const closing = app.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(closed, true);
});

test("a closed app refuses to start a native Steer reset", async () => {
  const app = appForTest();
  const internals = app as unknown as {
    closed: boolean;
    resetNativeSteering: (sessionId: string) => Promise<void>;
  };
  internals.closed = true;
  await internals.resetNativeSteering(SESSION_ID);
  await app.close();
});

test("app close fences and drains already-admitted Primary operations", async () => {
  const app = appForTest();
  const internals = app as unknown as {
    primaryOperationAdmission: { acquire(): { release(): void }; isClosed: boolean };
  };
  const operation = internals.primaryOperationAdmission.acquire();
  let closed = false;
  const closing = app.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(internals.primaryOperationAdmission.isClosed, true);
  operation.release();
  await closing;
  assert.equal(closed, true);
});

test("late Primary settlement work and buffered events are inert after app close", async () => {
  const rpc = new FakeRpc("C:\\sessions\\close-settlement.jsonl", "close-settlement");
  const app = new PiChatApp({
    rpc: rpc as unknown as PiRpcClient,
    sessions: {} as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const internals = app as unknown as {
    ensurePrimaryIdentity: () => Promise<void>;
    drainPrimaryAfterSettlement: (sessionId: string, generation: number) => Promise<void>;
    primaryBoundSessionId: string;
    primaryRpcGeneration: number;
    running: boolean;
    lastPrimaryState: { isStreaming?: boolean };
  };
  let releaseBarrier!: () => void;
  let barrierStarted!: () => void;
  const barrierReady = new Promise<void>((resolve) => { barrierStarted = resolve; });
  const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
  const originalSend = rpc.send.bind(rpc);
  rpc.send = async (command, timeoutMs, options) => {
    if (command.type === "get_state" && options?.independentRead) {
      barrierStarted();
      await barrier;
      return {
        type: "response",
        success: true,
        data: {
          model: null,
          sessionFile: rpc.path,
          sessionId: rpc.sessionId,
          isStreaming: true,
        },
      };
    }
    return originalSend(command, timeoutMs, options);
  };
  try {
    await internals.ensurePrimaryIdentity();
    rpc.commands.length = 0;
    const lateDrain = internals.drainPrimaryAfterSettlement(
      internals.primaryBoundSessionId,
      internals.primaryRpcGeneration,
    );
    await barrierReady;
    await app.close();
    rpc.emitLate({ type: "agent_settled" });
    releaseBarrier();
    await lateDrain;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(internals.running, false, "a closed app must not accept a late settlement state");
    assert.equal(internals.lastPrimaryState.isStreaming, false, "late settlement cannot repaint closed state");
    assert.equal(
      rpc.commands.some((command) => command.type === "get_state"),
      false,
      "a buffered post-close event must not start another settlement barrier",
    );
  } finally {
    releaseBarrier();
    await app.close();
  }
});

test("Session deletion cleanup removes every server-owned per-Session projection", async () => {
  const app = appForTest();
  const timer = setTimeout(() => undefined, 60_000);
  timer.unref();
  const internals = app as unknown as {
    clearSessionRuntimeTransientState: (id: string, reason: string, options?: { removeGatePreference?: boolean }) => void;
    pendingExtensionTimers: Map<string, NodeJS.Timeout>;
    activePromptDiagnostics: Map<string, unknown>;
    contextUsagePendingRefresh: Set<string>;
    contextUsageRefreshTurn: Set<string>;
    compactionPendingBySession: Set<string>;
    rpcOutcomePendingBySession: Set<string>;
    runGenerationsBySession: Map<string, number>;
    gateModesBySession: Map<string, string>;
    fastModeBySession: Map<string, boolean>;
    pendingNativeSteeringBySession: Map<string, unknown>;
    nativeSteeringAdmissionsBySession: Map<string, unknown>;
    nativeSteeringResetAfterSettlement: Map<string, number>;
    nativeSteeringDequeueResults: Map<string, { sessionId: string }>;
    runtimeFailureReasonsBySession: Map<string, string>;
    runtimeIncidentIdsBySession: Map<string, string>;
    copyRecoveryPendingSessionIds: Set<string>;
    liveMessageIdentities: { project: (id: string, event: Record<string, unknown>) => unknown };
  };
  internals.pendingExtensionTimers.set(SESSION_ID, timer);
  internals.activePromptDiagnostics.set(SESSION_ID, { promptId: "prompt" });
  internals.contextUsagePendingRefresh.add(SESSION_ID);
  internals.contextUsageRefreshTurn.add(SESSION_ID);
  internals.compactionPendingBySession.add(SESSION_ID);
  internals.rpcOutcomePendingBySession.add(SESSION_ID);
  internals.runGenerationsBySession.set(SESSION_ID, 4);
  internals.gateModesBySession.set(SESSION_ID, "open");
  internals.fastModeBySession.set(SESSION_ID, true);
  internals.pendingNativeSteeringBySession.set(SESSION_ID, {
    generation: 4,
    messages: ["steer"],
    dequeued: [],
  });
  internals.nativeSteeringAdmissionsBySession.set(SESSION_ID, {
    generation: 4,
    items: [{ id: "steer", message: "steer", promptAt: 1, imageChars: 0 }],
  });
  internals.nativeSteeringResetAfterSettlement.set(SESSION_ID, 4);
  internals.nativeSteeringDequeueResults.set("dequeue", { sessionId: SESSION_ID });
  internals.runtimeFailureReasonsBySession.set(SESSION_ID, "failed");
  internals.runtimeIncidentIdsBySession.set(SESSION_ID, "PC-12345678");
  internals.copyRecoveryPendingSessionIds.add(SESSION_ID);
  internals.liveMessageIdentities.project(SESSION_ID, {
    type: "message_start",
    message: { role: "assistant", content: "live" },
  });

  try {
    internals.clearSessionRuntimeTransientState(SESSION_ID, "deleted", {
      removeGatePreference: true,
    });
    assert.equal(internals.pendingExtensionTimers.has(SESSION_ID), false);
    assert.equal(internals.activePromptDiagnostics.has(SESSION_ID), false);
    assert.equal(internals.contextUsagePendingRefresh.has(SESSION_ID), false);
    assert.equal(internals.contextUsageRefreshTurn.has(SESSION_ID), false);
    assert.equal(internals.compactionPendingBySession.has(SESSION_ID), false);
    assert.equal(internals.rpcOutcomePendingBySession.has(SESSION_ID), false);
    assert.equal(internals.runGenerationsBySession.has(SESSION_ID), false, "deletion drops the run generation anchor after cleanup");
    assert.equal(internals.gateModesBySession.has(SESSION_ID), false);
    assert.equal(internals.fastModeBySession.has(SESSION_ID), false);
    assert.equal(internals.pendingNativeSteeringBySession.has(SESSION_ID), false);
    assert.equal(internals.nativeSteeringAdmissionsBySession.has(SESSION_ID), false);
    assert.equal(internals.nativeSteeringResetAfterSettlement.has(SESSION_ID), false);
    assert.equal(internals.nativeSteeringDequeueResults.has("dequeue"), false);
    assert.equal(internals.runtimeFailureReasonsBySession.has(SESSION_ID), false);
    assert.equal(internals.runtimeIncidentIdsBySession.has(SESSION_ID), false);
    assert.equal(internals.copyRecoveryPendingSessionIds.has(SESSION_ID), false);
  } finally {
    await app.close();
  }
});
