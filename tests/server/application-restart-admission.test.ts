import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import { RpcRequestTimeoutError, type PiRpcClient } from "../../src/server/rpc-client";
import { idForPath } from "../../src/server/session-index";
import type { SessionIndex } from "../../src/server/session-index";
import type { ResourceManager } from "../../src/server/resource-manager";
import { ModelManager } from "../../src/server/model-manager";
import type { SessionSummary } from "../../src/shared/types";
import { FakeRpc } from "../helpers/server-app-fixture";

const LIFECYCLE_CLIENT = "11111111-1111-4111-8111-111111111111";
const LIFECYCLE_PAGE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function connectLifecyclePage(app: PiChatApp): Record<string, string> {
  const internals = app as unknown as {
    connectedPageClients: Map<string, string>;
    ssePageByResponse: Map<object, string>;
    sessionControl: { clientConnected(clientId: string): void };
  };
  internals.connectedPageClients.set(LIFECYCLE_PAGE, LIFECYCLE_CLIENT);
  internals.ssePageByResponse.set({}, LIFECYCLE_PAGE);
  internals.sessionControl.clientConnected(LIFECYCLE_CLIENT);
  return {
    "x-pi-chat-client": LIFECYCLE_CLIENT,
    "x-pi-chat-page": LIFECYCLE_PAGE,
  };
}

function openEventStream(
  origin: string,
  clientId: string,
  pageId: string,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/api/events`, {
      headers: {
        "x-pi-chat-client": clientId,
        "x-pi-chat-page": pageId,
      },
    });
    request.once("response", resolve);
    request.once("error", reject);
    request.end();
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(predicate(), true);
}

test("a handshake-only local poller cannot restart or shut down open browser pages", async () => {
  let builds = 0;
  let shutdowns = 0;
  const app = new PiChatApp({
    rpc: new FakeRpc("primary") as unknown as PiRpcClient,
    sessions: {} as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    applicationRestart: async () => {
      builds += 1;
      return {
        promote: async () => undefined,
        handoff: () => undefined,
        discard: async () => undefined,
      };
    },
    applicationShutdown: () => { shutdowns += 1; },
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const callerHeaders = {
    "x-pi-chat-client": "22222222-2222-4222-8222-222222222222",
    "x-pi-chat-page": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    origin,
  };
  try {
    const missingIdentity = await fetch(`${origin}/api/restart`, { method: "POST" });
    assert.equal(missingIdentity.status, 400);
    assert.equal(
      (await missingIdentity.json() as { code?: string }).code,
      "LIFECYCLE_CLIENT_REQUIRED",
    );

    const handshake = await fetch(`${origin}/api/bootstrap/handshake`, {
      headers: callerHeaders,
    });
    assert.equal(handshake.status, 200);
    const handshakeData = await handshake.json() as { requestToken?: string };
    const response = await fetch(`${origin}/api/restart`, {
      method: "POST",
      headers: {
        ...callerHeaders,
        ...(handshakeData.requestToken
          ? { "x-pi-chat-token": handshakeData.requestToken }
          : null),
      },
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { code?: string; incidentId?: string };
    assert.equal(body.code, "LIFECYCLE_PAGE_NOT_CONNECTED");
    assert.match(body.incidentId || "", /^PC-[A-Z0-9_-]{8}$/);
    assert.equal(builds, 0);

    const shutdown = await fetch(`${origin}/api/shutdown`, {
      method: "POST",
      headers: {
        ...callerHeaders,
        ...(handshakeData.requestToken
          ? { "x-pi-chat-token": handshakeData.requestToken }
          : null),
      },
    });
    assert.equal(shutdown.status, 409);
    assert.equal(
      (await shutdown.json() as { code?: string }).code,
      "LIFECYCLE_PAGE_NOT_CONNECTED",
    );
    assert.equal(shutdowns, 0);
    const health = await fetch(`${origin}/api/health`);
    assert.equal((await health.json() as { lifecycle?: string }).lifecycle, "idle");
  } finally {
    server.close();
    await app.close();
  }
});

test("restart authority follows the exact EventSource page across a reload", async () => {
  let builds = 0;
  const app = new PiChatApp({
    rpc: new FakeRpc("primary") as unknown as PiRpcClient,
    sessions: {} as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    applicationRestart: async () => {
      builds += 1;
      throw new Error("simulated build failure");
    },
  });
  const internals = app as unknown as {
    ssePageByResponse: Map<object, string>;
  };
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const clientId = "44444444-4444-4444-8444-444444444444";
  const pageA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const pageB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const headersA = {
    "x-pi-chat-client": clientId,
    "x-pi-chat-page": pageA,
  };
  const headersB = {
    "x-pi-chat-client": clientId,
    "x-pi-chat-page": pageB,
  };
  let streamA: IncomingMessage | null = null;
  let streamB: IncomingMessage | null = null;
  try {
    streamA = await openEventStream(origin, clientId, pageA);
    assert.equal(streamA.statusCode, 200);
    await waitFor(() => [...internals.ssePageByResponse.values()].includes(pageA));

    const pageAWhileConnected = await fetch(`${origin}/api/restart`, {
      method: "POST",
      headers: headersA,
    });
    assert.equal(pageAWhileConnected.status, 500);
    assert.equal(builds, 1, "the exact connected page passes lifecycle admission");

    streamA.destroy();
    await waitFor(() => ![...internals.ssePageByResponse.values()].includes(pageA));
    streamB = await openEventStream(origin, clientId, pageB);
    assert.equal(streamB.statusCode, 200);
    await waitFor(() => [...internals.ssePageByResponse.values()].includes(pageB));

    const stalePageA = await fetch(`${origin}/api/restart`, {
      method: "POST",
      headers: headersA,
    });
    assert.equal(stalePageA.status, 409);
    assert.equal(
      (await stalePageA.json() as { code?: string }).code,
      "LIFECYCLE_PAGE_NOT_CONNECTED",
    );
    assert.equal(builds, 1, "replacement page B must not reauthorize stale page A");

    const currentPageB = await fetch(`${origin}/api/restart`, {
      method: "POST",
      headers: headersB,
    });
    assert.equal(currentPageB.status, 500);
    assert.equal(builds, 2, "the replacement page retains its own lifecycle authority");
  } finally {
    streamA?.destroy();
    streamB?.destroy();
    server.close();
    await app.close();
  }
});

test("restart barrier rejects new mutations throughout a long build and commits only after recheck", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  let resolveBuild: (() => void) | undefined;
  let promotions = 0;
  let handoffs = 0;
  let discards = 0;
  const build = new Promise<void>((resolve) => { resolveBuild = resolve; });
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    applicationRestart: async () => {
      await build;
      return {
        promote: async () => { promotions += 1; },
        handoff: () => { handoffs += 1; },
        discard: async () => { discards += 1; },
      };
    },
  });
  const lifecycleHeaders = connectLifecyclePage(app);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    const restart = fetch(`${origin}/api/restart`, { method: "POST", headers: lifecycleHeaders });
    let healthData: { ok?: boolean; service?: string; lifecycle?: string } = {};
    const healthDeadline = Date.now() + 1_000;
    do {
      const health = await fetch(`${origin}/api/health`);
      assert.equal(health.status, 200);
      healthData = await health.json() as typeof healthData;
      if (healthData.lifecycle !== "restarting") await new Promise((resolve) => setTimeout(resolve, 5));
    } while (healthData.lifecycle !== "restarting" && Date.now() < healthDeadline);
    assert.equal(healthData.ok, true);
    assert.equal(healthData.service, "pi-chat");
    assert.equal(healthData.lifecycle, "restarting");
    const maintenanceBootstrap = await fetch(`${origin}/api/bootstrap`);
    assert.equal(maintenanceBootstrap.status, 503);
    const maintenanceData = await maintenanceBootstrap.json() as { lifecycle?: string; requestToken?: string };
    assert.equal(maintenanceData.lifecycle, "restarting");
    assert.ok(maintenanceData.requestToken);
    assert.equal((await fetch(`${origin}/api/sessions`)).status, 200);
    assert.equal((await fetch(`${origin}/api/sessions/${id}/view`)).status, 200);
    for (const [url, body] of [
      ["/api/chat/prompt", { message: "must be rejected", sessionId: id }],
      ["/api/thinking/set", { level: "high", sessionId: id }],
      [`/api/sessions/${id}/activate`, {}],
      ["/api/extension-ui/respond", { id: "pending", sessionId: id, confirmed: true }],
    ] as const) {
      const blocked = await fetch(`${origin}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(blocked.status, 503, `${url} should be blocked`);
      assert.equal((await blocked.json() as { code?: string }).code, "APPLICATION_LIFECYCLE_BLOCKED");
    }
    assert.equal(primary.commands.some((command) => command.type === "prompt"), false);
    resolveBuild?.();
    const response = await restart;
    assert.equal(response.status, 202);
    assert.equal(promotions, 1);
    assert.equal(handoffs, 1);
    assert.equal(discards, 0);
  } finally {
    resolveBuild?.();
    server.close();
    await app.close();
  }
});

test("an incomplete request with no valid session identity does not block restart admission", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const primary = new FakeRpc(path, "primary");
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), applicationRestart: async () => ({ promote: async () => undefined, handoff: () => undefined, discard: async () => undefined }) });
  const lifecycleHeaders = connectLifecyclePage(app);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const slowPrompt = httpRequest(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } });
  slowPrompt.on("error", () => undefined);
  slowPrompt.write('{"message":"still uploading"');
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const restart = await fetch(`${origin}/api/restart`, { method: "POST", headers: lifecycleHeaders });
    assert.equal(restart.status, 202);
    const health = await fetch(`${origin}/api/health`);
    assert.equal((await health.json() as { lifecycle: string }).lifecycle, "restarting");
  } finally {
    slowPrompt.destroy();
    server.close();
    await app.close();
  }
});

test("an incomplete new-session body does not block restart admission", async () => {
  const path = "C:\\sessions\\primary-new.jsonl";
  const primary = new FakeRpc(path, "primary-new");
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions: {} as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    applicationRestart: async () => ({ promote: async () => undefined, handoff: () => undefined, discard: async () => undefined }),
  });
  const lifecycleHeaders = connectLifecyclePage(app);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const slowNew = httpRequest(`${origin}/api/sessions/new`, {
    method: "POST",
    headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
  });
  slowNew.on("error", () => undefined);
  slowNew.write('{"cwd":"');
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const restart = await fetch(`${origin}/api/restart`, { method: "POST", headers: lifecycleHeaders });
    assert.equal(restart.status, 202);
  } finally {
    slowNew.destroy();
    server.close();
    await app.close();
  }
});

test("restart build failure restores idle admission", async () => {
  const path = "C:\\sessions\\primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "primary");
  const sessions = {
    list: async () => [{ id, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true }],
    pathForId: () => path,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd(), applicationRestart: async () => { throw new Error("build failed"); } });
  const lifecycleHeaders = connectLifecyclePage(app);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    assert.equal((await fetch(`${origin}/api/restart`, { method: "POST", headers: lifecycleHeaders })).status, 500);
    const health = await fetch(`${origin}/api/health`);
    assert.equal((await health.json() as { lifecycle: string }).lifecycle, "idle");
    assert.equal((await fetch(`${origin}/api/chat/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "works after failure", sessionId: id }) })).status, 202);
  } finally {
    server.close();
    await app.close();
  }
});
