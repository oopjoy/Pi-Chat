import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp } from "../src/server/app";
import { requestGuardError } from "../src/server/request-guard";
import { requestClientId, requestPageId } from "../src/server/http-transport";
import type { PiRpcClient } from "../src/server/rpc-client";
import type { SessionIndex } from "../src/server/session-index";
import type { ResourceManager } from "../src/server/resource-manager";

function testApp(token: string) {
  const rpc = {
    onEvent: () => () => {},
    send: async (command: Record<string, unknown>) => {
      if (command.type === "get_state") return { type: "response", success: true, data: { model: null, isStreaming: false } };
      if (command.type === "get_messages") return { type: "response", success: true, data: { messages: [] } };
      if (command.type === "get_available_models") return { type: "response", success: true, data: { models: [] } };
      if (command.type === "get_commands") return { type: "response", success: true, data: { commands: [] } };
      if (command.type === "get_session_stats") return { type: "response", success: true, data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { type: "response", success: true, data: {} };
    },
  } as unknown as PiRpcClient;
  return new PiChatApp({
    rpc,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    requestToken: token,
    // Bare loopback host intentionally allows the OS-assigned test port.
    allowedHosts: ["127.0.0.1"],
  });
}

async function withServer<T>(token: string, run: (origin: string) => Promise<T>): Promise<T> {
  const app = testApp(token);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try { return await run(`http://127.0.0.1:${address.port}`); }
  finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("browser API requests require exact localhost host, origin, and startup token", async () => {
  await withServer("current-token", async (origin) => {
    const handshake = await fetch(`${origin}/api/bootstrap/handshake`, { headers: { origin, "sec-fetch-site": "same-origin" } });
    assert.equal(handshake.status, 200);
    assert.equal((await handshake.json() as { requestToken: string }).requestToken, "current-token");

    const tokenlessBootstrap = await fetch(`${origin}/api/bootstrap`, { headers: { origin, "sec-fetch-site": "same-origin" } });
    assert.equal(tokenlessBootstrap.status, 403);
    const bootstrap = await fetch(`${origin}/api/bootstrap`, { headers: { origin, "sec-fetch-site": "same-origin", "x-pi-chat-token": "current-token" } });
    assert.equal(bootstrap.status, 200);
    assert.equal((await bootstrap.json() as { requestToken: string }).requestToken, "current-token");

    // The restart handoff is an Origin-less local process; exact-host health is
    // its one tokenless, fixed-shape liveness probe.
    const handoffHealth = await fetch(`${origin}/api/health`);
    assert.equal(handoffHealth.status, 200);
    assert.deepEqual(await handoffHealth.json(), {
      ok: true,
      service: "pi-chat",
      lifecycle: "idle",
      buildIdentity: { schemaVersion: 1, packageVersion: "unknown", revision: "unknown", fingerprint: "unknown", builtAt: "unknown" },
    });

    const tokenlessView = await fetch(`${origin}/api/sessions/00000000000000000000/view`, { headers: { origin, "sec-fetch-site": "same-origin" } });
    assert.equal(tokenlessView.status, 403, "the lightweight handshake must not make Session reads tokenless");

    const allowed = await fetch(`${origin}/api/health`, { headers: { origin, "sec-fetch-site": "same-origin", "x-pi-chat-token": "current-token" } });
    assert.equal(allowed.status, 200);

    const hostileOrigin = await fetch(`${origin}/api/health`, { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "x-pi-chat-token": "current-token" } });
    assert.equal(hostileOrigin.status, 403);

    const staleToken = await fetch(`${origin}/api/health`, { headers: { origin, "sec-fetch-site": "same-origin", "x-pi-chat-token": "old-token" } });
    assert.equal(staleToken.status, 403);


  });
});

test("EventSource and close beacons carry browser and page identities without custom headers", () => {
  const client = "11111111-1111-4111-8111-111111111111";
  const page = "22222222-2222-4222-8222-222222222222";
  const eventRequest = { url: `/api/events?client=${client}&page=${page}`, headers: {} } as unknown as import("node:http").IncomingMessage;
  const closeRequest = { url: `/api/window/close?client=${client}&page=${page}`, headers: {} } as unknown as import("node:http").IncomingMessage;
  assert.equal(requestClientId(eventRequest), client);
  assert.equal(requestPageId(eventRequest), page);
  assert.equal(requestClientId(closeRequest), client);
  assert.equal(requestPageId(closeRequest), page);
  assert.equal(requestClientId({ url: "/api/events?client=invalid", headers: {} } as unknown as import("node:http").IncomingMessage), "");
});

test("same-origin close beacons may authenticate with the startup token query", () => {
  const allowed = requestGuardError({
    method: "POST",
    url: "/api/window/close?token=current-token&client=11111111-1111-4111-8111-111111111111",
    headers: { host: "127.0.0.1:30170", origin: "http://127.0.0.1:30170", "sec-fetch-site": "same-origin" },
  } as unknown as import("node:http").IncomingMessage, { allowedHosts: ["127.0.0.1:30170"], token: "current-token" });
  assert.equal(allowed, null);

  const stale = requestGuardError({
    method: "POST",
    url: "/api/window/close?token=old-token&client=11111111-1111-4111-8111-111111111111",
    headers: { host: "127.0.0.1:30170", origin: "http://127.0.0.1:30170", "sec-fetch-site": "same-origin" },
  } as unknown as import("node:http").IncomingMessage, { allowedHosts: ["127.0.0.1:30170"], token: "current-token" });
  assert.equal(stale, "Pi Chat 请求令牌无效或已过期");
});

test("existing-session mutation bodies fail closed before control or RPC work", async () => {
  await withServer("current-token", async (origin) => {
    const routes = [
      ["/api/chat/prompt", "POST", { message: "must not target Primary" }],
      ["/api/chat/abort", "POST", {}],
      ["/api/chat/queue/resume", "POST", {}],
      ["/api/chat/compact", "POST", {}],
      ["/api/models/set", "POST", { provider: "test", modelId: "model" }],
      ["/api/thinking/set", "POST", { level: "high" }],
      ["/api/extension-ui/respond", "POST", { id: "request" }],
      ["/api/chat/queue/11111111-1111-4111-8111-111111111111", "DELETE", {}],
    ] as const;
    for (const [path, method, body] of routes) {
      for (const sessionId of [undefined, "", "   ", "not-a-session", 1, null, {}]) {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sessionId === undefined ? body : { ...body, sessionId }),
        });
        assert.equal(response.status, 400, `${method} ${path} must reject ${JSON.stringify(sessionId)}`);
      }
    }
  });
});

test("health and bootstrap expose the same non-secret build identity", async () => {
  await withServer("current-token", async (origin) => {
    const health = await (await fetch(`${origin}/api/health`)).json() as { buildIdentity?: { fingerprint?: string } };
    const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as { buildIdentity?: { fingerprint?: string } };
    assert.equal(health.buildIdentity?.fingerprint, "unknown");
    assert.deepEqual(bootstrap.buildIdentity, health.buildIdentity);
  });
});

test("malformed request bodies are client errors and missing assets stay 404", async () => {
  await withServer("current-token", async (origin) => {
    const malformed = await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    assert.equal(malformed.status, 400);
    const arrayBody = await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: "[]" });
    assert.equal(arrayBody.status, 400);
    const oversized = await fetch(`${origin}/api/chat/queue/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(1_000_001) }) });
    assert.equal(oversized.status, 413);
    const missingAsset = await fetch(`${origin}/assets/missing.js`, { headers: { accept: "*/*" } });
    assert.equal(missingAsset.status, 404);
  });
});

test("exact-authority handoff health allows no Origin or token after Host validation", () => {
  const result = requestGuardError({
    method: "GET",
    url: "/api/health",
    headers: { host: "127.0.0.1:30170" },
  } as unknown as import("node:http").IncomingMessage, { allowedHosts: ["127.0.0.1:30170"], token: "current-token" });
  assert.equal(result, null);
});

test("tokenless health rejects Host values that are URLs or carry credentials", () => {
  for (const host of ["127.0.0.1:30170/ignored", "user@127.0.0.1:30170", "127.0.0.1:30170?query"]) {
    const result = requestGuardError({
      method: "GET",
      url: "/api/health",
      headers: { host },
    } as unknown as import("node:http").IncomingMessage, { allowedHosts: ["127.0.0.1:30170"], token: "current-token" });
    assert.equal(result, "请求 Host 未获允许", host);
  }
});

test("the tokenless health exception does not relax other exact-authority API routes", () => {
  const result = requestGuardError({
    method: "GET",
    url: "/api/sessions",
    headers: { host: "127.0.0.1:30170" },
  } as unknown as import("node:http").IncomingMessage, { allowedHosts: ["127.0.0.1:30170"], token: "current-token" });
  assert.equal(result, "请求缺少同源 Origin");
});

test("tokenless mutations are rejected in exact-authority mode", () => {
  const result = requestGuardError({
    method: "POST",
    url: "/api/workspace/set",
    headers: { host: "127.0.0.1:30170", "content-type": "application/json" },
  } as unknown as import("node:http").IncomingMessage, { allowedHosts: ["127.0.0.1:30170"], token: "current-token" });
  assert.equal(result, "请求缺少同源 Origin");
});

test("IPv6 loopback authority is normalized", () => {
  const result = requestGuardError({
    method: "GET",
    url: "/api/bootstrap/handshake",
    headers: { host: "[::1]:30170", origin: "http://[::1]:30170" },
  } as unknown as import("node:http").IncomingMessage, { allowedHosts: ["[::1]:30170"], token: "current-token" });
  assert.equal(result, null);
});

test("host rebinding attempts are rejected before token processing", () => {
  const result = requestGuardError({
    method: "POST",
    url: "/api/chat/prompt",
    headers: { host: "evil.example:30991", origin: "http://evil.example:30991", "x-pi-chat-token": "current-token" },
  } as unknown as import("node:http").IncomingMessage, { allowedHosts: ["127.0.0.1:30991"], token: "current-token" });
  assert.equal(result, "请求 Host 未获允许");
});
