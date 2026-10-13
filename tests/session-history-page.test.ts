import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { readSessionHistoryPage, SESSION_TAIL_MAX_RETAINED_BYTES, SessionIndex } from "../src/server/session-index";

function message(id: string, parentId: string | null, role: string, content: string) {
  return { type: "message", id, parentId, message: { role, content, timestamp: 1 } };
}

async function fixture(entries: object[]) {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-history-page-"));
  const path = join(root, "history.jsonl");
  await writeFile(path, entries.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return { path, close: () => rm(root, { recursive: true, force: true }) };
}

test("an environment-selected Session root keeps its index cache inside that root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-index-isolation-"));
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = root;
    const index = new SessionIndex();
    assert.equal(index.root, root);
    assert.equal(index.cachePath, join(root, ".pi-chat-session-index.json"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Session outline keeps history connected through a naming entry", async () => {
  const f = await fixture([
    { type: "session", id: "session", version: 3 },
    message("u1", null, "user", "before rename"), message("a1", "u1", "assistant", "answer"),
    { type: "session_info", id: "rename", parentId: "a1", name: "Renamed session" },
    message("u2", "rename", "user", "after rename"), message("a2", "u2", "assistant", "answer"),
  ]);
  try {
    const index = new SessionIndex(dirname(f.path));
    const summary = (await index.list())[0];
    assert.equal(summary.turnCount, 2, "session_info is metadata, but its parent link remains part of the branch");
    assert.equal(summary.messageCount, 4);
    const cachePath = join(dirname(f.path), ".pi-chat-session-index.json");
    const oldCache = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(oldCache.version, 7);
    oldCache.version = 6;
    for (const entry of Object.values(oldCache.entries) as Array<{ summary: { turnCount: number } }>) entry.summary.turnCount = 1;
    await writeFile(cachePath, JSON.stringify(oldCache), "utf8");
    const reopened = new SessionIndex(dirname(f.path));
    assert.equal((await reopened.list())[0].turnCount, 2, "pre-fix cache totals must not survive a restart");
    const page = await readSessionHistoryPage(f.path, "u2:0", 10);
    assert.deepEqual(page?.messages.map(row => row.piChatPersistedMessageId), ["u1:0", "a1:0"]);
  } finally { await f.close(); }
});

test("history pages follow the active parent chain rather than adjacent discarded branch records", async () => {
  const f = await fixture([
    { type: "session", id: "session", version: 3 },
    message("u1", null, "user", "first"), message("a1", "u1", "assistant", "first answer"),
    message("discarded-user", "a1", "user", "other branch"), message("discarded-answer", "discarded-user", "assistant", "other answer"),
    message("u2", "a1", "user", "second"), message("a2", "u2", "assistant", "second answer"),
    message("u3", "a2", "user", "third"), message("a3", "u3", "assistant", "third answer"),
  ]);
  try {
    const page = await readSessionHistoryPage(f.path, "u3:0", 1);
    assert.ok(page);
    assert.deepEqual(page.messages.map(row => row.piChatPersistedMessageId), ["u2:0", "a2:0"]);
    assert.equal(page.turnTotal, 3);
    assert.equal(page.messagesTruncated, true);
    const oldest = await readSessionHistoryPage(f.path, "u2:0", 1);
    assert.ok(oldest);
    assert.deepEqual(oldest.messages.map(row => row.piChatPersistedMessageId), ["u1:0", "a1:0"]);
    assert.equal(oldest.messagesTruncated, false);
    assert.equal(await readSessionHistoryPage(f.path, "discarded-user:0", 10), null);
  } finally { await f.close(); }
});

test("history pages advance across the retained-byte limit without losing older turns", async () => {
  const entries: object[] = [{ type: "session", id: "session", version: 3 }];
  let parent: string | null = null;
  const expected: string[] = [];
  for (let i = 1; i <= 5; i++) {
    entries.push(message(`u${i}`, parent, "user", `turn ${i}`));
    entries.push(message(`t${i}`, `u${i}`, "toolResult", "x".repeat(3 * 1024 * 1024)));
    parent = `t${i}`;
    expected.push(`u${i}:0`, `t${i}:0`);
  }
  entries.push(message("boundary", parent, "user", "current turn"));
  const f = await fixture(entries);
  try {
    let before = "boundary:0";
    let collected: string[] = [];
    let pages = 0;
    for (;;) {
      const page = await readSessionHistoryPage(f.path, before, 10);
      assert.ok(page);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= SESSION_TAIL_MAX_RETAINED_BYTES);
      const ids = page.messages.map(row => row.piChatPersistedMessageId!);
      assert.ok(ids.length > 0, "each bounded page makes progress");
      collected = [...ids, ...collected];
      pages++;
      if (!page.messagesTruncated) break;
      before = ids[0];
      assert.ok(pages < 10);
    }
    assert.ok(pages > 1);
    assert.deepEqual(collected, expected);
  } finally { await f.close(); }
});

test("a single over-budget history record fails explicitly instead of claiming end of history", async () => {
  const f = await fixture([
    message("u1", null, "user", "older"),
    message("large", "u1", "toolResult", "x".repeat(SESSION_TAIL_MAX_RETAINED_BYTES)),
    message("u2", "large", "user", "newest"),
  ]);
  try {
    await assert.rejects(readSessionHistoryPage(f.path, "u2:0", 10), /单条历史记录超过分页显示上限/);
  } finally { await f.close(); }
});

test("history pages refuse ambiguous entry identities and unknown boundaries", async () => {
  const f = await fixture([message("same", null, "user", "one"), message("same", null, "user", "two")]);
  try {
    await assert.rejects(readSessionHistoryPage(f.path, "same:0", 10), /重复|ambiguous/);
    assert.equal(await readSessionHistoryPage(f.path, "invalid", 10), null);
  } finally { await f.close(); }
});
