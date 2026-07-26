import assert from "node:assert/strict";
import test from "node:test";
import { refreshFailureKeepsCommittedView, sidebarNavigationBlocked } from "../src/web/lib/refresh-navigation-guards";

test("background view failures preserve an already committed conversation", () => {
  assert.equal(refreshFailureKeepsCommittedView(new Error("Pi Chat 请求超时（65 秒）"), "session-a"), true);
  assert.equal(refreshFailureKeepsCommittedView(new Error("Pi RPC 查询仍在处理中"), "session-a"), true);
  assert.equal(refreshFailureKeepsCommittedView(new Error("会话不存在"), "session-a"), false);
  assert.equal(refreshFailureKeepsCommittedView(new Error("timeout"), ""), false);
});

test("an orphaned blank view can escape a stale global busy state through the sidebar", () => {
  assert.equal(sidebarNavigationBlocked(false, false, true, true), true);
  assert.equal(sidebarNavigationBlocked(false, false, true, false), false);
  assert.equal(sidebarNavigationBlocked(true, false, false, false), true);
  assert.equal(sidebarNavigationBlocked(false, true, false, false), true);
});
