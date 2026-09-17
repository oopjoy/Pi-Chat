import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import type { ResourceManager } from "../../src/server/resource-manager";
import type { PiRpcClient } from "../../src/server/rpc-client";
import { RuntimePool } from "../../src/server/runtime-pool";
import type { SessionRelationStore } from "../../src/server/session-relations";
import { idForPath, type SessionIndex } from "../../src/server/session-index";
import type { SessionSummary } from "../../src/shared/types";
import { FakeRpc } from "../helpers/server-app-fixture";

class HeldStateRpc extends FakeRpc {
  private holdState = false;
  private startedResolve: (() => void) | null = null;
  private releaseResolve: (() => void) | null = null;
  private released = Promise.resolve();

  holdNextStateRead(): { started: Promise<void>; release: () => void } {
    this.holdState = true;
    const started = new Promise<void>((resolve) => {
      this.startedResolve = resolve;
    });
    this.released = new Promise<void>((resolve) => {
      this.releaseResolve = resolve;
    });
    return {
      started,
      release: () => this.releaseResolve?.(),
    };
  }

  override async send(
    command: Record<string, unknown>,
    timeoutMs?: number,
    options?: Parameters<FakeRpc["send"]>[2],
  ) {
    if (this.holdState && command.type === "get_state") {
      this.holdState = false;
      this.startedResolve?.();
      await this.released;
    }
    return super.send(command, timeoutMs, options);
  }
}

function sessionIndex(summaries: SessionSummary[]): SessionIndex {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  return {
    list: async () => summaries,
    summaryForId: (id: string) => byId.get(id) || null,
    pathForId: (id: string) => byId.has(id) ? `${id}.jsonl` : null,
    messagesForId: async (id: string) => byId.has(id) ? [] : null,
  } as unknown as SessionIndex;
}

async function listen(app: PiChatApp) {
  const server = createServer((request, response) => {
    void app.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

test("Secondary reclaim drains an admitted view and the response falls back cold", async () => {
  const primaryPath = "C:\\sessions\\view-admission-primary.jsonl";
  const secondaryPath = "C:\\sessions\\view-admission-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "view-admission-primary");
  const secondary = new HeldStateRpc(secondaryPath, "view-admission-secondary");
  const summaries: SessionSummary[] = [
    {
      id: primaryId,
      sessionId: "view-admission-primary",
      name: "Primary",
      preview: "",
      cwd: process.cwd(),
      updatedAt: 2,
      messageCount: 1,
      active: true,
    },
    {
      id: secondaryId,
      sessionId: "view-admission-secondary",
      name: "Secondary",
      preview: "",
      cwd: process.cwd(),
      updatedAt: 1,
      messageCount: 1,
      active: false,
    },
  ];
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => secondary as unknown as PiRpcClient,
    sessions: sessionIndex(summaries),
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const { server, origin } = await listen(app);
  try {
    assert.equal((await fetch(`${origin}/api/sessions/${secondaryId}/activate`, {
      method: "POST",
    })).status, 200);
    const held = secondary.holdNextStateRead();
    const responsePromise = fetch(`${origin}/api/sessions/${secondaryId}/view`);
    await held.started;

    const pool = (app as unknown as { runtimePool: RuntimePool }).runtimePool;
    const runtime = pool.get(secondaryId);
    assert.ok(runtime);
    const stopPromise = pool.stopReclaimable(runtime);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(secondary.stopCount, 0, "reclaim waits for the admitted read");

    held.release();
    assert.equal(await stopPromise, true);
    pool.detach(secondaryId);
    const response = await responsePromise;
    assert.equal(response.status, 200);
    const view = await response.json() as {
      isActive: boolean;
      runtimeStatus: string;
    };
    assert.equal(view.isActive, false);
    assert.equal(view.runtimeStatus, "view-only");
  } finally {
    server.close();
    await app.close();
  }
});

test("Fork-origin lookup remains inside Secondary view admission", async () => {
  const primaryPath = "C:\\sessions\\fork-admission-primary.jsonl";
  const secondaryPath = "C:\\sessions\\fork-admission-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "fork-admission-primary");
  const secondary = new FakeRpc(secondaryPath, "fork-admission-secondary");
  const summaries: SessionSummary[] = [
    {
      id: primaryId,
      sessionId: "fork-admission-primary",
      name: "Primary",
      preview: "",
      cwd: process.cwd(),
      updatedAt: 2,
      messageCount: 1,
      active: true,
    },
    {
      id: secondaryId,
      sessionId: "fork-admission-secondary",
      name: "Secondary",
      preview: "",
      cwd: process.cwd(),
      updatedAt: 1,
      messageCount: 1,
      active: false,
    },
  ];
  let originCalls = 0;
  let originStarted!: () => void;
  let releaseOrigin!: () => void;
  const started = new Promise<void>((resolve) => { originStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseOrigin = resolve; });
  const relations = {
    getForkOrigin: async () => {
      originCalls += 1;
      if (originCalls === 1) {
        originStarted();
        await released;
      }
      return null;
    },
    recordFork: async () => undefined,
    removeDestination: async () => undefined,
  } as unknown as SessionRelationStore;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => secondary as unknown as PiRpcClient,
    sessions: sessionIndex(summaries),
    sessionRelations: relations,
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const { server, origin } = await listen(app);
  try {
    assert.equal((await fetch(`${origin}/api/sessions/${secondaryId}/activate`, {
      method: "POST",
    })).status, 200);
    const responsePromise = fetch(`${origin}/api/sessions/${secondaryId}/view`);
    await started;

    const pool = (app as unknown as { runtimePool: RuntimePool }).runtimePool;
    const runtime = pool.get(secondaryId);
    assert.ok(runtime);
    const stopPromise = pool.stopReclaimable(runtime);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(secondary.stopCount, 0, "Fork read retains the operation lease");

    releaseOrigin();
    assert.equal(await stopPromise, true);
    pool.detach(secondaryId);
    const response = await responsePromise;
    assert.equal(response.status, 200);
    const view = await response.json() as {
      isActive: boolean;
      runtimeStatus: string;
    };
    assert.equal(view.isActive, false);
    assert.equal(view.runtimeStatus, "view-only");
    assert.equal(originCalls, 2, "cold fallback re-reads provenance");
  } finally {
    server.close();
    await app.close();
  }
});

test("Primary rest drains an admitted view and cannot return active state", async () => {
  const primaryPath = "C:\\sessions\\primary-view-admission.jsonl";
  const primaryId = idForPath(primaryPath);
  const primary = new HeldStateRpc(primaryPath, "primary-view-admission");
  const summary: SessionSummary = {
    id: primaryId,
    sessionId: "primary-view-admission",
    name: "Primary",
    preview: "",
    cwd: process.cwd(),
    updatedAt: 1,
    messageCount: 1,
    active: true,
  };
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions: sessionIndex([summary]),
    resources: {} as ResourceManager,
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
  const { server, origin } = await listen(app);
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    const held = primary.holdNextStateRead();
    const responsePromise = fetch(`${origin}/api/sessions/${primaryId}/view`);
    await held.started;

    const rest = (
      app as unknown as {
        restSessionAfterWindowClose(id: string): Promise<boolean>;
      }
    ).restSessionAfterWindowClose(primaryId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(primary.stopCount, 0, "rest waits for the admitted read");

    held.release();
    assert.equal(await rest, true);
    const response = await responsePromise;
    assert.equal(response.status, 200);
    const view = await response.json() as {
      isActive: boolean;
      runtimeStatus: string;
    };
    assert.equal(view.isActive, false);
    assert.equal(view.runtimeStatus, "view-only");
  } finally {
    server.close();
    await app.close();
  }
});
