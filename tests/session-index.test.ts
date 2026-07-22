import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionIndex, cleanPreview, idForPath, readSessionMessages, readSessionUsage, textFromContent } from "../src/server/session-index";

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

test("session helper output is stable and compact", () => {
  assert.equal(cleanPreview(" a\n  b "), "a b");
  assert.equal(textFromContent([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "shown" }]), "shown");
  assert.equal(idForPath("C:/one"), idForPath("C:/one"));
  assert.notEqual(idForPath("C:/one"), idForPath("C:/two"));
});
