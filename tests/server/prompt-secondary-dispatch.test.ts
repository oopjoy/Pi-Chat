import assert from "node:assert/strict";
import test from "node:test";
import { dispatchSecondaryPrompt } from "../../src/server/services/prompt-secondary-dispatch";
import { RpcRequestTimeoutError } from "../../src/server/rpc-client";

test("Secondary dispatch fences between settings, Gate, and prompt write", async () => {
  const calls: string[] = [];
  const result = await dispatchSecondaryPrompt({
    applySettings: async () => { calls.push("settings"); return {}; },
    isPartialSettingsError: () => false,
    rememberPartialSettings: () => calls.push("partial"),
    rememberSettings: () => calls.push("remember"),
    assertCurrent: () => calls.push("current"),
    syncGate: async () => calls.push("gate"),
    setRunning: (running) => calls.push(`running:${running}`),
    traceAdmitted: () => calls.push("admitted"),
    broadcastActivity: () => calls.push("activity"),
    sendPrompt: async () => calls.push("send"),
    outcomeUnknown: () => false,
    traceDeliveryUncertain: () => calls.push("uncertain"),
    notifyAccepted: () => calls.push("accepted"),
    onFailure: () => calls.push("failure"),
  }, { message: "hello", images: [], promptId: "prompt" });
  assert.deepEqual(result, { status: 202, body: { accepted: true, queued: false, promptId: "prompt" } });
  assert.deepEqual(calls, ["settings", "remember", "current", "gate", "current", "running:true", "admitted", "activity", "send", "accepted"]);
});

test("uncertain Secondary delivery remains accepted and not marked failed", async () => {
  const calls: string[] = [];
  const result = await dispatchSecondaryPrompt({
    applySettings: async () => ({}),
    isPartialSettingsError: () => false,
    rememberPartialSettings: () => {},
    rememberSettings: () => {},
    assertCurrent: () => {},
    syncGate: async () => {},
    setRunning: () => {},
    traceAdmitted: () => {},
    broadcastActivity: () => {},
    sendPrompt: async () => { throw new RpcRequestTimeoutError("prompt"); },
    outcomeUnknown: () => true,
    traceDeliveryUncertain: () => calls.push("uncertain"),
    notifyAccepted: () => calls.push("accepted"),
    onFailure: () => calls.push("failure"),
  }, { message: "hello", images: [], promptId: "prompt" });
  assert.equal(result.body.deliveryUncertain, true);
  assert.deepEqual(calls, ["uncertain", "accepted"]);
});

test("partial setting failure is remembered before the error escapes", async () => {
  const calls: string[] = [];
  const partial = { applied: { thinkingLevel: "low" as const } };
  await assert.rejects(
    () => dispatchSecondaryPrompt({
      applySettings: async () => { throw partial; },
      isPartialSettingsError: (error): error is typeof partial => error === partial,
      rememberPartialSettings: () => calls.push("partial"),
      rememberSettings: () => {},
      assertCurrent: () => {},
      syncGate: async () => {},
      setRunning: () => {},
      traceAdmitted: () => {},
      broadcastActivity: () => {},
      sendPrompt: async () => {},
      outcomeUnknown: () => false,
      traceDeliveryUncertain: () => {},
      notifyAccepted: () => {},
      onFailure: () => calls.push("failure"),
    }, { message: "hello", images: [], promptId: "prompt" }),
    (error) => error === partial,
  );
  assert.deepEqual(calls, ["partial", "failure"]);
});
