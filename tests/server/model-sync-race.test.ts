import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import type { PiRpcClient } from "../../src/server/rpc-client";
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
  };
}

/** Serves a selection whose limits differ from the freshly refreshed catalogue. */
class LimitChangingRpc extends FakeRpc {
  /** Called inside the refresh RPC so a test can change models.json mid-call. */
  duringRefresh?: () => Promise<void> | void;
  reconcileAttempts = 0;
  refreshAttempts = 0;
  modelChangeCommands: string[] = [];
  failSetModel = false;
  failRefresh = false;
  private refreshEntered = false;

  override async send(command: Record<string, unknown>, ...rest: unknown[]) {
    if (command.type === "pi_chat_refresh_models") {
      this.refreshAttempts += 1;
      const firstEntry = !this.refreshEntered;
      this.refreshEntered = true;
      if (firstEntry) await this.duringRefresh?.();
      if (this.failRefresh) throw new Error("Pi 模型目录刷新失败");
      return { type: "response", success: true, data: {} };
    }
    if (command.type === "set_model") {
      this.reconcileAttempts += 1;
      this.modelChangeCommands.push("set_model");
      if (this.failSetModel) throw new Error("Pi set_model 失败");
      const models = await this.send({ type: "get_available_models" });
      const list = (models as { data?: { models?: ModelInfo[] } }).data?.models || [];
      this.model = list.find((model) => model.id === command.modelId) || this.model;
      return { type: "response", success: true, data: {} };
    }
    if (command.type === "get_available_models") {
      return {
        type: "response",
        success: true,
        data: {
          models: [{
            provider: "test",
            id: "next",
            name: "Next",
            api: "openai-completions",
            reasoning: true,
            maxTokens: 16_000,
            contextWindow: 200_000,
          }],
        },
      };
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
    // The failing refresh must leave this worker stale, never credited.
    await waitFor(() => state.modelRuntimeSyncFailures > 0);
    const bootstrap = await app.bootstrap();
    assert.equal(
      bootstrap.modelRuntimeSyncPending,
      true,
      "a matching provider/id list is not proof that the new address reached the worker",
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
    await new Promise((resolve) => setTimeout(resolve, 400));
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
    assert.equal(
      state.modelRuntimeSyncPending,
      true,
      "the Session still carries old limits, so the catalogue refresh is not the whole story",
    );
    assert.ok(state.modelRuntimeSyncFailures > 0, "the failure is scheduled for a bounded retry");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
