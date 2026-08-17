import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { MAX_RPC_INBOUND_LINE_BYTES, MAX_RPC_OUTBOUND_LINE_BYTES } from "../src/shared/rpc-contracts";
import type { IncidentDiagnostics, IncidentFields } from "../src/server/incident-diagnostics";
import {
  PiRpcClient,
  RpcFrameTooLargeError,
  RpcProcessExitUnconfirmedError,
  RpcRequestTimeoutError,
  resolvePiEntry,
  type RpcRequestObservation,
  rpcData,
} from "../src/server/rpc-client";

const piEntry = resolvePiEntry();

function incidentCollector() {
  const records: Array<IncidentFields & { incidentId: string }> = [];
  const diagnostics: IncidentDiagnostics = {
    directory: null,
    hostId: "test-host",
    hashSession: () => "session-hash",
    hashBrowser: () => "browser-hash",
    hashPage: () => "page-hash",
    record: (fields) => {
      const incidentId = `PC-TEST${String(records.length).padStart(4, "0")}`;
      records.push({ ...fields, incidentId });
      return { incidentId };
    },
    async flush() {},
    async close() {},
  };
  return { records, diagnostics };
}

test("RPC compatibility probe reports missing required capabilities", async () => {
  const client = new PiRpcClient({ cwd: process.cwd() });
  const responses: Record<string, unknown> = {
    get_state: { isStreaming: false },
    get_messages: { messages: [] },
    get_available_models: { models: [] },
    get_commands: { commands: [] },
    get_session_stats: { tokens: {} },
  };
  Object.assign(client, { send: async (command: Record<string, unknown>) => ({ type: "response", success: true, data: responses[command.type as string] }) });
  assert.deepEqual(await client.probeCompatibility(), { compatible: true, diagnostics: [] });
  responses.get_commands = {};
  const incompatible = await client.probeCompatibility();
  assert.equal(incompatible.compatible, false);
  assert.match(incompatible.diagnostics.join("\n"), /get_commands/);
});

function fakeChild() {
  const writes: string[] = [];
  const child = new EventEmitter() as EventEmitter & { exitCode: number | null; killed: boolean; stdin: EventEmitter & { writable: boolean; write: (value: string, callback?: (error?: Error | null) => void) => boolean }; kill: (signal: string) => boolean };
  child.exitCode = null;
  child.killed = false;
  child.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: (value: string, callback?: (error?: Error | null) => void) => { writes.push(value); callback?.(null); return true; },
  });
  child.kill = () => { child.killed = true; child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0, null)); return true; };
  return { child, writes };
}

test("RPC request observer reports allocation, buffering, and matching response without changing payload", async () => {
  const { child, writes } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  const observations: RpcRequestObservation[] = [];
  const internals = client as unknown as {
    child: typeof child | null;
    handleLine(line: string): void;
  };
  internals.child = child;
  const pending = client.send(
    { type: "prompt", message: "private prompt" },
    1_000,
    { observe: (observation) => observations.push(observation) },
  );
  const written = JSON.parse(writes[0]) as Record<string, unknown>;
  assert.deepEqual(Object.keys(written).sort(), ["id", "message", "type"]);
  assert.equal("promptId" in written, false);
  internals.handleLine(JSON.stringify({
    type: "response",
    id: written.id,
    success: true,
  }));
  assert.equal((await pending).success, true);
  assert.deepEqual(
    observations.map(({ phase, outcome }) => ({ phase, outcome })),
    [
      { phase: "allocated", outcome: "allocated" },
      { phase: "written", outcome: "written" },
      { phase: "response", outcome: "response-success" },
    ],
  );
  assert.ok(observations.every((item) => item.requestId === written.id));
});

test("RPC request observer is fail-open when it throws", async () => {
  const { child, writes } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  const internals = client as unknown as {
    child: typeof child | null;
    handleLine(line: string): void;
  };
  internals.child = child;
  const pending = client.send(
    { type: "prompt", message: "still works" },
    1_000,
    { observe: () => { throw new Error("observer failed"); } },
  );
  const written = JSON.parse(writes[0]) as Record<string, unknown>;
  assert.doesNotThrow(() => internals.handleLine(JSON.stringify({
    type: "response",
    id: written.id,
    success: true,
  })));
  assert.equal((await pending).success, true);
});

test("RPC request observer preserves written-outcome-unknown timeout semantics", async () => {
  const { child } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  const observations: RpcRequestObservation[] = [];
  Object.assign(client, { child });
  await assert.rejects(
    client.send(
      { type: "prompt", message: "possibly accepted" },
      5,
      { observe: (observation) => observations.push(observation) },
    ),
    (error) => error instanceof RpcRequestTimeoutError && error.outcomeUnknown,
  );
  assert.deepEqual(
    observations.map(({ phase, outcome }) => ({ phase, outcome })),
    [
      { phase: "allocated", outcome: "allocated" },
      { phase: "written", outcome: "written" },
      { phase: "failed", outcome: "written-outcome-unknown" },
    ],
  );
  await client.stop();
});

test("RPC request timeouts retain their command identity", async () => {
  const { child } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  await assert.rejects(
    client.send({ type: "abort" }, 5),
    (error) =>
      error instanceof RpcRequestTimeoutError && error.requestType === "abort",
  );
  await client.stop();
});

test("deliberate stop rejects pending requests immediately instead of leaking timers", async () => {
  const { child } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  const observations: RpcRequestObservation[] = [];
  Object.assign(client, { child });
  const pending = client.send(
    { type: "never_answers" },
    60_000,
    { observe: (observation) => observations.push(observation) },
  );
  await client.stop();
  await assert.rejects(pending, /Pi RPC 已停止/);
  assert.equal(observations.at(-1)?.outcome, "process-rejected");
});

test("an unexpected child exit reports a written mutation as outcome unknown", async () => {
  const { child } = fakeChild();
  const incidents = incidentCollector();
  const client = new PiRpcClient({
    cwd: process.cwd(),
    diagnostics: incidents.diagnostics,
    runtimeKind: "primary",
    sessionId: () => "canonical-session",
  });
  const source = { generation: 3, child, stderrTail: "" };
  const internals = client as unknown as {
    child: typeof child | null;
    source: typeof source | null;
    handleExit(source: typeof source, error: Error): void;
  };
  internals.child = child;
  internals.source = source;
  const pending = client.send({ type: "never_answers" }, 60_000);
  internals.handleExit(source, new Error("child crashed"));
  await assert.rejects(
    pending,
    (error) => error instanceof RpcRequestTimeoutError
      && error.requestType === "never_answers"
      && error.outcomeUnknown
      && /^PC-/.test((error as RpcRequestTimeoutError & { incidentId?: string }).incidentId || ""),
  );
  assert.equal(incidents.records.length, 1);
  assert.equal(incidents.records[0].operation, "rpc.child-exit");
  assert.equal(incidents.records[0].sessionId, "canonical-session");
  assert.equal(incidents.records[0].rpcGeneration, 3);
});

test("RPC rejects an oversized outbound frame before writing it", async () => {
  const { child, writes } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  await assert.rejects(
    client.send({ type: "prompt", message: "x".repeat(MAX_RPC_OUTBOUND_LINE_BYTES) }),
    (error) => error instanceof RpcFrameTooLargeError
      && error.direction === "stdin"
      && error.status === 413,
  );
  assert.equal(writes.length, 0);
});

test("RPC reports a written mutation timeout as outcome unknown", async () => {
  const { child } = fakeChild();
  const incidents = incidentCollector();
  const client = new PiRpcClient({
    cwd: process.cwd(),
    diagnostics: incidents.diagnostics,
    runtimeKind: "primary",
    sessionId: () => "session-secret",
  });
  Object.assign(client, { child });
  await assert.rejects(
    client.send({ type: "abort" }, 5),
    (error) => error instanceof RpcRequestTimeoutError
      && error.requestType === "abort"
      && error.outcome === "written-outcome-unknown"
      && /^PC-/.test((error as RpcRequestTimeoutError & { incidentId?: string }).incidentId || ""),
  );
  assert.equal(incidents.records.length, 1);
  assert.equal(incidents.records[0].operation, "rpc.abort");
  assert.equal(incidents.records[0].outcome, "written-outcome-unknown");
  assert.equal(incidents.records[0].errorCode, "PI_RPC_REQUEST_TIMEOUT");
  assert.equal(incidents.records[0].sessionId, "session-secret");
});

test("a synchronous stdin rejection remains definitely not written", async () => {
  const { child } = fakeChild();
  const rejection = new Error("stdin rejected");
  const observations: RpcRequestObservation[] = [];
  child.stdin.write = (_value, callback) => {
    callback?.(rejection);
    return false;
  };
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  await assert.rejects(
    client.send(
      { type: "abort" },
      1_000,
      { observe: (observation) => observations.push(observation) },
    ),
    rejection,
  );
  assert.deepEqual(
    observations.map(({ phase, outcome }) => ({ phase, outcome })),
    [
      { phase: "allocated", outcome: "allocated" },
      { phase: "failed", outcome: "not-written" },
    ],
  );
});

test("an asynchronous stdin failure after write returns is outcome unknown", async () => {
  const { child } = fakeChild();
  child.stdin.write = (_value, callback) => {
    queueMicrotask(() => callback?.(new Error("pipe closed")));
    return true;
  };
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  await assert.rejects(
    client.send({ type: "abort" }, 1_000),
    (error) => error instanceof RpcRequestTimeoutError
      && error.outcome === "written-outcome-unknown",
  );
});

test("an oversized inbound frame correlates a written mutation with the process event", async () => {
  const stream = new PassThrough();
  const { child } = fakeChild();
  const incidents = incidentCollector();
  child.kill = () => { child.killed = true; return true; };
  const client = new PiRpcClient({
    cwd: process.cwd(),
    diagnostics: incidents.diagnostics,
    runtimeKind: "primary",
  });
  const events: Record<string, unknown>[] = [];
  client.onEvent((event) => events.push(event));
  const source = { generation: 4, childPid: 4321, child, stderrTail: "" };
  Object.assign(child, { pid: 4321 });
  const internals = client as unknown as {
    child: typeof child | null;
    source: typeof source | null;
    attachJsonlReader(stream: NodeJS.ReadableStream, source: typeof source): void;
  };
  internals.child = child;
  internals.source = source;
  internals.attachJsonlReader(stream, source);
  const pending = client.send({ type: "prompt", message: "written mutation" }, 60_000);
  stream.write(Buffer.alloc(MAX_RPC_INBOUND_LINE_BYTES + 1, 0x61));
  await assert.rejects(pending, (error) => {
    const value = error as RpcRequestTimeoutError & { incidentId?: string; errorCode?: string };
    return error instanceof RpcRequestTimeoutError
      && error.outcomeUnknown
      && value.incidentId === events[0]?.incidentId
      && value.errorCode === "PI_RPC_FRAME_TOO_LARGE";
  });
  assert.equal(events[0]?.errorCode, "PI_RPC_FRAME_TOO_LARGE");
  assert.equal(incidents.records.length, 1);
  assert.equal(incidents.records[0].incidentId, events[0]?.incidentId);
  assert.equal(incidents.records[0].errorCode, "PI_RPC_FRAME_TOO_LARGE");
  child.exitCode = 0;
  await client.stop();
});

test("an oversized inbound line retains child ownership until exit is proved", async () => {
  const stream = new PassThrough();
  const { child } = fakeChild();
  const incidents = incidentCollector();
  child.kill = () => {
    child.killed = true;
    return true;
  };
  const client = new PiRpcClient({
    cwd: process.cwd(),
    diagnostics: incidents.diagnostics,
    runtimeKind: "secondary",
    sessionId: () => "session-secret",
  });
  const events: Record<string, unknown>[] = [];
  client.onEvent((event) => events.push(event));
  const source = { generation: 1, child, stderrTail: "" };
  const internals = client as unknown as {
    child: typeof child | null;
    source: typeof source | null;
    unconfirmedChild: typeof child | null;
    attachJsonlReader(stream: NodeJS.ReadableStream, source: typeof source): void;
  };
  internals.child = child;
  internals.source = source;
  internals.attachJsonlReader(stream, source);
  stream.write(Buffer.alloc(MAX_RPC_INBOUND_LINE_BYTES + 1, 0x61));
  assert.equal(internals.child, null);
  assert.equal(internals.unconfirmedChild, child);
  assert.equal(child.killed, true);
  assert.match(String(events[0]?.error), /stdout.*安全上限/);
  assert.match(String(events[0]?.incidentId), /^PC-/);
  assert.equal(incidents.records[0].operation, "rpc.stdout-frame");
  assert.equal(incidents.records[0].outcome, "oversized");
  assert.equal(incidents.records[0].rpcGeneration, 1);
  await assert.rejects(
    client.start(),
    /未确认退出/,
    "a protocol-violating child must still block a replacement writer",
  );
  child.exitCode = 0;
  await client.stop();
  assert.equal(internals.unconfirmedChild, null);
});

test("exit-unconfirmed stop and duplicate-writer diagnostics retain generation and PID", async () => {
  const { child } = fakeChild();
  Object.assign(child, { pid: 9876 });
  child.kill = () => { child.killed = true; return true; };
  const incidents = incidentCollector();
  const client = new PiRpcClient({ cwd: process.cwd(), diagnostics: incidents.diagnostics });
  const source = { generation: 6, childPid: 9876, child, stderrTail: "" };
  Object.assign(client, { child, source });
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) =>
    originalSetTimeout(callback, 0, ...args)) as typeof setTimeout;
  try {
    await assert.rejects(client.stop(), RpcProcessExitUnconfirmedError);
    await assert.rejects(client.start(), /未确认退出/);
    assert.deepEqual(
      incidents.records.slice(-2).map(({ operation, outcome, errorCode, rpcGeneration, childPid }) =>
        ({ operation, outcome, errorCode, rpcGeneration, childPid })),
      [
        { operation: "rpc.stop", outcome: "exit-unconfirmed", errorCode: "PI_RPC_EXIT_UNCONFIRMED", rpcGeneration: 6, childPid: 9876 },
        { operation: "runtime.start", outcome: "rejected", errorCode: "RPC_DUPLICATE_WRITER_BLOCKED", rpcGeneration: 6, childPid: 9876 },
      ],
    );
    child.exitCode = 0;
    await client.stop();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("stop observes a synchronous exit emitted by kill", async () => {
  const { child } = fakeChild();
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    return true;
  };
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  await client.stop();
  assert.equal((client as unknown as { unconfirmedChild: unknown }).unconfirmedChild, null);
});

test("stop fails closed and retains ownership when neither termination is observed", async () => {
  const { child } = fakeChild();
  child.kill = () => {
    child.killed = true;
    return true;
  };
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) =>
    originalSetTimeout(callback, 0, ...args)) as typeof setTimeout;
  try {
    await assert.rejects(
      client.stop(),
      (error) => error instanceof RpcProcessExitUnconfirmedError,
    );
    await assert.rejects(
      client.stop(),
      (error) => error instanceof RpcProcessExitUnconfirmedError,
      "a later stop must not forget the same unconfirmed child",
    );
    await assert.rejects(
      client.start(),
      /未确认退出/,
      "a replacement writer must remain blocked",
    );
    child.exitCode = 0;
    await client.stop();
    assert.equal(
      (client as unknown as { unconfirmedChild: unknown }).unconfirmedChild,
      null,
      "a later observed exit releases the retained ownership barrier",
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("sendRaw has a bounded unknown outcome when stdin never acknowledges", async () => {
  const { child } = fakeChild();
  child.stdin.write = () => true;
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  await assert.rejects(
    client.sendRaw({ type: "extension_ui_response", id: "gate" }, 5),
    (error) => error instanceof RpcRequestTimeoutError
      && error.requestType === "extension_ui_response"
      && error.outcomeUnknown,
  );
});

test("concurrent identical read queries share one RPC command", async () => {
  const { child, writes } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  const first = client.send({ type: "get_state" }, 1_000);
  const second = client.send({ type: "get_state" }, 1_000);
  assert.equal(writes.length, 1);
  const id = (JSON.parse(writes[0]) as { id: string }).id;
  (client as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify({ type: "response", id, success: true, data: { isStreaming: false } }));
  assert.deepEqual(await first, await second);
  await client.stop();
});

test("a coalesced read caller keeps its own shorter timeout budget", async () => {
  const { child, writes } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  const long = client.send({ type: "get_state" }, 1_000);
  const short = client.send({ type: "get_state" }, 5);
  await assert.rejects(short, /请求超时/);
  assert.equal(writes.length, 1);
  const id = (JSON.parse(writes[0]) as { id: string }).id;
  (client as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify({ type: "response", id, success: true, data: { isStreaming: false } }));
  await long;
  await client.stop();
});

test("an independent read is queued after, not coalesced with, a short read", async () => {
  const { child, writes } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  const short = client.send({ type: "get_state" }, 5);
  const barrier = client.send(
    { type: "get_state" },
    1_000,
    { independentRead: true },
  );
  await assert.rejects(short, /请求超时/);
  assert.equal(writes.length, 2, "the FIFO barrier must not inherit the ordinary reader's timeout");
  const firstId = (JSON.parse(writes[0]) as { id: string }).id;
  const barrierId = (JSON.parse(writes[1]) as { id: string }).id;
  const internals = client as unknown as { handleLine(line: string): void };
  internals.handleLine(JSON.stringify({ type: "response", id: firstId, success: true, data: { isStreaming: false } }));
  internals.handleLine(JSON.stringify({ type: "response", id: barrierId, success: true, data: { isStreaming: false } }));
  assert.equal((await barrier).data.isStreaming, false);
  await client.stop();
});

test("timed-out read queries reject duplicates until their late response is consumed", async () => {
  const { child, writes } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  const events: Record<string, unknown>[] = [];
  client.onEvent((event) => events.push(event));
  const pending = client.send({ type: "get_commands" }, 5);
  const id = (JSON.parse(writes[0]) as { id: string }).id;
  await assert.rejects(pending, /请求超时/);
  await assert.rejects(client.send({ type: "get_commands" }, 5), /仍在处理中/);
  assert.equal(writes.length, 1);
  (client as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify({ type: "response", id, success: true, data: { commands: [] } }));
  assert.deepEqual(events, []);
  const next = client.send({ type: "get_commands" }, 1_000);
  assert.equal(writes.length, 2);
  const nextId = (JSON.parse(writes[1]) as { id: string }).id;
  (client as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify({ type: "response", id: nextId, success: true, data: { commands: [] } }));
  await next;
  await client.stop();
});

test("startup get_state uses one long budget instead of retrying an orphan query", async () => {
  const { child, writes } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  Object.assign(client, { child });
  const internals = client as unknown as {
    waitUntilReady: () => Promise<Record<string, unknown>>;
    handleLine(line: string): void;
  };
  let writeCount = 0;
  child.stdin.write = (value, callback) => {
    writes.push(value);
    callback?.(null);
    const id = (JSON.parse(value) as { id: string }).id;
    writeCount += 1;
    setTimeout(() => {
      internals.handleLine(JSON.stringify({ type: "response", id, success: true, data: { isStreaming: false } }));
    }, writeCount === 1 ? 2_050 : 0);
    return true;
  };
  await internals.waitUntilReady();
  assert.equal(writes.length, 1);
  await client.stop();
});

test("a late child generation cannot emit events or clear a replacement transport", () => {
  const first = fakeChild().child;
  const second = fakeChild().child;
  const client = new PiRpcClient({ cwd: process.cwd() });
  const events: Array<{ event: Record<string, unknown>; generation?: number }> = [];
  client.onEvent((event, source) => events.push({ event, generation: source?.generation }));
  const internals = client as unknown as {
    child: typeof first;
    source: { generation: number; child: typeof first; stderrTail: string };
    handleLine(line: string, source: { generation: number }): void;
    handleExit(source: { generation: number }, error: Error): void;
  };
  internals.child = second;
  internals.source = { generation: 2, child: second, stderrTail: "" };

  internals.handleLine(JSON.stringify({ type: "agent_start" }), { generation: 1 });
  internals.handleExit({ generation: 1 }, new Error("old child exit"));
  assert.equal(events.length, 0);
  assert.equal(internals.child, second, "old exit must not detach replacement child");
  assert.equal(client.currentGeneration(), 2);

  internals.handleLine(JSON.stringify({ type: "agent_start" }), { generation: 2 });
  assert.deepEqual(events, [{ event: { type: "agent_start" }, generation: 2 }]);
});

test("process-exit fanout isolates synchronous and asynchronous listeners", async () => {
  const { child } = fakeChild();
  const client = new PiRpcClient({ cwd: process.cwd() });
  const received: Array<{ event: Record<string, unknown>; generation?: number }> = [];
  client.onEvent(() => {
    throw new Error("synchronous listener failure");
  });
  client.onEvent(async () => {
    throw new Error("asynchronous listener failure");
  });
  client.onEvent((event, source) =>
    received.push({ event, generation: source?.generation }),
  );
  const internals = client as unknown as {
    child: typeof child | null;
    source: { generation: number; child: typeof child; stderrTail: string } | null;
    handleExit(source: { generation: number }, error: Error): void;
  };
  internals.child = child;
  internals.source = { generation: 7, child, stderrTail: "" };
  const originalConsoleError = console.error;
  const errors: string[] = [];
  console.error = (...values: unknown[]) =>
    errors.push(values.map((value) => String(value)).join(" "));
  try {
    assert.doesNotThrow(() =>
      internals.handleExit({ generation: 7 }, new Error("child exited")),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(internals.child, null);
    assert.equal(received.length, 1);
    assert.equal(received[0].generation, 7);
    assert.equal(received[0].event.type, "pi_chat_process_error");
    assert.equal(received[0].event.error, "child exited");
    assert.equal(received[0].event.errorCode, "RPC_CHILD_EXIT");
    assert.match(String(received[0].event.incidentId), /^PC-/);
    assert.equal(errors.length, 2, "both faulty listeners are contained and logged");
  } finally {
    console.error = originalConsoleError;
  }
});

test("global Pi RPC starts and answers state requests",  { skip: !piEntry, timeout: 75_000 }, async () => {
  assert.ok(piEntry);
  const client = new PiRpcClient({
    cwd: process.cwd(),
    piEntry,
    args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"],
  });
  try {
    await client.start();
    const state = rpcData<{ isStreaming: boolean }>(await client.send({ type: "get_state" }));
    assert.equal(state.isStreaming, false);
    const models = rpcData<{ models: unknown[] }>(await client.send({ type: "get_available_models" }));
    assert.ok(Array.isArray(models.models));
  } finally {
    await client.stop();
  }
});
