import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { handleWindowControlRoute } from "../../src/server/routes/window-control";

async function fixture() {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    void handleWindowControlRoute({
      assertIdle: () => {},
      isConnectedWindowPage: () => true,
      noteClientPresence: (_client, _page, _revision, foreground) => {
        calls.push(foreground ? "foreground" : "background");
        return true;
      },
      isClientPresent: () => true,
      closeWindowClient: (_client, page) => { calls.push(`close:${page}`); return "session"; },
      openWindowCount: () => 1,
      activeMutationRequests: () => 0,
      runtimeStartingCount: () => 0,
      restSessionAfterWindowClose: async () => true,
      scheduleLastWindowShutdown: () => { calls.push("shutdown"); },
      lastWindowAutoShutdownEnabled: () => true,
      applicationShutdownAvailable: () => true,
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

test("window control route owns page-scoped presence validation through narrow ports", async () => {
  const target = await fixture();
  try {
    const response = await fetch(`${target.origin}/api/presence`, {
      method: "POST",
      headers: { "x-pi-chat-client": "aaaaaaaaaaaaaaaaaaaa", "x-pi-chat-page": "bbbbbbbbbbbbbbbbbbbb", "content-type": "application/json" },
      body: JSON.stringify({ foreground: true, revision: 1 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { present: true });
    assert.deepEqual(target.calls, ["foreground"]);
  } finally {
    await target.close();
  }
});

test("window control route closes a page without owning application lifecycle state", async () => {
  const target = await fixture();
  try {
    const response = await fetch(`${target.origin}/api/window/close?foreground=1`, {
      method: "POST",
      headers: { "x-pi-chat-client": "aaaaaaaaaaaaaaaaaaaa", "x-pi-chat-page": "bbbbbbbbbbbbbbbbbbbb" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { sessionId: string }).sessionId, "session");
    assert.deepEqual(target.calls, ["close:bbbbbbbbbbbbbbbbbbbb"]);
  } finally {
    await target.close();
  }
});
