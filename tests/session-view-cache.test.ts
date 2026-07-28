import assert from "node:assert/strict";
import test from "node:test";
import type { SessionViewData } from "../src/shared/types";
import { SessionViewCache } from "../src/web/lib/session-view-cache";

function view(id: string): SessionViewData {
  return {
    session: { id, sessionId: id, name: id, preview: "", cwd: "C:/", updatedAt: 1, messageCount: 1, active: false },
    state: { model: null, isStreaming: false },
    messages: [],
    messageTotal: 0,
    messagesTruncated: false,
    isActive: false,
  };
}

test("SessionViewCache refreshes recency and evicts the oldest view", () => {
  let now = 0;
  const cache = new SessionViewCache(2, () => ++now);
  cache.remember(view("one"));
  cache.remember(view("two"));
  cache.remember(view("one"));
  cache.remember(view("three"));
  assert.equal(cache.get("one")?.cachedAt, 3);
  assert.equal(cache.get("two"), undefined);
  assert.equal(cache.get("three")?.session.id, "three");
  cache.forget("one");
  assert.equal(cache.get("one"), undefined);
});

test("authoritative Gate updates survive cached session navigation", () => {
  const cache = new SessionViewCache();
  cache.remember({ ...view("gate"), gateMode: "open" });
  cache.patch("gate", { gateMode: "strict" });
  assert.equal(cache.get("gate")?.gateMode, "strict");
});

test("a delayed busy view cannot erase terminal SSE messages or its live draft", () => {
  const cache = new SessionViewCache();
  const base = {
    ...view("busy"),
    state: { model: null, isStreaming: true },
    isActive: true,
    isStreaming: true,
    messages: [{ role: "user", content: "question", timestamp: 1 }],
    messageTotal: 1,
    turnTotal: 1,
    liveMessage: { role: "assistant", content: [{ type: "thinking", thinking: "inspect" }] },
  } satisfies SessionViewData;
  cache.remember(base);
  cache.appendTerminal("busy", { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }], timestamp: 2 });
  cache.appendTerminal("busy", { role: "toolResult", toolCallId: "read-1", toolName: "read", content: "done", timestamp: 3 });

  const stale = cache.remember({ ...base, liveMessage: undefined });
  assert.deepEqual(stale.messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
  assert.equal(stale.liveMessage, undefined);
});

test("an idle view that is only a stale prefix cannot erase an SSE terminal tail", () => {
  const cache = new SessionViewCache();
  cache.remember({
    ...view("settled-lag"),
    state: { model: null, isStreaming: true },
    isStreaming: true,
    messages: [
      { role: "user", content: "old question", timestamp: 1 },
      { role: "assistant", content: "old answer", timestamp: 2 },
    ],
    messageTotal: 2,
    turnTotal: 1,
  });
  cache.appendTerminal("settled-lag", { role: "user", content: "new question", timestamp: 3 });
  cache.appendTerminal("settled-lag", { role: "assistant", content: "new answer", timestamp: 4 });
  const staleSettled = cache.remember({
    ...view("settled-lag"),
    messages: [
      { role: "user", content: "old question", timestamp: 1 },
      { role: "assistant", content: "old answer", timestamp: 2 },
    ],
    messageTotal: 2,
    turnTotal: 2,
  });
  assert.deepEqual(staleSettled.messages.map((message) => message.content), ["old question", "old answer", "new question", "new answer"]);
});

test("a divergent stale settled view cannot erase an unconfirmed terminal answer", () => {
  const cache = new SessionViewCache();
  cache.remember({
    ...view("divergent"),
    state: { model: null, isStreaming: true },
    isStreaming: true,
    messages: [{ role: "user", content: "question", timestamp: 1 }],
    messageTotal: 1,
    turnTotal: 1,
  });
  const terminal = { role: "assistant", content: "final answer", timestamp: 4 };
  cache.appendTerminal("divergent", terminal);

  const stale = cache.remember({
    ...view("divergent"),
    messages: [
      { role: "user", content: "duplicated stale question", timestamp: 2 },
      { role: "user", content: "question", timestamp: 1 },
    ],
    messageTotal: 2,
    turnTotal: 1,
  });
  assert.equal(stale.messages.at(-1)?.content, "final answer");
  assert.equal(stale.turnTotal, 2);

  const confirmed = cache.remember({
    ...view("divergent"),
    messages: [{ role: "user", content: "question", timestamp: 1 }, terminal],
    messageTotal: 2,
    turnTotal: 1,
  });
  assert.deepEqual(confirmed.messages.map((message) => message.content), ["question", "final answer"]);
  assert.equal(confirmed.turnTotal, 1);
});

test("a cloned cached snapshot must not be treated as terminal persistence", () => {
  const cache = new SessionViewCache();
  cache.remember({
    ...view("cloned-terminal"),
    messages: [{ role: "user", content: "question", timestamp: 1 }],
    messageTotal: 1,
    turnTotal: 1,
  });
  const terminal = { role: "assistant", content: "answer", timestamp: 2 };
  const leased = cache.appendTerminal("cloned-terminal", terminal)!;

  // App navigation patches an otherwise empty busy view. That patch must not
  // become evidence that JSONL persisted the terminal answer.
  cache.patch("cloned-terminal", { state: { model: null, isStreaming: true }, isStreaming: true, messages: [], messageTotal: 0, turnTotal: 0 });
  const stale = cache.remember({
    ...view("cloned-terminal"),
    messages: [
      { role: "user", content: "divergent stale turn", timestamp: 0 },
      { role: "user", content: "question", timestamp: 1 },
    ],
    messageTotal: 2,
    turnTotal: 2,
  });

  assert.equal(stale.messages.at(-1)?.content, "answer");
});

test("transient cache patches never recount terminal leases", () => {
  const cache = new SessionViewCache();
  cache.remember({
    ...view("patch-terminal"),
    state: { model: null, isStreaming: true },
    isStreaming: true,
    messages: [{ role: "user", content: "question", timestamp: 1 }],
    messageTotal: 1,
    turnTotal: 1,
  });
  cache.appendTerminal("patch-terminal", { role: "assistant", content: "answer", timestamp: 2 });

  cache.patch("patch-terminal", { liveMessage: { role: "assistant", content: "next draft", timestamp: 3 }, isStreaming: true });
  const patched = cache.patch("patch-terminal", { liveMessage: undefined, isStreaming: false });

  assert.equal(patched?.messageTotal, 2);
  assert.equal(patched?.turnTotal, 1);
  assert.deepEqual(patched?.messages.map((message) => message.content), ["question", "answer"]);
});

test("an idle authoritative branch may replace a different old streaming branch", () => {
  const cache = new SessionViewCache();
  cache.remember({
    ...view("idle"),
    state: { model: null, isStreaming: true },
    isStreaming: true,
    messages: [{ role: "user", content: "old branch" }],
    messageTotal: 1,
    turnTotal: 1,
  });
  const settled = cache.remember({
    ...view("idle"),
    messages: [{ role: "user", content: "current branch" }],
    messageTotal: 1,
    turnTotal: 1,
  });
  assert.deepEqual(settled.messages.map((message) => message.content), ["current branch"]);
});
