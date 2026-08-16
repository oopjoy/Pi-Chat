import assert from "node:assert/strict";
import test from "node:test";
import { PromptEvidenceLedger } from "../src/server/prompt-evidence-ledger";
import {
  reducePromptEvidenceRecord,
  replayPromptEvidence,
  type PromptEvidenceFact,
  type PromptEvidenceFactKind,
} from "../src/shared/prompt-evidence";

const SESSION_ID = "0123456789abcdefabcd";
const PROMPT_ID = "11111111-1111-4111-8111-111111111111";

function facts(
  kinds: PromptEvidenceFactKind[],
  options: { rpcGeneration?: number; runGeneration?: number } = {},
): PromptEvidenceFact[] {
  return kinds.map((kind, index) => ({
    sequence: index + 1,
    observedAt: new Date(1_000 + index).toISOString(),
    promptId: PROMPT_ID,
    sessionId: SESSION_ID,
    kind,
    ...options,
  }));
}

test("prompt evidence replays an immediate successful turn on independent axes", () => {
  const record = replayPromptEvidence(facts([
    "admitted",
    "dispatch",
    "rpc-allocated",
    "rpc-written",
    "agent-start",
    "rpc-response-success",
    "settled",
    "settlement-barrier",
  ], { rpcGeneration: 7, runGeneration: 3 }));
  assert.ok(record);
  assert.equal(record.delivery, "confirmed");
  assert.equal(record.execution, "settled");
  assert.equal(record.rpcGeneration, 7);
  assert.equal(record.runGeneration, 3);
  assert.equal(record.conflicted, undefined);
});

test("prompt evidence preserves timeout uncertainty until Runtime proof arrives", () => {
  const uncertain = replayPromptEvidence(facts([
    "admitted",
    "dispatch",
    "rpc-allocated",
    "rpc-written",
    "rpc-written-outcome-unknown",
    "delivery-uncertain",
  ], { rpcGeneration: 7 }));
  assert.equal(uncertain?.delivery, "uncertain");
  assert.equal(uncertain?.execution, "dispatching");

  const converged = replayPromptEvidence([
    ...facts([
      "admitted",
      "dispatch",
      "rpc-written",
      "rpc-written-outcome-unknown",
    ], { rpcGeneration: 7 }),
    {
      sequence: 5,
      observedAt: new Date(1_005).toISOString(),
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      kind: "agent-start",
      rpcGeneration: 7,
      runGeneration: 4,
    },
    {
      sequence: 6,
      observedAt: new Date(1_006).toISOString(),
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      kind: "settled",
      rpcGeneration: 7,
      runGeneration: 4,
    },
  ]);
  assert.equal(converged?.delivery, "confirmed");
  assert.equal(converged?.execution, "settled");
});

test("prompt evidence permits an explicit requeue before a successful retry", () => {
  const record = replayPromptEvidence(facts([
    "admitted",
    "queued",
    "dispatch",
    "rpc-not-written",
    "requeued",
    "dispatch",
    "rpc-written",
    "rpc-response-success",
    "agent-start",
    "settled",
  ], { rpcGeneration: 7, runGeneration: 5 }));
  assert.equal(record?.delivery, "confirmed");
  assert.equal(record?.execution, "settled");
  assert.equal(record?.conflicted, undefined);
});

test("prompt evidence rebinds a requeued retry to a replacement RPC generation", () => {
  const record = replayPromptEvidence([
    ...facts(["admitted", "queued", "dispatch"], { rpcGeneration: 1 }),
    {
      sequence: 4,
      observedAt: new Date(1_004).toISOString(),
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      kind: "rpc-not-written",
      rpcGeneration: 1,
    },
    {
      sequence: 5,
      observedAt: new Date(1_005).toISOString(),
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      kind: "requeued",
      rpcGeneration: 1,
    },
    ...facts([
      "dispatch",
      "rpc-allocated",
      "rpc-written",
      "rpc-response-success",
      "agent-start",
      "settled",
    ], { rpcGeneration: 2, runGeneration: 9 }).map((fact, index) => ({
      ...fact,
      sequence: index + 6,
      observedAt: new Date(1_006 + index).toISOString(),
    })),
    {
      sequence: 20,
      observedAt: new Date(1_020).toISOString(),
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      kind: "settled",
      rpcGeneration: 1,
      runGeneration: 8,
    },
  ]);
  assert.equal(record?.delivery, "confirmed");
  assert.equal(record?.execution, "settled");
  assert.equal(record?.rpcGeneration, 2);
  assert.equal(record?.runGeneration, 9);
  assert.equal(record?.facts.filter((kind) => kind === "settled").length, 1);
});

test("prompt evidence rejects stale lifecycle generations and exposes contradictions", () => {
  const base = facts([
    "admitted",
    "dispatch",
    "rpc-allocated",
    "rpc-not-written",
  ], { rpcGeneration: 7 });
  const stale = replayPromptEvidence([
    ...base,
    {
      sequence: 5,
      observedAt: new Date(1_005).toISOString(),
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      kind: "agent-start",
      rpcGeneration: 6,
      runGeneration: 2,
    },
  ]);
  assert.equal(stale?.delivery, "not-delivered");
  assert.equal(stale?.execution, "failed");
  assert.equal(stale?.facts.includes("agent-start"), false);

  const conflict = replayPromptEvidence([
    ...base,
    {
      sequence: 5,
      observedAt: new Date(1_005).toISOString(),
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      kind: "agent-start",
      rpcGeneration: 7,
      runGeneration: 2,
    },
  ]);
  assert.equal(conflict?.delivery, "unknown");
  assert.equal(conflict?.execution, "unknown");
  assert.equal(conflict?.conflicted, true);
});

test("prompt evidence ignores a stale run settlement within the same RPC generation", () => {
  const record = replayPromptEvidence([
    ...facts(["admitted", "dispatch", "rpc-written"], { rpcGeneration: 7 }),
    {
      sequence: 4,
      observedAt: new Date(1_004).toISOString(),
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      kind: "agent-start",
      rpcGeneration: 7,
      runGeneration: 8,
    },
    {
      sequence: 5,
      observedAt: new Date(1_005).toISOString(),
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      kind: "settled",
      rpcGeneration: 7,
      runGeneration: 7,
    },
  ]);
  assert.equal(record?.execution, "started");
  assert.equal(record?.runGeneration, 8);
  assert.equal(record?.facts.includes("settled"), false);
});

test("prompt evidence duplicate ingestion is idempotent and matches replay", () => {
  const input = facts([
    "admitted",
    "queued",
    "dispatch",
    "rpc-written",
    "agent-start",
    "settled",
  ], { rpcGeneration: 7, runGeneration: 8 });
  const replayed = replayPromptEvidence(input);
  let incremental: ReturnType<typeof replayPromptEvidence>;
  for (const fact of input) incremental = reducePromptEvidenceRecord(incremental, fact);
  incremental = reducePromptEvidenceRecord(incremental, { ...input.at(-1)!, sequence: 99 });
  assert.deepEqual(incremental, replayed);
});

test("prompt evidence keeps reducing after a long retry history", () => {
  const ledger = new PromptEvidenceLedger();
  ledger.record({ sessionId: SESSION_ID, promptId: PROMPT_ID, kind: "admitted" });
  ledger.record({ sessionId: SESSION_ID, promptId: PROMPT_ID, kind: "queued" });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    ledger.record({ sessionId: SESSION_ID, promptId: PROMPT_ID, kind: "dispatch", rpcGeneration: 7 });
    ledger.record({ sessionId: SESSION_ID, promptId: PROMPT_ID, kind: "rpc-not-written", rpcGeneration: 7 });
    ledger.record({ sessionId: SESSION_ID, promptId: PROMPT_ID, kind: "requeued", rpcGeneration: 7 });
  }
  ledger.record({ sessionId: SESSION_ID, promptId: PROMPT_ID, kind: "dispatch", rpcGeneration: 7 });
  ledger.record({ sessionId: SESSION_ID, promptId: PROMPT_ID, kind: "rpc-written", rpcGeneration: 7 });
  ledger.record({ sessionId: SESSION_ID, promptId: PROMPT_ID, kind: "rpc-response-success", rpcGeneration: 7 });
  ledger.record({ sessionId: SESSION_ID, promptId: PROMPT_ID, kind: "agent-start", rpcGeneration: 7, runGeneration: 9 });
  ledger.record({ sessionId: SESSION_ID, promptId: PROMPT_ID, kind: "settled", rpcGeneration: 7, runGeneration: 9 });
  const record = ledger.snapshot().records[0];
  assert.ok(record.facts.length > 64);
  assert.equal(record.delivery, "confirmed");
  assert.equal(record.execution, "settled");
});

test("prompt evidence ledger is whole-record bounded, age-limited, and immutable", () => {
  let now = Date.parse("2026-08-16T01:00:00.000Z");
  const ledger = new PromptEvidenceLedger({
    now: () => now,
    windowMs: 10_000,
    maximumRecords: 2,
    maximumBytes: 64 * 1_024,
  });
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];
  for (const promptId of ids) {
    ledger.record({ sessionId: SESSION_ID, promptId, kind: "admitted" });
    now += 1;
  }
  const bounded = ledger.snapshot();
  assert.equal(bounded.records.length, 2);
  assert.deepEqual(bounded.records.map((record) => record.promptId), ids.slice(1));
  bounded.records[0].facts.push("queued");
  assert.deepEqual(ledger.snapshot().records[0].facts, ["admitted"]);

  now += 11_000;
  assert.equal(ledger.snapshot().records.length, 0);
});

test("prompt evidence byte bounds evict whole records rather than partial facts", () => {
  const ledger = new PromptEvidenceLedger({
    maximumRecords: 100,
    maximumBytes: 1_024,
  });
  for (let index = 1; index <= 12; index += 1) {
    const promptId = `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
    ledger.record({ sessionId: SESSION_ID, promptId, kind: "admitted" });
    ledger.record({ sessionId: SESSION_ID, promptId, kind: "queued" });
    ledger.record({ sessionId: SESSION_ID, promptId, kind: "dispatch" });
  }
  const snapshot = ledger.snapshot();
  assert.ok(snapshot.records.length < 12);
  assert.ok(snapshot.status.approximateBytes <= snapshot.status.maximumBytes);
  assert.ok(snapshot.records.every((record) =>
    record.facts.length === 3
    && record.facts[0] === "admitted"
    && record.facts[2] === "dispatch"
  ));
});

test("prompt evidence ledger drops malformed and observer-failure input", () => {
  const ledger = new PromptEvidenceLedger();
  assert.doesNotThrow(() => ledger.record({
    sessionId: "not-a-session",
    promptId: PROMPT_ID,
    kind: "admitted",
  }));
  assert.doesNotThrow(() => ledger.record({
    sessionId: SESSION_ID,
    promptId: "private prompt text",
    kind: "admitted",
  }));
  assert.equal(ledger.snapshot().records.length, 0);

  const failing = new PromptEvidenceLedger({
    encodeBytes: () => { throw new Error("encoder failed"); },
  });
  assert.doesNotThrow(() => failing.record({
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
    kind: "admitted",
  }));
  assert.equal(failing.snapshot().records.length, 0);
});
