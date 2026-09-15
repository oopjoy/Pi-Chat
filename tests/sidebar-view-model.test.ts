import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../src/shared/types";
import {
  buildSidebarViewModel,
  sidebarSessionStatus,
  sidebarWorkspaceResetRequired,
} from "../src/web/application/sidebar-view-model";

const session = (id: string, cwd: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  sessionId: id,
  name: id,
  preview: "",
  cwd,
  updatedAt: 1,
  messageCount: 1,
  ...patch,
});

test("sidebar view model projects search, collapsed visibility, and pin membership without mutation", () => {
  const sessions = [
    session("alpha", "C:/work"),
    session("beta", "D:/archive"),
  ];
  const model = buildSidebarViewModel({
    sessions,
    sessionDirectories: [
      { cwd: "C:/work", count: 1, lastUserPromptAt: 1 },
      { cwd: "D:/archive", count: 1, lastUserPromptAt: 1 },
    ],
    workspaceCwd: "C:/work",
    searchQuery: "alpha",
    pinnedSessionIds: ["alpha"],
    pinnedDirectoryKeys: [],
    collapsedDirectoryKeys: ["C:/work"],
    expandedDirectoryKeys: [],
  });

  assert.equal(model.searching, true);
  assert.equal(model.visibleSessionCount, 1);
  assert.equal(model.visibleSessionIds.has("alpha"), true, "search expands the matching group");
  assert.equal(model.visibleSessionIds.has("beta"), false);
  assert.equal(model.pinnedSessionIds.has("alpha"), true);
  assert.deepEqual(sessions.map((entry) => entry.id), ["alpha", "beta"]);
});

test("sidebar selector keeps status and workspace-reset policy deterministic", () => {
  assert.deepEqual(
    sidebarSessionStatus(session("queued", "C:/work", { activity: { execution: "queued", awaitingConfirmation: false } }), false, false),
    { kind: "running", label: "消息等待自动执行" },
  );
  assert.equal(
    sidebarWorkspaceResetRequired(
      { cwd: "C:/before", epoch: "epoch-a", revision: 1 },
      { cwd: "D:/after", epoch: "epoch-a", revision: 2 },
    ),
    true,
  );
});
