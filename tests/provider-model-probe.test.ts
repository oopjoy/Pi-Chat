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
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url || "");
    if (request.url === "/models") {
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
    assert.deepEqual(hits, ["/v1/models", "/models"], "fallback must exercise both endpoints");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Different loopback ports are different origins. No real provider or secret is used.
test("provider probes never forward credentials through redirects", async () => {
  let targetHits = 0;
  const target = createServer((_request, response) => {
    targetHits += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "unexpected" }] }));
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  assert.ok(address && typeof address === "object");
  const source = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${address.port}/models` });
    response.end();
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const sourceAddress = source.address();
  assert.ok(sourceAddress && typeof sourceAddress === "object");
  try {
    for (const api of ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]) {
      await assert.rejects(probeProviderModels({
        baseUrl: `http://127.0.0.1:${sourceAddress.port}`, api, apiKey: "dummy-review-key",
      }), /重定向/);
    }
    assert.equal(targetHits, 0, "even a stripped credential must not authorize a redirected probe");
  } finally {
    await Promise.all([source, target].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});

test("probe redirects are rejected before reading a body or trying another endpoint", async () => {
  const requests: string[] = [];
  let cancelled = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(String(input));
    assert.equal(init?.redirect, "manual");
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 307, headers: { location: "/canonical/models" },
    });
  };
  await assert.rejects(probeProviderModels({
    baseUrl: "https://example.invalid", api: "openai-responses", apiKey: "dummy-key", fetchImpl,
  }), /重定向/);
  assert.equal(requests.length, 1);
  assert.equal(cancelled, true);
});
