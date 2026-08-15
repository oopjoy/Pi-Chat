import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PiChatApp } from "../src/server/app";
import type { PiRpcClient } from "../src/server/rpc-client";
import type { ResourceManager } from "../src/server/resource-manager";
import type { SessionIndex } from "../src/server/session-index";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

class IdleRpc {
  private readonly listeners = new Set<
    (event: Record<string, unknown>) => void
  >();
  stopped = false;

  onEvent(listener: (event: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isRunning() {
    return !this.stopped;
  }
  async stop() {
    this.stopped = true;
  }
  async send(command: Record<string, unknown>) {
    if (command.type === "get_state")
      return {
        type: "response",
        success: true,
        data: { model: null, isStreaming: false },
      };
    if (command.type === "get_messages")
      return { type: "response", success: true, data: { messages: [] } };
    if (command.type === "get_available_models")
      return { type: "response", success: true, data: { models: [] } };
    if (command.type === "get_commands")
      return { type: "response", success: true, data: { commands: [] } };
    if (command.type === "get_session_stats")
      return { type: "response", success: true, data: {} };
    return { type: "response", success: true, data: {} };
  }
}

async function startApp(options: { controllerReleaseMs?: number; presenceTtlMs?: number } = {}) {
  const rpc = new IdleRpc();
  const app = new PiChatApp({
    rpc: rpc as unknown as PiRpcClient,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
    ...options,
  });
  const server = createServer(
    (request, response) => void app.handle(request, response),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    app,
    origin,
    close: async () => {
      await app.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function openEvents(origin: string, client: string, page = client) {
  const bootstrap = await fetch(`${origin}/api/bootstrap`);
  assert.equal(bootstrap.status, 200);
  const token = ((await bootstrap.json()) as { requestToken: string })
    .requestToken;
  const controller = new AbortController();
  const response = await fetch(
    `${origin}/api/events?token=${encodeURIComponent(token)}&client=${encodeURIComponent(client)}&page=${encodeURIComponent(page)}`,
    {
      headers: { origin, "x-pi-chat-client": client, "x-pi-chat-page": page },
      signal: controller.signal,
    },
  );
  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  assert.ok(reader);
  const first = await reader.read();
  const readyFrame = new TextDecoder().decode(first.value);
  assert.match(readyFrame, /event: ready/);
  // The frame is the initial capability snapshot for browsers whose bootstrap
  // finished before EventSource connected.
  assert.match(
    readyFrame,
    /"primaryRuntime":\{"status":"ready","generation":0\}/,
  );
  return { controller, reader, token };
}

async function updatePresence(
  origin: string,
  token: string,
  client: string,
  page: string,
  update: { foreground?: boolean; revision?: number },
) {
  const response = await fetch(`${origin}/api/presence`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "x-pi-chat-token": token,
      "x-pi-chat-client": client,
      "x-pi-chat-page": page,
    },
    body: JSON.stringify(update),
  });
  return {
    status: response.status,
    body: await response.json() as { present?: boolean; error?: string },
  };
}

test("page-scoped presence revisions ignore delayed background updates", async () => {
  const fixture = await startApp();
  const client = "55555555-5555-4555-8555-555555555555";
  const oldPage = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const replacementPage = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const sessionId = "abababababababababab";
  const internals = fixture.app as unknown as {
    sessionControl: {
      isClientPresent(clientId: string): boolean;
      setController(sessionId: string, clientId: string): void;
      sessionControllers: Map<string, string>;
    };
  };
  try {
    const oldEvents = await openEvents(fixture.origin, client, oldPage);
    const replacementEvents = await openEvents(fixture.origin, client, replacementPage);

    assert.equal((await updatePresence(fixture.origin, oldEvents.token, client, oldPage, {})).status, 400);
    assert.equal(
      (
        await updatePresence(
          fixture.origin,
          oldEvents.token,
          client,
          "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          { foreground: true, revision: 1 },
        )
      ).status,
      409,
    );
    assert.deepEqual(
      await updatePresence(fixture.origin, oldEvents.token, client, oldPage, { foreground: true, revision: 1 }),
      { status: 200, body: { present: true } },
    );
    internals.sessionControl.setController(sessionId, client);
    assert.deepEqual(
      await updatePresence(fixture.origin, replacementEvents.token, client, replacementPage, { foreground: true, revision: 1 }),
      { status: 200, body: { present: true } },
    );

    // The replaced page can legitimately advance its own counter, but its
    // background intent must clear only its own page lease.
    assert.deepEqual(
      await updatePresence(fixture.origin, oldEvents.token, client, oldPage, { foreground: false, revision: 2 }),
      { status: 200, body: { present: true } },
    );
    assert.equal(internals.sessionControl.isClientPresent(client), true);
    assert.equal(internals.sessionControl.sessionControllers.get(sessionId), client);

    // Equal revisions are recognized no-ops; a strictly newer update applies.
    assert.deepEqual(
      await updatePresence(fixture.origin, replacementEvents.token, client, replacementPage, { foreground: false, revision: 1 }),
      { status: 200, body: { present: true } },
    );
    assert.deepEqual(
      await updatePresence(fixture.origin, replacementEvents.token, client, replacementPage, { foreground: false, revision: 2 }),
      { status: 200, body: { present: false } },
    );
    assert.equal(internals.sessionControl.sessionControllers.has(sessionId), false);

    oldEvents.controller.abort();
    replacementEvents.controller.abort();
    await oldEvents.reader.cancel().catch(() => undefined);
    await replacementEvents.reader.cancel().catch(() => undefined);
  } finally {
    await fixture.close();
  }
});

test("disconnecting one page drops only its lease when a sibling shares the client", async () => {
  const fixture = await startApp({ controllerReleaseMs: 30 });
  const client = "66666666-6666-4666-8666-666666666666";
  const foregroundPage = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const siblingPage = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const sessionId = "bcbcbcbcbcbcbcbcbcbc";
  const foregroundSocket = { write: () => true, end() {} };
  const siblingSocket = { write: () => true, end() {} };
  const internals = fixture.app as unknown as {
    sseClients: Map<object, string>;
    ssePageByResponse: Map<object, string>;
    sseHub: { remove(response: object): string };
    sessionControl: {
      clientConnected(clientId: string): void;
      noteClientPresence(clientId: string, pageId: string, revision: number): boolean;
      isClientPresent(clientId: string): boolean;
      setController(sessionId: string, clientId: string): void;
      sessionControllers: Map<string, string>;
    };
  };
  try {
    internals.sseClients.set(foregroundSocket, client);
    internals.sseClients.set(siblingSocket, client);
    internals.ssePageByResponse.set(foregroundSocket, foregroundPage);
    internals.ssePageByResponse.set(siblingSocket, siblingPage);
    internals.sessionControl.clientConnected(client);
    internals.sessionControl.clientConnected(client);
    internals.sessionControl.noteClientPresence(client, foregroundPage, 1);
    internals.sessionControl.setController(sessionId, client);

    internals.sseHub.remove(foregroundSocket);
    assert.equal(internals.sessionControl.isClientPresent(client), false);
    assert.equal(
      internals.sessionControl.sessionControllers.get(sessionId),
      client,
      "transport recovery keeps ownership during the short disconnect grace",
    );
    await sleep(40);
    assert.equal(internals.sessionControl.sessionControllers.has(sessionId), false);

    internals.sseHub.remove(siblingSocket);
  } finally {
    await fixture.close();
  }
});

test("one overlapping EventSource disconnect keeps the same page lease", async () => {
  const fixture = await startApp();
  const client = "77777777-7777-4777-8777-777777777777";
  const page = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const sessionId = "cdcdcdcdcdcdcdcdcdcd";
  const firstSocket = { write: () => true, end() {} };
  const replacementSocket = { write: () => true, end() {} };
  const internals = fixture.app as unknown as {
    sseClients: Map<object, string>;
    ssePageByResponse: Map<object, string>;
    sseHub: { remove(response: object): string };
    sessionControl: {
      clientConnected(clientId: string): void;
      noteClientPresence(clientId: string, pageId: string, revision: number): boolean;
      isClientPresent(clientId: string): boolean;
      setController(sessionId: string, clientId: string): void;
      sessionControllers: Map<string, string>;
    };
  };
  try {
    internals.sseClients.set(firstSocket, client);
    internals.sseClients.set(replacementSocket, client);
    internals.ssePageByResponse.set(firstSocket, page);
    internals.ssePageByResponse.set(replacementSocket, page);
    internals.sessionControl.clientConnected(client);
    internals.sessionControl.clientConnected(client);
    internals.sessionControl.noteClientPresence(client, page, 1);
    internals.sessionControl.setController(sessionId, client);

    internals.sseHub.remove(firstSocket);
    assert.equal(internals.sessionControl.isClientPresent(client), true);
    assert.equal(internals.sessionControl.sessionControllers.get(sessionId), client);

    internals.sseHub.remove(replacementSocket);
    assert.equal(internals.sessionControl.isClientPresent(client), false);
  } finally {
    await fixture.close();
  }
});

test("a real sole SSE transport drop leaves health, bootstrap, and a replacement SSE available", async () => {
  const fixture = await startApp();
  const firstClient = "11111111-1111-4111-8111-111111111111";
  const secondClient = "22222222-2222-4222-8222-222222222222";
  try {
    const first = await openEvents(fixture.origin, firstClient);
    first.controller.abort();
    await first.reader.cancel().catch(() => undefined);
    await sleep(60);

    assert.equal((await fetch(`${fixture.origin}/api/health`)).status, 200);
    assert.equal((await fetch(`${fixture.origin}/api/bootstrap`)).status, 200);

    const replacement = await openEvents(fixture.origin, secondClient);
    replacement.controller.abort();
    await replacement.reader.cancel().catch(() => undefined);
  } finally {
    await fixture.close();
  }
});

test("foreground presence expiry pushes a control-state SSE frame that clears an observing banner", async () => {
  const fixture = await startApp({ presenceTtlMs: 40 });
  const appInternals = fixture.app as unknown as {
    sseClients: Map<object, string>;
    sessionControl: {
      clientConnected(clientId: string): void;
      noteClientPresence(clientId: string): boolean;
      setController(sessionId: string, clientId: string): void;
    };
  };
  const sessionId = "aaaaaaaaaaaaaaaaaaaa";
  const owner = "11111111-1111-4111-8111-111111111111";
  const observer = "22222222-2222-4222-8222-222222222222";
  const ownerFrames: string[] = [];
  const observerFrames: string[] = [];
  const ownerSocket = {
    write: (frame: string) => {
      ownerFrames.push(frame);
      return true;
    },
    end() {},
  };
  const observerSocket = {
    write: (frame: string) => {
      observerFrames.push(frame);
      return true;
    },
    end() {},
  };
  appInternals.sseClients.set(ownerSocket, owner);
  appInternals.sseClients.set(observerSocket, observer);
  appInternals.sessionControl.clientConnected(owner);
  appInternals.sessionControl.clientConnected(observer);
  appInternals.sessionControl.noteClientPresence(owner);
  appInternals.sessionControl.noteClientPresence(observer);
  appInternals.sessionControl.setController(sessionId, owner);
  ownerFrames.length = 0;
  observerFrames.length = 0;
  try {
    await sleep(20);
    appInternals.sessionControl.noteClientPresence(observer);
    await sleep(30);
    const observerFrame = observerFrames.at(-1) || "";
    assert.match(observerFrame, /"type":"pi_chat_session_control_changed"/);
    assert.match(observerFrame, /"sessionId":"aaaaaaaaaaaaaaaaaaaa"/);
    assert.doesNotMatch(observerFrame, /"controlOwner"/);
    assert.match(observerFrame, /"controlledByThisWindow":false/);
  } finally {
    await fixture.close();
  }
});

test("application close leaves no SessionControl release timer after closing SSE clients", async () => {
  const fixture = await startApp();
  const appInternals = fixture.app as unknown as {
    sseClients: Map<object, string>;
    sessionControl: {
      clientConnected(clientId: string): void;
      connectedClients: Map<string, number>;
      controllerReleaseTimers: Map<string, NodeJS.Timeout>;
    };
  };
  const clientId = "close-cleanup-client";
  const client = { write: () => true, end() {} };
  appInternals.sseClients.set(client, clientId);
  appInternals.sessionControl.clientConnected(clientId);
  try {
    await fixture.app.close();
    assert.equal(appInternals.sseClients.size, 0);
    assert.equal(appInternals.sessionControl.connectedClients.size, 0);
    assert.equal(appInternals.sessionControl.controllerReleaseTimers.size, 0);
  } finally {
    await fixture.close();
  }
});

test("server-initiated SSE removal releases its SessionControl presence", async () => {
  const fixture = await startApp();
  const appInternals = fixture.app as unknown as {
    sseClients: Map<object, string>;
    connectedClients: Map<string, number>;
    broadcast(event: Record<string, unknown>): void;
  };
  const clientId = "33333333-3333-4333-8333-333333333333";
  const client = new EventEmitter() as EventEmitter & {
    ended: boolean;
    write(frame: string): boolean;
    end(): void;
  };
  client.ended = false;
  client.write = () => false;
  client.end = () => {
    client.ended = true;
  };
  appInternals.sseClients.set(client, clientId);
  appInternals.connectedClients.set(clientId, 1);
  try {
    for (let index = 0; index < 6; index += 1) {
      appInternals.broadcast({
        type: "tool_execution_end",
        sequence: index,
        payload: "x".repeat(450_000),
      });
    }
    assert.equal(client.ended, true);
    assert.equal(appInternals.sseClients.size, 0);
    assert.equal(appInternals.connectedClients.has(clientId), false);
    // The later HTTP request-close path sees an already removed socket and must
    // not decrement below zero or schedule a second ownership cleanup.
    (
      fixture.app as unknown as { sseHub: { remove(response: object): string } }
    ).sseHub.remove(client);
    assert.equal(appInternals.connectedClients.has(clientId), false);
  } finally {
    await fixture.close();
  }
});

test("write-error removal releases SessionControl presence exactly once", async () => {
  const fixture = await startApp();
  const appInternals = fixture.app as unknown as {
    sseClients: Map<object, string>;
    connectedClients: Map<string, number>;
    broadcast(event: Record<string, unknown>): void;
  };
  const clientId = "44444444-4444-4444-8444-444444444444";
  const client = new EventEmitter() as EventEmitter & {
    write(frame: string): boolean;
    end(): void;
  };
  client.write = () => {
    throw new Error("broken socket");
  };
  client.end = () => {};
  appInternals.sseClients.set(client, clientId);
  appInternals.connectedClients.set(clientId, 1);
  try {
    appInternals.broadcast({
      type: "message_update",
      payload: "trigger write error",
    });
    assert.equal(appInternals.sseClients.size, 0);
    assert.equal(appInternals.connectedClients.has(clientId), false);
    (
      fixture.app as unknown as { sseHub: { remove(response: object): string } }
    ).sseHub.remove(client);
    assert.equal(appInternals.connectedClients.has(clientId), false);
  } finally {
    await fixture.close();
  }
});

test("a sole backpressured SSE client is dropped without taking down the application", async () => {
  const fixture = await startApp();
  const appInternals = fixture.app as unknown as {
    sseClients: Map<object, string>;
    broadcast(event: Record<string, unknown>): void;
  };
  const client = new EventEmitter() as EventEmitter & {
    ended: boolean;
    write(frame: string): boolean;
    end(): void;
  };
  client.ended = false;
  client.write = () => false;
  client.end = () => {
    client.ended = true;
  };
  appInternals.sseClients.set(client, "backpressured-client");
  try {
    // The first false write enters backpressure; later non-coalescible frames
    // deliberately exceed the 2 MiB retention cap and force this client away.
    for (let index = 0; index < 6; index += 1) {
      appInternals.broadcast({
        type: "tool_execution_end",
        sequence: index,
        payload: "x".repeat(450_000),
      });
    }
    assert.equal(client.ended, true);
    assert.equal(appInternals.sseClients.size, 0);
    assert.equal((await fetch(`${fixture.origin}/api/health`)).status, 200);
    assert.equal((await fetch(`${fixture.origin}/api/bootstrap`)).status, 200);
  } finally {
    await fixture.close();
  }
});
