import assert from "node:assert/strict";
import test from "node:test";
import { createSessionNavigationActions } from "../../src/web/application/session-navigation-actions";

test("session navigation actions preserve the App-owned address map and open verified children", () => {
  const addresses = new Map<string, { parentSessionId: string; label: string }>();
  const forgotten: string[] = [];
  const navigated: Array<[string, string | undefined]> = [];
  const actions = createSessionNavigationActions({
    addresses,
    forgetCurrent: (sessionId) => forgotten.push(sessionId),
    navigate: (sessionId, label) => navigated.push([sessionId, label]),
  });

  actions.openSubagentSession("parent", "0123456789abcdef0123", "Child");

  assert.deepEqual(addresses.get("0123456789abcdef0123"), {
    parentSessionId: "parent",
    label: "Child",
  });
  assert.deepEqual(forgotten, ["0123456789abcdef0123"]);
  assert.deepEqual(navigated, [["0123456789abcdef0123", "Child"]]);
});

test("session navigation actions reject malformed ancestor IDs without touching authority", () => {
  const addresses = new Map<string, { parentSessionId: string; label: string }>();
  let navigations = 0;
  const actions = createSessionNavigationActions({
    addresses,
    forgetCurrent: () => {},
    navigate: () => { navigations += 1; },
  });

  actions.navigateSubagentAncestor("not-a-session-id", "Ancestor");

  assert.equal(navigations, 0);
});
