import assert from "node:assert/strict";
import test from "node:test";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) || null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

test("new-session API serialization retains the selected model API route", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousFetch = globalThis.fetch;
  let requestBody = "";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: new MemoryStorage(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    },
  });
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = String(init?.body || "");
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  };
  try {
    const { api } = await import("../src/web/api");
    await api.submitNewSession({
      message: "first",
      images: [],
      model: {
        provider: "route",
        id: "same",
        name: "Same",
        api: "openai-responses",
      },
    });
    assert.deepEqual(JSON.parse(requestBody), {
      initial: {
        message: "first",
        images: [],
        model: {
          provider: "route",
          modelId: "same",
          api: "openai-responses",
        },
      },
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("Runtime-affecting browser mutations use the full preparation budget", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousFetch = globalThis.fetch;
  const delays: number[] = [];
  let timerId = 0;
  const windowValue = {
    sessionStorage: new MemoryStorage(),
    setTimeout: (_callback: () => void, delay: number) => {
      delays.push(delay);
      timerId += 1;
      return timerId;
    },
    clearTimeout: () => undefined,
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowValue,
  });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  } as Response);
  try {
    const { api, RUNTIME_OPERATION_TIMEOUT_MS } = await import("../src/web/api");
    await api.newSession();
    await api.activateSession("0123456789abcdefabcd");
    await api.renameSession("0123456789abcdefabcd", "renamed");
    await api.deleteSession("0123456789abcdefabcd");
    await api.setModel("provider", "model", "0123456789abcdefabcd");
    await api.setThinking("high", "0123456789abcdefabcd");
    assert.deepEqual(
      delays,
      Array.from({ length: 6 }, () => RUNTIME_OPERATION_TIMEOUT_MS),
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
