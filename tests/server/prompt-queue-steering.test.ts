import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
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

test("Primary and Secondary settlement dispatch every queued follow-up", async () => {
  const pathA = "C:\\sessions\\queue-primary.jsonl";
  const pathB = "C:\\sessions\\queue-secondary.jsonl";
  const idA = idForPath(pathA);
  const idB = idForPath(pathB);
  const primary = new FakeRpc(pathA, "queue-primary");
  const secondary = new FakeRpc(pathB, "queue-secondary");
  const sessions = {
    list: async (activePath?: string) => [
      { id: idA, sessionId: "queue-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: idForPath(activePath || pathA) === idA },
      { id: idB, sessionId: "queue-secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
    ],
    pathForId: (id: string) => id === idA ? pathA : id === idB ? pathB : null,
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
  const prompt = (sessionId: string, message: string) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, message }),
  });
  const settle = async (rpc: FakeRpc) => {
    rpc.streaming = false;
    rpc.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  try {
    await fetch(`${origin}/api/bootstrap`);
    await fetch(`${origin}/api/sessions/${idB}/view`);
    for (const [id, rpc, prefix] of [[idA, primary, "primary"], [idB, secondary, "secondary"]] as const) {
      const first = await prompt(id, `${prefix}-A`);
      assert.equal(first.status, 202);
      const second = await prompt(id, `${prefix}-B`);
      const secondId = (await second.json() as { id: string }).id;
      const third = await prompt(id, `${prefix}-C`);
      const thirdId = (await third.json() as { id: string }).id;
      await settle(rpc);
      assert.ok(
        rpc.requestTimeouts.some(
          ({ type, timeoutMs, independentRead }) =>
            type === "get_state" &&
            timeoutMs === 60_000 &&
            independentRead,
        ),
        "the post-settlement FIFO barrier must be a long independent state read",
      );
      assert.deepEqual(rpc.commands.filter((command) => command.type === "prompt").map((command) => command.message), [`${prefix}-A`, `${prefix}-B`]);
      await settle(rpc);
      assert.deepEqual(rpc.commands.filter((command) => command.type === "prompt").map((command) => command.message), [`${prefix}-A`, `${prefix}-B`, `${prefix}-C`]);
      await settle(rpc);

      const diagnosticSnapshot = (app as unknown as {
        stateDiagnostics: { snapshot(): {
          entries: Array<{ category: string; name: string; sessionId?: string; promptId?: string }>;
          promptEvidence: { records: Array<{ promptId: string; delivery: string; execution: string; facts: string[] }> };
        } };
        activePromptDiagnostics: Map<string, unknown>;
      }).stateDiagnostics.snapshot();
      const diagnosticEntries = diagnosticSnapshot.entries.filter((entry) =>
        entry.category === "prompt" && entry.sessionId === id
      );
      const admittedIds = diagnosticEntries
        .filter((entry) => entry.name === "admitted")
        .map((entry) => entry.promptId);
      assert.equal(admittedIds.length, 3);
      assert.equal(new Set(admittedIds).size, 3);
      for (const queuedId of [secondId, thirdId]) {
        assert.ok(admittedIds.includes(queuedId));
        const names = diagnosticEntries
          .filter((entry) => entry.promptId === queuedId)
          .map((entry) => entry.name);
        for (const expected of [
          "admitted",
          "queued",
          "dispatch",
          "rpc-allocated",
          "rpc-written",
          "agent-start",
          "rpc-response",
          "settled",
          "settlement-barrier",
        ]) assert.ok(names.includes(expected), `${prefix} ${queuedId} missing ${expected}`);
        const evidence = diagnosticSnapshot.promptEvidence.records.find((record) => record.promptId === queuedId);
        assert.equal(evidence?.delivery, "confirmed");
        assert.equal(evidence?.execution, "settled");
        assert.ok(evidence?.facts.includes("queued"));
      }
      assert.equal(
        (app as unknown as { activePromptDiagnostics: Map<string, unknown> })
          .activePromptDiagnostics.has(id),
        false,
      );
      assert.equal(JSON.stringify(diagnosticEntries).includes(`${prefix}-A`), false);
    }
  } finally {
    server.close();
    await app.close();
  }
});

test("in-flight tool activity prevents a stale false streaming snapshot from admitting an ordinary prompt", async () => {
  const path = "C:\\sessions\\tool-active-primary.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "tool-active-primary");
  const summary = { id, sessionId: "tool-active-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true };
  const sessions = {
    list: async () => [summary],
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summary,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    primary.emit({ type: "tool_execution_start", toolName: "bash" });
    // Reproduce the observed contradiction: a lagging state projection says
    // false while the current assistant turn still owns unresolved tool work.
    (app as unknown as { running: boolean }).running = false;
    primary.streaming = false;
    const inventory = await fetch(`${origin}/api/sessions`);
    assert.equal(inventory.status, 200);
    const inventoryBody = await inventory.json() as { sessions: SessionSummary[] };
    assert.equal(inventoryBody.sessions[0]?.activity?.execution, "running");
    assert.equal(inventoryBody.sessions[0]?.running, true);
    const bootstrapProjection = await fetch(`${origin}/api/bootstrap`);
    assert.equal(bootstrapProjection.status, 200);
    const bootstrapBody = await bootstrapProjection.json() as { state: { isStreaming: boolean }; toolStatus?: string };
    assert.equal(bootstrapBody.state.isStreaming, true);
    assert.match(bootstrapBody.toolStatus || "", /bash/);
    const viewProjection = await fetch(`${origin}/api/sessions/${id}/view`);
    assert.equal(viewProjection.status, 200);
    const viewBody = await viewProjection.json() as { state: { isStreaming: boolean }; isStreaming: boolean; session: SessionSummary; toolStatus?: string };
    assert.equal(viewBody.state.isStreaming, true);
    assert.equal(viewBody.isStreaming, true);
    assert.equal(viewBody.session.running, true);
    assert.match(viewBody.toolStatus || "", /bash/);
    const response = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "must queue behind tool" }),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as { queued?: boolean; queue?: Array<{ message: string }> };
    assert.equal(body.queued, true);
    assert.deepEqual(body.queue?.map((item) => item.message), ["must queue behind tool"]);
    assert.equal(
      primary.commands.some((command) => command.type === "prompt" && command.message === "must queue behind tool"),
      false,
      "ordinary input cannot enter Pi until the tool-owning turn settles",
    );
    const resume = await fetch(`${origin}/api/chat/queue/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
    });
    assert.equal(resume.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      primary.commands.some((command) => command.type === "prompt" && command.message === "must queue behind tool"),
      false,
      "manual queue resume cannot bypass unresolved live/tool activity",
    );
    const reconcile = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "confirm stale tool state", delivery: "steer" }),
    });
    assert.equal(reconcile.status, 409);
    assert.equal(
      (await reconcile.json() as { code?: string }).code,
      "STEER_ALREADY_SETTLED",
    );
    for (let attempt = 0; attempt < 20 && !primary.commands.some((command) => command.type === "prompt" && command.message === "must queue behind tool"); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      primary.commands.some((command) => command.type === "prompt" && command.message === "must queue behind tool"),
      true,
      "the authoritative idle probe clears stale tool activity and releases the queued ordinary prompt",
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("steering bypasses local queues for running Primary and Secondary only", async () => {
  const primaryPath = "C:\\sessions\\steer-primary.jsonl";
  const secondaryPath = "C:\\sessions\\steer-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "steer-primary");
  const secondary = new FakeRpc(secondaryPath, "steer-secondary");
  const summaries = [
    { id: primaryId, sessionId: "steer-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "steer-secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    summaryForId: (id: string) => summaries.find((session) => session.id === id) || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => secondary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const steer = (sessionId: string, message: string) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, message, delivery: "steer" }),
  });
  try {
    await fetch(`${origin}/api/bootstrap`);
    await fetch(`${origin}/api/sessions/${secondaryId}/warm`, { method: "POST" });

    const idle = await steer(primaryId, "too late");
    assert.equal(idle.status, 409);
    const idleBody = await idle.json() as { error: string; code?: string };
    assert.match(idleBody.error, /未在运行/);
    assert.equal(idleBody.code, "STEER_NOT_RUNNING");
    assert.equal(primary.commands.some((command) => command.type === "steer"), false);

    primary.streaming = true;
    secondary.streaming = true;
    primary.emit({ type: "agent_start" });
    secondary.emit({ type: "agent_start" });
    const primarySteer = await steer(primaryId, "redirect primary");
    const secondarySteer = await steer(secondaryId, "redirect secondary");
    assert.equal(primarySteer.status, 202);
    assert.deepEqual(await primarySteer.json(), {
      accepted: true,
      queued: false,
      steered: true,
    });
    assert.equal(secondarySteer.status, 202);
    assert.deepEqual(await secondarySteer.json(), {
      accepted: true,
      queued: false,
      steered: true,
    });
    assert.deepEqual(
      primary.commands.filter((command) => command.type === "steer").map((command) => command.message),
      ["redirect primary"],
    );
    assert.deepEqual(
      secondary.commands.filter((command) => command.type === "steer").map((command) => command.message),
      ["redirect secondary"],
    );
    assert.deepEqual((app as unknown as { promptQueue: unknown[] }).promptQueue, []);
    assert.deepEqual(
      (app as unknown as { runtimePool: { get(id: string): { promptQueue: unknown[] } | undefined } }).runtimePool.get(secondaryId)?.promptQueue,
      [],
    );
    assert.equal((app as unknown as {
      stateDiagnostics: { snapshot(): { promptEvidence: { records: unknown[] } } };
    }).stateDiagnostics.snapshot().promptEvidence.records.length, 0);

    const abortSecondary = await fetch(`${origin}/api/chat/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: secondaryId }),
    });
    assert.equal(abortSecondary.status, 200);
    assert.equal(secondary.restartCount, 1, "Stop must reset an unconsumed native steering queue");
  } finally {
    server.close();
    await app.close();
  }
});

test("a Steer that reaches an already-settled Pi is rejected and cleared without becoming a prompt", async () => {
  const path = "C:\\sessions\\steer-settle-race.jsonl";
  const id = idForPath(path);
  class SettledBeforeSteerAckRpc extends FakeRpc {
    override async send(command: Record<string, unknown>, timeoutMs?: number) {
      if (command.type === "steer") {
        const response = await super.send(command, timeoutMs);
        this.streaming = false;
        this.emit({ type: "agent_settled" });
        return response;
      }
      return super.send(command, timeoutMs);
    }
  }
  const primary = new SettledBeforeSteerAckRpc(path, "steer-settle-race");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-settle-race", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const response = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "too late", delivery: "steer" }),
    });
    assert.equal(response.status, 409);
    const responseBody = await response.json() as { error: string; code?: string };
    assert.match(responseBody.error, /已结束/);
    assert.equal(responseBody.code, "STEER_ALREADY_SETTLED");
    assert.equal(primary.restartCount, 1);
    assert.equal(
      primary.commands.some(
        (command) => command.type === "prompt" && command.message === "too late",
      ),
      false,
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("settlement clears native steering even when the post-Steer state snapshot was still running", async () => {
  const path = "C:\\sessions\\steer-late-settle.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-late-settle");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-late-settle", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const response = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "accepted before late settle", delivery: "steer" }),
    });
    assert.equal(response.status, 202);
    primary.streaming = false;
    primary.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(primary.restartCount, 1);
    assert.equal(
      primary.commands.some(
        (command) =>
          command.type === "prompt" &&
          command.message === "accepted before late settle",
      ),
      false,
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("a crashed worker's stale steering state cannot reset the recovered Runtime", async () => {
  const path = "C:\\sessions\\steer-crash-recover.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-crash-recover");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-crash-recover", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const prompt = (message: string, delivery?: string) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: id, message, ...(delivery ? { delivery } : {}) }),
  });
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const steer = await prompt("queued before crash", "steer");
    assert.equal(steer.status, 202);
    // The worker crashes before consuming: process-error must clear the stale
    // steering bookkeeping instead of leaving it for the replacement worker.
    primary.crash();
    // A later ordinary prompt recovers the Runtime and runs normally.
    const recovered = await prompt("recover me");
    assert.equal(recovered.status, 202);
    // The recovered worker settles; stale steering must not reset it again.
    primary.streaming = false;
    primary.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(primary.restartCount, 1, "only the recovery restart may occur");
  } finally {
    server.close();
    await app.close();
  }
});

test("only a verified dequeue consumes a Steer admission, never a same-text ordinary prompt", async () => {
  const path = "C:\\sessions\\steer-verified-consume.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-verified-consume");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-verified-consume", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const state = app as unknown as {
    nativeSteeringAdmissionsBySession: Map<string, { generation: number; items: Array<{ message: string; promptAt: number }> }>;
    lastUserPromptAtBySession: Map<string, number>;
  };
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const steer = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "继续", delivery: "steer" }),
    });
    assert.equal(steer.status, 202);
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id)?.items.length, 1);
    // An ordinary prompt with the identical text emits message_start without a
    // prior dequeue; it must not consume the admission.
    primary.emit({ type: "message_start", message: { role: "user", content: "继续" } });
    assert.equal(
      state.nativeSteeringAdmissionsBySession.get(id)?.items.length,
      1,
      "text-only message_start must not consume a Steer admission",
    );
    // Pi consumes the steer: it dequeues (queue_update shrinks) immediately
    // before the consuming message_start.
    primary.emit({ type: "queue_update", steering: [], followUp: [] });
    primary.emit({ type: "message_start", message: { role: "user", content: "继续" } });
    assert.equal(
      state.nativeSteeringAdmissionsBySession.get(id),
      undefined,
      "verified dequeue + message_start consumes the admission",
    );
    assert.equal(state.lastUserPromptAtBySession.has(id), true);
  } finally {
    server.close();
    await app.close();
  }
});

test("identical native Steers are consumed as distinct queue occurrences", async () => {
  const path = "C:\\sessions\\steer-identical.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-identical");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-identical", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const state = app as unknown as {
    pendingNativeSteeringBySession: Map<string, { messages: string[]; dequeued: string[] }>;
    nativeSteeringAdmissionsBySession: Map<string, { items: Array<{ message: string }> }>;
  };
  const steer = () => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: id, message: "继续", delivery: "steer" }),
  });
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    assert.equal((await steer()).status, 202);
    assert.equal((await steer()).status, 202);
    assert.deepEqual(primary.steeringQueue, ["继续", "继续"]);
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id)?.items.length, 2);

    primary.steeringQueue.shift();
    primary.emit({ type: "queue_update", steering: [...primary.steeringQueue], followUp: [] });
    primary.emit({ type: "message_start", message: { role: "user", content: "继续" } });
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id)?.items.length, 1);
    assert.deepEqual(state.pendingNativeSteeringBySession.get(id), {
      generation: 0,
      messages: ["继续"],
      dequeued: [],
    });

    primary.steeringQueue.shift();
    primary.emit({ type: "queue_update", steering: [], followUp: [] });
    primary.emit({ type: "message_start", message: { role: "user", content: "继续" } });
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id), undefined);
    assert.equal(state.pendingNativeSteeringBySession.get(id), undefined);
  } finally {
    server.close();
    await app.close();
  }
});

test("a verified Steer dequeue survives an intervening queue_update", async () => {
  const path = "C:\\sessions\\steer-dequeue-gap.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-dequeue-gap");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-dequeue-gap", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const state = app as unknown as {
    pendingNativeSteeringBySession: Map<string, { messages: string[]; dequeued: string[] }>;
    nativeSteeringAdmissionsBySession: Map<string, { items: Array<{ message: string }> }>;
  };
  const steer = (message: string) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: id, message, delivery: "steer" }),
  });
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    assert.equal((await steer("A")).status, 202);
    assert.equal((await steer("B")).status, 202);
    primary.steeringQueue.shift();
    primary.emit({ type: "queue_update", steering: [...primary.steeringQueue], followUp: [] });
    assert.deepEqual(state.pendingNativeSteeringBySession.get(id)?.dequeued, ["A"]);

    assert.equal((await steer("C")).status, 202);
    assert.deepEqual(
      state.pendingNativeSteeringBySession.get(id),
      { generation: 0, messages: ["B", "C"], dequeued: ["A"] },
      "a later queue_update must retain the earlier verified dequeue",
    );
    primary.emit({ type: "message_start", message: { role: "user", content: "A" } });
    assert.deepEqual(
      state.nativeSteeringAdmissionsBySession.get(id)?.items.map((item) => item.message),
      ["B", "C"],
    );
    assert.deepEqual(state.pendingNativeSteeringBySession.get(id), {
      generation: 0,
      messages: ["B", "C"],
      dequeued: [],
    });
  } finally {
    server.close();
    await app.close();
  }
});

test("failed settlement reset still clears lost native Steers and broadcasts the reason", async () => {
  const path = "C:\\sessions\\steer-reset-failure.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-reset-failure");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-reset-failure", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const frames: string[] = [];
  const clients = (app as unknown as { sseClients: Map<{ write: (frame: string) => boolean }, string> }).sseClients;
  clients.set({ write: (frame) => { frames.push(frame); return true; } }, "11111111-1111-4111-8111-111111111111");
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const state = app as unknown as {
    pendingNativeSteeringBySession: Map<string, unknown>;
    nativeSteeringAdmissionsBySession: Map<string, unknown>;
  };
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const accepted = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "lost during reset", delivery: "steer" }),
    });
    assert.equal(accepted.status, 202);
    primary.restartFailures = 1;
    primary.streaming = false;
    primary.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(primary.restartCount, 1);
    assert.equal(state.pendingNativeSteeringBySession.get(id), undefined);
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id), undefined);
    const cleared = frames.find((frame) =>
      frame.includes('"type":"pi_chat_native_steering_cleared"'),
    );
    assert.ok(cleared, "restart failure must settle accepted Steers");
    assert.match(cleared, /"reason":"process-error"/);
    assert.match(cleared, /"droppedCount":1/);
    const processError = frames.find((frame) =>
      frame.includes('"type":"pi_chat_process_error"'),
    );
    assert.match(
      processError || "",
      /"nativeSteeringDroppedCount":1/,
      "the synthesized process error must preserve the specific drop verdict",
    );
  } finally {
    clients.clear();
    server.close();
    await app.close();
  }
});

test("a post-Steer get_state timeout keeps the accepted Steer as 202", async () => {
  const path = "C:\\sessions\\steer-probe-timeout.jsonl";
  const id = idForPath(path);
  class StateTimeoutAfterSteerRpc extends FakeRpc {
    override async send(command: Record<string, unknown>, timeoutMs?: number) {
      if (
        command.type === "get_state" &&
        this.commands.some((candidate) => candidate.type === "steer")
      ) {
        this.commands.push(command);
        throw new RpcRequestTimeoutError("get_state");
      }
      return super.send(command, timeoutMs);
    }
  }
  const primary = new StateTimeoutAfterSteerRpc(path, "steer-probe-timeout");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-probe-timeout", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const response = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "accepted under timeout", delivery: "steer" }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      accepted: true,
      queued: false,
      steered: true,
    });
  } finally {
    server.close();
    await app.close();
  }
});

test("a timed-out Steer write retains its admission for later verified consumption", async () => {
  const path = "C:\\sessions\\steer-write-timeout.jsonl";
  const id = idForPath(path);
  class SteerTimeoutRpc extends FakeRpc {
    override async send(command: Record<string, unknown>, timeoutMs?: number) {
      if (command.type === "steer") {
        await super.send(command, timeoutMs);
        throw new RpcRequestTimeoutError("steer");
      }
      return super.send(command, timeoutMs);
    }
  }
  const primary = new SteerTimeoutRpc(path, "steer-write-timeout");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-write-timeout", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const state = app as unknown as {
    nativeSteeringAdmissionsBySession: Map<string, { items: unknown[] }>;
  };
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const response = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "possibly queued", delivery: "steer" }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      accepted: true,
      queued: false,
      steered: true,
      deliveryUncertain: true,
    });
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id)?.items.length, 1);
    primary.steeringQueue.shift();
    primary.emit({ type: "queue_update", steering: [], followUp: [] });
    primary.emit({ type: "message_start", message: { role: "user", content: "possibly queued" } });
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id), undefined);
  } finally {
    server.close();
    await app.close();
  }
});

test("a timed-out Steer without queue_update is cleared when the active turn settles", async () => {
  const path = "C:\\sessions\\steer-timeout-no-snapshot.jsonl";
  const id = idForPath(path);
  class LostSteerTimeoutRpc extends FakeRpc {
    override async send(command: Record<string, unknown>, timeoutMs?: number) {
      if (command.type === "steer") {
        // Model a write that reached an indeterminate transport boundary: no
        // queue_update proves Pi accepted it, but the local admission remains.
        this.commands.push(command);
        throw new RpcRequestTimeoutError("steer");
      }
      return super.send(command, timeoutMs);
    }
  }
  const primary = new LostSteerTimeoutRpc(path, "steer-timeout-no-snapshot");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-timeout-no-snapshot", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const state = app as unknown as {
    pendingNativeSteeringBySession: Map<string, unknown>;
    nativeSteeringAdmissionsBySession: Map<string, { items: unknown[] }>;
  };
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const response = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "possibly lost", delivery: "steer" }),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json() as { deliveryUncertain?: boolean }).deliveryUncertain, true);
    assert.equal(state.pendingNativeSteeringBySession.get(id), undefined);
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id)?.items.length, 1);

    primary.streaming = false;
    primary.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(primary.restartCount, 1);
    assert.equal(state.pendingNativeSteeringBySession.get(id), undefined);
    assert.equal(state.nativeSteeringAdmissionsBySession.get(id), undefined);
  } finally {
    server.close();
    await app.close();
  }
});

test("native steering backlog is bounded and rejects the 21st Steer", async () => {
  const path = "C:\\sessions\\steer-backlog.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-backlog");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-backlog", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const steer = (message: string) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: id, message, delivery: "steer" }),
  });
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    for (let index = 0; index < 20; index += 1) {
      const response = await steer(`steer ${index}`);
      assert.equal(response.status, 202, `steer ${index} should be accepted`);
    }
    const overflow = await steer("steer overflow");
    assert.equal(overflow.status, 409);
    assert.match((await overflow.json() as { error: string }).error, /已满/);
    assert.equal(
      primary.commands.filter((command) => command.type === "steer").length,
      20,
      "the 21st Steer must never reach Pi",
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("native steering image payload is bounded", async () => {
  const path = "C:\\sessions\\steer-image-bound.jsonl";
  const id = idForPath(path);
  const primary = new FakeRpc(path, "steer-image-bound");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-image-bound", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const steerWithImages = (message: string, imageData: string[]) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: id,
      message,
      delivery: "steer",
      images: imageData.map((data) => ({ mimeType: "image/png", data })),
    }),
  });
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    // ~33 MB chars of queued images stay under the 45 MB bound.
    const accepted = await steerWithImages("look", ["a".repeat(11_000_000), "a".repeat(11_000_000), "a".repeat(11_000_000)]);
    assert.equal(accepted.status, 202);
    // The next payload pushes the queued total over the bound.
    const overflow = await steerWithImages("look again", ["b".repeat(6_100_000), "b".repeat(6_100_000)]);
    assert.equal(overflow.status, 409);
    assert.match((await overflow.json() as { error: string }).error, /图片总量/);
  } finally {
    server.close();
    await app.close();
  }
});

test("a Steer admitted while abort is in flight is reset by the live pending re-check", async () => {
  const path = "C:\\sessions\\steer-during-abort.jsonl";
  const id = idForPath(path);
  class GatedAbortRpc extends FakeRpc {
    releaseAbort!: () => void;
    private readonly abortGate = new Promise<void>((resolve) => {
      this.releaseAbort = resolve;
    });
    override async send(command: Record<string, unknown>) {
      if (command.type === "abort") {
        this.commands.push(command);
        await this.abortGate;
        this.streaming = false;
        return { type: "response", success: true };
      }
      return super.send(command);
    }
  }
  const primary = new GatedAbortRpc(path, "steer-during-abort");
  primary.streaming = true;
  const summaries = [
    { id, sessionId: "steer-during-abort", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    const abort = fetch(`${origin}/api/chat/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
    });
    // Steer arrives while the abort command is still in flight.
    const steer = await fetch(`${origin}/api/chat/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "during abort", delivery: "steer" }),
    });
    assert.equal(steer.status, 202);
    primary.releaseAbort();
    const abortResponse = await abort;
    assert.equal(abortResponse.status, 200);
    assert.equal(primary.restartCount, 1, "the live pending re-check must reset the unconsumed Steer");
  } finally {
    server.close();
    await app.close();
  }
});

test("a timed-out Primary prompt returns deliveryUncertain and queues the next message safely", async () => {
  const path = "C:\\sessions\\primary-prompt-timeout.jsonl";
  const id = idForPath(path);
  class PromptTimeoutRpc extends FakeRpc {
    override async send(command: Record<string, unknown>, timeoutMs?: number) {
      if (command.type === "prompt") {
        this.commands.push(command);
        this.streaming = true;
        this.emit({ type: "agent_start" });
        throw new RpcRequestTimeoutError("prompt");
      }
      return super.send(command, timeoutMs);
    }
  }
  const primary = new PromptTimeoutRpc(path, "primary-prompt-timeout");
  const summaries = [
    { id, sessionId: "primary-prompt-timeout", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: true },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (candidate: string) => candidate === id ? path : null,
    summaryForId: () => summaries[0],
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const prompt = (message: string) => fetch(`${origin}/api/chat/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: id, message }),
  });
  try {
    await fetch(`${origin}/api/bootstrap`);
    const uncertain = await prompt("possibly accepted");
    assert.equal(uncertain.status, 202);
    assert.deepEqual(await uncertain.json(), {
      accepted: true,
      queued: false,
      deliveryUncertain: true,
    });
    const diagnosticInternals = app as unknown as {
      activePromptDiagnostics: Map<string, { promptId: string; rpcGeneration: number }>;
      stateDiagnostics: { snapshot(): { entries: Array<{ category: string; name: string; promptId?: string }> } };
    };
    const uncertainPromptId = diagnosticInternals.activePromptDiagnostics.get(id)?.promptId;
    assert.match(uncertainPromptId || "", /^[a-f0-9-]{36}$/);
    assert.ok(
      diagnosticInternals.stateDiagnostics.snapshot().entries.some((entry) =>
        entry.category === "prompt"
        && entry.name === "delivery-uncertain"
        && entry.promptId === uncertainPromptId
      ),
    );
    const queued = await prompt("must wait behind uncertain turn");
    assert.equal(queued.status, 202);
    const body = await queued.json() as {
      accepted: boolean;
      queued: boolean;
      queue: Array<{ message: string }>;
    };
    assert.equal(body.queued, true);
    assert.deepEqual(body.queue.map((item) => item.message), [
      "must wait behind uncertain turn",
    ]);
    assert.deepEqual(
      primary.commands
        .filter((command) => command.type === "prompt")
        .map((command) => command.message),
      ["possibly accepted"],
      "the next prompt must not race a command Pi may already be executing",
    );
  } finally {
    server.close();
    await app.close();
  }
});

test("abort timeouts remain accepted while Primary and Secondary wait to settle", async () => {
  const primaryPath = "C:\\sessions\\abort-primary.jsonl";
  const secondaryPath = "C:\\sessions\\abort-secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  class SlowAbortRpc extends FakeRpc {
    override async send(command: Record<string, unknown>) {
      if (command.type === "abort") {
        this.commands.push(command);
        throw new RpcRequestTimeoutError("abort");
      }
      return super.send(command);
    }
  }
  const primary = new SlowAbortRpc(primaryPath, "abort-primary");
  const secondary = new SlowAbortRpc(secondaryPath, "abort-secondary");
  primary.streaming = true;
  secondary.streaming = true;
  const summaries = [
    { id: primaryId, sessionId: "abort-primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "abort-secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    summaryForId: (id: string) => summaries.find((session) => session.id === id) || null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => secondary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const postAbort = (sessionId: string) => fetch(`${origin}/api/chat/abort`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId }) });
  try {
    await fetch(`${origin}/api/bootstrap`);
    await fetch(`${origin}/api/sessions/${secondaryId}/warm`, { method: "POST" });
    for (const sessionId of [primaryId, secondaryId]) {
      const response = await postAbort(sessionId);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        abortPending: true,
        isStreaming: true,
        queuePaused: false,
      });
    }
  } finally {
    server.close();
    await app.close();
  }
});

test("all opened sessions route prompts, events and aborts to independent RPC workers", async () => {
  const pathA = "C:\\sessions\\a.jsonl";
  const pathB = "C:\\sessions\\b.jsonl";
  const pathC = "C:\\sessions\\c.jsonl";
  const idA = idForPath(pathA);
  const idB = idForPath(pathB);
  const idC = idForPath(pathC);
  const primary = new FakeRpc(pathA, "a");
  const secondary = new FakeRpc(pathB, "b");
  const third = new FakeRpc(pathC, "c");
  const summaries = [
    { id: idA, sessionId: "a", name: "A", preview: "A", cwd: process.cwd(), updatedAt: 3, messageCount: 0, active: true },
    { id: idB, sessionId: "b", name: "B", preview: "B", cwd: process.cwd(), updatedAt: 2, messageCount: 0, active: false },
    { id: idC, sessionId: "c", name: "C", preview: "C", cwd: process.cwd(), updatedAt: 1, messageCount: 0, active: false },
  ];
  const workers = [secondary, third];
  const sessions = {
    list: async (activePath?: string) => summaries.map((session) => ({ ...session, active: session.id === idForPath(activePath || pathA) })),
    pathForId: (id: string) => id === idA ? pathA : id === idB ? pathB : id === idC ? pathC : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    createRpc: () => workers.shift() as unknown as PiRpcClient,
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
  const post = (path: string, body: object = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as { activeSessionIds: string[] };
    assert.deepEqual(bootstrap.activeSessionIds, [idA]);
    assert.equal((await fetch(`${origin}/api/sessions/${idB}/view`)).status, 200);
    assert.equal((await fetch(`${origin}/api/sessions/${idC}/view`)).status, 200);

    assert.equal((await post("/api/chat/prompt", { message: "for A", sessionId: idA })).status, 202);
    assert.equal((await post("/api/chat/prompt", { message: "for B", sessionId: idB })).status, 202);
    assert.equal((await post("/api/chat/prompt", { message: "for C", sessionId: idC })).status, 202);
    assert.deepEqual(primary.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for A"]);
    assert.deepEqual(secondary.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for B"]);
    assert.deepEqual(third.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for C"]);
    assert.equal(primary.streaming, true);
    assert.equal(secondary.streaming, true);
    assert.equal(third.streaming, true);

    const queuedB2 = await post("/api/chat/prompt", { message: "B queued then cancelled", sessionId: idB });
    const queuedB2Data = await queuedB2.json() as { queued: boolean; id: string };
    assert.equal(queuedB2.status, 202);
    assert.equal(queuedB2Data.queued, true);
    const queuedB3 = await post("/api/chat/prompt", { message: "B queued then dispatched", sessionId: idB });
    assert.equal((await queuedB3.json() as { queued: boolean }).queued, true);
    const cancelled = await fetch(`${origin}/api/chat/queue/${queuedB2Data.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: idB }) });
    assert.equal(cancelled.status, 200);
    assert.deepEqual((await cancelled.json() as { queue: Array<{ message: string }> }).queue.map((item) => item.message), ["B queued then dispatched"]);
    const cancelledEvidence = (app as unknown as {
      stateDiagnostics: { snapshot(): { promptEvidence: { records: Array<{ promptId: string; delivery: string; execution: string; facts: string[] }> } } };
    }).stateDiagnostics.snapshot().promptEvidence.records.find((record) => record.promptId === queuedB2Data.id);
    assert.equal(cancelledEvidence?.delivery, "unknown");
    assert.equal(cancelledEvidence?.execution, "cancelled");
    assert.deepEqual(cancelledEvidence?.facts, ["admitted", "queued", "cancelled"]);

    const abortedB = await post("/api/chat/abort", { sessionId: idB });
    assert.equal(abortedB.status, 200);
    assert.equal((await abortedB.json() as { queuePaused: boolean }).queuePaused, true);
    assert.equal(primary.streaming, true);
    assert.equal(secondary.streaming, false);
    assert.equal(primary.commands.filter((item) => item.type === "abort").length, 0);
    assert.equal(secondary.commands.filter((item) => item.type === "abort").length, 1);

    secondary.crash();
    const resumed = await post("/api/chat/queue/resume", { sessionId: idB });
    assert.equal(resumed.status, 200);
    assert.equal(secondary.restartCount, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(secondary.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for B", "B queued then dispatched"]);
    assert.deepEqual(primary.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for A"]);
    assert.deepEqual(third.commands.filter((item) => item.type === "prompt").map((item) => item.message), ["for C"]);
  } finally {
    server.close();
    await app.close();
  }
});
