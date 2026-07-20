import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionIndex, cleanPreview, idForPath, readSessionMessages, readSessionUsage, textFromContent } from "../src/server/session-index";

test("session index extracts header, title, preview and message count", async () => {
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
    assert.equal(sessions[0].active, true);
    assert.equal(index.pathForId(sessions[0].id), path);
    assert.equal((await index.list(path, "C:\\work")).length, 1);
    assert.equal((await index.list(path, "C:\\other")).length, 0);
    assert.equal(index.pathForId(sessions[0].id), null);
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

test("session helper output is stable and compact", () => {
  assert.equal(cleanPreview(" a\n  b "), "a b");
  assert.equal(textFromContent([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "shown" }]), "shown");
  assert.equal(idForPath("C:/one"), idForPath("C:/one"));
  assert.notEqual(idForPath("C:/one"), idForPath("C:/two"));
});
