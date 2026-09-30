import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { handleLifecycleControlRoute } from "../../src/server/routes/lifecycle-control";

async function fixture() {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    void handleLifecycleControlRoute({
      applicationShutdownAvailable: () => true,
      applicationRestartAvailable: () => true,
      isConnectedWindowPage: () => true,
      beginLifecycle: (lifecycle) => calls.push(`begin:${lifecycle}`),
      endLifecycle: (lifecycle) => calls.push(`end:${lifecycle}`),
      verifyApplicationQuiescent: async (reason) => { calls.push(`verify:${reason}`); },
      broadcast: (event) => calls.push(String(event.type)),
      shutdown: (reason) => calls.push(`shutdown:${reason}`),
      restart: async () => ({
        promote: async () => { calls.push("promote"); },
        discard: async () => { calls.push("discard"); },
        handoff: () => { calls.push("handoff"); },
      }),
      reportIncident: () => ({ incidentId: "PC-TEST1234" }),
    }, request, response, url).then((handled) => {
      if (!handled) { response.statusCode = 404; response.end(); }
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

test("lifecycle route runs the restart promotion barrier through narrow ports", async () => {
  const target = await fixture();
  try {
    const response = await fetch(`${target.origin}/api/restart`, {
      method: "POST",
      headers: { "x-pi-chat-client": "aaaaaaaaaaaaaaaaaaaa", "x-pi-chat-page": "bbbbbbbbbbbbbbbbbbbb" },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(target.calls, ["begin:restarting", "verify:应用更新并重启", "verify:完成重启", "promote", "handoff"]);
  } finally {
    await target.close();
  }
});

test("lifecycle route broadcasts before shutdown handoff", async () => {
  const target = await fixture();
  try {
    const response = await fetch(`${target.origin}/api/shutdown`, {
      method: "POST",
      headers: { "x-pi-chat-client": "aaaaaaaaaaaaaaaaaaaa", "x-pi-chat-page": "bbbbbbbbbbbbbbbbbbbb" },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(target.calls, ["begin:shutting-down", "verify:关闭 Pi Chat", "pi_chat_application_closing", "shutdown:api-shutdown"]);
  } finally {
    await target.close();
  }
});
