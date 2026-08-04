import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionIndex, cleanPreview, idForPath, readSessionMessages, readSessionUsage, textFromContent } from "../src/server/session-index";
import { LOCAL_COORDINATION_ROLE } from "../src/shared/types";

test("session index extracts header, title, preview, message count and user turn count", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-sessions-"));
  try {
    const directory = join(root, "--project--");
    await mkdir(directory);
    const path = join(directory, "session.jsonl");
    const lines = [
      { type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00Z", cwd: "C:\\work" },
      { type: "message", id: "1", message: { role: "user", content: [{ type: "text", text: "  First   question  " }] } },
      { type: "message", id: "2", message: { role: "assistant", content: [{ type: "text", text: "Answer" }] } },
      { type: "session_info", id: "3", name: "Named conversation" },
    ].map(JSON.stringify).join("\n");
    await writeFile(path, `${lines}\n`);

    const index = new SessionIndex(root);
    const sessions = await index.list(path);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, "session-1");
    assert.equal(sessions[0].name, "Named conversation");
    assert.equal(sessions[0].preview, "First question");
    assert.equal(sessions[0].messageCount, 2);
    assert.equal(sessions[0].turnCount, 1);
    assert.equal(sessions[0].active, true);
    assert.equal(index.pathForId(sessions[0].id), path);
    assert.equal((await index.list(path, "C:\\work")).length, 1);
    assert.equal((await index.list(path, "C:\\other")).length, 0);
    assert.equal(index.pathForId(sessions[0].id), path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session index orders active streams by their last user instruction rather than JSONL mtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-session-prompt-order-"));
  try {
    const first = join(root, "first.jsonl");
    const second = join(root, "second.jsonl");
    await writeFile(first, [
      { type: "session", id: "first", cwd: "C:\\work" },
      { type: "message", id: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "first prompt" } },
    ].map(JSON.stringify).join("\n"));
    await writeFile(second, [
      { type: "session", id: "second", cwd: "C:\\work" },
      { type: "message", id: "u2", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "second prompt" } },
    ].map(JSON.stringify).join("\n"));
    // Simulate a later streamed assistant/tool write to the older conversation.
    await new Promise((resolve) => setTimeout(resolve, 15));
    await appendFile(first, `\n${JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "assistant", content: "still streaming" } })}`);
    const sessions = await new SessionIndex(root, join(root, "cache.json")).list();
    assert.deepEqual(sessions.map((session) => session.sessionId), ["second", "first"]);
    assert.equal(sessions.find((session) => session.sessionId === "first")?.lastUserPromptAt, Date.parse("2026-01-01T00:00:01.000Z"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session index keeps auto-created subagent child sessions out of sidebar history", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-subagent-index-"));
  try {
    const parent = join(root, "parent.jsonl");
    const childDir = join(root, "parent", "run-0");
    const child = join(childDir, "session.jsonl");
    await mkdir(childDir, { recursive: true });
    await writeFile(parent, [
      { type: "session", id: "parent", cwd: "C:\\work" },
      { type: "message", id: "m1", parentId: null, message: { role: "user", content: "main task" } },
    ].map(JSON.stringify).join("\n"));
    await writeFile(child, [
      { type: "session", id: "child", cwd: "C:\\work" },
      { type: "session_info", id: "name", parentId: null, name: "subagent-reviewer-abc-1" },
      { type: "message", id: "m1", parentId: "name", message: { role: "user", content: "child task" } },
    ].map(JSON.stringify).join("\n"));
    const index = new SessionIndex(root, join(root, "cache.json"));
    assert.deepEqual((await index.list()).map((session) => session.id), [idForPath(parent)]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session index keeps generated top-level subagent sessions out of sidebar history", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-top-level-subagent-index-"));
  try {
    const path = join(root, "subagent.jsonl");
    await writeFile(path, [
      { type: "session", id: "child", cwd: "C:\\work" },
      { type: "session_info", id: "name", parentId: null, name: "subagent-planner-40b9af6d-1" },
      { type: "message", id: "m1", parentId: "name", message: { role: "user", content: "child task" } },
    ].map(JSON.stringify).join("\n"));
    assert.deepEqual(await new SessionIndex(root, join(root, "cache.json")).list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session index keeps empty draft JSONL files out of sidebar history", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-empty-draft-"));
  try {
    await writeFile(join(root, "empty.jsonl"), `${JSON.stringify({ type: "session", id: "empty", cwd: "C:\\work" })}\n`);
    await writeFile(join(root, "saved.jsonl"), [
      { type: "session", id: "saved", cwd: "C:\\work" },
      { type: "message", id: "m1", message: { role: "user", content: "saved question" } },
    ].map(JSON.stringify).join("\n"));
    const sessions = await new SessionIndex(root).list();
    assert.deepEqual(sessions.map((session) => session.sessionId), ["saved"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session sidebar summary and recency follow only the active JSONL branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-summary-branch-"));
  try {
    const path = join(root, "branch-summary.jsonl");
    await writeFile(path, [
      { type: "session", id: "session", cwd: "C:\\work" },
      { type: "session_info", id: "info", parentId: null, name: "Branched conversation" },
      { type: "message", id: "u1", parentId: "info", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "kept prompt" } },
      { type: "message", id: "abandoned-u2", parentId: "u1", timestamp: "2026-01-01T00:02:00Z", message: { role: "user", content: "abandoned later prompt" } },
      { type: "message", id: "current-a1", parentId: "u1", timestamp: "2026-01-01T00:01:00Z", message: { role: "assistant", content: "current branch answer" } },
    ].map(JSON.stringify).join("\n"));

    const [session] = await new SessionIndex(root, join(root, "cache.json")).list();
    assert.equal(session.name, "Branched conversation");
    assert.equal(session.preview, "kept prompt");
    assert.equal(session.messageCount, 2);
    assert.equal(session.turnCount, 1);
    assert.equal(session.lastUserPromptAt, Date.parse("2026-01-01T00:00:00Z"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session message reader follows only the current JSONL branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-session-branch-"));
  try {
    const path = join(root, "branch.jsonl");
    await writeFile(path, [
      { type: "session", id: "session", cwd: "C:\\work" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "kept user" } },
      { type: "message", id: "abandoned", parentId: "u1", message: { role: "assistant", content: "abandoned answer" } },
      { type: "message", id: "u2", parentId: "u1", message: { role: "user", content: "current user" } },
      { type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: "current answer" } },
    ].map(JSON.stringify).join("\n"));
    const messages = await readSessionMessages(path);
    assert.deepEqual(messages.map((message) => message.content), ["kept user", "current user", "current answer"]);
    assert.equal(messages[0].timestamp, Date.parse("2026-01-01T00:00:00Z"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an intercom custom message stays visible as a read-only process boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-intercom-history-"));
  try {
    const path = join(root, "history.jsonl");
    await writeFile(path, [
      { type: "session", id: "session", cwd: "C:\\work" },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "original question" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "completed answer" } },
      {
        type: "custom_message",
        customType: "intercom_message",
        id: "coordination",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:03.000Z",
        details: {
          from: { name: "chat2" },
          bodyText: "请停止运行中的操作，只报告当前状态。",
        },
      },
      { type: "message", id: "tool-run", parentId: "coordination", message: { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "status" } }] } },
    ].map(JSON.stringify).join("\n"));

    const messages = await readSessionMessages(path);
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", LOCAL_COORDINATION_ROLE, "assistant"]);
    assert.equal(messages[2].content, "请停止运行中的操作，只报告当前状态。");
    assert.deepEqual(messages[2].localCoordination, { source: "chat2" });
    assert.equal(messages[2].timestamp, Date.parse("2026-01-01T00:00:03.000Z"));

    const [summary] = await new SessionIndex(root, join(root, "cache.json")).list();
    assert.equal(summary.turnCount, 1, "local coordination never becomes a user turn");
    assert.equal(summary.messageCount, 3, "the sidebar still counts only Pi message records");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session snapshot retains its last persisted model and thinking selections", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-settings-snapshot-"));
  try {
    const path = join(root, "settings.jsonl");
    await writeFile(path, [
      { type: "session", id: "session", cwd: "C:\\work" },
      { type: "model_change", id: "m1", parentId: null, provider: "one", modelId: "first" },
      { type: "thinking_level_change", id: "t1", parentId: "m1", thinkingLevel: "low" },
      { type: "message", id: "u1", parentId: "t1", message: { role: "user", content: "hi" } },
      { type: "model_change", id: "m2", parentId: "u1", provider: "two", modelId: "last" },
      { type: "thinking_level_change", id: "t2", parentId: "m2", thinkingLevel: "xhigh" },
      { type: "message", id: "a1", parentId: "t2", message: { role: "assistant", content: "answer", provider: "two", model: "last" } },
    ].map(JSON.stringify).join("\n"));
    const index = new SessionIndex(root, join(root, "cache.json"));
    const [session] = await index.list();
    const snapshot = await index.snapshotForId(session.id);
    assert.deepEqual(snapshot?.settings, { provider: "two", modelId: "last", thinkingLevel: "xhigh" });
    assert.equal(snapshot?.messages.find((message) => message.role === "assistant")?.thinkingLevel, "xhigh", "assistant replies inherit the preceding persisted thinking level");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage reader sums successful turns and derives context from the last one", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-usage-"));
  try {
    const path = join(root, "usage.jsonl");
    await writeFile(path, [
      { type: "session", id: "session", cwd: "C:\\work" },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hi" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "one", provider: "p", model: "m1", usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0 } } },
      { type: "message", id: "a2", parentId: "a1", message: { role: "assistant", content: "failed", stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } },
      { type: "message", id: "a3", parentId: "a2", message: { role: "assistant", content: "two", provider: "p", model: "m2", usage: { input: 50, output: 30, cacheRead: 1200, cacheWrite: 10 } } },
    ].map(JSON.stringify).join("\n"));
    const usage = await readSessionUsage(path);
    assert.deepEqual(usage.tokens, { input: 150, output: 50, cacheRead: 2100, cacheWrite: 10, total: 2310 });
    assert.deepEqual(usage.context, { tokens: 1260, provider: "p", model: "m2" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage reader follows only the current branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-usage-branch-"));
  try {
    const path = join(root, "usage-branch.jsonl");
    await writeFile(path, [
      { type: "session", id: "session", cwd: "C:\\work" },
      { type: "message", id: "root", parentId: null, message: { role: "user", content: "hi" } },
      { type: "message", id: "old-leaf", parentId: "root", message: { role: "assistant", content: "old", provider: "p", model: "m", usage: { input: 999, output: 1, cacheRead: 0, cacheWrite: 0 } } },
      { type: "message", id: "new-leaf", parentId: "root", message: { role: "assistant", content: "new", provider: "p", model: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } },
    ].map(JSON.stringify).join("\n"));
    const usage = await readSessionUsage(path);
    assert.deepEqual(usage.tokens, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 });
    assert.deepEqual(usage.context, { tokens: 10, provider: "p", model: "m" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session snapshots reuse one parsed branch until the JSONL file changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-session-snapshot-"));
  try {
    const path = join(root, "session.jsonl");
    const initial = [
      { type: "session", id: "snapshot", cwd: process.cwd() },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "one" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "answer", provider: "p", model: "m", usage: { input: 2, output: 1, cacheRead: 3, cacheWrite: 0 } } },
    ];
    await writeFile(path, initial.map(JSON.stringify).join("\n"));
    const index = new SessionIndex(root, join(root, "cache.json"));
    const [session] = await index.list();
    const first = await index.snapshotForId(session.id);
    const second = await index.snapshotForId(session.id);
    assert.equal(first, second);
    assert.equal(first?.messages.length, 2);
    assert.equal(first?.usage.tokens.total, 6);

    await writeFile(path, [...initial, { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "two with a different file size" } }].map(JSON.stringify).join("\n"));
    const changed = await index.snapshotForId(session.id);
    assert.notEqual(changed, first);
    assert.equal(changed?.messages.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleting a cached Session snapshot releases its tracked byte budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-snapshot-enoent-"));
  try {
    const path = join(root, "cached.jsonl");
    await writeFile(path, [
      { type: "session", id: "cached", cwd: "C:\\work" },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "one" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "x".repeat(4_096) } },
    ].map(JSON.stringify).join("\n"));
    const index = new SessionIndex(root, join(root, "cache.json"));
    const [session] = await index.list();
    await index.snapshotForId(session.id);
    assert.ok((index as unknown as { snapshotCacheBytes: number }).snapshotCacheBytes > 0);
    await rm(path);
    assert.equal(await index.snapshotForId(session.id), null);
    assert.equal(index.cachedSnapshotForId(session.id), null);
    assert.equal((index as unknown as { snapshotCacheBytes: number }).snapshotCacheBytes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session index coalesces identical concurrent refreshes without losing path lookups", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-session-concurrent-"));
  try {
    const sessionPath = join(root, "session.jsonl");
    await writeFile(sessionPath, [
      { type: "session", id: "concurrent", cwd: process.cwd() },
      { type: "message", id: "m1", parentId: null, message: { role: "user", content: "hello" } },
    ].map(JSON.stringify).join("\n"));
    const index = new SessionIndex(root, join(root, "cache.json"));
    const [first, second, third] = await Promise.all([index.list(undefined, process.cwd()), index.list(undefined, process.cwd()), index.list(undefined, process.cwd())]);
    assert.deepEqual(first, second);
    assert.deepEqual(second, third);
    assert.equal(index.pathForId(idForPath(sessionPath)), sessionPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session index returns a complete cached snapshot without waiting for the next scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-session-cached-list-"));
  try {
    const sessionPath = join(root, "session.jsonl");
    await writeFile(sessionPath, [
      { type: "session", id: "cached-list", cwd: process.cwd() },
      { type: "message", id: "m1", parentId: null, message: { role: "user", content: "hello" } },
    ].map(JSON.stringify).join("\n"));
    const index = new SessionIndex(root, join(root, "cache.json"));
    const initial = await index.list(undefined, process.cwd());
    const originalRefresh = (index as unknown as { refresh: (activePath?: string, cwd?: string) => Promise<unknown> }).refresh.bind(index);
    let refreshFinished = false;
    (index as unknown as { refresh: (activePath?: string, cwd?: string) => Promise<unknown> }).refresh = async (activePath?: string, cwd?: string) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const result = await originalRefresh(activePath, cwd);
      refreshFinished = true;
      return result;
    };
    const cached = await index.listCached(undefined, process.cwd(), 0);
    assert.deepEqual(cached, initial);
    assert.equal(refreshFinished, false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(refreshFinished, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session index serializes concurrent refreshes with different keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-session-different-keys-"));
  try {
    const sessionPath = join(root, "session.jsonl");
    await writeFile(sessionPath, [
      { type: "session", id: "different-keys", cwd: process.cwd() },
      { type: "message", id: "m1", parentId: null, message: { role: "user", content: "hello" } },
    ].map(JSON.stringify).join("\n"));
    const index = new SessionIndex(root, join(root, "cache.json"));
    const originalRefresh = (index as unknown as { refresh: (activePath?: string, cwd?: string) => Promise<unknown> }).refresh.bind(index);
    let activeRefreshes = 0;
    let maximumConcurrentRefreshes = 0;
    (index as unknown as { refresh: (activePath?: string, cwd?: string) => Promise<unknown> }).refresh = async (activePath?: string, cwd?: string) => {
      activeRefreshes += 1;
      maximumConcurrentRefreshes = Math.max(maximumConcurrentRefreshes, activeRefreshes);
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        return await originalRefresh(activePath, cwd);
      } finally {
        activeRefreshes -= 1;
      }
    };
    await Promise.all([
      index.list(undefined, process.cwd()),
      index.list(sessionPath, process.cwd()),
      index.list(undefined, join(process.cwd(), "other")),
    ]);
    assert.equal(maximumConcurrentRefreshes, 1);
    assert.equal(index.pathForId(idForPath(sessionPath)), sessionPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session index joins a same-key refresh that starts while waiting on another scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-session-join-after-wait-"));
  try {
    const sessionPath = join(root, "session.jsonl");
    await writeFile(sessionPath, [
      { type: "session", id: "join-after-wait", cwd: process.cwd() },
      { type: "message", id: "m1", parentId: null, message: { role: "user", content: "hello" } },
    ].map(JSON.stringify).join("\n"));
    const index = new SessionIndex(root, join(root, "cache.json"));
    const originalRefresh = (index as unknown as { refresh: (activePath?: string, cwd?: string) => Promise<unknown> }).refresh.bind(index);
    let refreshStarts = 0;
    (index as unknown as { refresh: (activePath?: string, cwd?: string) => Promise<unknown> }).refresh = async (activePath?: string, cwd?: string) => {
      refreshStarts += 1;
      await new Promise((resolve) => setTimeout(resolve, refreshStarts === 1 ? 30 : 5));
      return originalRefresh(activePath, cwd);
    };
    // First caller starts key A. While it is still running, two key-B callers
    // wait. After A finishes they must share one B refresh, not race two.
    const first = index.list(undefined, join(process.cwd(), "other"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [second, third] = await Promise.all([
      index.list(undefined, process.cwd()),
      index.list(undefined, process.cwd()),
    ]);
    await first;
    assert.equal(refreshStarts, 2);
    assert.deepEqual(second, third);
    assert.equal(index.pathForId(idForPath(sessionPath)), sessionPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session index persists metadata and refreshes only changed session files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-session-cache-"));
  try {
    const first = join(root, "first.jsonl");
    const second = join(root, "second.jsonl");
    const writeSession = async (path: string, id: string, title: string) => {
      await writeFile(path, [
        { type: "session", id, cwd: "C:\\work" },
        { type: "message", message: { role: "user", content: title } },
        { type: "session_info", name: title },
      ].map(JSON.stringify).join("\n"));
    };
    await writeSession(first, "first", "First title");
    await writeSession(second, "second", "Second title");
    const cachePath = join(root, "index.json");
    const initial = new SessionIndex(root, cachePath);
    assert.deepEqual((await initial.list()).map((item) => item.name).sort(), ["First title", "Second title"]);
    const stored = JSON.parse(await readFile(cachePath, "utf8")) as { entries: Record<string, unknown> };
    assert.equal(Object.keys(stored.entries).length, 2);

    const restarted = new SessionIndex(root, cachePath);
    assert.deepEqual((await restarted.list()).map((item) => item.name).sort(), ["First title", "Second title"]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeSession(second, "second", "Updated second title");
    const updated = await restarted.list();
    assert.equal(updated.find((item) => item.sessionId === "first")?.name, "First title");
    assert.equal(updated.find((item) => item.sessionId === "second")?.name, "Updated second title");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session refresh tolerates a JSONL deleted after enumeration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-delete-race-"));
  try {
    const path = join(root, "vanishing.jsonl");
    await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: "vanishing", cwd: root })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "hello" } })}\n`);
    let first = true;
    const index = new SessionIndex(root, join(root, "cache.json"), async (candidate) => {
      if (first && candidate === path) {
        first = false;
        await rm(path);
        const error = new Error("deleted after enumeration") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return stat(candidate);
    });
    assert.deepEqual(await index.list(), []);
    assert.equal(index.pathForId(idForPath(path)), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a persisted metadata cache restores one cold target before any global inventory scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-session-index-target-"));
  try {
    const directory = join(root, "--project--");
    await mkdir(directory);
    const path = join(directory, "session.jsonl");
    await writeFile(path, [
      { type: "session", version: 3, id: "target", timestamp: "2026-01-01T00:00:00Z", cwd: root },
      { type: "message", id: "1", message: { role: "user", content: "question" } },
    ].map(JSON.stringify).join("\n") + "\n");
    const first = new SessionIndex(root);
    const [session] = await first.list();
    const statPaths: string[] = [];
    const second = new SessionIndex(root, first.cachePath, async (candidate) => {
      statPaths.push(candidate);
      assert.equal(candidate, path, "target restore may stat only the requested JSONL");
      return stat(candidate);
    });
    const summary = await second.cachedSummaryForId(session.id);
    assert.equal(summary?.id, session.id);
    assert.equal(second.pathForId(session.id), path);
    assert.deepEqual(statPaths, [path]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("target-only cache restore refreshes stale metadata without scanning other Sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-session-index-target-stale-"));
  try {
    const path = join(root, "session.jsonl");
    const writeSession = async (name: string) => writeFile(path, [
      { type: "session", version: 3, id: "target-stale", timestamp: "2026-01-01T00:00:00Z", cwd: root },
      { type: "message", id: "1", message: { role: "user", content: name } },
      { type: "session_info", id: "2", name },
    ].map(JSON.stringify).join("\n") + "\n");
    await writeSession("Old title");
    const first = new SessionIndex(root);
    const [session] = await first.list();
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeSession("New title with more bytes");

    const statPaths: string[] = [];
    const second = new SessionIndex(root, first.cachePath, async (candidate) => {
      statPaths.push(candidate);
      return stat(candidate);
    });
    const summary = await second.cachedSummaryForId(session.id);
    assert.equal(summary?.name, "New title with more bytes");
    assert.deepEqual(statPaths, [path]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an in-progress inventory refresh keeps the previous ID-to-path mapping readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-session-index-atomic-"));
  try {
    const directory = join(root, "--project--");
    await mkdir(directory);
    const path = join(directory, "session.jsonl");
    await writeFile(path, [
      { type: "session", version: 3, id: "atomic", timestamp: "2026-01-01T00:00:00Z", cwd: root },
      { type: "message", id: "1", message: { role: "user", content: "question" } },
    ].map(JSON.stringify).join("\n") + "\n");
    let releaseStat!: () => void;
    let blockNextStat = false;
    const index = new SessionIndex(root, undefined, async (candidate) => {
      if (blockNextStat && candidate === path) {
        blockNextStat = false;
        await new Promise<void>((resolve) => { releaseStat = resolve; });
      }
      return stat(candidate);
    });
    const [session] = await index.list();
    assert.equal(index.pathForId(session.id), path);

    blockNextStat = true;
    const refresh = index.list(undefined, root);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(index.pathForId(session.id), path, "known target remains addressable while the global scan is pending");
    assert.equal(index.summaryForId(session.id)?.id, session.id);
    releaseStat();
    await refresh;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session helper output is stable and compact", () => {
  assert.equal(cleanPreview(" a\n  b "), "a b");
  assert.equal(textFromContent([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "shown" }]), "shown");
  assert.equal(idForPath("C:/one"), idForPath("C:/one"));
  assert.notEqual(idForPath("C:/one"), idForPath("C:/two"));
});
