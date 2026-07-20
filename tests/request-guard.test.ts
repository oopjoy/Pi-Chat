import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp } from "../src/server/app";
import { requestGuardError } from "../src/server/request-guard";
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
    allowedHosts: ["127.0.0.1:30991"],
  });
}

async function withServer<T>(token: string, run: (origin: string) => Promise<T>): Promise<T> {
  const app = testApp(token);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(30991, "127.0.0.1", resolve));
  try { return await run("http://127.0.0.1:30991"); }
  finally { server.close(); await app.close(); }
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

test("host rebinding attempts are rejected before token processing", () => {
  const result = requestGuardError({
    method: "POST",
    url: "/api/chat/prompt",
    headers: { host: "evil.example:30991", origin: "http://evil.example:30991", "x-pi-chat-token": "current-token" },
  } as unknown as import("node:http").IncomingMessage, { allowedHosts: ["127.0.0.1:30991"], token: "current-token" });
  assert.equal(result, "请求 Host 未获允许");
});
