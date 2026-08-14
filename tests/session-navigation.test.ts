import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../src/shared/types";
import {
  filterSessionsBySearch,
  groupSessionsForNavigation,
  normalizeCwdKey,
  orderedPinnedSessionIds,
  orderSessionsByPins,
  togglePinnedSession,
} from "../src/web/lib/session-navigation";

const session = (id: string, name: string, preview: string, cwd: string): SessionSummary => ({
  id,
  sessionId: id,
  name,
  preview,
  cwd,
  updatedAt: 0,
  messageCount: 1,
  active: false,
});

const sessions = [
  session("a", "Alpha", "first preview", "C:/work/one"),
  session("b", "Beta", "second preview", "C:/work/two"),
  session("c", "Gamma", "third preview", "D:/other"),
];

test("pin ordering is stable and newly pinned sessions move to the front", () => {
  assert.deepEqual(togglePinnedSession(["b"], "c"), ["c", "b"]);
  assert.deepEqual(togglePinnedSession(["c", "b"], "c"), ["b"]);
  assert.deepEqual(orderSessionsByPins(sessions, ["c", "a"]).map((item) => item.id), ["c", "a", "b"]);
  assert.deepEqual(orderSessionsByPins(sessions, ["missing", "b"]).map((item) => item.id), ["b", "a", "c"]);
});

test("session search matches name, preview and cwd case-insensitively", () => {
  assert.deepEqual(filterSessionsBySearch(sessions, " alpha ").map((item) => item.id), ["a"]);
  assert.deepEqual(filterSessionsBySearch(sessions, "SECOND").map((item) => item.id), ["b"]);
  assert.deepEqual(filterSessionsBySearch(sessions, "d:/other").map((item) => item.id), ["c"]);
  assert.equal(filterSessionsBySearch(sessions, "missing").length, 0);
  assert.equal(filterSessionsBySearch(sessions, "").length, 3);
});

test("stored pin IDs are bounded, trimmed and deduplicated", () => {
  assert.deepEqual(orderedPinnedSessionIds([" a ", "a", "", 3, "b"]), ["a", "b"]);
  assert.deepEqual(orderedPinnedSessionIds(null), []);
});

test("directory groups keep directory pins outside session pins and normalize Windows cwd", () => {
  const mixed = [
    session("a", "A", "", "D:/Other"),
    session("b", "B", "", "C:\\Work\\Project\\"),
    session("c", "C", "", "d:/other"),
    session("d", "D", "", "C:/Work/Project"),
  ];
  const groups = groupSessionsForNavigation(mixed, ["d", "c"], ["c:/work/project"], [], "");
  assert.equal(normalizeCwdKey("C:\\Work\\Project\\"), "c:/work/project");
  assert.equal(normalizeCwdKey("//SERVER//Share/"), "//server/share");
  assert.equal(normalizeCwdKey("/Case/Kept/"), "/Case/Kept");
  assert.deepEqual(groups.map((group) => group.key), ["c:/work/project", "d:/other"]);
  assert.deepEqual(groups[0].sessions.map((item) => item.id), ["d", "b"]);
  assert.deepEqual(groups[1].sessions.map((item) => item.id), ["c", "a"]);
});

test("missing-cwd directories keep their real total and raw read key", () => {
  const unknown = Array.from({ length: 15 }, (_, index) =>
    session(`unknown-${index}`, `Unknown ${index}`, "", ""),
  );
  const [group] = groupSessionsForNavigation(
    unknown,
    [],
    [],
    [],
    "",
    [{ cwd: "", count: 25, lastUserPromptAt: 1 }],
  );
  assert.equal(group.key, "__unknown_cwd__");
  assert.equal(group.cwd, "");
  assert.equal(group.label, "未记录工作目录");
  assert.equal(group.total, 25);
  assert.equal(group.sessions.length, 15);
});

test("search opens collapsed matching directories without changing their stored state", () => {
  const groups = groupSessionsForNavigation(sessions, [], [], ["c:/work/one"], "alpha");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].collapsed, false);
  assert.equal(groups[0].key, "c:/work/one");
  const collapsed = groupSessionsForNavigation(sessions, [], [], ["c:/work/one"], "");
  assert.equal(collapsed.find((group) => group.key === "c:/work/one")?.collapsed, true);
});
