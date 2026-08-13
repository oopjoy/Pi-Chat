import assert from "node:assert/strict";
import test from "node:test";
import type { PiMessage, SessionViewData } from "../src/shared/types";
import {
  conversationPaneReducer,
  emptyConversationPane,
  type ConversationPaneCommit,
} from "../src/web/state/conversation-pane";

const sessionA = "aaaaaaaaaaaaaaaaaaaa";
const sessionB = "bbbbbbbbbbbbbbbbbbbb";

function commit(sessionId = sessionA, overrides: Partial<ConversationPaneCommit> = {}): ConversationPaneCommit {
  return {
    ...emptyConversationPane(),
    identity: { kind: "session", sessionId },
    piState: { model: null, isStreaming: false, sessionId },
    runtimeStatus: "active",
    messages: [{ role: "user", content: `message-${sessionId}` }],
    messageTotal: 1,
    turnTotal: 1,
    visibleTurnCount: 1,
    ...overrides,
  };
}

function reduce(...actions: Parameters<typeof conversationPaneReducer>[1][]) {
  return actions.reduce(conversationPaneReducer, emptyConversationPane());
}

test("COMMIT_VIEW atomically replaces the visible pane projection", () => {
  const pending: PiMessage = { role: "user", content: "pending" };
  const state = reduce({
    type: "COMMIT_VIEW",
    pane: commit(sessionA, {
      queue: [{ id: "queue", message: "later", imageCount: 0, createdAt: 1 }],
      queuePaused: true,
      pendingUserMessage: pending,
      toolStatus: "working",
      control: { controlOwner: "owner", controlledByThisWindow: false },
    }),
  });

  assert.deepEqual(state.identity, { kind: "session", sessionId: sessionA });
  assert.equal(state.messages[0].content, `message-${sessionA}`);
  assert.equal(state.queue[0].id, "queue");
  assert.equal(state.queuePaused, true);
  assert.equal(state.pendingUserMessage, pending);
  assert.equal(state.toolStatus, "working");
  assert.deepEqual(state.control, { controlOwner: "owner", controlledByThisWindow: false });

  const controlled = conversationPaneReducer(state, {
    type: "CONTROL_UPDATED",
    sessionId: sessionA,
    control: { controlOwner: "this-window", controlledByThisWindow: true },
  });
  assert.equal(controlled.control.controlledByThisWindow, true);
  assert.equal(
    conversationPaneReducer(controlled, {
      type: "CONTROL_UPDATED",
      sessionId: sessionB,
      control: { controlOwner: "stale", controlledByThisWindow: false },
    }),
    controlled,
    "a different Session cannot replace the visible control projection",
  );
});

test("a stale Session action cannot update a different committed pane", () => {
  const state = conversationPaneReducer(emptyConversationPane(), {
    type: "COMMIT_VIEW",
    pane: commit(sessionB),
  });
  const next = conversationPaneReducer(state, {
    type: "AGENT_STARTED",
    sessionId: sessionA,
    toolStatus: "stale A",
  });

  assert.equal(next, state);
  assert.equal(next.piState.isStreaming, false);
  assert.equal(next.toolStatus, "");
});

test("COMMIT_VIEW consumes the coordinator-normalized command projection", () => {
  const a = conversationPaneReducer(emptyConversationPane(), {
    type: "COMMIT_VIEW",
    pane: commit(sessionA, {
      commands: [{ name: "only-a", description: "A command", source: "extension" }],
    }),
  });
  const sameA = conversationPaneReducer(a, {
    type: "COMMIT_VIEW",
    pane: commit(sessionA, { commands: a.commands }),
  });
  const b = conversationPaneReducer(sameA, {
    type: "COMMIT_VIEW",
    pane: commit(sessionB, { commands: [] }),
  });

  assert.deepEqual(sameA.commands, a.commands, "a normalized same-Session partial refresh keeps commands");
  assert.deepEqual(b.identity, { kind: "session", sessionId: sessionB });
  assert.deepEqual(b.commands, []);
});

test("a new COMMIT_VIEW for a revisited Session replaces its old projection", () => {
  const firstA = conversationPaneReducer(emptyConversationPane(), {
    type: "COMMIT_VIEW",
    pane: commit(sessionA, { toolStatus: "old A", messages: [{ role: "assistant", content: "old" }] }),
  });
  const b = conversationPaneReducer(firstA, { type: "COMMIT_VIEW", pane: commit(sessionB) });
  const revisitedA = conversationPaneReducer(b, {
    type: "COMMIT_VIEW",
    pane: commit(sessionA, { toolStatus: "new A", messages: [{ role: "assistant", content: "new" }] }),
  });

  assert.equal(revisitedA.toolStatus, "new A");
  assert.equal(revisitedA.messages[0].content, "new");
});

test("RESET_DRAFT is the only reducer-owned draft display transition", () => {
  const state = reduce(
    { type: "COMMIT_VIEW", pane: commit(sessionA) },
    { type: "RESET_DRAFT", model: { id: "m", name: "Model", provider: "test" }, thinkingLevel: "high", draftWorkspaceCwd: "C:/draft" },
  );

  assert.deepEqual(state.identity, { kind: "draft", sessionId: "" });
  assert.equal(state.runtimeStatus, "draft");
  assert.equal(state.piState.model?.id, "m");
  assert.equal(state.piState.thinkingLevel, "high");
  assert.equal(state.draftWorkspaceCwd, "C:/draft");
  assert.deepEqual(state.messages, []);
  assert.equal(state.queue.length, 0);
});

test("terminal, settlement, and failure transitions update their visible fields atomically", () => {
  const terminal: PiMessage = { role: "assistant", content: "done" };
  const started = reduce(
    {
      type: "COMMIT_VIEW",
      pane: commit(sessionA, {
        piState: {
          model: { id: "gpt-5.6-sol", name: "5.6 Sol", provider: "cpa-proxy" },
          thinkingLevel: "high",
          isStreaming: false,
          sessionId: sessionA,
        },
        promptStarting: true,
      }),
    },
    { type: "AGENT_STARTED", sessionId: sessionA, toolStatus: "thinking" },
  );
  assert.equal(started.piState.isStreaming, true);
  assert.equal(started.runtimeStatus, "active");
  assert.equal(started.promptStarting, false);
  assert.equal(started.toolStatus, "thinking");

  const live = conversationPaneReducer(started, {
    type: "LIVE_MESSAGE_UPDATED",
    sessionId: sessionA,
    message: { role: "assistant", content: "draft" },
  });
  assert.equal(live.liveMessage?.provider, "cpa-proxy");
  assert.equal(live.liveMessage?.model, "gpt-5.6-sol");
  assert.equal(live.liveMessage?.thinkingLevel, "high");

  const terminalCommitted = conversationPaneReducer(live, {
    type: "TERMINAL_MESSAGE_COMMITTED",
    sessionId: sessionA,
    message: terminal,
  });
  assert.equal(terminalCommitted.liveMessage, null);
  assert.equal(terminalCommitted.messages.at(-1)?.content, "done");
  assert.equal(terminalCommitted.messages.at(-1)?.provider, "cpa-proxy");
  assert.equal(terminalCommitted.messages.at(-1)?.model, "gpt-5.6-sol");
  assert.equal(terminalCommitted.messages.at(-1)?.thinkingLevel, "high");

  const settled = conversationPaneReducer(terminalCommitted, {
    type: "AGENT_SETTLED",
    sessionId: sessionA,
  });
  assert.equal(settled.piState.isStreaming, false);
  assert.equal(settled.piState.isCompacting, false);
  assert.equal(settled.toolStatus, "");
  assert.equal(settled.promptStarting, false);

  const failed = conversationPaneReducer({ ...settled, piState: { ...settled.piState, isStreaming: true }, toolStatus: "tool" }, {
    type: "PROCESS_FAILED",
    sessionId: sessionA,
  });
  assert.equal(failed.runtimeStatus, "view-only");
  assert.equal(failed.piState.isStreaming, false);
  assert.equal(failed.liveMessage, null);
  assert.equal(failed.toolStatus, "");
});

test("queue compound transitions preserve queue and transcript exclusivity", () => {
  const pending: PiMessage = { role: "user", content: "queued" };
  const waiting = reduce(
    { type: "COMMIT_VIEW", pane: commit(sessionA, { pendingUserMessage: pending }) },
    {
      type: "QUEUE_UPDATED",
      sessionId: sessionA,
      queue: [{ id: "q", message: "queued", imageCount: 0, createdAt: 1 }],
      paused: false,
      messages: [],
      pendingUserMessage: null,
    },
  );
  assert.equal(waiting.queue.length, 1);
  assert.deepEqual(waiting.messages, []);
  assert.equal(waiting.pendingUserMessage, null);

  const dispatched = conversationPaneReducer(waiting, {
    type: "QUEUE_DISPATCHED",
    sessionId: sessionA,
    queue: [],
    messages: [pending],
    pendingUserMessage: null,
  });
  assert.equal(dispatched.piState.isStreaming, true);
  assert.equal(dispatched.queue.length, 0);
  assert.equal(dispatched.messages[0], pending);

  const failed = conversationPaneReducer(dispatched, {
    type: "QUEUE_FAILED",
    sessionId: sessionA,
    queue: [{ id: "q", message: "queued", imageCount: 0, createdAt: 1 }],
    paused: true,
    messages: [],
    pendingUserMessage: null,
  });
  assert.equal(failed.piState.isStreaming, false);
  assert.equal(failed.queuePaused, true);
  assert.deepEqual(failed.messages, []);
});

test("targeted synchronous actions match only their current pane identity", () => {
  const draft = conversationPaneReducer(emptyConversationPane(), {
    type: "RESET_DRAFT",
    model: null,
    draftWorkspaceCwd: "C:/draft",
  });
  const stagedDraft = conversationPaneReducer(draft, {
    type: "PREFERENCES_STAGED",
    target: { kind: "draft" },
    thinkingLevel: "high",
  });
  assert.equal(stagedDraft.piState.thinkingLevel, "high");
  assert.equal(
    conversationPaneReducer(stagedDraft, {
      type: "PROMPT_STARTED",
      target: { kind: "session", sessionId: sessionA },
      pendingUserMessage: { role: "user", content: "ignored" },
    }),
    stagedDraft,
    "a session target cannot update a draft",
  );

  const session = conversationPaneReducer(stagedDraft, {
    type: "COMMIT_VIEW",
    pane: commit(sessionA),
  });
  assert.equal(
    conversationPaneReducer(session, {
      type: "PROMPT_PREPARING",
      target: { kind: "session", sessionId: sessionB },
      status: "ignored",
    }),
    session,
    "a different Session target cannot update the current pane",
  );
});

test("draft-only and terminal clear actions cannot leave a second display authority", () => {
  const draft = conversationPaneReducer(emptyConversationPane(), {
    type: "RESET_DRAFT",
    model: null,
    draftWorkspaceCwd: "C:/draft",
  });
  const updatedDraft = conversationPaneReducer(draft, { type: "DRAFT_WORKSPACE_SELECTED", cwd: "D:/draft" });
  const ignoredSessionAction = conversationPaneReducer(updatedDraft, {
    type: "TOOL_STATUS_UPDATED",
    sessionId: sessionA,
    status: "ignored",
  });
  const cleared = conversationPaneReducer(ignoredSessionAction, { type: "CLEAR_PANE" });

  assert.equal(updatedDraft.draftWorkspaceCwd, "D:/draft");
  assert.equal(ignoredSessionAction.toolStatus, "");
  assert.deepEqual(cleared, emptyConversationPane());
});
