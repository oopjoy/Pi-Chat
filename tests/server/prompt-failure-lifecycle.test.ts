import assert from "node:assert/strict";
import test from "node:test";
import { projectPromptFailureLifecycle } from "../../src/server/services/prompt-failure-lifecycle";

test("prompt failure lifecycle projects native retry without owning the retry scheduler", () => {
  const events: Record<string, unknown>[] = [];
  const evidence: string[] = [];
  const active = { promptId: "p", rpcGeneration: 1, route: { provider: "provider", modelId: "model" } };
  projectPromptFailureLifecycle({
    active,
    sessionId: "s",
    event: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "retry" },
    runGeneration: 2,
    rpcGeneration: 1,
  }, {
    runEpoch: () => "epoch",
    broadcast: (event) => events.push(event),
    recordEvidence: (fact) => evidence.push(fact.kind),
  });
  assert.equal(active.retryPending, true);
  assert.deepEqual(evidence, ["retry-scheduled"]);
  assert.equal(events[0]?.type, "pi_chat_prompt_retry_scheduled");
  assert.equal(events[0]?.piChatPromptId, "p");
});

test("prompt failure lifecycle publishes one terminal failure", () => {
  const events: Record<string, unknown>[] = [];
  const active = { promptId: "p", rpcGeneration: 1, failure: undefined as unknown } as never;
  projectPromptFailureLifecycle({
    active,
    sessionId: "s",
    event: { type: "pi_chat_process_error", error: "failure" },
    runGeneration: 2,
    rpcGeneration: 1,
  }, {
    runEpoch: () => "epoch",
    broadcast: (event) => events.push(event),
    recordEvidence: () => {},
  });
  assert.equal(events.filter((event) => event.type === "pi_chat_prompt_failed").length, 1);
});
