import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/server/app.ts", import.meta.url), "utf8");

test("model config refresh is bounded per worker and never waits for unrelated sessions", () => {
  const start = source.indexOf("private modelRegistryClients");
  const end = source.indexOf("private async syncModelRuntime");
  assert.ok(start > 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /\{ rpc: this\.options\.rpc, idle: !this\.primaryTurnActive\(\) \}/);
  assert.match(body, /idle: this\.runtimePool\.isIdle\(runtime\)/);
  assert.match(body, /if \(!idle && await this\.workerIsStreaming\(rpc\)\) \{/);
  assert.match(body, /pi_chat_refresh_models/);
  assert.doesNotMatch(body, /busyConversationCount/, "a busy unrelated Session must not gate the refresh");
});

test("only an older Pi lacking the adapter falls back to a full Runtime reload", () => {
  const refreshStart = source.indexOf("private async refreshLiveModelRegistries");
  const reconcileStart = source.indexOf("private async reconcileSelectedModel");
  const refreshBody = source.slice(refreshStart, reconcileStart);
  assert.match(refreshBody, /Unknown command/, "a missing adapter is the only reload trigger");
  const start = source.indexOf("private async syncModelRuntime");
  const end = source.indexOf("private beginMutation");
  const body = source.slice(start, end);
  assert.match(body, /if \(refresh\.refreshed\.length\)/);
  assert.match(body, /if \(refresh\.busy > 0\)/);
  const refreshReturn = body.indexOf("return;");
  const reload = body.indexOf("await this.reloadRpc()");
  assert.ok(refreshReturn > 0 && reload > refreshReturn, "the reload fallback comes after the refresh path");
  assert.match(body, /if \(this\.busyConversationCount\(\) > 0\)/, "reload still waits for quiescence");
});

test("a refreshed catalogue re-selects a stale session model without touching a running turn", () => {
  const start = source.indexOf("private async reconcileSelectedModel");
  const end = source.indexOf("private async syncModelRuntime");
  const body = source.slice(start, end);
  assert.match(body, /if \(state\.isStreaming\) return;/);
  assert.match(body, /type: "set_model", provider: fresh\.provider, modelId: fresh\.id/);
  assert.match(body, /JSON\.stringify\(fresh\) === JSON\.stringify\(selected\)/);
  // Pi recomputes thinking from the user default on re-selection.
  assert.match(body, /type: "set_thinking_level", level: thinkingLevel/);
});

test("a worker's own state decides idleness, and retries back off instead of looping", () => {
  assert.match(source, /private async workerIsStreaming/);
  assert.match(source, /if \(!idle && await this\.workerIsStreaming\(rpc\)\)/);
  assert.match(source, /this\.modelRuntimeSyncFailures < 5/);
  assert.match(source, /Math\.min\(30_000, 1_000 \* 2 \*\* this\.modelRuntimeSyncFailures\)/);
  assert.match(source, /this\.modelRegistryRevisions\.get\(rpc\) === this\.modelCatalogueRevision/, "already-current workers are skipped on retry");
});
