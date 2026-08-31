import assert from "node:assert/strict";
import test from "node:test";
import {
  composerWaitStatus,
  runtimePreparationForDisplay,
} from "../src/web/lib/composer-wait-status.ts";

const status = (overrides: Partial<Parameters<typeof composerWaitStatus>[0]> = {}) =>
  composerWaitStatus({
    isStreaming: false,
    pendingSubmissions: 1,
    viewSwitching: false,
    runtimePreparing: false,
    compacting: false,
    subagentTargetUnavailable: false,
    ...overrides,
  });

test("Runtime preparation display distinguishes cold capability from active admission", () => {
  assert.equal(
    runtimePreparationForDisplay({
      localDraft: false,
      runtimeStatus: "active",
      warming: false,
      primaryStatus: "ready",
    }),
    false,
  );
  assert.equal(
    runtimePreparationForDisplay({
      localDraft: false,
      runtimeStatus: "active",
      warming: true,
      primaryStatus: "ready",
    }),
    true,
  );
  assert.equal(
    runtimePreparationForDisplay({
      localDraft: false,
      runtimeStatus: "restoring",
      warming: false,
      primaryStatus: "ready",
    }),
    true,
  );
  assert.equal(
    runtimePreparationForDisplay({
      localDraft: true,
      runtimeStatus: "draft",
      warming: false,
      primaryStatus: "starting",
    }),
    true,
  );
  assert.equal(
    runtimePreparationForDisplay({
      localDraft: false,
      runtimeStatus: "active",
      warming: false,
      primaryStatus: "ready",
      draftSubmissionBusy: true,
    }),
    false,
  );
  assert.equal(
    runtimePreparationForDisplay({
      localDraft: true,
      runtimeStatus: "draft",
      warming: false,
      primaryStatus: "ready",
      draftSubmissionBusy: true,
    }),
    true,
  );
  assert.equal(
    runtimePreparationForDisplay({
      localDraft: true,
      runtimeStatus: "draft",
      warming: false,
      primaryStatus: "ready",
    }),
    false,
  );
});

test("Composer wait status explains each retained-submission boundary", () => {
  assert.match(status({ viewSwitching: true }), /等待会话切换完成后自动发送/);
  assert.match(status({ runtimePreparing: true }), /准备 Pi Runtime.*准备完成后自动发送/);
  assert.match(status({ compacting: true }), /压缩上下文.*压缩完成后自动发送/);
  assert.match(status({ subagentTargetUnavailable: true }), /父对话地址尚未验证.*验证恢复后自动发送/);
  assert.match(status(), /消息已提交.*等待 Pi 处理/);
});

test("Composer wait status does not duplicate ordinary streaming or compaction activity", () => {
  assert.equal(status({ isStreaming: true, pendingSubmissions: 0 }), "");
  assert.equal(status({ compacting: true, pendingSubmissions: 0 }), "");
  assert.equal(
    status({ runtimePreparing: true, pendingSubmissions: 0 }),
    "正在准备 Pi Runtime…",
  );
  assert.equal(status({ pendingSubmissions: 0 }), "");
});
