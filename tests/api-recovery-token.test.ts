import assert from "node:assert/strict";
import test from "node:test";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) || null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function response(value: unknown, ok = true): Response {
  return {
    ok,
    json: async () => value,
  } as Response;
}

test("reconnect token acceptance prevents an older response from restoring its token", async () => {
  const sessionStorage = new MemoryStorage();
  Object.assign(globalThis, {
    window: { sessionStorage, setTimeout, clearTimeout },
    sessionStorage,
  });
  let resolveOldBootstrap!: (value: Response) => void;
  const oldBootstrap = new Promise<Response>((resolve) => {
    resolveOldBootstrap = resolve;
  });
  const authenticatedTokens: string[] = [];
  let handshakeCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path === "/api/bootstrap/handshake") {
      handshakeCalls += 1;
      return response({
        requestToken: handshakeCalls === 1 ? "token-a" : "token-b",
        buildIdentity: {
          schemaVersion: 1,
          packageVersion: "test",
          revision: "test",
          fingerprint: "0".repeat(64),
          builtAt: "test",
        },
      });
    }
    const headers = new Headers(init?.headers);
    authenticatedTokens.push(headers.get("x-pi-chat-token") || "");
    if (path === "/api/bootstrap") return oldBootstrap;
    if (path === "/api/presence") return response({ present: true });
    throw new Error(`unexpected request: ${path}`);
  };
  try {
    const { api } = await import("../src/web/api");
    const initialBootstrap = api.bootstrap();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(authenticatedTokens, ["token-a"]);

    await api.recoverConnection();
    assert.match(api.eventsUrl(), /token=token-b/);

    resolveOldBootstrap(response({ requestToken: "token-a" }));
    await initialBootstrap;
    assert.match(api.eventsUrl(), /token=token-b/);

    await api.renewPresence();
    assert.deepEqual(authenticatedTokens, ["token-a", "token-b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
