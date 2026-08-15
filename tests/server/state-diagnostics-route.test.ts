import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import type { PiRpcClient } from "../../src/server/rpc-client";
import { idForPath } from "../../src/server/session-index";
import type { SessionIndex } from "../../src/server/session-index";
import type { ResourceManager } from "../../src/server/resource-manager";
import type { ServerStateDiagnosticSnapshot } from "../../src/shared/state-diagnostics";
import { diagnosticFrame } from "../../src/web/hooks/use-pi-event-source";
import { FakeRpc } from "../helpers/server-app-fixture";

async function fixture() {
  const path = "C:\\sessions\\diagnostic-state.jsonl";
  const id = idForPath(path);
  const rpc = new FakeRpc(path, "diagnostic-state");
  const summary = {
    id,
    sessionId: "diagnostic-state",
    name: "Diagnostic",
    preview: "",
    cwd: process.cwd(),
    updatedAt: 1,
    messageCount: 1,
    active: true,
  };
  const sessions = {
    list: async () => [summary],
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: (candidate: string) => candidate === id ? summary : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: rpc as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    buildIdentity: {
      schemaVersion: 1,
      packageVersion: "test",
      revision: "diagnostic-revision",
      fingerprint: "a".repeat(64),
      builtAt: new Date(0).toISOString(),
    },
    runEpoch: "diagnostic-run",
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    app,
    rpc,
    id,
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => { server.close(); await app.close(); },
  };
}

const ownerA = {
  "x-pi-chat-client": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "x-pi-chat-page": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};
const ownerB = {
  "x-pi-chat-client": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "x-pi-chat-page": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};

async function register(origin: string, headers: Record<string, string>): Promise<void> {
  assert.equal((await fetch(`${origin}/api/bootstrap/handshake`, { headers })).status, 200);
}

async function snapshot(origin: string, headers: Record<string, string>) {
  const response = await fetch(`${origin}/api/diagnostics/snapshot`, { headers });
  return { response, value: response.ok ? await response.json() as ServerStateDiagnosticSnapshot : null };
}

test("always-on diagnostic snapshot captures redacted API, RPC, SSE, and projections", async () => {
  const target = await fixture();
  try {
    await register(target.origin, ownerA);
    assert.equal((await fetch(`${target.origin}/api/bootstrap`, { headers: ownerA })).status, 200);
    target.rpc.emit({
      type: "tool_execution_start",
      toolName: "bash",
      message: "private prompt",
      content: "private answer",
      cwd: "C:\\private",
      requestToken: "secret-token",
    });
    target.rpc.emit({ type: "secret-token C:\\private\\key.txt" });
    for (let index = 0; index < 2_500; index += 1)
      target.rpc.emit({
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: String(index) }] },
      });
    target.rpc.emit({ type: "agent_settled" });
    assert.equal((await fetch(`${target.origin}/api/sessions/${target.id}/view`, { headers: ownerA })).status, 200);
    const malformed = await fetch(`${target.origin}/api/chat/prompt`, {
      method: "POST",
      headers: { ...ownerA, "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);

    const result = await snapshot(target.origin, ownerA);
    assert.equal(result.response.status, 200);
    const value = result.value!;
    assert.equal(value.schemaVersion, 2);
    assert.equal(value.runEpoch, "diagnostic-run");
    assert.equal(value.buildFingerprint, "a".repeat(64));
    assert.ok(value.entries.some((entry) =>
      entry.category === "rpc-event" && entry.details.eventType === "tool_execution_start",
    ));
    assert.ok(value.entries.some((entry) =>
      entry.category === "rpc-event" && entry.details.eventType === "agent_settled",
    ));
    assert.equal(value.entries.some((entry) => entry.details.eventType === "message_update"), false);
    assert.ok(value.entries.some((entry) =>
      entry.category === "sse-transport" && entry.details.eventType === "tool_execution_start",
    ));
    assert.ok(value.entries.some((entry) =>
      entry.category === "projection" && entry.name === "bootstrap",
    ));
    assert.ok(value.entries.some((entry) =>
      entry.category === "projection" && entry.name === "session-view",
    ));
    const failedRequest = value.entries.filter((entry) =>
      entry.category === "http" && entry.details.route === "/api/chat/prompt",
    );
    assert.deepEqual(failedRequest.map((entry) => entry.name), [
      "request-start",
      "request-error",
      "request-end",
    ]);
    assert.equal(
      value.entries.some((entry) => entry.details.route === "/api/diagnostics/snapshot"),
      false,
      "snapshot reads must not add an incomplete span to their own export",
    );
    const raw = JSON.stringify(value);
    for (const forbidden of [
      "private prompt",
      "private answer",
      "C:\\\\private",
      "secret-token",
    ]) assert.equal(raw.includes(forbidden), false, forbidden);
  } finally {
    await target.close();
  }
});

test("registered pages can independently snapshot one process recorder without ownership", async () => {
  const target = await fixture();
  try {
    await register(target.origin, ownerA);
    await register(target.origin, ownerB);
    target.rpc.emit({ type: "agent_start" });
    const first = await snapshot(target.origin, ownerA);
    const second = await snapshot(target.origin, ownerB);
    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 200);
    assert.deepEqual(second.value?.entries, first.value?.entries);

    assert.equal((await fetch(`${target.origin}/api/window/close`, {
      method: "POST",
      headers: ownerA,
    })).status, 200);
    const stale = await snapshot(target.origin, ownerA);
    assert.equal(stale.response.status, 409);
    assert.equal((await stale.response.json() as { code?: string }).code, "DIAGNOSTIC_PAGE_NOT_REGISTERED");
    assert.equal((await snapshot(target.origin, ownerB)).response.status, 200);
  } finally {
    await target.close();
  }
});

test("server-appended Runtime metadata remains the final diagnostic attribution", async () => {
  const target = await fixture();
  const internals = target.app as unknown as {
    broadcast: (event: Record<string, unknown>) => void;
    broadcastRpcEvent: (
      event: Record<string, unknown>,
      sessionId: string,
      runGeneration?: number,
    ) => void;
  };
  const originalBroadcast = internals.broadcast;
  const captured: Record<string, unknown>[] = [];
  internals.broadcast = (event) => { captured.push(event); };
  try {
    internals.broadcastRpcEvent({
      piChatSessionId: "fedcba9876543210abcd",
      type: "message_end",
      message: {
        role: "assistant",
        content: "x".repeat(8_000),
        piChatSessionId: "11111111111111111111",
        piChatRunGeneration: 999,
      },
      piChatRunEpoch: "untrusted",
      piChatRunGeneration: 998,
    }, target.id, 17);
    assert.equal(captured.length, 1);
    assert.deepEqual(Object.keys(captured[0]).slice(-3), [
      "piChatSessionId",
      "piChatRunEpoch",
      "piChatRunGeneration",
    ]);
    const frame = diagnosticFrame(JSON.stringify(captured[0]));
    assert.equal(frame.sessionId, target.id);
    assert.equal(frame.runGeneration, 17);
  } finally {
    internals.broadcast = originalBroadcast;
    await target.close();
  }
});

test("server diagnostic failures do not perturb Runtime events or HTTP", async () => {
  const target = await fixture();
  const recorder = (target.app as unknown as {
    stateDiagnostics: { record: (...args: unknown[]) => void };
  }).stateDiagnostics;
  const originalRecord = recorder.record;
  recorder.record = () => { throw new Error("diagnostic failure"); };
  try {
    assert.doesNotThrow(() => target.rpc.emit({ type: "agent_start" }));
    assert.equal((await fetch(`${target.origin}/api/bootstrap`, { headers: ownerA })).status, 200);
  } finally {
    recorder.record = originalRecord;
    await target.close();
  }
});
