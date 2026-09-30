import assert from "node:assert/strict";
import test from "node:test";
import { dispatchPrimaryPrompt } from "../../src/server/services/prompt-primary-dispatch";

test("Primary dispatch traces admission and uncertain delivery in authority order", async () => {
  const calls: string[] = [];
  const result = await dispatchPrimaryPrompt({
    sendPrompt: async () => { calls.push("send"); return "unknown"; },
    traceAdmitted: () => calls.push("admitted"),
    traceDeliveryUncertain: () => calls.push("uncertain"),
  }, "prompt");
  assert.deepEqual(result, {
    status: 202,
    body: { accepted: true, queued: false, promptId: "prompt", deliveryUncertain: true },
  });
  assert.deepEqual(calls, ["admitted", "send", "uncertain"]);
});
