import assert from "node:assert/strict";
import test from "node:test";
import { recentSessionWorkspaces } from "../src/web/lib/session-workspaces";

test("recent Session workspaces are ordered, deduplicated, and bounded", () => {
  const workspaces = recentSessionWorkspaces([
    { cwd: " C:/older ", updatedAt: 10 },
    { cwd: "D:/research", updatedAt: 20, lastUserPromptAt: 50 },
    { cwd: "d:\\RESEARCH\\", updatedAt: 60 },
    { cwd: "C:/newest", updatedAt: 40, lastUserPromptAt: 70 },
    { cwd: "", updatedAt: 100 },
  ], 2);

  assert.deepEqual(workspaces, ["C:/newest", "d:\\RESEARCH\\"]);
});

test("a non-positive workspace option limit returns no paths", () => {
  assert.deepEqual(recentSessionWorkspaces([{ cwd: "C:/work", updatedAt: 1 }], 0), []);
});
