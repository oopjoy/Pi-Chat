import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp } from "../src/server/app";
import { requestGuardError } from "../src/server/request-guard";
import { requestClientId } from "../src/server/http-transport";
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
    const bootstrap = await fetch(`${origin}/api/bootstrap`, { headers: { origin, "sec-fetch-site": "same-origin" } });
    assert.equal(bootstrap.status, 200);
    assert.equal((await bootstrap.json() as { requestToken: string }).requestToken, "current-token");

    const allowed = await fetch(`${origin}/api/health`, { headers: { origin, "sec-fetch-site": "same-origin", "x-pi-chat-token": "current-token" } });
    assert.equal(allowed.status, 200);

    const hostileOrigin = await fetch(`${origin}/api/health`, { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "x-pi-chat-token": "current-token" } });
    assert.equal(hostileOrigin.status, 403);

    const staleToken = await fetch(`${origin}/api/health`, { headers: { origin, "sec-fetch-site": "same-origin", "x-pi-chat-token": "old-token" } });
    assert.equal(staleToken.status, 403);
  });
});

test("EventSource query carries the browser window identity without custom headers", () => {
  const client = "11111111-1111-4111-8111-111111111111";
  assert.equal(requestClientId({ url: `/api/events?client=${client}`, headers: {} } as unknown as import("node:http").IncomingMessage), client);
  assert.equal(requestClientId({ url: "/api/events?client=invalid", headers: {} } as unknown as import("node:http").IncomingMessage), "");
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

test("host rebinding attempts are rejected before token processing", () => {
  const result = requestGuardError({
    method: "POST",
    url: "/api/chat/prompt",
    headers: { host: "evil.example:30991", origin: "http://evil.example:30991", "x-pi-chat-token": "current-token" },
  } as unknown as import("node:http").IncomingMessage, { allowedHosts: ["127.0.0.1:30991"], token: "current-token" });
  assert.equal(result, "请求 Host 未获允许");
});
