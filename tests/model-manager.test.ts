import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelManager, validateCustomModel } from "../src/server/model-manager";

test("model manager adds, annotates and removes custom models without losing provider config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-models-"));
  try {
    await writeFile(join(root, "models.json"), JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          apiKey: "$LOCAL_KEY",
          headers: { "x-test": "keep" },
          models: [{ id: "existing", name: "Existing" }],
        },
      },
    }));
    const manager = new ModelManager(root);
    await manager.add({
      provider: "local",
      id: "vision-model",
      name: "Vision Model",
      api: "openai-responses",
      reasoning: true,
      imageInput: true,
      contextWindow: 256000,
      maxTokens: 32000,
    });
    const configured = JSON.parse(await readFile(join(root, "models.json"), "utf8"));
    assert.equal(configured.providers.local.headers["x-test"], "keep");
    assert.equal(configured.providers.local.apiKey, "$LOCAL_KEY");
    assert.equal(configured.providers.local.models.length, 2);
    assert.equal(configured.providers.local.models[1].api, "openai-responses");
    assert.deepEqual(configured.providers.local.models[1].input, ["text", "image"]);

    const editable = await manager.getCustomConfig("local", "vision-model");
    assert.deepEqual(editable, {
      provider: "local",
      id: "vision-model",
      name: "Vision Model",
      baseUrl: "http://localhost:11434/v1",
      api: "openai-responses",
      apiKey: "",
      reasoning: true,
      imageInput: true,
      contextWindow: 256000,
      maxTokens: 32000,
    });

    const annotated = await manager.annotate([
      { provider: "local", id: "vision-model", name: "Vision Model" },
      { provider: "openai", id: "built-in", name: "Built-in" },
    ]);
    assert.equal(annotated[0].custom, true);
    assert.equal(annotated[1].custom, false);

    await manager.remove("local", "vision-model");
    const removed = JSON.parse(await readFile(join(root, "models.json"), "utf8"));
    assert.deepEqual(removed.providers.local.models.map((model: { id: string }) => model.id), ["existing"]);
    assert.equal(removed.providers.local.headers["x-test"], "keep");
    await assert.rejects(() => manager.remove("openai", "built-in"), /只能删除/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model manager update renames provider/id, carries secrets and rejects collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-models-update-"));
  try {
    await writeFile(join(root, "models.json"), JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          apiKey: "$LOCAL_KEY",
          models: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
        },
        other: {
          baseUrl: "http://other.example/v1",
          api: "openai-completions",
          models: [{ id: "a", name: "Other A" }],
        },
      },
    }));
    const manager = new ModelManager(root);

    // Same-key edit keeps sibling models and provider config intact.
    await manager.update("local", "a", { provider: "local", id: "a", name: "A2", api: "openai-completions", reasoning: true, imageInput: false });
    let configured = JSON.parse(await readFile(join(root, "models.json"), "utf8"));
    assert.equal(configured.providers.local.models[0].name, "A2");
    assert.equal(configured.providers.local.models.length, 2);
    assert.equal(configured.providers.local.apiKey, "$LOCAL_KEY");

    // Renaming onto an existing custom model is rejected.
    await assert.rejects(
      () => manager.update("local", "a", { provider: "local", id: "b", api: "openai-completions", reasoning: false, imageInput: false }),
      /已存在/,
    );

    // Provider rename carries baseUrl/apiKey because the form never echoes the key.
    await manager.update("local", "a", { provider: "moved", id: "a", name: "A2", api: "openai-completions", reasoning: false, imageInput: false });
    configured = JSON.parse(await readFile(join(root, "models.json"), "utf8"));
    assert.deepEqual(configured.providers.local.models.map((model: { id: string }) => model.id), ["b"]);
    assert.equal(configured.providers.moved.baseUrl, "http://localhost:11434/v1");
    assert.equal(configured.providers.moved.apiKey, "$LOCAL_KEY");
    assert.equal(configured.providers.moved.models[0].name, "A2");

    // Renaming away the last model removes the empty provider shell.
    await manager.update("other", "a", { provider: "other2", id: "a", api: "openai-completions", reasoning: false, imageInput: false });
    configured = JSON.parse(await readFile(join(root, "models.json"), "utf8"));
    assert.equal(configured.providers.other, undefined);
    assert.equal(configured.providers.other2.baseUrl, "http://other.example/v1");

    // Entries outside models.json cannot be edited.
    await assert.rejects(
      () => manager.update("nope", "a", { provider: "nope", id: "a", api: "openai-completions", reasoning: false, imageInput: false }),
      /只能编辑/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom model validation rejects unsafe provider names and invalid endpoints", () => {
  assert.throws(() => validateCustomModel({ provider: "../bad", id: "model", api: "openai-completions" }), /Provider/);
  assert.throws(() => validateCustomModel({ provider: "local", id: "model", api: "openai-completions", baseUrl: "file:///tmp" }), /Base URL/);
});
