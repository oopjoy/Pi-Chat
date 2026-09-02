import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { act, createElement } from "react";
import type { BootstrapData, SessionViewData } from "../../src/shared/types";
import { activeSessionId as activeId, createBootstrapFixture, createSessionViewFixture } from "../fixtures/app-bootstrap";
import { captureApiSnapshot } from "../helpers/api-stub";
import { installAppDom as installDom } from "../helpers/app-dom";

let bootstrap: BootstrapData;
let draftView: SessionViewData;

beforeEach(() => {
  bootstrap = createBootstrapFixture();
  draftView = createSessionViewFixture();
});


test("queue SSE invalidates an older Session view before it can erase queue state", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const queuedItem = {
    id: "00000000-0000-4000-8000-000000000099",
    message: "SSE queue state wins",
    imageCount: 0,
    createdAt: 9,
  };
  let resolveView!: (view: SessionViewData) => void;
  const staleView = new Promise<SessionViewData>((resolve) => {
    resolveView = resolve;
  });
  const oldView: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: activeId,
      sessionId: "active",
      name: "Active",
      active: true,
      writable: true,
    },
    state: { ...bootstrap.state, isStreaming: false },
    queue: [],
    queuePaused: false,
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true },
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async () => staleView,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({ type: "agent_settled", piChatSessionId: activeId }),
    );
    await act(async () =>
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        admittedId: queuedItem.id,
        queue: [queuedItem],
        paused: true,
      }),
    );
    assert.equal(
      dom.window.document.querySelectorAll(".prompt-queue article").length,
      1,
    );
    await act(async () => {
      source.emitPi({
        type: "pi_chat_queue_update",
        piChatSessionId: activeId,
        paused: false,
      });
    });
    assert.equal(
      dom.window.document.querySelectorAll(".prompt-queue article").length,
      1,
      "a malformed queue frame cannot be treated as an empty queue",
    );

    await act(async () => resolveView(oldView));
    assert.equal(
      dom.window.document.querySelectorAll(".prompt-queue article").length,
      1,
      "the earlier view must not overwrite newer queue SSE state",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});

test("agent settlement preserves a completed compaction status until its terminal event", async () => {
  const { dom, FakeEventSource } = installDom();
  const { createRoot } = await import("react-dom/client");
  const { api } = await import("../../src/web/api");
  const { App } = await import("../../src/web/App");
  const restoreApi = captureApiSnapshot(api);
  const settledView: SessionViewData = {
    ...draftView,
    session: {
      ...draftView.session,
      id: activeId,
      sessionId: "active",
      name: "Active",
      active: true,
      writable: true,
    },
    state: { ...bootstrap.state, isStreaming: false, isCompacting: false },
    isStreaming: false,
    toolStatus: "",
  };
  Object.assign(api, {
    bootstrap: async () => ({
      ...bootstrap,
      state: { ...bootstrap.state, isStreaming: true, isCompacting: true },
      messages: [
        {
          role: "assistant" as const,
          content: [
            {
              type: "toolCall" as const,
              id: "bash-1",
              name: "bash",
              arguments: { command: "dir" },
            },
          ],
        },
        {
          role: "toolResult" as const,
          toolCallId: "bash-1",
          toolName: "bash",
          content: "done",
        },
      ],
    }),
    eventsUrl: () => "/api/events",
    markSessionViewed: async () => ({ viewing: activeId }),
    viewSession: async () => settledView,
    sessions: async () => ({
      sessions: bootstrap.sessions,
      total: bootstrap.sessions.length,
    }),
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () =>
      source.emitPi({
        type: "tool_execution_end",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        toolName: "bash",
        isError: false,
      }),
    );
    assert.match(
      dom.window.document.querySelector(".agent-status")?.textContent || "",
      /正在压缩上下文，当前消息会在完成后继续发送…/,
    );
    assert.ok(
      dom.window.document.querySelector(".agent-status.is-compacting"),
      "a tool terminal cannot prove that an existing compaction has finished",
    );

    await act(async () =>
      source.emitPi({
        type: "agent_settled",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
      }),
    );
    assert.ok(
      !dom.window.document.querySelector(".agent-status"),
      "settled conversations must not retain a status spinner",
    );
    assert.ok(
      !dom.window.document.querySelector(
        ".conversation-process .process-status-icon.is-running",
      ),
    );
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='消息输入']",
      )?.disabled,
      false,
    );
    await act(async () => {
      source.emitPi({
        type: "tool_execution_end",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        toolName: "bash",
        isError: false,
      });
      source.emitPi({
        type: "pi_chat_session_status",
        piChatSessionId: activeId,
        piChatRunGeneration: 1,
        activity: { execution: "running", awaitingConfirmation: false },
      });
    });
    assert.ok(
      !dom.window.document.querySelector(".agent-status"),
      "late tool/status events from a settled generation must not restore a spinner",
    );
    assert.ok(
      !dom.window.document.querySelector(".session-status.is-running"),
      "late running activity must not restore the sidebar spinner",
    );
  } finally {
    await act(async () => root.unmount());
    restoreApi();
  }
});
