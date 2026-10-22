import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  modelsUrlCandidates,
  parseProviderModelList,
  probeProviderModels,
} from "../src/server/provider-model-probe";

test("probe URL candidates prefer versioned /models then /v1/models", () => {
  assert.deepEqual(modelsUrlCandidates("https://api.example.com/v1/", "openai-completions"), [
    "https://api.example.com/v1/models",
  ]);
  assert.deepEqual(modelsUrlCandidates("https://api.example.com", "openai-completions"), [
    "https://api.example.com/v1/models",
    "https://api.example.com/models",
  ]);
  assert.deepEqual(modelsUrlCandidates("https://generativelanguage.googleapis.com", "google-generative-ai"), [
    "https://generativelanguage.googleapis.com/v1beta/models",
  ]);
});

test("parseProviderModelList accepts OpenAI, catalog, and Google shapes", () => {
  assert.deepEqual(parseProviderModelList({
    data: [{ id: "gpt-4.1" }, { id: "gpt-4.1" }, { id: "kimi-k2", owned_by: "moonshot" }],
  }), [
    { id: "gpt-4.1" },
    { id: "kimi-k2", ownedBy: "moonshot" },
  ]);
  assert.deepEqual(parseProviderModelList({
    models: [{ slug: "glm-5" }, { id: "glm-4.7" }],
  }).map((model) => model.id), ["glm-5", "glm-4.7"]);
  assert.deepEqual(parseProviderModelList({
    models: [{ name: "models/gemini-2.5-flash" }],
  }), [{ id: "gemini-2.5-flash" }]);
});

test("probeProviderModels uses the first successful OpenAI-compatible list", async () => {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url || "");
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }));
      return;
    }
    response.writeHead(404); response.end("missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const models = await probeProviderModels({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: "openai-completions",
      apiKey: "sk-test",
    });
    assert.deepEqual(models.map((model) => model.id), ["alpha", "beta"]);
    assert.deepEqual(hits, ["/v1/models"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("probeProviderModels sends a Bearer token and maps 401 to a Chinese auth error", async () => {
  const headers: string[] = [];
  const server = createServer((request, response) => {
    headers.push(String(request.headers.authorization || ""));
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "sk-secret-should-not-leak" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(
      () => probeProviderModels({
        baseUrl: `http://127.0.0.1:${address.port}`,
        api: "openai-responses",
        apiKey: "sk-secret-should-not-leak",
      }),
      /上游认证失败/,
    );
    assert.equal(headers[0], "Bearer sk-secret-should-not-leak");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("probeProviderModels skips a 404 candidate then reads the next", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "recovered" }] }));
      return;
    }
    response.writeHead(404); response.end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const models = await probeProviderModels({
      baseUrl: `http://127.0.0.1:${address.port}`,
      api: "openai-completions",
      apiKey: "sk-test",
    });
    assert.deepEqual(models.map((model) => model.id), ["recovered"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
