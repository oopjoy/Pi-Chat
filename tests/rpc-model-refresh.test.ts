import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PiRpcClient, rpcData } from "../src/server/rpc-client";
import { pinnedPiEntry } from "./helpers/pinned-pi";
import type { ModelInfo } from "../src/shared/types";

type ModelsResponse = { models: ModelInfo[] };

test("a real Pi worker refreshes models.json in place without restarting", { timeout: 90_000 }, async () => {
  const piEntry = pinnedPiEntry;
  assert.ok(piEntry);
  const rpcRegister = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "resources",
    "runtime",
    "pi-chat-rpc-register.mjs",
  );
  const sandbox = await mkdtemp(join(tmpdir(), "pi-chat-model-refresh-"));
  const writeModels = (name: string, extraModels: Array<{ id: string; name: string }> = []) => writeFile(
    join(sandbox, "models.json"),
    JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "test-key",
          models: [{ id: "alpha", name, contextWindow: 100_000, maxTokens: 2_000 }, ...extraModels],
        },
      },
    }, null, 2),
  );
  await mkdir(sandbox, { recursive: true });
  await writeModels("Alpha");
  const client = new PiRpcClient({
    cwd: sandbox,
    childEnvironment: {
      PI_CODING_AGENT_DIR: sandbox,
      PI_CODING_AGENT_SESSION_DIR: join(sandbox, "sessions"),
      HOME: sandbox,
      USERPROFILE: sandbox,
      PI_OFFLINE: "1",
    },
    piEntry,
    rpcRegister,
    args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"],
  });
  try {
    await client.start();
    const pid = (client as unknown as { child?: { pid?: number } }).child?.pid;
    const before = rpcData<ModelsResponse>(await client.send({ type: "get_available_models" })).models
      .filter((model) => model.provider === "local");
    assert.deepEqual(before.map((model) => model.id), ["alpha"]);

    await writeModels("Alpha Renamed", [{ id: "beta", name: "Beta" }]);
    const stillCached = rpcData<ModelsResponse>(await client.send({ type: "get_available_models" })).models
      .filter((model) => model.provider === "local");
    assert.deepEqual(stillCached.map((model) => model.id), ["alpha"], "the snapshot is cached until refreshed");

    const refreshed = await client.send({ type: "pi_chat_refresh_models" }, 30_000);
    assert.notEqual(refreshed.success, false, String(refreshed.error || ""));
    const after = rpcData<ModelsResponse>(await client.send({ type: "get_available_models" })).models
      .filter((model) => model.provider === "local");
    assert.deepEqual(after.map((model) => model.id).sort(), ["alpha", "beta"]);
    assert.equal(after.find((model) => model.id === "alpha")?.name, "Alpha Renamed");

    const stateAfter = rpcData<{ sessionId: string; sessionFile?: string }>(
      await client.send({ type: "get_state" }),
    );
    assert.ok(stateAfter.sessionId, "the same worker keeps serving the same session");
    const pidAfter = (client as unknown as { child?: { pid?: number } }).child?.pid;
    assert.equal(pidAfter, pid, "model refresh must not replace the Pi process");
  } finally {
    await client.stop();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a Session selected model keeps its limits until the refreshed model is re-selected", { timeout: 90_000 }, async () => {
  const piEntry = pinnedPiEntry;
  assert.ok(piEntry);
  const rpcRegister = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "resources",
    "runtime",
    "pi-chat-rpc-register.mjs",
  );
  const sandbox = await mkdtemp(join(tmpdir(), "pi-chat-model-reselect-"));
  const writeModels = (maxTokens: number) => writeFile(
    join(sandbox, "models.json"),
    JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "test-key",
          models: [{ id: "alpha", name: "Alpha", contextWindow: 100_000, maxTokens }],
        },
      },
    }, null, 2),
  );
  await mkdir(sandbox, { recursive: true });
  await writeModels(2_000);
  const client = new PiRpcClient({
    cwd: sandbox,
    childEnvironment: {
      PI_CODING_AGENT_DIR: sandbox,
      PI_CODING_AGENT_SESSION_DIR: join(sandbox, "sessions"),
      HOME: sandbox,
      USERPROFILE: sandbox,
      PI_OFFLINE: "1",
    },
    piEntry,
    rpcRegister,
    args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"],
  });
  try {
    await client.start();
    await client.send({ type: "set_model", provider: "local", modelId: "alpha" }, 30_000);
    const selected = rpcData<{ model: ModelInfo | null }>(await client.send({ type: "get_state" })).model;
    assert.equal(selected?.maxTokens, 2_000);

    await writeModels(16_000);
    const refreshed = await client.send({ type: "pi_chat_refresh_models" }, 30_000);
    assert.notEqual(refreshed.success, false, String(refreshed.error || ""));
    const stale = rpcData<{ model: ModelInfo | null }>(await client.send({ type: "get_state" })).model;
    assert.equal(stale?.maxTokens, 2_000, "registry refresh alone does not rewrite this Session's selected model");

    const snapshot = rpcData<ModelsResponse>(await client.send({ type: "get_available_models" })).models
      .find((model) => model.provider === "local" && model.id === "alpha");
    assert.equal(snapshot?.maxTokens, 16_000, "the refreshed catalogue carries the new limit");
    assert.notDeepEqual(
      { ...stale },
      { ...snapshot },
      "a stale selection is detectable, so the Host can re-select it",
    );

    await client.send({ type: "set_model", provider: "local", modelId: "alpha" }, 30_000);
    const applied = rpcData<{ model: ModelInfo | null }>(await client.send({ type: "get_state" })).model;
    assert.equal(applied?.maxTokens, 16_000, "re-selecting the same model applies the refreshed limits");
  } finally {
    await client.stop();
    await rm(sandbox, { recursive: true, force: true });
  }
});
