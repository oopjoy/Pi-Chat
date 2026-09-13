import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
  rpc.generation = 7;
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
    assert.equal(value.schemaVersion, 4);
    assert.equal(value.runEpoch, "diagnostic-run");
    assert.equal(value.buildFingerprint, "a".repeat(64));
    assert.ok(value.entries.some((entry) =>
      entry.category === "rpc-event" && entry.details.eventType === "tool_execution_start",
    ));
    assert.ok(value.entries.some((entry) =>
      entry.category === "rpc-event" && entry.details.eventType === "agent_settled",
    ));
    assert.equal(value.entries.some((entry) => entry.details.eventType === "message_update"), false);
    assert.equal(
      value.entries.filter((entry) =>
        entry.category === "sse-transport" && entry.name === "snapshot-summary"
      ).length,
      1,
      "thousands of cumulative frames retain one aggregate run summary",
    );
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


test("server streaming diagnostics aggregate hot frames after terminal transport flush", async () => {
  const target = await fixture();
  const frames: string[] = [];
  const client = new EventEmitter() as EventEmitter & {
    write(frame: string): boolean;
    end(): void;
  };
  client.write = (frame) => { frames.push(frame); return true; };
  client.end = () => undefined;
  const internals = target.app as unknown as {
    sseClients: Map<unknown, string>;
    broadcast(event: Record<string, unknown>): void;
    stateDiagnostics: { snapshot(): ServerStateDiagnosticSnapshot };
  };
  internals.sseClients.set(client, "diagnostic-client");
  try {
    internals.broadcast({
      type: "message_update",
      piChatSessionId: target.id,
      piChatRunGeneration: 31,
      message: { role: "assistant", content: "private cumulative one" },
    });
    internals.broadcast({
      type: "message_update",
      piChatSessionId: target.id,
      piChatRunGeneration: 31,
      message: { role: "assistant", content: "private cumulative two" },
    });
    internals.broadcast({
      type: "agent_settled",
      piChatSessionId: target.id,
      piChatRunGeneration: 31,
    });
    assert.equal(frames.length, 3);
    assert.match(frames[1], /private cumulative two/);
    assert.match(frames[2], /agent_settled/);
    const entries = internals.stateDiagnostics.snapshot().entries;
    const summaries = entries.filter((entry) =>
      entry.category === "sse-transport"
      && entry.name === "snapshot-summary"
      && entry.sessionId === target.id
      && entry.runGeneration === 31
    );
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].details.snapshotsWritten, 2);
    assert.equal(summaries[0].details.snapshotsScheduled, 1);
    assert.equal(
      entries.some((entry) => entry.details.eventType === "message_update"),
      false,
      "hot frame diagnostics must remain aggregate-only",
    );
    assert.equal(JSON.stringify(entries).includes("private cumulative"), false);
  } finally {
    await target.close();
  }
});


test("explicit diagnostic snapshot checkpoints an active streaming aggregate", async () => {
  const target = await fixture();
  const client = new EventEmitter() as EventEmitter & {
    write(frame: string): boolean;
    end(): void;
  };
  client.write = () => true;
  client.end = () => undefined;
  const internals = target.app as unknown as {
    sseClients: Map<unknown, string>;
    broadcast(event: Record<string, unknown>): void;
  };
  internals.sseClients.set(client, "diagnostic-client");
  try {
    await register(target.origin, ownerA);
    internals.broadcast({
      type: "message_update",
      piChatSessionId: target.id,
      piChatRunGeneration: 32,
      message: { role: "assistant", content: "private active cumulative" },
    });
    const value = (await snapshot(target.origin, ownerA)).value!;
    const summary = value.entries.find((entry) =>
      entry.category === "sse-transport"
      && entry.name === "snapshot-summary"
      && entry.runGeneration === 32
    );
    assert.ok(summary);
    assert.equal(summary.details.snapshotsWritten, 1);
    assert.equal(JSON.stringify(value).includes("private active cumulative"), false);
  } finally {
    await target.close();
  }
});

test("ordinary Primary prompt diagnostics correlate synchronous start through settlement barrier", async () => {
  const target = await fixture();
  try {
    await register(target.origin, ownerA);
    assert.equal((await fetch(`${target.origin}/api/bootstrap`, { headers: ownerA })).status, 200);
    const response = await fetch(`${target.origin}/api/chat/prompt`, {
      method: "POST",
      headers: { ...ownerA, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: target.id, message: "private prompt text" }),
    });
    assert.equal(response.status, 202);
    target.rpc.streaming = false;
    target.rpc.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const value = (await snapshot(target.origin, ownerA)).value!;
    const promptEntries = value.entries.filter((entry) => entry.category === "prompt");
    const promptIds = [...new Set(promptEntries.map((entry) => entry.promptId).filter(Boolean))];
    assert.equal(promptIds.length, 1);
    assert.match(promptIds[0] || "", /^[a-f0-9-]{36}$/);
    assert.ok(
      promptEntries.every((entry) => entry.rpcGeneration === 7),
      "production-style prompt correlation must retain the source-tagged child generation",
    );
    assert.deepEqual(
      promptEntries.map((entry) => entry.name),
      [
        "admitted",
        "dispatch",
        "rpc-allocated",
        "rpc-written",
        "agent-start",
        "rpc-response",
        "settled",
        "settlement-barrier",
      ],
    );
    assert.equal(JSON.stringify(value).includes("private prompt text"), false);
    assert.equal(value.promptEvidence.records.length, 1);
    assert.equal(value.promptEvidence.records[0].promptId, promptIds[0]);
    assert.equal(value.promptEvidence.records[0].sessionId, target.id);
    assert.equal(value.promptEvidence.records[0].delivery, "confirmed");
    assert.equal(value.promptEvidence.records[0].execution, "settled");
    assert.deepEqual(value.promptEvidence.records[0].facts, [
      "admitted",
      "dispatch",
      "rpc-allocated",
      "rpc-written",
      "agent-start",
      "rpc-response-success",
      "settled",
      "settlement-barrier",
    ]);
    assert.equal(
      (target.app as unknown as { activePromptDiagnostics: Map<string, unknown> })
        .activePromptDiagnostics.size,
      0,
    );
  } finally {
    await target.close();
  }
});

test("settlement barrier failure does not invent prompt execution failure", async () => {
  const target = await fixture();
  try {
    await register(target.origin, ownerA);
    await fetch(`${target.origin}/api/bootstrap`, { headers: ownerA });
    const response = await fetch(`${target.origin}/api/chat/prompt`, {
      method: "POST",
      headers: { ...ownerA, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: target.id, message: "private barrier prompt" }),
    });
    assert.equal(response.status, 202);
    const originalSend = target.rpc.send.bind(target.rpc);
    target.rpc.send = (async (command: Record<string, unknown>, timeoutMs?: number, options?: { independentRead?: boolean }) => {
      if (command.type === "get_state" && options?.independentRead)
        throw new Error("simulated settlement barrier failure");
      return originalSend(command, timeoutMs, options);
    }) as typeof target.rpc.send;
    target.rpc.streaming = false;
    target.rpc.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const value = (await snapshot(target.origin, ownerA)).value!;
    const evidence = value.promptEvidence.records[0];
    assert.equal(evidence.delivery, "confirmed");
    assert.equal(evidence.execution, "settled");
    assert.equal(evidence.facts.includes("process-failed"), false);
    assert.ok(value.entries.some((entry) =>
      entry.category === "prompt" && entry.name === "process-failed"
    ), "the legacy raw trace remains available without upgrading the ledger");
  } finally {
    await target.close();
  }
});

test("current process failure settles and clears active prompt diagnostics", async () => {
  const target = await fixture();
  try {
    await register(target.origin, ownerA);
    await fetch(`${target.origin}/api/bootstrap`, { headers: ownerA });
    const response = await fetch(`${target.origin}/api/chat/prompt`, {
      method: "POST",
      headers: { ...ownerA, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: target.id, message: "private crash prompt" }),
    });
    assert.equal(response.status, 202);
    target.rpc.crash();
    const entries = (await snapshot(target.origin, ownerA)).value!.entries.filter((entry) =>
      entry.category === "prompt"
    );
    assert.ok(entries.some((entry) => entry.name === "process-failed"));
    assert.equal(JSON.stringify(entries).includes("private crash prompt"), false);
    const evidence = (await snapshot(target.origin, ownerA)).value!.promptEvidence.records[0];
    assert.equal(evidence.delivery, "confirmed");
    assert.equal(evidence.execution, "failed");
    assert.ok(evidence.facts.includes("process-failed"));
    assert.equal(
      (target.app as unknown as { activePromptDiagnostics: Map<string, unknown> })
        .activePromptDiagnostics.size,
      0,
    );
  } finally {
    await target.close();
  }
});

test("stale RPC generations cannot bind a current prompt diagnostic", async () => {
  const target = await fixture();
  const promptId = "33333333-3333-4333-8333-333333333333";
  const internals = target.app as unknown as {
    primaryBoundSessionId: string;
    primaryRpcGeneration: number;
    activePromptDiagnostics: Map<string, { promptId: string; rpcGeneration: number }>;
    handleRpcEvent(event: Record<string, unknown>, source: { generation: number }): void;
    stateDiagnostics: { snapshot(): ServerStateDiagnosticSnapshot };
  };
  try {
    await fetch(`${target.origin}/api/bootstrap`);
    internals.primaryBoundSessionId = target.id;
    internals.primaryRpcGeneration = 7;
    internals.activePromptDiagnostics.set(target.id, { promptId, rpcGeneration: 7 });
    internals.handleRpcEvent({ type: "agent_start" }, { generation: 6 });
    assert.equal(
      internals.stateDiagnostics.snapshot().entries.some((entry) => entry.promptId === promptId),
      false,
    );
    internals.handleRpcEvent({ type: "agent_start" }, { generation: 7 });
    assert.ok(
      internals.stateDiagnostics.snapshot().entries.some((entry) =>
        entry.promptId === promptId && entry.name === "agent-start"
      ),
    );
  } finally {
    await target.close();
  }
});

test("app close clears observation-only prompt correlation", async () => {
  const target = await fixture();
  const active = (target.app as unknown as {
    activePromptDiagnostics: Map<string, { promptId: string; rpcGeneration: number }>;
  }).activePromptDiagnostics;
  active.set(target.id, {
    promptId: "44444444-4444-4444-8444-444444444444",
    rpcGeneration: 0,
  });
  await target.close();
  assert.equal(active.size, 0);
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

test("process failures are normalized and redacted at the SSE boundary", async () => {
  const target = await fixture();
  const internals = target.app as unknown as {
    broadcast: (event: Record<string, unknown>) => void;
    broadcastRpcEvent: (event: Record<string, unknown>, sessionId: string, runGeneration?: number) => void;
    promptRpcObserver: (rpc: unknown, sessionId: string, promptId: string) => unknown;
    broadcastPromptFailureLifecycle: (sessionId: string, event: Record<string, unknown>, runGeneration: number, rpcGeneration: number) => void;
  };
  const captured: Record<string, unknown>[] = [];
  const originalBroadcast = internals.broadcast;
  internals.broadcast = (event) => { captured.push(event); };
  try {
    internals.promptRpcObserver({}, target.id, "prompt-123");
    internals.broadcastPromptFailureLifecycle(target.id, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Retry failed after 3 attempts: OpenAI API error (503): server_is_overloaded",
        provider: "cpa-proxy",
        model: "gpt-6-astra",
        api: "openai-responses",
      },
    }, 4, 3);
    assert.equal(captured.length, 0);
    internals.broadcastPromptFailureLifecycle(target.id, { type: "agent_settled" }, 4, 3);
    assert.equal(captured.length, 2);
    assert.equal(captured[0].type, "pi_chat_prompt_failed");
    assert.equal(captured[1].type, "pi_chat_prompt_retry_exhausted");
    assert.equal(captured[0].piChatSessionId, target.id);
    assert.equal(captured[0].piChatRunGeneration, 4);
    assert.equal(captured[0].piChatPromptId, "prompt-123");
    assert.equal(captured[0].failureKind, "overloaded");
    assert.equal(captured[0].retryAttempts, 3);
    captured.length = 0;
    internals.broadcastRpcEvent({
      type: "pi_chat_process_error",
      error: "OpenAI API error (503): server_is_overloaded sk-live-secret-value",
      errorCode: "PI_PROVIDER_FAILURE",
      incidentId: "PC-ABCDEFGH",
      provider: "cpa-proxy",
      model: "gpt-6-astra",
      api: "openai-responses",
    }, target.id, 3);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].error?.includes("sk-live-secret-value"), false);
    const failure = captured[0].failure as { kind?: string; provider?: string; model?: string; api?: string; status?: number };
    assert.deepEqual(failure, {
      kind: "overloaded",
      provider: "cpa-proxy",
      model: "gpt-6-astra",
      api: "openai-responses",
      status: 503,
      incidentId: "PC-ABCDEFGH",
      message: "OpenAI API error (503): server_is_overloaded [已隐藏]",
    });
  } finally {
    internals.broadcast = originalBroadcast;
    await target.close();
  }
});

test("native retry lifecycle is projected once and never leaks raw error text", async () => {
  const target = await fixture();
  const internals = target.app as unknown as {
    broadcast: (event: Record<string, unknown>) => void;
    promptRpcObserver: (rpc: unknown, sessionId: string, promptId: string) => unknown;
    broadcastPromptFailureLifecycle: (sessionId: string, event: Record<string, unknown>, runGeneration: number, rpcGeneration: number) => void;
  };
  const captured: Record<string, unknown>[] = [];
  const originalBroadcast = internals.broadcast;
  internals.broadcast = (event) => { captured.push(event); };
  try {
    internals.promptRpcObserver({}, target.id, "prompt-retry");
    internals.broadcastPromptFailureLifecycle(target.id, {
      type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 25,
      errorMessage: "provider secret sk-live-should-not-appear",
    }, 2, 1);
    internals.broadcastPromptFailureLifecycle(target.id, { type: "agent_start" }, 3, 1);
    internals.broadcastPromptFailureLifecycle(target.id, {
      type: "message_end", message: {
        role: "assistant", content: [], stopReason: "error",
        errorMessage: "attempt failed",
      },
    }, 3, 1);
    internals.broadcastPromptFailureLifecycle(target.id, {
      type: "auto_retry_end", success: false, attempt: 1, finalError: "final failed",
    }, 3, 1);
    internals.broadcastPromptFailureLifecycle(target.id, { type: "agent_settled" }, 3, 1);
    assert.deepEqual(captured.map((event) => event.type), [
      "pi_chat_prompt_retry_scheduled",
      "pi_chat_prompt_retry_started",
      "pi_chat_prompt_retry_exhausted",
      "pi_chat_prompt_failed",
    ]);
    assert.equal(JSON.stringify(captured).includes("sk-live-should-not-appear"), false);
    assert.equal(captured.filter((event) => event.type === "pi_chat_prompt_retry_exhausted").length, 1);
    assert.equal(captured.at(-1)?.piChatPromptId, "prompt-retry");
  } finally {
    internals.broadcast = originalBroadcast;
    await target.close();
  }
});

test("retry end without a final error does not invent exhaustion or a terminal failure", async () => {
  const target = await fixture();
  const internals = target.app as unknown as {
    broadcast: (event: Record<string, unknown>) => void;
    promptRpcObserver: (rpc: unknown, sessionId: string, promptId: string) => unknown;
    broadcastPromptFailureLifecycle: (sessionId: string, event: Record<string, unknown>, runGeneration: number, rpcGeneration: number) => void;
  };
  const captured: Record<string, unknown>[] = [];
  const originalBroadcast = internals.broadcast;
  internals.broadcast = (event) => { captured.push(event); };
  try {
    internals.promptRpcObserver({}, target.id, "prompt-inconclusive");
    internals.broadcastPromptFailureLifecycle(target.id, {
      type: "auto_retry_start", attempt: 1, maxAttempts: 2, errorMessage: "attempt failed",
    }, 2, 1);
    internals.broadcastPromptFailureLifecycle(target.id, {
      type: "auto_retry_end", success: false, attempt: 1,
    }, 2, 1);
    internals.broadcastPromptFailureLifecycle(target.id, { type: "agent_settled" }, 2, 1);
    assert.deepEqual(captured.map((event) => event.type), ["pi_chat_prompt_retry_scheduled"]);
  } finally {
    internals.broadcast = originalBroadcast;
    await target.close();
  }
});

test("abort during native retry settles one Prompt without inventing retry cancellation", async () => {
  const target = await fixture();
  const internals = target.app as unknown as {
    broadcast: (event: Record<string, unknown>) => void;
    promptRpcObserver: (rpc: unknown, sessionId: string, promptId: string) => unknown;
    broadcastPromptFailureLifecycle: (sessionId: string, event: Record<string, unknown>, runGeneration: number, rpcGeneration: number) => void;
  };
  const captured: Record<string, unknown>[] = [];
  const originalBroadcast = internals.broadcast;
  internals.broadcast = (event) => { captured.push(event); };
  try {
    internals.promptRpcObserver({}, target.id, "prompt-abort-retry");
    internals.broadcastPromptFailureLifecycle(target.id, {
      type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "attempt failed",
    }, 2, 1);
    internals.broadcastPromptFailureLifecycle(target.id, {
      type: "pi_chat_process_error",
      error: "用户取消了请求",
      failureKind: "user-aborted",
    }, 2, 1);
    assert.deepEqual(captured.map((event) => event.type), [
      "pi_chat_prompt_retry_scheduled",
      "pi_chat_prompt_failed",
    ]);
    assert.equal(captured.at(-1)?.piChatPromptId, "prompt-abort-retry");
    assert.equal(captured.some((event) => event.type === "pi_chat_prompt_retry_exhausted"), false);
    assert.equal(captured.some((event) => event.type === "pi_chat_prompt_retry_cancelled"), false);
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

test("oversized cumulative snapshots remain aggregate-only in server diagnostics", async () => {
  const target = await fixture();
  const client = new EventEmitter() as EventEmitter & {
    write(frame: string): boolean;
    end(): void;
  };
  client.write = () => true;
  client.end = () => undefined;
  const internals = target.app as unknown as {
    sseClients: Map<unknown, string>;
    broadcast(event: Record<string, unknown>): void;
    stateDiagnostics: { snapshot(): ServerStateDiagnosticSnapshot };
  };
  internals.sseClients.set(client, "diagnostic-client");
  try {
    internals.broadcast({
      type: "message_update",
      piChatSessionId: target.id,
      piChatRunGeneration: 33,
      message: {
        role: "assistant",
        content: `private oversized cumulative ${"x".repeat(530 * 1024)}`,
      },
    });
    internals.broadcast({
      type: "agent_settled",
      piChatSessionId: target.id,
      piChatRunGeneration: 33,
    });
    const entries = internals.stateDiagnostics.snapshot().entries;
    const summaries = entries.filter((entry) =>
      entry.category === "sse-transport"
      && entry.name === "snapshot-summary"
      && entry.runGeneration === 33
    );
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].details.snapshotsOversized, 1);
    assert.equal(summaries[0].details.snapshotsWritten, 1);
    assert.equal(
      entries.some((entry) =>
        entry.category === "sse-transport"
        && entry.name === "oversized-substitute"
        && entry.details.originalEventType === "message_update"
      ),
      false,
    );
    assert.equal(JSON.stringify(entries).includes("private oversized cumulative"), false);
  } finally {
    await target.close();
  }
});
