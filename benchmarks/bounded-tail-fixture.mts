import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

export const MAX_TAIL_FIXTURE_BYTES = 512 * 1024 * 1024;
export const RECENT_FIXTURE_TURNS = 60;
const HISTORY_PAYLOAD_BYTES = 256 * 1024;

export interface TailFixtureManifest {
  schemaVersion: 1;
  fixtureName: "bounded-tail.jsonl";
  layout: "padded-history-small-recent-turns";
  minimumBytes: number;
  bytes: number;
  records: number;
  messages: number;
  userTurns: number;
  recentTurns: number;
  contentSha256: string;
}

/** Streaming synthetic history: large old replies followed by a small recent suffix. */
export async function generateBoundedTailFixture(path: string, minimumBytes: number): Promise<TailFixtureManifest> {
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 1 || minimumBytes > MAX_TAIL_FIXTURE_BYTES) {
    throw new Error("Fixture minimumBytes must be an integer from 1 through 512 MiB");
  }
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "w");
  const hash = createHash("sha256");
  let bytes = 0;
  let records = 0;
  let turns = 0;
  let parentId: string | null = null;
  const append = async (record: Record<string, unknown>) => {
    const line = Buffer.from(JSON.stringify(record) + String.fromCharCode(10));
    await file.writeFile(line);
    hash.update(line);
    bytes += line.length;
    records += 1;
  };
  const appendTurn = async (reply: string) => {
    const userId = `user-${turns}`;
    const assistantId = `assistant-${turns}`;
    const timestamp = Date.UTC(2026, 0, 1) + turns * 1000;
    await append({ type: "message", id: userId, parentId, timestamp,
      message: { role: "user", content: `Synthetic question ${turns}`, timestamp } });
    await append({ type: "message", id: assistantId, parentId: userId, timestamp,
      message: { role: "assistant", content: reply, timestamp, stopReason: "stop" } });
    parentId = assistantId;
    turns += 1;
  };
  try {
    await append({ type: "session", version: 3, id: "bench-bounded-tail",
      timestamp: "2026-01-01T00:00:00.000Z", cwd: "/pi-chat-benchmark/fixture-workspace" });
    await append({ type: "session_info", name: "Bounded tail benchmark" });
    const payload = "h".repeat(HISTORY_PAYLOAD_BYTES);
    while (bytes < minimumBytes) await appendTurn(payload);
    for (let turn = 0; turn < RECENT_FIXTURE_TURNS; turn += 1) {
      await appendTurn(`Small recent reply ${turn}`);
    }
  } finally {
    await file.close();
  }
  return {
    schemaVersion: 1, fixtureName: "bounded-tail.jsonl",
    layout: "padded-history-small-recent-turns", minimumBytes, bytes, records,
    messages: turns * 2, userTurns: turns, recentTurns: RECENT_FIXTURE_TURNS,
    contentSha256: hash.digest("hex"),
  };
}
