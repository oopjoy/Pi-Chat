import assert from "node:assert/strict";
import test from "node:test";
import { respondToExtension } from "../../src/server/services/extension-response";

test("extension response service releases target lease when an uncertain result rejects before retry", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => respondToExtension({
      target: () => ({
        rpc: { sendRaw: () => { throw new (class extends Error { outcomeUnknown = true })(); } } as never,
        release: () => calls.push("release"),
      }),
      hasUncertain: () => false,
      pendingRequest: () => ({ id: "request" }),
      claim: () => true,
      releaseClaim: () => calls.push("unclaim"),
      rpcOutcomeUnknown: () => true,
      markOutcomePending: () => calls.push("pending"),
      markUncertain: () => calls.push("uncertain"),
      rethrowResultPending: () => { throw new Error("result pending"); },
      clearPending: () => {},
    }, { sessionId: "s", requestId: "request" }),
    /result pending/,
  );
  assert.deepEqual(calls, ["uncertain", "pending", "release", "unclaim"]);
});

test("extension response service claims exactly one pending request and releases its Runtime lease", async () => {
  const calls: string[] = [];
  const result = await respondToExtension({
    target: () => ({
      rpc: { sendRaw: async (command: Record<string, unknown>) => calls.push(`send:${command.id}`) } as never,
      release: () => calls.push("release"),
    }),
    hasUncertain: () => false,
    pendingRequest: () => ({ id: "request" }),
    claim: () => { calls.push("claim"); return true; },
    releaseClaim: () => calls.push("unclaim"),
    rpcOutcomeUnknown: () => false,
    markOutcomePending: () => {},
    markUncertain: () => {},
    rethrowResultPending: (error) => { throw error; },
    clearPending: () => calls.push("clear"),
  }, { sessionId: "s", requestId: "request", confirmed: true });
  assert.equal(result, undefined);
  assert.deepEqual(calls, ["claim", "send:request", "clear", "release", "unclaim"]);
});
