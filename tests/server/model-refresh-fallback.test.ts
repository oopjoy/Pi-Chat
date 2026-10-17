import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import type { PiRpcClient } from "../../src/server/rpc-client";
import type { ResourceManager } from "../../src/server/resource-manager";
import type { SessionIndex } from "../../src/server/session-index";
import { ModelManager } from "../../src/server/model-manager";
import { FakeRpc } from "../helpers/server-app-fixture";

/** An older Pi rejects the process-local adapter the way RpcClient reports it. */
class OldPiRpc extends FakeRpc {
  refreshAttempts = 0;
  override async send(command: Record<string, unknown>, ...rest: unknown[]) {
    if (command.type === "pi_chat_refresh_models") {
      this.refreshAttempts += 1;
      // RpcClient rejects a `success: false` response instead of resolving it.
      throw new Error("Unknown command: pi_chat_refresh_models");
    }
    return super.send(command, ...(rest as []));
  }
}

function appFor(root: string, primary: FakeRpc) {
  return new PiChatApp({
    rpc: primary as unknown as PiRpcClient,
    sessions: { list: async () => [] } as unknown as SessionIndex,
    resources: {} as ResourceManager,
    modelManager: new ModelManager(root),
    cwd: process.cwd(),
    webRoot: process.cwd(),
  });
}

test("an older Pi without the refresh adapter falls back to one idle Runtime reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-model-fallback-"));
  const primary = new OldPiRpc("C:\\sessions\\primary.jsonl", "primary");
  const models = new ModelManager(root);
  await models.add({ provider: "local", id: "old", baseUrl: "http://127.0.0.1:1", api: "openai-completions" });
  const app = appFor(root, primary);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await models.add({ provider: "local", id: "next", baseUrl: "http://127.0.0.1:1", api: "openai-completions" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await fetch(`${origin}/api/bootstrap`);
    assert.ok(primary.refreshAttempts > 0, "the cheap path is attempted first");
    assert.equal(primary.restartCount, 1, "only the missing adapter justifies a Runtime reload");
  } finally {
    server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a worker with a request in flight is not refreshed mid-turn and is refreshed once it settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-model-busy-"));
  const primary = new FakeRpc("C:\\sessions\\primary.jsonl", "primary");
  primary.streaming = true;
  const models = new ModelManager(root);
  await models.add({ provider: "local", id: "old", baseUrl: "http://127.0.0.1:1", api: "openai-completions" });
  const app = appFor(root, primary);
  const server = createServer((request, response) => void app.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${origin}/api/bootstrap`);
    primary.emit({ type: "agent_start" });
    await models.add({ provider: "local", id: "next", baseUrl: "http://127.0.0.1:1", api: "openai-completions" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      primary.commands.filter((command) => command.type === "pi_chat_refresh_models").length,
      0,
      "a running turn keeps the route it resolved",
    );
    assert.equal(primary.restartCount, 0, "no reload is attempted while a turn is active");

    // The fake worker keeps reporting isStreaming until it is told the turn
    // ended, which is exactly the state a mid-turn refresh must respect.
    primary.streaming = false;
    primary.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    assert.ok(
      primary.commands.some((command) => command.type === "pi_chat_refresh_models"),
      "the settled worker picks up the catalogue without a reload",
    );
    assert.equal(primary.restartCount, 0);
  } finally {
    server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
