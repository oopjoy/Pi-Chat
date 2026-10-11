import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import type { PiMessage, SessionViewData } from "../../src/shared/types";
import { createBootstrapFixture, createSessionViewFixture, activeSessionId } from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom } from "../helpers/app-dom";

test("busy view refresh cannot move a dispatched user into the preceding process card", async () => {
  const { dom, FakeEventSource } = installAppDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const now = Date.now();
  const oldUser: PiMessage = { role: "user", content: "OLD_REQUEST", timestamp: now - 10000, piChatPersistedMessageId: "old-user:0" };
  const early: PiMessage = { role: "assistant", timestamp: now - 9000, piChatPersistedMessageId: "early:0", content: [{ type: "thinking", thinking: "OLD_EARLY_WORK" }, { type: "toolCall", name: "read", id: "early-read", arguments: {} }] };
  // The second prompt is submitted while this old turn is still running.
  const late: PiMessage = { role: "assistant", timestamp: now + 30000, piChatPersistedMessageId: "late:0", content: [{ type: "thinking", thinking: "OLD_LATE_WORK" }, { type: "toolCall", name: "bash", id: "late-test", arguments: {} }] };
  const final: PiMessage = { role: "assistant", timestamp: now + 40000, piChatPersistedMessageId: "final:0", content: "OLD_FINAL_ANSWER" };
  const next: PiMessage = { role: "assistant", timestamp: now + 50000, piChatLiveMessageId: "next-live", content: [{ type: "thinking", thinking: "NEW_REQUEST_WORK" }, { type: "toolCall", name: "read", id: "next-read", arguments: {} }] };
  const data = createBootstrapFixture();
  const session = { ...data.sessions[0], running: true, turnCount: 1 };
  const queuedId = "00000000-0000-4000-8000-000000000101";
  const queued = { id: queuedId, message: "NEW_REQUEST", imageCount: 0, createdAt: now };
  let messages = [oldUser, early];
  let queue: typeof queued[] = [];
  let turns = 1;
  let bootstrapCalls = 0;
  const view = (): SessionViewData => ({
    ...createSessionViewFixture(), session, messages,
    state: { ...data.state, isStreaming: true },
    isActive: true, runtimeStatus: "active", isStreaming: true,
    messageTotal: messages.length, turnTotal: turns, visibleTurnCount: turns,
    queue, queuePaused: false,
  });
  Object.assign(api, {
    bootstrap: async () => { bootstrapCalls++; return { ...data, messages, state: { ...data.state, isStreaming: true }, sessions: [session], turnTotal: turns, messageTotal: messages.length, queue }; },
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeSessionId }),
    sessions: async () => ({ sessions: [session], total: 1 }),
    viewSession: async () => view(),
    prompt: async () => { queue = [queued]; return { accepted: true, queued: true, id: queuedId, queue }; },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const document = dom.window.document;
  const userRows = () => [...document.querySelectorAll<HTMLElement>(".message-user")];
  try {
    await act(async () => root.render(createElement(App)));
    const textarea = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, queued.message);
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: queued.message }));
    });
    await act(async () => document.querySelector<HTMLButtonElement>(".queue-submit-button")!.click());
    assert.equal(userRows().filter(row => row.textContent?.includes("NEW_REQUEST")).length, 0);
    queue = [];
    await act(async () => FakeEventSource.instances.at(-1)!.emitPi({ type: "pi_chat_queue_dispatch", piChatSessionId: activeSessionId, id: queuedId, message: queued.message, imageCount: 0 }));
    assert.equal(userRows().filter(row => row.textContent?.includes("NEW_REQUEST")).length, 1);
    // JSONL now includes the previous turn's late tools/final; the new User's
    // receipt is not in the view yet, but its next assistant SSE already is.
    messages = [oldUser, early, late, final, next];
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="刷新会话列表"]')!.click());
    assert.ok(bootstrapCalls > 1, "manual refresh consumed the new authoritative snapshot");
    const processes = [...document.querySelectorAll<HTMLElement>(".conversation-process")];
    assert.equal(processes.length, 2);
    assert.match(processes[0].textContent || "", /OLD_EARLY_WORK/);
    assert.match(processes[0].textContent || "", /OLD_LATE_WORK/);
    assert.equal(processes[0].classList.contains("is-streaming"), false);
    assert.match(processes[1].textContent || "", /NEW_REQUEST_WORK/);
    assert.equal(processes[1].classList.contains("is-streaming"), true);
    const oldFinal = [...document.querySelectorAll<HTMLElement>(".message-assistant")].find(row => row.textContent?.includes("OLD_FINAL_ANSWER"))!;
    const newUser = userRows().find(row => row.textContent?.includes("NEW_REQUEST"))!;
    assert.ok(oldFinal.compareDocumentPosition(newUser) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(newUser.compareDocumentPosition(processes[1]) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);

    messages = [oldUser, early, late, final, { role: "user", content: queued.message, timestamp: now + 45000, piChatPersistedMessageId: "next-user:0" }, next];
    turns = 2;
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="刷新会话列表"]')!.click());
    assert.equal(userRows().filter(row => row.textContent?.includes("NEW_REQUEST")).length, 1);
    assert.equal(document.querySelectorAll(".conversation-process").length, 2);
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
