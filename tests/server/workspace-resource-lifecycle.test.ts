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

test("paused Secondary queue does not block future-default workspace changes", async () => {
  const primaryPath = "C:\\sessions\\primary.jsonl";
  const secondaryPath = "C:\\sessions\\secondary.jsonl";
  const primaryId = idForPath(primaryPath);
  const secondaryId = idForPath(secondaryPath);
  const primary = new FakeRpc(primaryPath, "primary");
  const secondary = new FakeRpc(secondaryPath, "secondary");
  const summaries = [
    { id: primaryId, sessionId: "primary", name: "Primary", preview: "", cwd: process.cwd(), updatedAt: 2, messageCount: 1, active: true },
    { id: secondaryId, sessionId: "secondary", name: "Secondary", preview: "", cwd: process.cwd(), updatedAt: 1, messageCount: 1, active: false },
  ];
  const sessions = {
    list: async () => summaries,
    pathForId: (id: string) => id === primaryId ? primaryPath : id === secondaryId ? secondaryPath : null,
    messagesForId: async () => [],
  } as unknown as SessionIndex;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, createRpc: () => secondary as unknown as PiRpcClient, sessions, resources: {} as ResourceManager, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 200);
    assert.equal((await fetch(`${origin}/api/sessions/${secondaryId}/activate`, { method: "POST" })).status, 200);
    const runtime = (app as unknown as { runtimes: Map<string, { queuePaused: boolean; promptQueue: object[] }> }).runtimes.get(secondaryId);
    assert.ok(runtime);
    runtime.queuePaused = true;
    runtime.promptQueue.push({ id: "queued" });
    const workspace = await fetch(`${origin}/api/workspace/set`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: process.cwd() }) });
    assert.equal(workspace.status, 200);
    for (const kind of ["skills", "extensions", "packages"]) {
      const resource = await fetch(`${origin}/api/resources/${kind}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "resource", enabled: true }) });
      assert.equal(resource.status, 405);
    }
    assert.equal(secondary.stopCount, 0);
  } finally {
    server.close();
    await app.close();
  }
});

test("model file mutation rolls back and restores the primary Runtime when reload fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-model-rollback-"));
  const path = "C:\\sessions\\primary.jsonl";
  const primary = new FakeRpc(path, "primary");
  const models = new ModelManager(root);
  await models.add({ provider: "local", id: "old", baseUrl: "http://127.0.0.1:1", api: "openai-completions" });
  const before = await readFile(models.path, "utf8");
  primary.restartFailures = 1;
  const app = new PiChatApp({ rpc: primary as unknown as PiRpcClient, sessions: {} as SessionIndex, resources: {} as ResourceManager, modelManager: models, cwd: process.cwd(), webRoot: process.cwd() });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/api/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "local", id: "new", baseUrl: "http://127.0.0.1:1", api: "openai-completions" }),
    });
    assert.equal(response.status, 500);
    assert.match((await response.json() as { error: string }).error, /原配置已自动恢复/);
    assert.equal(await readFile(models.path, "utf8"), before);
    assert.equal(primary.restartCount, 2);
    assert.equal(primary.alive, true);
    const health = await fetch(`${origin}/api/health`);
    assert.equal((await health.json() as { lifecycle: string }).lifecycle, "idle");
  } finally {
    server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace default change never restarts or rebinds a live Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-rollback-"));
  const previousCwd = join(root, "old");
  const nextCwd = join(root, "new");
  await Promise.all([mkdir(previousCwd), mkdir(nextCwd)]);
  const path = "C:\\sessions\\primary.jsonl";
  const primary = new FakeRpc(path, "primary");
  primary.restartFailures = 1;
  const app = new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources: {} as ResourceManager,
    cwd: previousCwd,
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/workspace/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: nextCwd }),
    });
    assert.equal(response.status, 200);
    assert.equal((app as unknown as { currentCwd: string }).currentCwd, nextCwd);
    assert.equal(primary.restartCount, 0);
    assert.equal(primary.alive, true);
  } finally {
    server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace commits serialize concurrent defaults and respect an active lifecycle barrier", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-commit-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await Promise.all([mkdir(first), mkdir(second)]);
  const app = new PiChatApp({
    rpc: new FakeRpc("C:\\sessions\\workspace.jsonl", "workspace") as unknown as PiRpcClient,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources: {} as ResourceManager,
    cwd: root,
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const setWorkspace = (path: string) => fetch(`${origin}/api/workspace/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const [firstResult, secondResult] = await Promise.all([setWorkspace(first), setWorkspace(second)]);
    assert.equal(firstResult.status, 200);
    assert.equal(secondResult.status, 200);
    assert.equal((app as unknown as { currentCwd: string }).currentCwd, second);
    assert.equal(JSON.parse(await readFile(join(agentDir, "pi-chat-workspace.json"), "utf8")).cwd, second);

    const lifecycle = app as unknown as { lifecycleCoordinator: { begin: (kind: "restarting") => void; end: (kind: "restarting") => void } };
    lifecycle.lifecycleCoordinator.begin("restarting");
    const blocked = await setWorkspace(first);
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json() as { code: string }).code, "APPLICATION_LIFECYCLE_BLOCKED");
    lifecycle.lifecycleCoordinator.end("restarting");
  } finally {
    server.close();
    await app.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace picker retains the former bootstrap response for older browser bundles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-picker-contract-"));
  const selected = join(root, "selected");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(selected);
  const app = new PiChatApp({
    rpc: new FakeRpc("C:\\sessions\\picker.jsonl", "picker") as unknown as PiRpcClient,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources: {} as ResourceManager,
    cwd: root,
    webRoot: process.cwd(),
    pickWorkspaceFolder: async () => selected,
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/workspace/pick`, { method: "POST" });
    assert.equal(response.status, 200);
    const data = await response.json() as { cancelled: boolean; cwd: string; workspaceEpoch: string; workspaceRevision: number; data?: { workspaceCwd?: string; workspaceEpoch?: string; workspaceRevision?: number } };
    assert.equal(data.cancelled, false);
    assert.equal(data.cwd, selected);
    assert.equal(data.data?.workspaceCwd, selected, "older clients still read the nested bootstrap workspace path");
    assert.equal(data.data?.workspaceEpoch, data.workspaceEpoch);
    assert.equal(data.data?.workspaceRevision, data.workspaceRevision);
  } finally {
    server.close();
    await app.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("a delayed workspace picker responds with one latest snapshot for legacy and revision-aware clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-picker-snapshot-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await Promise.all([mkdir(first), mkdir(second)]);
  const app = new PiChatApp({
    rpc: new FakeRpc("C:\\sessions\\picker-snapshot.jsonl", "picker-snapshot") as unknown as PiRpcClient,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources: {} as ResourceManager,
    cwd: root,
    webRoot: process.cwd(),
    pickWorkspaceFolder: async () => first,
  });
  const internals = app as unknown as { bootstrap: (clientId?: string) => Promise<unknown> };
  const originalBootstrap = internals.bootstrap.bind(app);
  let releaseBootstrap!: () => void;
  const heldBootstrap = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
  let bootstrapStarted!: () => void;
  const startedBootstrap = new Promise<void>((resolve) => { bootstrapStarted = resolve; });
  internals.bootstrap = async (clientId = "") => {
    bootstrapStarted();
    await heldBootstrap;
    return originalBootstrap(clientId);
  };
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const pickerResponse = fetch(`${origin}/api/workspace/pick`, { method: "POST" });
    await startedBootstrap;
    const newerCommit = await fetch(`${origin}/api/workspace/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: second }),
    });
    assert.equal(newerCommit.status, 200);
    releaseBootstrap();
    const response = await pickerResponse;
    assert.equal(response.status, 200);
    const data = await response.json() as { cwd: string; workspaceEpoch: string; workspaceRevision: number; data: { workspaceCwd: string; workspaceEpoch?: string; workspaceRevision?: number } };
    assert.equal(data.cwd, second, "a picker response cannot restore its earlier committed cwd");
    assert.equal(data.workspaceRevision, 2);
    assert.equal(data.data.workspaceCwd, data.cwd, "legacy and new clients receive the same workspace snapshot");
    assert.equal(data.data.workspaceEpoch, data.workspaceEpoch);
    assert.equal(data.data.workspaceRevision, data.workspaceRevision);
  } finally {
    releaseBootstrap?.();
    server.close();
    await app.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace resource inventory remains rooted at the Primary cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-workspace-resources-"));
  const primaryCwd = join(root, "primary");
  const laterDefault = join(root, "later-default");
  await Promise.all([mkdir(primaryCwd), mkdir(laterDefault)]);
  const calls: string[] = [];
  const resources = {
    listSkills: async (cwd: string) => { calls.push(`skills:${cwd}`); return { resources: [], diagnostics: [] }; },
    listExtensions: async (cwd: string) => { calls.push(`extensions:${cwd}`); return { resources: [], diagnostics: [] }; },
    listPackages: async (cwd: string) => { calls.push(`packages:${cwd}`); return { resources: [], diagnostics: [] }; },
  } as unknown as ResourceManager;
  const app = new PiChatApp({
    rpc: new FakeRpc("C:\\sessions\\resources.jsonl", "resources") as unknown as PiRpcClient,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources,
    cwd: primaryCwd,
    webRoot: process.cwd(),
  });
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const changed = await fetch(`${origin}/api/workspace/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: laterDefault }),
    });
    assert.equal(changed.status, 200);
    for (const kind of ["skills", "extensions", "packages"]) assert.equal((await fetch(`${origin}/api/resources/${kind}`)).status, 200);
    assert.deepEqual(calls, [`skills:${primaryCwd}`, `extensions:${primaryCwd}`, `packages:${primaryCwd}`]);
  } finally {
    server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
