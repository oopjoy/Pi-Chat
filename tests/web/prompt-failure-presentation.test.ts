import assert from "node:assert/strict";
import test from "node:test";
import { presentPromptFailure } from "../../src/web/application/prompt-failure-presentation";

test("prompt failure presentation commits rejection and routes notice/error through sinks", () => {
  const calls: string[] = [];
  const authority = {} as never;
  const visible = presentPromptFailure({
    sessionId: "s",
    paneAuthority: authority,
    draftAuthority: null,
    rejectionMessages: undefined,
    stoppedSteerRejection: false,
    stateStreaming: true,
    promptAcceptedByEvent: false,
    resultPending: true,
    causeMessage: "pending",
  }, {
    commitPane: () => { calls.push("pane"); return true; },
    commitDraft: () => false,
    scheduleSidebarRefresh: () => calls.push("refresh"),
    showNotice: (message) => calls.push(`notice:${message}`),
    showError: (message) => calls.push(`error:${message}`),
  });
  assert.equal(visible, true);
  assert.deepEqual(calls, ["pane", "notice:pending"]);
});
