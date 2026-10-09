import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import test from "node:test";
import { measureIndexScale } from "../benchmarks/run-index-scale-bench.mts";

const execute = promisify(execFile);
test("index scale benchmark rejects unbounded fixture sizes", async () => {
  await assert.rejects(measureIndexScale(0, 1), /sessions must/);
  await assert.rejects(measureIndexScale(2001, 1), /sessions must/);
  await assert.rejects(measureIndexScale(1, 2001), /toolPairs/);
});

test("index scale benchmark measures a private synthetic inventory and emits metadata only", async () => {
  const root = resolve(import.meta.dirname, "..");
  const { stdout } = await execute(process.execPath, ["--expose-gc", "--import", "tsx", "benchmarks/run-index-scale-bench.mts", "2", "1"], { cwd: root, timeout: 20000 });
  const result = JSON.parse(stdout) as { sessionCount: number; records: number; sourceBytes: number; unchangedRefreshMs: number[]; sourceHashes: Record<string, string>; scope: string };
  assert.equal(result.sessionCount, 2);
  assert.equal(result.records, 8);
  assert.ok(result.sourceBytes > 0);
  assert.equal(result.unchangedRefreshMs.length, 3);
  assert.ok(Object.values(result.sourceHashes).every(hash => /^[a-f0-9]{64}$/.test(hash)));
  assert.match(result.scope, /not a leak proof/);
  assert.doesNotMatch(stdout, /pi-chat-index-scale-[A-Za-z0-9]{6}/);
});
