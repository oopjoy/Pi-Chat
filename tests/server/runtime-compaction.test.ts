import assert from "node:assert/strict";
import test from "node:test";
import { compactRuntime } from "../../src/server/services/runtime-compaction";

test("compaction rejects existing outcome fences before writing RPC", async () => {
  const result = await compactRuntime({
    outcomePending: () => true,
    busy: () => assert.fail("fence must win before busy check"),
    newOutcomeToken: () => assert.fail("fence must not allocate a token"),
    sendCompact: async () => assert.fail("fence must not write RPC"),
    outcomeUnknown: () => false,
    markOutcomePending: () => {},
    markUncertainCompaction: () => {},
    broadcastActivity: () => {},
    rethrowResultPending: () => { throw new Error("unexpected"); },
  }, "ignored");
  assert.deepEqual(result, {
    kind: "conflict",
    error: "上一次操作结果尚未确认；请刷新页面核对，不要重复压缩",
    code: "RESULT_PENDING",
  });
});

test("compaction sends a minimal or instructed command through the stable target", async () => {
  const commands: Record<string, unknown>[] = [];
  const result = await compactRuntime({
    outcomePending: () => false,
    busy: () => false,
    newOutcomeToken: () => "token",
    sendCompact: async (command, token) => {
      assert.equal(token, "token");
      commands.push(command);
      return { compacted: true };
    },
    outcomeUnknown: () => false,
    markOutcomePending: () => {},
    markUncertainCompaction: () => {},
    broadcastActivity: () => {},
    rethrowResultPending: () => { throw new Error("unexpected"); },
  }, " keep recent code ");
  assert.deepEqual(commands, [{ type: "compact", customInstructions: " keep recent code " }]);
  assert.deepEqual(result, { kind: "success", result: { compacted: true } });
});

test("unknown compaction outcome fences only after the RPC write is uncertain", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => compactRuntime({
      outcomePending: () => false,
      busy: () => false,
      newOutcomeToken: () => "token",
      sendCompact: async () => { throw new Error("timeout"); },
      outcomeUnknown: () => true,
      markOutcomePending: (_, token) => calls.push(`pending:${token}`),
      markUncertainCompaction: () => calls.push("uncertain"),
      broadcastActivity: () => calls.push("activity"),
      rethrowResultPending: () => { throw new Error("result pending"); },
    }, ""),
    /result pending/,
  );
  assert.deepEqual(calls, ["pending:token", "uncertain", "activity"]);
});
