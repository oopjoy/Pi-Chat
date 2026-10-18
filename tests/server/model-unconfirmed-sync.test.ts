import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import { RpcRequestTimeoutError, type PiRpcClient, type RpcSendOptions } from "../../src/server/rpc-client";
import type { ResourceManager } from "../../src/server/resource-manager";
import type { SessionIndex } from "../../src/server/session-index";
import { FakeRpc } from "../helpers/server-app-fixture";

const sessionId = "model-fence-fixture";
const modelA = { provider: "fixture", id: "A", name: "A", api: "openai-completions", maxTokens: 16000 };
const modelB = { ...modelA, id: "B", name: "B" };

class UnconfirmedRpc extends FakeRpc {
  selected = { ...modelA, maxTokens: 2000 };
  thinking = "high";
  timeoutStage: "set_model" | "set_thinking_level" | null = "set_model";
  late?: (response: Record<string, unknown>) => void;
  writes: Record<string, unknown>[] = [];
  refreshes = 0;
  afterCatalogueRead?: () => void;

  override async send(command: Record<string, unknown>, timeout?: number, options?: RpcSendOptions) {
    if (command.type === "get_state") return { success: true, data: { model: this.selected, thinkingLevel: this.thinking, isStreaming: false } };
    if (command.type === "get_available_models") {
      this.afterCatalogueRead?.();
      return { success: true, data: { models: [modelA, modelB] } };
    }
    if (command.type === "pi_chat_refresh_models") { this.refreshes += 1; return { success: true, data: {} }; }
    if (command.type === "set_model" || command.type === "set_thinking_level") {
      this.writes.push(command);
      if (this.timeoutStage === command.type) {
        this.late = options?.onLateResponse;
        throw new RpcRequestTimeoutError(String(command.type), "written-outcome-unknown");
      }
      if (command.type === "set_model") {
        this.selected = command.modelId === "B" ? modelB : modelA;
        this.thinking = "low";
      } else this.thinking = String(command.level);
      return { success: true, data: {} };
    }
    return super.send(command, timeout, options);
  }
}

type SyncMethods = {
  activeSessionId: string;
  modelCatalogueRevision: number;
  modelRuntimeSyncPending: boolean;
  syncModelRuntime(): Promise<void>;
  sessionMutationOutcomePending(id: string): boolean;
  reconcileSelectedModel(target: { rpc: PiRpcClient; sessionId: string; generation: number }): Promise<string>;
  broadcast(event: Record<string, unknown>): void;
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-fenced-model-"));
  const rpc = new UnconfirmedRpc(join(root, "session.jsonl"), "pi-session");
  const app = new PiChatApp({
    rpc: rpc as unknown as PiRpcClient,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources: {} as ResourceManager, cwd: root, webRoot: root,
  });
  const state = app as unknown as SyncMethods;
  state.activeSessionId = sessionId;
  state.modelCatalogueRevision = 2;
  state.modelRuntimeSyncPending = true;
  const events: Record<string, unknown>[] = [];
  state.broadcast = (event) => { events.push(event); };
  return { rpc, state, events, target: { rpc: rpc as unknown as PiRpcClient, sessionId, generation: rpc.generation },
    async close() { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

test("a fenced selection stays pending and every sync entry refuses another write", async () => {
  const f = await fixture();
  try {
    await f.state.syncModelRuntime();
    assert.equal(f.state.sessionMutationOutcomePending(sessionId), true);
    assert.equal(f.state.modelRuntimeSyncPending, true, "blocked retry does not mean finished");
    assert.equal(f.events.filter((event) => event.type === "pi_chat_models_updated").at(-1)?.runtimeSync, "waiting-for-runtime-reload");
    const before = f.rpc.writes.length;
    assert.equal(await f.state.reconcileSelectedModel(f.target), "unconfirmed");
    await f.state.syncModelRuntime();
    f.state.modelCatalogueRevision += 1; // a new save is another wake source
    await f.state.syncModelRuntime();
    assert.equal(f.rpc.writes.length, before);
    assert.equal(f.rpc.refreshes, 1, "a fenced worker is not refreshed by a new config save either");
    assert.equal(f.state.modelRuntimeSyncPending, true);
  } finally { await f.close(); }
});

test("late acknowledgement permits verification but cannot overwrite a newer user model", async () => {
  const f = await fixture();
  try {
    await f.state.syncModelRuntime();
    assert.ok(f.rpc.late);
    f.rpc.timeoutStage = null;
    f.rpc.selected = modelB; // user selection wins before the next serial check
    f.rpc.thinking = "high";
    const before = f.rpc.writes.length;
    f.rpc.late({ type: "response", success: true });
    assert.equal(f.state.sessionMutationOutcomePending(sessionId), false);
    assert.equal(f.state.modelRuntimeSyncPending, true, "an acknowledgement alone is not a sync completion");
    await f.state.syncModelRuntime();
    assert.equal(f.state.modelRuntimeSyncPending, false);
    assert.equal(f.rpc.selected.id, "B");
    assert.equal(f.rpc.thinking, "high");
    assert.equal(f.rpc.writes.length, before);
  } finally { await f.close(); }
});

test("a replaced worker cannot receive a stale background model or thinking write", async () => {
  const f = await fixture();
  try {
    f.rpc.timeoutStage = null;
    f.rpc.afterCatalogueRead = () => { f.rpc.generation += 1; };
    assert.equal(await f.state.reconcileSelectedModel(f.target), "unchanged");
    assert.deepEqual(f.rpc.writes, []);
  } finally { await f.close(); }
});
