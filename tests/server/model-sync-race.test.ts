import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import { RpcRequestTimeoutError, type PiRpcClient } from "../../src/server/rpc-client";
import type { ResourceManager } from "../../src/server/resource-manager";
import type { SessionIndex } from "../../src/server/session-index";
import { ModelManager } from "../../src/server/model-manager";
import type { ModelInfo } from "../../src/shared/types";
import { FakeRpc } from "../helpers/server-app-fixture";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the expected model-sync state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function appFor(root: string, primary: FakeRpc): PiChatApp {
  return new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources: {} as ResourceManager,
    modelManager: new ModelManager(root),
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
}

function appState(app: PiChatApp) {
  return app as unknown as {
    modelRuntimeSyncPending: boolean;
    modelRuntimeSyncFailures: number;
    modelCatalogueRevision: number;
    activeSessionId: string;
    beginPromptAdmission(sessionId: string): Promise<() => void>;
    sessionMutationOutcomePending(sessionId: string): boolean;
  };
}

/** Serves a selection whose limits differ from the freshly refreshed catalogue. */
class LimitChangingRpc extends FakeRpc {
  /** Called inside the refresh RPC so a test can change models.json mid-call. */
  duringRefresh?: () => Promise<void> | void;
  reconcileAttempts = 0;
  refreshAttempts = 0;
  thinkingLevelCommands: string[] = [];
  failSetModel = false;
  failRefresh = false;
  /** True models an older Pi whose loader cannot install the refresh adapter. */
  unsupportedRefresh = false;
  /**
   * The Runtime's own snapshot. Tests that need the pre-fix bootstrap predicate
   * to be satisfiable must serve the real models.json rows here, otherwise the
   * comparison is trivially false and the test proves nothing.
   */
  catalogue: ModelInfo[] = [{
    provider: "test",
    id: "next",
    name: "Next",
    api: "openai-completions",
    reasoning: true,
    maxTokens: 16_000,
    contextWindow: 200_000,
  }];
  private refreshEntered = false;

  override async send(command: Record<string, unknown>, ...rest: unknown[]) {
    if (command.type === "pi_chat_refresh_models") {
      this.refreshAttempts += 1;
      const firstEntry = !this.refreshEntered;
      this.refreshEntered = true;
      if (firstEntry) await this.duringRefresh?.();
      if (this.unsupportedRefresh) throw new Error("Unknown command: pi_chat_refresh_models");
      if (this.failRefresh) throw new Error("Pi 模型目录刷新失败");
      return { type: "response", success: true, data: {} };
    }
    if (command.type === "set_model") {
      this.reconcileAttempts += 1;
      if (this.failSetModel) throw new Error("Pi set_model 失败");
      this.model = this.catalogue.find((model) => model.id === command.modelId) || this.model;
      return { type: "response", success: true, data: {} };
    }
    if (command.type === "set_thinking_level") {
      this.thinkingLevelCommands.push(String(command.level));
      return { type: "response", success: true, data: {} };
    }
    if (command.type === "get_available_models") {
      return { type: "response", success: true, data: { models: this.catalogue } };
    }
    return super.send(command, ...(rest as []));
  }
}

test("bootstrap never clears a pending model sync that a worker still owes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-bootstrap-pending-"));
  const primary = new LimitChangingRpc("C:\\sessions\\primary.jsonl", "primary");
  const models = new ModelManager(root);
  await models.add({ provider: "local", id: "old", baseUrl: "http://127.0.0.1:1", api: "openai-completions" });
  const app = appFor(root, primary);
  const state = appState(app);
  primary.failRefresh = true;
  try {
    await models.add({ provider: "local", id: "next", baseUrl: "http://127.0.0.1:2", api: "openai-completions" });
    // Serve the Runtime the SAME provider/id/api identity that models.json now
    // declares, which is exactly the condition the old bootstrap trusted. Only
    // the connection address differs, so a list comparison cannot detect it.
    primary.catalogue = [{
      provider: "local",
      id: "old",
      name: "old",
      api: "openai-completions",
      maxTokens: 2_000,
      contextWindow: 100_000,
    }, {
      provider: "local",
      id: "next",
      name: "next",
      api: "openai-completions",
      maxTokens: 16_000,
      contextWindow: 200_000,
    }];
    // The failing refresh must leave this worker stale, never credited.
    await waitFor(() => state.modelRuntimeSyncFailures > 0);
    const bootstrap = await app.bootstrap();
    assert.equal(
      bootstrap.modelRuntimeSyncPending,
      true,
      "a matching provider/id/api list is not proof that the new address reached the worker",
    );
    assert.equal(state.modelRuntimeSyncPending, true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a save that lands during a refresh is not credited to the worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-refresh-race-"));
  const primary = new LimitChangingRpc("C:\\sessions\\primary.jsonl", "primary");
  const models = new ModelManager(root);
  await models.add({ provider: "local", id: "old", baseUrl: "http://127.0.0.1:1", api: "openai-completions" });
  const app = appFor(root, primary);
  const state = appState(app);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  primary.duringRefresh = async () => {
    entered.resolve();
    await release.promise;
  };
  try {
    await models.add({ provider: "local", id: "next", baseUrl: "http://127.0.0.1:2", api: "openai-completions" });
    await entered.promise;
    const revisionDuringRefresh = state.modelCatalogueRevision;
    // Simulate a second save while the first refresh is still in flight.
    await models.add({ provider: "local", id: "third", baseUrl: "http://127.0.0.1:3", api: "openai-completions" });
    await waitFor(() => state.modelCatalogueRevision > revisionDuringRefresh);
    release.resolve();
    // The worker read the earlier file, so it must stay stale and be refreshed
    // again instead of being credited with the newer revision.
    await waitFor(() => primary.refreshAttempts >= 2);
    assert.equal(state.modelRuntimeSyncPending, false, "the retried refresh catches the worker up");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a background re-selection waits behind the user's own Session operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-reconcile-lane-"));
  const primary = new LimitChangingRpc("C:\\sessions\\primary.jsonl", "primary");
  primary.model = {
    provider: "test",
    id: "next",
    name: "Next",
    api: "openai-completions",
    maxTokens: 2_000,
  } as ModelInfo;
  const models = new ModelManager(root);
  await models.add({ provider: "local", id: "old", baseUrl: "http://127.0.0.1:1", api: "openai-completions" });
  const app = appFor(root, primary);
  const state = appState(app);
  try {
    const release = await state.beginPromptAdmission(state.activeSessionId);
    await models.add({ provider: "local", id: "next", baseUrl: "http://127.0.0.1:2", api: "openai-completions" });
    // Positive evidence that the background pass actually started; otherwise a
    // slow machine would pass the negative assertion below without testing it.
    await waitFor(() => primary.refreshAttempts > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      primary.reconcileAttempts,
      0,
      "a user operation holding the Session lane keeps the background pass out",
    );
    release();
    await waitFor(() => primary.reconcileAttempts > 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an old Pi with a catalogue gap reloads once instead of looping", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-model-gap-"));
  const primary = new LimitChangingRpc("C:\\sessions\\primary.jsonl", "primary");
  // This Pi cannot refresh a registry, and its startup catalogue never contains
  // the configured model, so the gap is permanent rather than stale sync.
  primary.catalogue = [{ provider: "other", id: "foreign", name: "Foreign", api: "openai-completions" }];
  primary.unsupportedRefresh = true;
  const models = new ModelManager(root);
  await models.add({ provider: "local", id: "old", baseUrl: "http://127.0.0.1:1", api: "openai-completions" });
  const app = appFor(root, primary);
  try {
    await models.add({ provider: "local", id: "next", baseUrl: "http://127.0.0.1:2", api: "openai-completions" });
    await waitFor(() => primary.restartCount > 0);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(
      primary.restartCount,
      1,
      "a permanent catalogue gap must not trigger a Runtime restart every retry tick",
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a background reconcile that fails never escalates to a full Runtime reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-no-escalation-"));
  const primary = new LimitChangingRpc("C:\\sessions\\primary.jsonl", "primary");
  primary.model = {
    provider: "test",
    id: "next",
    name: "Next",
    api: "openai-completions",
    maxTokens: 2_000,
  } as ModelInfo;
  primary.failSetModel = true;
  const models = new ModelManager(root);
  await models.add({ provider: "local", id: "old", baseUrl: "http://127.0.0.1:1", api: "openai-completions" });
  const app = appFor(root, primary);
  try {
    await models.add({ provider: "local", id: "next", baseUrl: "http://127.0.0.1:2", api: "openai-completions" });
    await waitFor(() => primary.reconcileAttempts > 0);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(
      primary.restartCount,
      0,
      "recovering one Session's limits must not stop every other worker",
    );
    assert.ok(primary.reconcileAttempts >= 2, "the bounded retry keeps trying");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed re-selection keeps sync pending instead of reporting ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-reconcile-fail-"));
  const primary = new LimitChangingRpc("C:\\sessions\\primary.jsonl", "primary");
  primary.model = {
    provider: "test",
    id: "next",
    name: "Next",
    api: "openai-completions",
    maxTokens: 2_000,
  } as ModelInfo;
  primary.failSetModel = true;
  const models = new ModelManager(root);
  await models.add({ provider: "local", id: "old", baseUrl: "http://127.0.0.1:1", api: "openai-completions" });
  const app = appFor(root, primary);
  const state = appState(app);
  try {
    await models.add({ provider: "local", id: "next", baseUrl: "http://127.0.0.1:2", api: "openai-completions" });
    await waitFor(() => primary.reconcileAttempts > 0);
    await waitFor(() => state.modelRuntimeSyncPending);
    assert.ok(state.modelRuntimeSyncFailures > 0, "the failure is scheduled for a bounded retry");
    // The user-visible consequence: a page reload must not turn this into
    // "模型目录已刷新" while the Session still carries the old limits.
    assert.equal(
      (await app.bootstrap()).modelRuntimeSyncPending,
      true,
      "bootstrap must not convert a failed re-selection into ready",
    );
    // And it must never escalate to a full Runtime reload for this.
    assert.equal(primary.restartCount, 0, "a failed re-selection must not restart the Runtime");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a timed-out re-selection fences the Session before releasing its lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-reconcile-timeout-"));
  // An acknowledgement that never arrives: the write may still land later.
  class TimingOutRpc extends LimitChangingRpc {
    override async send(command: Record<string, unknown>, ...rest: unknown[]) {
      if (command.type === "set_model") {
        this.reconcileAttempts += 1;
        throw new RpcRequestTimeoutError("set_model", "written-outcome-unknown");
      }
      return super.send(command, ...(rest as []));
    }
  }
  const primary = new TimingOutRpc("C:\sessions\primary.jsonl", "primary");
  primary.model = {
    provider: "test",
    id: "next",
    name: "Next",
    api: "openai-completions",
    maxTokens: 2_000,
  } as ModelInfo;
  const models = new ModelManager(root);
  await models.add({ provider: "local", id: "old", baseUrl: "http://127.0.0.1:1", api: "openai-completions" });
  const app = appFor(root, primary);
  const state = appState(app);
  // A bound Session is what the fence is keyed by; an unbound primary has no
  // competing user operation to protect.
  state.activeSessionId = "session-under-test";
  try {
    await models.add({ provider: "local", id: "next", baseUrl: "http://127.0.0.1:2", api: "openai-completions" });
    await waitFor(() => primary.reconcileAttempts > 0);
    await waitFor(() => state.sessionMutationOutcomePending("session-under-test"));
    // The fence exists while the lane is still held, so a user cannot slip in
    // and then be reverted by the late write.
    assert.equal(
      state.sessionMutationOutcomePending("session-under-test"),
      true,
      "an unconfirmed background write must be fenced, like the user-facing set_model",
    );
    // And it must not be retried blindly on top of an unknown write.
    const attempts = primary.reconcileAttempts;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(primary.reconcileAttempts, attempts, "an unconfirmed write is not repeated");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
