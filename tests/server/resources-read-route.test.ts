import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { handleResourcesReadRoute } from "../../src/server/routes/resources-read";

async function fixture(browsePath = "C:\\resources") {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    void handleResourcesReadRoute({
      primaryRuntimeCwd: () => "C:\\work",
      resources: {
        resolveBrowsePath: (kind) => { calls.push(`browse:${kind}`); return browsePath; },
        listSkills: async (cwd) => { calls.push(`skills:${cwd}`); return { resources: [{ enabled: true }, { enabled: false }], diagnostics: [] }; },
        listExtensions: async () => ({ resources: [{ enabled: true }], diagnostics: [] }),
        listPackages: async () => ({ resources: [{ enabled: false }], diagnostics: [] }),
      },
      reveal: async (path) => { calls.push(`reveal:${path}`); },
      openDefault: async (path) => { calls.push(`open:${path}`); },
    } as never, request, response, url).then((handled) => {
      if (!handled) {
        response.statusCode = 404;
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("resources route adapter keeps inventory reads narrow and filters disabled resources", async () => {
  const target = await fixture();
  try {
    const response = await fetch(`${target.origin}/api/resources/skills`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { resources: [{ enabled: true }], diagnostics: [] });
    assert.deepEqual(target.calls, ["skills:C:\\work"]);
  } finally {
    await target.close();
  }
});

test("missing models.json opens its parent directory with an explicit missing marker", async () => {
  const target = await fixture("C:\\definitely-missing-pi-chat-models\\models.json");
  try {
    const response = await fetch(`${target.origin}/api/resources/browse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "models-root" }),
    });
    assert.equal(response.status, 200);
    const value = await response.json() as { missing?: boolean; openedPath?: string; path?: string };
    assert.equal(value.missing, true);
    assert.equal(value.path, "C:\\definitely-missing-pi-chat-models\\models.json");
    assert.equal(typeof value.openedPath, "string");
    assert.equal(target.calls.some((call) => call.startsWith("reveal:")), true);
    assert.equal(target.calls.some((call) => call.startsWith("open:")), false);
  } finally {
    await target.close();
  }
});

test("resources route adapter rejects malformed browse kinds", async () => {
  const target = await fixture();
  try {
    const response = await fetch(`${target.origin}/api/resources/browse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "invalid" }),
    });
    assert.equal(response.status, 400);
  } finally {
    await target.close();
  }
});
