import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { handleSessionRuntimeControlRoute } from "../../src/server/routes/session-runtime-control";

async function fixture() {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    void handleSessionRuntimeControlRoute({
      activeSessionId: () => "aaaaaaaaaaaaaaaaaaaa",
      runtimeExists: () => false,
      runtimeCanReclaim: () => false,
      sweepRuntimes: () => calls.push("sweep"),
      clearViewed: () => "",
      knownSession: async () => true,
      markViewed: () => calls.push("viewed"),
      touchRuntime: () => calls.push("touch"),
      ensurePrimaryIdentity: async () => calls.push("identity"),
      ensurePrimaryRuntime: async () => calls.push("primary"),
      ensureSecondaryRuntime: async () => calls.push("secondary"),
      primaryReady: (id) => ({ sessionId: id, state: { isStreaming: false }, gateMode: "strict" }),
      secondaryReady: (id) => ({ sessionId: id, state: { isStreaming: false }, gateMode: "strict" }),
      sessionView: async (id) => ({ session: { id } }),
      rethrowResultPending: (error) => { throw error; },
    }, request, response, url).then((handled) => {
      if (!handled) { response.statusCode = 404; response.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { origin: `http://127.0.0.1:${address.port}`, calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("session runtime control adapter warms and activates through narrow ports", async () => {
  const target = await fixture();
  try {
    const warm = await fetch(`${target.origin}/api/sessions/aaaaaaaaaaaaaaaaaaaa/warm`, { method: "POST" });
    assert.equal(warm.status, 200);
    const activate = await fetch(`${target.origin}/api/sessions/aaaaaaaaaaaaaaaaaaaa/activate`, { method: "POST" });
    assert.equal(activate.status, 200);
    assert.deepEqual(target.calls, ["primary", "identity", "primary"]);
  } finally { await target.close(); }
});

test("session runtime control adapter records viewing without Runtime creation", async () => {
  const target = await fixture();
  try {
    const response = await fetch(`${target.origin}/api/sessions/bbbbbbbbbbbbbbbbbbbb/viewing`, {
      method: "POST",
      headers: { "x-pi-chat-client": "cccccccccccccccccccc" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(target.calls, ["viewed"]);
  } finally { await target.close(); }
});
