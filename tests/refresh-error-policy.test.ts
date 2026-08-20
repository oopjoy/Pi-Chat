import assert from "node:assert/strict";
import test from "node:test";
import {
  recoverableRefreshError,
  surfaceAutomaticRefreshError,
} from "../src/web/lib/refresh-error-policy.js";

test("a background read timeout stays quiet when conversation state is already readable", () => {
  const message = "Pi Chat 请求超时（65 秒）。Pi 可能正在压缩上下文或模型服务没有响应";
  assert.equal(recoverableRefreshError(message), true);
  assert.equal(surfaceAutomaticRefreshError(message, true), false);
});

test("initial startup still surfaces a timeout when nothing readable exists", () => {
  assert.equal(
    surfaceAutomaticRefreshError("Pi Chat 请求超时（65 秒）", false),
    true,
  );
});

test("non-recoverable automatic refresh failures remain visible", () => {
  assert.equal(
    surfaceAutomaticRefreshError("Session Index 数据损坏", true),
    true,
  );
});
