import assert from "node:assert/strict";
import test from "node:test";
import { hostVisibleModelsFromConfig, modelsConfigFingerprint } from "../src/server/models-config-revision";

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
