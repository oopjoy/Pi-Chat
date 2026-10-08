import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { installAppDom } from "../helpers/app-dom";
import { captureApiSnapshot } from "../helpers/api-stub";
import { activeSessionId, createBootstrapFixture } from "../fixtures/app-bootstrap";
import type { PiMessage } from "../../src/shared/types";

test("streaming updates do not rerender unchanged historical ChatMessage components", async t => {
  const { dom, FakeEventSource } = installAppDom();
  const key = "__PI_CHAT_BENCHMARK_REACT_PROFILER__";
  const previousFlag = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value: true });
  const { api } = await import("../../src/web/api");
  const restoreApi = captureApiSnapshot(api);
  const { ChatMessage } = await import("../../src/web/components/ChatMessage");
  const { reactRenderBenchmarkEnabled } = await import("../../src/web/lib/benchmark-profiler");
  assert.equal(reactRenderBenchmarkEnabled, true);
  const memoType = ChatMessage as unknown as { type(props: ComponentProps<typeof ChatMessage>): ReactNode };
  const originalRender = memoType.type;
  let historyRenders = 0;
  t.mock.method(memoType, "type", props => {
    if (props.message.piChatPersistedMessageId?.startsWith("history-")) historyRenders++;
    return originalRender(props);
  });
  const data = createBootstrapFixture();
  const messages: PiMessage[] = Array.from({ length: 20 }, (_, index) => [
    { role: "user", content: `Historical request ${index}`, piChatPersistedMessageId: `history-user-${index}` },
    { role: "assistant", content: `Historical answer ${index}`, piChatPersistedMessageId: `history-assistant-${index}` },
  ]).flat();
  messages.push({ role: "user", content: "Current request", piChatPersistedMessageId: "current-user" });
  Object.assign(api, {
    bootstrap: async () => ({ ...data, messages, messageTotal: messages.length, turnTotal: 21, state: { ...data.state, isStreaming: true } }),
    eventsUrl: () => "/api/events", markSessionViewed: async () => ({ viewing: activeSessionId }),
    renewPresence: async () => ({ present: true }), relinquishPresence: async () => ({ present: false }),
  });
  const { App } = await import("../../src/web/App");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(App)));
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => source.emitPi({ type: "agent_start", piChatSessionId: activeSessionId, piChatRunEpoch: "epoch-a", piChatRunGeneration: 1 }));
    const baseline = historyRenders;
    const sink = (dom.window as unknown as { __piChatReactRenderBenchmark: { commits: Array<{ id: string; actualDuration: number }> } }).__piChatReactRenderBenchmark;
    const baselineCommits = sink.commits.length;
    for (let n = 1; n <= 8; n++) {
      await act(async () => {
        source.emitPi({ type: n === 1 ? "message_start" : "message_update", piChatSessionId: activeSessionId, piChatRunEpoch: "epoch-a", piChatRunGeneration: 1,
          message: { role: "assistant", timestamp: 999, piChatLiveMessageId: "live-current", content: [{ type: "text", text: "growing ".repeat(n) }] } });
        await new Promise(resolve => setTimeout(resolve, 70));
      });
    }
    const measured = sink.commits.slice(baselineCommits).filter(commit => commit.id.includes("history-"));
    t.diagnostic(JSON.stringify({ historicalRows: 40, updates: 8, historicalComponentRenders: historyRenders - baseline,
      profilerHistoryCommits: measured.length, profilerActualDurationMs: measured.reduce((sum, item) => sum + item.actualDuration, 0) }));
    assert.match(dom.window.document.body.textContent || "", /growing growing/);
    assert.equal(historyRenders, baseline, "a live-only update must not invalidate all historical memo props");
  } finally {
    await act(async () => root.unmount()); restoreApi();
    if (previousFlag) Object.defineProperty(globalThis, key, previousFlag); else Reflect.deleteProperty(globalThis, key);
  }
});
