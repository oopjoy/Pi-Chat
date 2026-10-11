import assert from "node:assert/strict";
import test from "node:test";
import { installAppDom } from "./helpers/app-dom";

test("runtime restart waits for the pre-POST token to rotate even when SSE wins the response race", async () => {
  installAppDom();
  const { api } = await import("../src/web/api");
  api.acceptConnectionToken("old-process-token");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    calls.push(path);
    if (path === "/api/runtime/restart") {
      assert.equal(new Headers(init?.headers).get("x-pi-chat-token"), "old-process-token");
      assert.equal(init?.method, "POST");
      api.acceptConnectionToken("replacement-token"); // SSE arrives before POST settles.
      return new Response(JSON.stringify({ restarting: true }));
    }
    if (path === "/api/bootstrap/handshake") return new Response(JSON.stringify({ requestToken: "replacement-token" }));
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await api.restartRuntime({ mode: "retry", configurationRevision: "a".repeat(64) });
    assert.deepEqual(calls, ["/api/runtime/restart", "/api/bootstrap/handshake"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("rejected runtime setup never polls for a replacement or retries the mutation", async () => {
  installAppDom();
  const { api } = await import("../src/web/api");
  api.acceptConnectionToken("valid-token");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: "busy", code: "APPLICATION_BUSY" }), { status: 409 }); };
  try {
    await assert.rejects(api.restartRuntime({ mode: "retry", configurationRevision: "a".repeat(64) }), /busy/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});
