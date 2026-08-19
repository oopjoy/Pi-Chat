import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import type { PiRpcClient } from "../../src/server/rpc-client";
import { idForPath } from "../../src/server/session-index";
import type { SessionIndex } from "../../src/server/session-index";
import type { ResourceManager } from "../../src/server/resource-manager";
import { FakeRpc } from "../helpers/server-app-fixture";

class BlockingCompactRpc extends FakeRpc {
  private resolveCompactStarted!: () => void;
  private resolveCompact!: () => void;
  readonly compactStarted = new Promise<void>((resolve) => {
    this.resolveCompactStarted = resolve;
  });
  private readonly compactReleased = new Promise<void>((resolve) => {
    this.resolveCompact = resolve;
  });

  releaseCompact(): void {
    this.resolveCompact();
  }

  override async send(...args: Parameters<FakeRpc["send"]>) {
    const [command] = args;
    if (command.type !== "compact") return super.send(...args);
    this.commands.push(command);
    this.resolveCompactStarted();
    await this.compactReleased;
    return { type: "response", success: true, data: {} };
  }
}

test("compact restores a cold secondary Session without bypassing its queue", async () => {
  const primaryPath = "C:\\sessions\\compact-primary.jsonl";
  const secondaryPath = "C:\\sessions\\compact-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "compact-primary");
  const secondary = new FakeRpc(secondaryPath, "compact-secondary");
  const summaries = [
    {
      id: primaryId,
      sessionId: "compact-primary",
      name: "Primary",
      preview: "",
      cwd: process.cwd(),
      updatedAt: 2,
      messageCount: 1,
      active: true,
    },
    {
      id: secondaryId,
      sessionId: "compact-secondary",
      name: "Secondary",
      preview: "",
      cwd: process.cwd(),
      updatedAt: 1,
      messageCount: 1,
      active: false,
    },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) =>
      id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    summaryForId: (id: string) => summaries.find((session) => session.id === id) || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => secondary as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const internals = app as unknown as {
    runtimePool: {
      get(id: string): {
        promptQueue: Array<{
          id: string;
          message: string;
          images: [];
          imageCount: number;
          createdAt: number;
        }>;
        queuePaused: boolean;
        dispatching: boolean;
      } | undefined;
    };
  };
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const compact = (customInstructions: string) =>
    fetch(`${origin}/api/chat/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: secondaryId, customInstructions }),
    });

  try {
    assert.equal((await compact("cold")).status, 200);
    assert.deepEqual(
      secondary.commands.filter((command) => command.type === "compact"),
      [{ type: "compact", customInstructions: "cold" }],
      "a cold Secondary receives the compact RPC",
    );
    assert.equal(
      primary.commands.some((command) => command.type === "compact"),
      false,
      "the Primary must never receive a Secondary compact request",
    );
    assert.equal(
      primary.commands.filter((command) => command.type === "get_state").length,
      1,
      "direct compact binds Primary identity before restoring a cold Secondary",
    );

    const runtime = internals.runtimePool.get(secondaryId);
    assert.ok(runtime);
    runtime.promptQueue.push({
      id: "00000000-0000-4000-8000-000000000801",
      message: "must stay queued",
      images: [],
      imageCount: 0,
      createdAt: 1,
    });
    runtime.queuePaused = true;
    const blocked = await compact("must not run");
    assert.equal(blocked.status, 409);
    assert.equal(
      secondary.commands.filter((command) => command.type === "compact").length,
      1,
      "Compact must not bypass a paused Secondary queue",
    );

    runtime.promptQueue.length = 0;
    runtime.queuePaused = false;
    runtime.dispatching = true;
    const dispatching = await compact("must not cross dispatch barrier");
    assert.equal(dispatching.status, 409);
    assert.equal(
      secondary.commands.filter((command) => command.type === "compact").length,
      1,
      "Compact must not run while a Secondary dispatch barrier is active",
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("compact rejects an unknown but well-formed Session without creating a Runtime", async () => {
  const primaryPath = "C:\\sessions\\unknown-compact-primary.jsonl";
  const primaryId = idForPath(primaryPath);
  const unknownId = "0123456789abcdefabcd";
  const primary = new FakeRpc(primaryPath, "unknown-compact-primary");
  const sessions = {
    list: async () => [{
      id: primaryId,
      sessionId: "unknown-compact-primary",
      name: "Primary",
      preview: "",
      cwd: process.cwd(),
      updatedAt: 1,
      messageCount: 1,
      active: true,
    }],
    pathForId: (id: string) => id === primaryId ? primaryPath : null,
    summaryForId: () => null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => new FakeRpc("C:\\sessions\\unexpected.jsonl", "unexpected") as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const internals = app as unknown as {
    runtimePool: { size: number };
  };
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${origin}/api/chat/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: unknownId }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(
      await response.json(),
      { error: "该会话尚未启用" },
    );
    assert.equal(internals.runtimePool.size, 0);
    assert.equal(
      primary.commands.some((command) => command.type === "compact"),
      false,
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("compact restores a reclaimed secondary Session through its own Runtime", async () => {
  const primaryPath = "C:\\sessions\\reclaimed-compact-primary.jsonl";
  const secondaryPath = "C:\\sessions\\reclaimed-compact-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "reclaimed-compact-primary");
  const secondary = new FakeRpc(secondaryPath, "reclaimed-compact-secondary");
  const summaries = [
    { id: primaryId, sessionId: "reclaimed-compact-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "reclaimed-compact-secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) =>
      id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    summaryForId: (id: string) => summaries.find((session) => session.id === id) || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => secondary as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const internals = app as unknown as {
    runtimePool: { reclaim(id: string, reason: "idle"): Promise<boolean> };
  };
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    assert.equal(
      (await fetch(`${origin}/api/sessions/${secondaryId}/activate`, { method: "POST" })).status,
      200,
    );
    assert.equal(await internals.runtimePool.reclaim(secondaryId, "idle"), true);
    const response = await fetch(`${origin}/api/chat/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: secondaryId, customInstructions: "reclaimed" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      secondary.commands
        .filter((command) => command.type === "compact")
        .map((command) => command.customInstructions),
      ["reclaimed"],
      "the compact request recreates the reclaimed Secondary rather than targeting Primary",
    );
    assert.equal(
      primary.commands.some((command) => command.type === "compact"),
      false,
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("compact still targets an idle Primary and rejects all scheduler-busy Primary states", async () => {
  const primaryPath = "C:\\sessions\\primary-compact.jsonl";
  const primaryId = idForPath(primaryPath);
  const primary = new FakeRpc(primaryPath, "primary-compact");
  const sessions = {
    list: async () => [{
      id: primaryId,
      sessionId: "primary-compact",
      name: "Primary",
      preview: "",
      cwd: process.cwd(),
      updatedAt: 1,
      messageCount: 1,
      active: true,
    }],
    pathForId: (id: string) => id === primaryId ? primaryPath : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const internals = app as unknown as {
    scheduler: {
      primaryDispatching: boolean;
      primaryQueuePaused: boolean;
      primaryToolStatus: string;
      primaryQueue: Array<{
        id: string;
        message: string;
        images: [];
        imageCount: number;
        createdAt: number;
      }>;
    };
  };
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const compact = () => fetch(`${origin}/api/chat/compact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: primaryId }),
  });

  try {
    assert.equal((await compact()).status, 200);
    assert.equal(
      primary.commands.filter((command) => command.type === "compact").length,
      1,
      "an idle Primary receives compact",
    );
    const busyStates = [
      () => { internals.scheduler.primaryDispatching = true; },
      () => { internals.scheduler.primaryQueuePaused = true; },
      () => { internals.scheduler.primaryToolStatus = "tool running"; },
      () => internals.scheduler.primaryQueue.push({
        id: "00000000-0000-4000-8000-000000000802",
        message: "queued",
        images: [],
        imageCount: 0,
        createdAt: 1,
      }),
    ];
    for (const makeBusy of busyStates) {
      makeBusy();
      const response = await compact();
      assert.equal(response.status, 409);
      assert.equal(
        primary.commands.filter((command) => command.type === "compact").length,
        1,
        "busy Primary state must not send compact",
      );
      internals.scheduler.primaryDispatching = false;
      internals.scheduler.primaryQueuePaused = false;
      internals.scheduler.primaryToolStatus = "";
      internals.scheduler.primaryQueue.length = 0;
    }
  } finally {
    server.close();
    await app.close();
  }
});

test("compact serializes a same-Session prompt behind its idle proof and RPC write", async () => {
  const primaryPath = "C:\\sessions\\compact-serial-primary.jsonl";
  const secondaryPath = "C:\\sessions\\compact-serial-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "compact-serial-primary");
  const secondary = new BlockingCompactRpc(secondaryPath, "compact-serial-secondary");
  const summaries = [
    { id: primaryId, sessionId: "compact-serial-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "compact-serial-secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) =>
      id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    summaryForId: (id: string) => summaries.find((session) => session.id === id) || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => secondary as unknown as PiRpcClient,
    sessions,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    await fetch(`${origin}/api/bootstrap`);
    const compact = fetch(`${origin}/api/chat/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: secondaryId }),
    });
    await secondary.compactStarted;
    const prompt = fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: secondaryId, message: "after compact" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      secondary.commands.some(
        (command) => command.type === "prompt" && command.message === "after compact",
      ),
      false,
      "prompt admission waits until Compact releases the same Session transaction",
    );
    secondary.releaseCompact();
    assert.equal((await compact).status, 200);
    assert.equal((await prompt).status, 202);
    assert.deepEqual(
      secondary.commands
        .filter((command) => command.type === "compact" || command.type === "prompt")
        .map((command) => command.type),
      ["compact", "prompt"],
    );
  } finally {
    server.close();
    await app.close();
  }
});
