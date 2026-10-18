import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PiRpcClient, rpcData } from "../src/server/rpc-client";
import { pinnedPiEntry as piEntry } from "./helpers/pinned-pi";
import type { ModelInfo } from "../src/shared/types";

const rpcRegister = resolve(dirname(fileURLToPath(import.meta.url)), "..", "resources", "runtime", "pi-chat-rpc-register.mjs");

/**
 * Documents the exact reason the Host compensates after a catalogue refresh:
 * Pi recomputes the thinking level from the user default when the same model
 * is re-selected, which would silently drop a Session-only choice.
 */
test("re-selecting a model recomputes thinking, so the Host restores the Session level", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-model-thinking-"));
  const writeModels = (maxTokens: number) => writeFile(
    join(root, "models.json"),
    JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "test-key",
          models: [{ id: "alpha", name: "Alpha", reasoning: true, contextWindow: 100_000, maxTokens }],
        },
      },
    }, null, 2),
  );
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }, null, 2));
  await writeModels(2_000);
  const client = new PiRpcClient({
    cwd: root,
    childEnvironment: {
      PI_CODING_AGENT_DIR: root,
      PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
      HOME: root,
      USERPROFILE: root,
      PI_OFFLINE: "1",
    },
    piEntry: piEntry!,
    rpcRegister,
    args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"],
  });
  try {
    await client.start();
    await client.send({ type: "set_model", provider: "local", modelId: "alpha" }, 30_000);
    await client.send({ type: "set_thinking_level", level: "high" }, 30_000);
    assert.equal(rpcData<{ thinkingLevel: string }>(await client.send({ type: "get_state" })).thinkingLevel, "high");

    await writeModels(16_000);
    await client.send({ type: "pi_chat_refresh_models" }, 30_000);
    await client.send({ type: "set_model", provider: "local", modelId: "alpha" }, 30_000);
    const bare = rpcData<{ thinkingLevel: string; model: ModelInfo | null }>(await client.send({ type: "get_state" }));
    assert.equal(bare.model?.maxTokens, 16_000, "the refreshed limits reach the selected model");
    assert.equal(bare.thinkingLevel, "low", "Pi resets thinking from the user default on re-selection");

    // This is what the Host does right after re-selecting.
    await client.send({ type: "set_thinking_level", level: "high" }, 20_000);
    const restored = rpcData<{ thinkingLevel: string }>(await client.send({ type: "get_state" }));
    assert.equal(restored.thinkingLevel, "high", "the Host restores the Session level so the refresh is invisible");
  } finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  }
});
