import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionIndex } from "../src/server/session-index.js";

export async function measureIndexScale(sessionCount: number, toolPairs: number) {
  if (!Number.isInteger(sessionCount) || sessionCount < 1 || sessionCount > 2000 || !Number.isInteger(toolPairs) || toolPairs < 0 || toolPairs > 2000)
    throw new Error("sessions must be 1..2000 and toolPairs 0..2000");
  if (typeof global.gc !== "function") throw new Error("Run with node --expose-gc; retained-heap comparisons require explicit GC.");
  const root = await mkdtemp(join(tmpdir(), "pi-chat-index-scale-"));
  const row = (value: unknown) => JSON.stringify(value) + "\n";
  let sourceBytes = 0;
  try {
    for (let n = 0; n < sessionCount; n++) {
      const lines = [row({ type: "session", id: `session-${n}`, cwd: root }), row({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "synthetic scale fixture", timestamp: 1000 } })];
      let parent = "u1";
      for (let i = 0; i < toolPairs; i++) {
        const id = `a${i}`, result = `t${i}`;
        lines.push(row({ type: "message", id, parentId: parent, message: { role: "assistant", timestamp: 2000 + i * 2, content: [{ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: "synthetic.txt" } }] } }));
        lines.push(row({ type: "message", id: result, parentId: id, message: { role: "toolResult", timestamp: 2001 + i * 2, toolCallId: `call-${i}`, toolName: "read", content: "fixture output ".repeat(8) } }));
        parent = result;
      }
      const text = lines.join("");
      sourceBytes += Buffer.byteLength(text);
      await writeFile(join(root, `session-${n}.jsonl`), text);
    }
    global.gc();
    const before = process.memoryUsage();
    const index = new SessionIndex(root, join(root, "metadata-cache.json"));
    const started = performance.now();
    const initial = await index.list();
    const initialMs = performance.now() - started;
    if (initial.length !== sessionCount || initial.some(s => s.messageCount !== 1 + 2 * toolPairs)) throw new Error("Fixture summary mismatch");
    const refreshMs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const summaries = await index.list();
      refreshMs.push(performance.now() - start);
      if (summaries.length !== sessionCount) throw new Error("Refresh lost a Session");
    }
    global.gc();
    const after = process.memoryUsage();
    // Keep the index reachable through measurement; this is retained cache
    // cost, not memory after dropping the entire service-owned object.
    if (index.snapshot()?.length !== sessionCount) throw new Error("Missing retained inventory");
    const hashes: Record<string, string> = {};
    for (const name of ["session-index.ts", "session-projection.ts"])
      hashes[name] = createHash("sha256").update(await readFile(new URL(`../src/server/${name}`, import.meta.url))).digest("hex");
    return { schemaVersion: 1, node: process.version, platform: process.platform, sessionCount, toolPairs,
      records: sessionCount * (2 + 2 * toolPairs), sourceBytes, initialMs, unchangedRefreshMs: refreshMs,
      heapUsedBefore: before.heapUsed, heapUsedAfter: after.heapUsed, retainedHeapDelta: after.heapUsed - before.heapUsed,
      rssAfter: after.rss, sourceHashes: hashes,
      scope: "Synthetic private-temp SessionIndex inventory only; includes outline and summary caches, not a leak proof or production threshold." };
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await measureIndexScale(Number(process.argv[2] || 200), Number(process.argv[3] || 50));
  console.log(JSON.stringify(result, null, 2));
}
