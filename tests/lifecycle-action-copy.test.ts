import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleActionHoldReason } from "../src/web/lib/lifecycle-action-copy";

const idle = {
  running: false,
  queued: false,
  pendingConfirmation: false,
  busy: false,
  lifecycleBlocked: false,
};

test("lifecycle hold copy prefers generating, then confirmation, then queue", () => {
  assert.equal(lifecycleActionHoldReason("关闭", idle), null);
  assert.equal(
    lifecycleActionHoldReason("重启", { ...idle, running: true, queued: true }),
    "有对话正在生成，结束后才能重启",
  );
  assert.equal(
    lifecycleActionHoldReason("关闭", { ...idle, pendingConfirmation: true, queued: true }),
    "有对话正在等待确认，处理后再关闭",
  );
  assert.equal(
    lifecycleActionHoldReason("关闭", { ...idle, queued: true }),
    "有待发送的消息，结束后才能关闭",
  );
  assert.equal(
    lifecycleActionHoldReason("重启", { ...idle, busy: true }),
    "Pi Chat 正在执行其他操作，请稍候再重启",
  );
  assert.equal(
    lifecycleActionHoldReason("关闭", { ...idle, loading: true }),
    "正在加载，请稍候再关闭",
  );
});
