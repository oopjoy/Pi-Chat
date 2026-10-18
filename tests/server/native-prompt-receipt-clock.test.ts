import assert from "node:assert/strict";
import test from "node:test";
import { PiChatApp } from "../../src/server/app";
import type { PiMessage } from "../../src/shared/types";
import type { PromptPersistenceReceipt } from "../../src/server/prompt-receipt";

type Pending = {
  id: string; promptId: string; message: PiMessage; expectedTurnTotal: number;
  baselinePersistedUserIds: Set<string>; receipt?: PromptPersistenceReceipt;
};
type ReceiptMethods = {
  pendingPromptPersisted(pending: Pending, messages: PiMessage[], claimed: Set<PiMessage>): PiMessage | undefined;
  promptPayloadFingerprint(message: PiMessage): string;
  recordPromptReceipt(id: string, promptId: string, receipt: PromptPersistenceReceipt): void;
  pendingAcceptedPromptsBySession: Map<string, Pending[]>;
  activeSessionId: string;
  runtimePool: { get(id: string): undefined };
};
function fixture() {
  const host = Object.create(PiChatApp.prototype) as ReceiptMethods;
  const canonical: PiMessage = { role: "user", content: "same repeated payload", timestamp: 1000, piChatPersistedMessageId: "new-user:0" };
  const receipt: PromptPersistenceReceipt = { version: 1, timestamp: 1000, payloadFingerprint: host.promptPayloadFingerprint(canonical) };
  const pending: Pending = {
    id: "pending", promptId: "prompt", message: { role: "user", content: "same repeated payload", timestamp: 1001 },
    expectedTurnTotal: 1, baselinePersistedUserIds: new Set(), receipt,
  };
  return { host, canonical, pending, receipt };
}

test("a native request-correlated receipt is not invalidated by a one-millisecond child clock skew", () => {
  const { host, canonical, pending } = fixture();
  assert.equal(host.pendingPromptPersisted(pending, [canonical], new Set()), canonical);
});

test("receipt matching still rejects baseline, claimed, mismatched-payload and foreign Prompt rows", () => {
  const { host, canonical, pending } = fixture();
  assert.equal(host.pendingPromptPersisted({ ...pending, baselinePersistedUserIds: new Set(["new-user:0"]) }, [canonical], new Set()), undefined);
  assert.equal(host.pendingPromptPersisted(pending, [canonical], new Set([canonical])), undefined);
  assert.equal(host.pendingPromptPersisted(pending, [{ ...canonical, content: "different" }], new Set()), undefined);
  assert.equal(host.pendingPromptPersisted(pending, [{ ...canonical, piChatPromptId: "foreign" }], new Set()), undefined);
});

test("legacy matching without a native receipt keeps its pre-admission timestamp guard", () => {
  const { host, canonical, pending } = fixture();
  assert.equal(host.pendingPromptPersisted({ ...pending, receipt: undefined }, [canonical], new Set()), undefined);
});

test("a late correlated receipt can enrich an existing uncertain admission despite clock skew", () => {
  const { host, pending, receipt } = fixture();
  pending.receipt = undefined;
  host.pendingAcceptedPromptsBySession = new Map([["session", [pending]]]);
  host.activeSessionId = "other";
  host.runtimePool = { get: () => undefined };
  host.recordPromptReceipt("session", pending.promptId, receipt);
  assert.equal(pending.receipt, receipt);
});
