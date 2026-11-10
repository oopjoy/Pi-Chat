import assert from "node:assert/strict";
import test from "node:test";
import {
  createRemovedHostCatalogue,
  hostVisibleModelsFromConfig,
  mergeHostAndRuntimeModels,
  modelsConfigFingerprint,
  rememberRemovedHostCatalogue,
} from "../src/server/models-config-revision";

test("host-visible catalogue ignores connection secrets and maxTokens, fingerprint does not", () => {
  const before = {
    providers: {
      zai: {
        baseUrl: "https://a.example/v1",
        apiKey: "secret-a",
        api: "openai-completions",
        models: [{ id: "glm-5", name: "GLM-5", maxTokens: 8192, contextWindow: 200_000 }],
      },
    },
  };
  const after = {
    providers: {
      zai: {
        baseUrl: "https://b.example/v1",
        apiKey: "secret-b",
        api: "openai-completions",
        models: [{ id: "glm-5", name: "GLM-5", maxTokens: 16384, contextWindow: 200_000 }],
      },
    },
  };
  assert.deepEqual(hostVisibleModelsFromConfig(before), hostVisibleModelsFromConfig(after));
  assert.notEqual(
    modelsConfigFingerprint(JSON.stringify(before)),
    modelsConfigFingerprint(JSON.stringify(after)),
    "Base URL, API key, and maxTokens must change the config revision",
  );
  assert.equal(hostVisibleModelsFromConfig(before)[0].id, "glm-5");
  assert.equal("apiKey" in hostVisibleModelsFromConfig(before)[0], false);
  assert.equal("baseUrl" in hostVisibleModelsFromConfig(before)[0], false);
});

test("deleting a custom Provider drops it from the published catalogue while Runtime still lists it", () => {
  const previousHost = [
    { provider: "cpafem", id: "glm-5.3-flash", api: "openai-responses" },
    { provider: "FEMAI", id: "deepseek-flash", api: "openai-responses" },
  ];
  const nextHost = [
    { provider: "FEMAI", id: "deepseek-flash", api: "openai-responses", name: "deepseek-flash", source: "models-json" as const, custom: true },
  ];
  const runtime = [
    { provider: "openai", id: "gpt-4", name: "GPT-4", api: "openai-completions" },
    { provider: "cpafem", id: "glm-5.3-flash", name: "glm-5.3-flash", api: "openai-responses" },
    { provider: "cpafem", id: "extra-from-runtime", name: "extra", api: "openai-responses" },
    { provider: "FEMAI", id: "deepseek-flash", name: "deepseek-flash", api: "openai-responses" },
  ];
  const removed = createRemovedHostCatalogue();
  rememberRemovedHostCatalogue(removed, previousHost, nextHost);
  const published = mergeHostAndRuntimeModels(runtime, nextHost, removed);
  assert.equal(published.some((model) => model.provider === "cpafem"), false);
  assert.ok(published.some((model) => model.provider === "openai" && model.id === "gpt-4"));
  assert.ok(published.some((model) => model.provider === "FEMAI" && model.id === "deepseek-flash"));
});

test("deleting one custom model keeps sibling models of the same Provider", () => {
  const previousHost = [
    { provider: "FEMAI", id: "deepseek-flash", api: "openai-responses" },
    { provider: "FEMAI", id: "deepseek-chat", api: "openai-responses" },
  ];
  const nextHost = [
    { provider: "FEMAI", id: "deepseek-flash", api: "openai-responses", name: "deepseek-flash" },
  ];
  const runtime = [
    { provider: "FEMAI", id: "deepseek-flash", name: "deepseek-flash", api: "openai-responses" },
    { provider: "FEMAI", id: "deepseek-chat", name: "deepseek-chat", api: "openai-responses" },
  ];
  const removed = createRemovedHostCatalogue();
  rememberRemovedHostCatalogue(removed, previousHost, nextHost);
  const published = mergeHostAndRuntimeModels(runtime, nextHost, removed);
  assert.deepEqual(published.map((model) => model.id), ["deepseek-flash"]);
});
