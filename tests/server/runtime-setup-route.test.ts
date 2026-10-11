import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { handleLifecycleControlRoute } from "../../src/server/routes/lifecycle-control";
import test from "node:test";
import { PiChatApp, type PiChatAppOptions } from "../../src/server/app";
import type { PiRpcClient } from "../../src/server/rpc-client";
import type { ResourceManager } from "../../src/server/resource-manager";
import type { SessionIndex } from "../../src/server/session-index";
import { FakeRpc } from "../helpers/server-app-fixture";

const revision = "a".repeat(64);
const client = "11111111-1111-4111-8111-111111111111";
const page = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function fixture(options: Partial<PiChatAppOptions> = {}) {
  const rpc = new FakeRpc("primary", "primary");
  const calls: string[] = [];
  const app = new PiChatApp({
    rpc: rpc as unknown as PiRpcClient,
    sessions: { list: async () => [], pathForId: () => null } as unknown as SessionIndex,
    resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(),
    runtimeSetupStatus: () => ({ current: null, configured: null, automatic: null, source: "automatic", environmentOverride: false, configurationRevision: revision, pickerAvailable: true, restartAvailable: true }),
    pickRuntimeEntry: async () => { calls.push("pick"); return null; },
    runtimeRestart: async () => {
      calls.push("prepare");
      return { promote: async () => { calls.push("commit"); }, discard: async () => { calls.push("discard"); }, handoff: () => { calls.push("handoff"); } };
    },
    ...options,
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  app.setAllowedHosts([`127.0.0.1:${address.port}`]);
  const handshake = await (await fetch(`${origin}/api/bootstrap/handshake`)).json() as { requestToken: string };
  const headers = { origin, "x-pi-chat-token": handshake.requestToken, "x-pi-chat-client": client, "x-pi-chat-page": page, "content-type": "application/json" };
  let stream: IncomingMessage | undefined;
  return {
    rpc, calls, app, origin, headers,
    async connect() {
      stream = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest(`${origin}/api/events`, { headers });
        req.on("response", resolve); req.on("error", reject); req.end();
      });
      assert.equal(stream.statusCode, 200);
      stream.resume();
    },
    async close() { stream?.destroy(); await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

const retry = JSON.stringify({ mode: "retry", configurationRevision: revision });

test("runtime setup metadata is guarded and detection never touches RPC or native picker", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.origin}/api/runtime/setup`)).status, 403);
    assert.equal((await fetch(`${f.origin}/api/runtime/setup`, { headers: { ...f.headers, origin: "https://evil.invalid" } })).status, 403);
    const response = await fetch(`${f.origin}/api/runtime/setup`, { headers: f.headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { configurationRevision: string }).configurationRevision, revision);
    assert.equal(f.rpc.commands.length, 0);
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});

test("runtime selection and restart require a live page rather than a token-only poller", async () => {
  const f = await fixture();
  try {
    for (const path of ["/api/runtime/pick", "/api/runtime/restart"])
      assert.equal((await fetch(`${f.origin}${path}`, { method: "POST", headers: f.headers, body: retry })).status, 409);
    assert.deepEqual(f.calls, []);
    await f.connect();
    const selected = await fetch(`${f.origin}/api/runtime/pick`, { method: "POST", headers: f.headers });
    assert.deepEqual(await selected.json(), { candidate: null });
    assert.deepEqual(f.calls, ["pick"]);
    assert.equal(f.rpc.restartCount, 0);
  } finally { await f.close(); }
});

test("runtime restart uses both quiescence checks and never invokes the build restart", async () => {
  const f = await fixture({ applicationRestart: async () => { throw new Error("must not build"); } });
  try {
    await f.connect();
    const response = await fetch(`${f.origin}/api/runtime/restart`, { method: "POST", headers: f.headers, body: retry });
    assert.equal(response.status, 202);
    assert.deepEqual(f.calls, ["prepare", "commit", "handoff"]);
    assert.equal(f.rpc.commands.filter(c => c.type === "get_state").length, 2);
    assert.equal((await fetch(`${f.origin}/api/runtime/restart`, { method: "POST", headers: f.headers, body: retry })).status, 503);
    assert.deepEqual(f.calls, ["prepare", "commit", "handoff"]);
  } finally { await f.close(); }
});

test("runtime restart rechecks page ownership after asynchronous body parsing", async () => {
  let checks = 0;
  let status = 0;
  const request = Object.assign(Readable.from([retry]), { method: "POST", headers: { "x-pi-chat-client": client, "x-pi-chat-page": page } }) as unknown as IncomingMessage;
  const response = { writeHead(code: number) { status = code; }, end() {} } as unknown as ServerResponse;
  const never = () => { throw new Error("stale page must not enter lifecycle"); };
  await handleLifecycleControlRoute({
    applicationShutdownAvailable: () => true, applicationRestartAvailable: () => true,
    isConnectedWindowPage: () => ++checks === 1,
    beginLifecycle: never, endLifecycle: never, verifyApplicationQuiescent: async () => never(), broadcast: never,
    restart: async () => never(), runtimeRestart: async () => never(), reportIncident: () => ({ incidentId: "fixture" }),
  }, request, response, new URL("http://localhost/api/runtime/restart"));
  assert.equal(checks, 2);
  assert.equal(status, 409);
});

test("runtime configuration commit failure restores idle admission and never hands off", async () => {
  const calls: string[] = [];
  const f = await fixture({ runtimeRestart: async () => ({
    promote: async () => { calls.push("commit"); throw new Error("fixture atomic write failed"); },
    discard: async () => { calls.push("discard"); }, handoff: () => { calls.push("handoff"); },
  }) });
  try {
    await f.connect();
    const response = await fetch(`${f.origin}/api/runtime/restart`, { method: "POST", headers: f.headers, body: retry });
    assert.equal(response.status, 500);
    assert.deepEqual(calls, ["commit", "discard"]);
    assert.equal((await (await fetch(`${f.origin}/api/health`)).json() as { lifecycle: string }).lifecycle, "idle");
  } finally { await f.close(); }
});

test("busy runtime blocks restart before configuration preparation", async () => {
  const f = await fixture();
  try {
    await f.connect();
    f.rpc.streaming = true;
    const response = await fetch(`${f.origin}/api/runtime/restart`, { method: "POST", headers: f.headers, body: retry });
    assert.equal(response.status, 409);
    assert.deepEqual(f.calls, []);
    const health = await (await fetch(`${f.origin}/api/health`)).json() as { lifecycle: string };
    assert.equal(health.lifecycle, "idle");
  } finally { await f.close(); }
});

test("runtime becoming busy during preparation discards without saving or handoff", async () => {
  let prepareStarted!: () => void;
  const started = new Promise<void>(resolve => { prepareStarted = resolve; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const f = await fixture({ runtimeRestart: async () => {
    prepareStarted(); await held;
    return { promote: async () => { calls.push("commit"); }, discard: async () => { calls.push("discard"); }, handoff: () => { calls.push("handoff"); } };
  } });
  try {
    await f.connect();
    const response = fetch(`${f.origin}/api/runtime/restart`, { method: "POST", headers: f.headers, body: retry });
    await started;
    f.rpc.streaming = true;
    release();
    assert.equal((await response).status, 409);
    assert.deepEqual(calls, ["discard"]);
    assert.equal((await (await fetch(`${f.origin}/api/health`)).json() as { lifecycle: string }).lifecycle, "idle");
  } finally { release(); await f.close(); }
});

test("invalid runtime settings leave lifecycle idle and native picker admission blocks restart", async () => {
  let release!: () => void;
  const held = new Promise<null>(resolve => { release = () => resolve(null); });
  let started!: () => void;
  const picking = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture({ pickRuntimeEntry: async () => { started(); return held; } });
  try {
    await f.connect();
    const malformed = await fetch(`${f.origin}/api/runtime/restart`, { method: "POST", headers: f.headers, body: "{}" });
    assert.equal(malformed.status, 400);
    assert.deepEqual(f.calls, []);
    const picker = fetch(`${f.origin}/api/runtime/pick`, { method: "POST", headers: f.headers });
    await picking;
    const response = await fetch(`${f.origin}/api/runtime/restart`, { method: "POST", headers: f.headers, body: retry });
    assert.equal(response.status, 409);
    release();
    assert.equal((await picker).status, 200);
    assert.deepEqual(f.calls, []);
  } finally { release(); await f.close(); }
});
