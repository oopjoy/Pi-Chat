import assert from "node:assert/strict";
import test from "node:test";
import { transitionRuntimeEvent, type RuntimeEventState } from "../src/server/runtime-event-transition";

const base = (): RuntimeEventState => ({
  runGeneration: 3,
  running: false,
  dispatching: false,
  failed: false,
  queuePaused: false,
  queueLength: 1,
  toolStatus: "",
  pendingTerminalMessages: [],
});

test("shared Runtime transition derives lifecycle and streaming facts without mutation", () => {
  const previous = base();
  const event = { type: "agent_start" };
  const started = transitionRuntimeEvent("session-a", previous, event);
  assert.equal(started.state.runGeneration, 4);
  assert.equal(started.state.running, true);
  assert.equal(started.state.dispatching, false, "agent_start releases the scheduler dispatch sentinel before settlement");
  assert.equal(started.state.toolStatus, "Pi 正在思考…");
  assert.deepEqual(started.effects, [{ type: "context-start" }, { type: "session-created" }]);
  assert.equal(previous.runGeneration, 3);
  assert.deepEqual(event, { type: "agent_start" });

  const live = transitionRuntimeEvent("session-a", started.state, {
    type: "message_update",
    message: { role: "assistant", content: "partial" },
  });
  const terminal = transitionRuntimeEvent("session-a", live.state, {
    type: "message_end",
    message: { role: "assistant", content: "" },
  });
  assert.deepEqual(terminal.broadcastEvent, {
    type: "message_end",
    piChatEventSchema: 1,
    terminalKind: "assistant",
    message: { role: "assistant", content: "partial" },
  });
  assert.equal(terminal.state.liveMessage, undefined);
  assert.equal(terminal.state.pendingTerminalMessages.length, 1);
});

test("shared Runtime transition rejects malformed terminals without state mutation", () => {
  const previous = {
    ...base(),
    liveMessage: { role: "assistant", content: "pending" },
  };
  for (const message of [
    { content: "missing role", secret: "drop me" },
    { role: "evil", content: "unknown role" },
    { role: "assistant", content: [{ type: "image", data: "x", mimeType: "image/png" }] },
    { role: "toolResult", content: "missing tool identity" },
  ]) {
    const rejected = transitionRuntimeEvent("session-a", previous, {
      type: "message_end",
      message,
    });
    assert.equal(rejected.broadcastEvent, null);
    assert.deepEqual(rejected.effects, []);
    assert.deepEqual(rejected.state.liveMessage, previous.liveMessage);
    assert.deepEqual(rejected.state.pendingTerminalMessages, []);
  }

  const exact = transitionRuntimeEvent("session-a", base(), {
    type: "message_end",
    message: {
      role: "toolResult",
      content: "done",
      toolCallId: "call-1",
      toolName: "read",
      isError: false,
      secret: "drop me",
    },
    requestToken: "drop me",
  });
  assert.deepEqual(exact.broadcastEvent, {
    type: "message_end",
    piChatEventSchema: 1,
    terminalKind: "tool-result",
    message: {
      role: "toolResult",
      content: "done",
      toolCallId: "call-1",
      toolName: "read",
      isError: false,
    },
  });
});

test("shared Runtime transition preserves terminal, created-event, and owner failure differences", () => {
  const userTerminal = transitionRuntimeEvent("session-a", base(), {
    type: "message_end",
    message: { role: "user", content: "do not buffer" },
  });
  assert.deepEqual(userTerminal.state.pendingTerminalMessages, []);
  const created = transitionRuntimeEvent("session-a", base(), { type: "message_start" });
  assert.deepEqual(created.effects, [{ type: "session-created" }]);
  const primaryFailure = transitionRuntimeEvent("session-a", {
    ...base(), liveMessage: { role: "assistant", content: "partial" },
  }, { type: "pi_chat_process_error" });
  assert.equal(primaryFailure.state.liveMessage, undefined);
  const secondaryFailure = transitionRuntimeEvent("session-a", {
    ...base(), preserveLiveMessageOnProcessError: true, liveMessage: { role: "assistant", content: "partial" },
  }, { type: "pi_chat_process_error" });
  assert.deepEqual(secondaryFailure.state.liveMessage, { role: "assistant", content: "partial" });
});

test("shared Runtime transition derives Fast status without treating it as an interactive request", () => {
  const enabled = transitionRuntimeEvent("session-a", base(), {
    type: "extension_ui_request",
    method: "setStatus",
    statusKey: "fast",
    statusText: "⚡",
  });
  assert.equal(enabled.state.extensionUiPending, false);
  assert.deepEqual(enabled.effects, [{ type: "fast-mode", active: true }]);

  const disabled = transitionRuntimeEvent("session-a", base(), {
    type: "extension_ui_request",
    method: "setStatus",
    statusKey: "fast",
  });
  assert.deepEqual(disabled.effects, [{ type: "fast-mode", active: false }]);

  const unrelated = transitionRuntimeEvent("session-a", base(), {
    type: "extension_ui_request",
    method: "setStatus",
    statusKey: "footer",
    statusText: "ready",
  });
  assert.deepEqual(unrelated.effects, []);
});

test("shared Runtime transition derives extension, failure, and settlement effects", () => {
  const pending = transitionRuntimeEvent("session-a", base(), {
    type: "extension_ui_request",
    id: "gate-1",
    method: "select",
    title: "Pi Chat Gate: bash",
    options: ["allow", "block"],
  });
  assert.equal(pending.state.extensionUiPending, true);
  assert.deepEqual(pending.effects, [{
    type: "extension-request",
    request: {
      type: "extension_ui_request",
      id: "gate-1",
      method: "select",
      title: "Pi Chat Gate: bash",
      options: ["allow", "block"],
      piChatSessionId: "session-a",
    },
  }]);
  const failed = transitionRuntimeEvent("session-a", { ...pending.state, running: true }, {
    type: "pi_chat_process_error",
  });
  assert.equal(failed.state.failed, true);
  assert.equal(failed.state.queuePaused, true);
  assert.deepEqual(failed.effects.map((effect) => effect.type), ["clear-extension-request", "queue-changed", "session-status"]);
  const settled = transitionRuntimeEvent("session-a", failed.state, { type: "agent_settled" });
  assert.equal(settled.state.running, false);
  assert.deepEqual(settled.effects.map((effect) => effect.type), ["context-complete", "settled"]);
});
