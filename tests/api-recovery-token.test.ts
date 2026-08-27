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

test("request deadlines preserve both caller abort and timeout cancellation", async () => {
  const sessionStorage = new MemoryStorage();
  Object.assign(globalThis, {
    window: { sessionStorage, setTimeout, clearTimeout },
    sessionStorage,
  });
  const { createRequestDeadline, RUNTIME_OPERATION_TIMEOUT_MS } = await import("../src/web/api");
  assert.equal(RUNTIME_OPERATION_TIMEOUT_MS, 210_000);

  const caller = new AbortController();
  const callerReason = new Error("navigation changed");
  const combined = createRequestDeadline(caller.signal, 1_000);
  caller.abort(callerReason);
  assert.equal(combined.signal.aborted, true);
  assert.equal(combined.signal.reason, callerReason);
  combined.cleanup();

  const timed = createRequestDeadline(undefined, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(timed.signal.aborted, true);
  assert.equal((timed.signal.reason as DOMException).name, "TimeoutError");
  timed.cleanup();
});

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
  const presenceBodies: Array<{ foreground?: boolean; revision?: number }> = [];
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
    if (path === "/api/presence") {
      presenceBodies.push(
        JSON.parse(String(init?.body)) as {
          foreground?: boolean;
          revision?: number;
        },
      );
      return response({ present: true });
    }
    if (path === "/api/diagnostics/snapshot")
      return response({ schemaVersion: 4, entries: [] });
    throw new Error(`unexpected request: ${path}`);
  };
  try {
    const { api } = await import("../src/web/api");
    const initialBootstrap = api.bootstrap();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(authenticatedTokens, ["token-a"]);

    await api.recoverConnection();
    assert.match(api.eventsUrl(), /token=token-b/);
    assert.match(api.eventsUrl(), /stream=delta-v1/, "new browsers advertise checkpoint/delta support while old URLs remain legacy-compatible");

    resolveOldBootstrap(response({ requestToken: "token-a" }));
    await initialBootstrap;
    assert.match(api.eventsUrl(), /token=token-b/);

    await api.renewPresence();
    await api.relinquishPresence();
    await api.renewPresence();
    assert.deepEqual(authenticatedTokens, ["token-a", "token-b", "token-b", "token-b"]);
    assert.deepEqual(presenceBodies, [
      { foreground: true, revision: 1 },
      { foreground: false, revision: 2 },
      { foreground: true, revision: 3 },
    ]);

    await api.stateDiagnosticSnapshot();
    assert.deepEqual(authenticatedTokens, ["token-a", "token-b", "token-b", "token-b", "token-b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
