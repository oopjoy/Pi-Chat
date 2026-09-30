import assert from "node:assert/strict";
import test from "node:test";
import { applyModelFileTransaction } from "../../src/server/services/model-file-transaction";

test("model file transaction refreshes catalogue after commit", async () => {
  const calls: string[] = [];
  const result = await applyModelFileTransaction({
    snapshot: async () => ({ path: "models.json", data: "old" } as never),
    restore: async () => { calls.push("restore"); },
    invalidateCatalogue: () => { calls.push("invalidate"); },
    rethrowResultPending: (error) => { throw error; },
  }, "models", async () => { calls.push("mutation"); return 7; });
  assert.equal(result, 7);
  assert.deepEqual(calls, ["mutation", "invalidate"]);
});

test("model file transaction restores after a committed mutation fails", async () => {
  const calls: string[] = [];
  let invalidations = 0;
  await assert.rejects(
    () => applyModelFileTransaction({
      snapshot: async () => ({ path: "models.json", data: "old" } as never),
      restore: async () => { calls.push("restore"); },
      invalidateCatalogue: () => {
        calls.push("invalidate");
        invalidations += 1;
        if (invalidations === 1) throw new Error("refresh failed");
      },
      rethrowResultPending: (error) => { throw error; },
    }, "models", async () => { calls.push("mutation"); return 1; }),
    /模型配置失败/,
  );
  assert.deepEqual(calls, ["mutation", "invalidate", "restore", "invalidate"]);
});
