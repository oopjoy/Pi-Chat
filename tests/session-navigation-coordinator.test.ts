import assert from "node:assert/strict";
import test from "node:test";
import { SessionNavigationCoordinator } from "../src/web/application/session-navigation-coordinator";

test("navigation coordinator advances intent before aborting stale work", () => {
  const coordinator = new SessionNavigationCoordinator();
  const first = coordinator.begin("session-a", 10);
  assert.equal(coordinator.navigationEpochRef.current, 1);
  assert.equal(coordinator.desiredSessionIdRef.current, "session-a");
  assert.equal(coordinator.navigationStartedAtRef.current.get(1), 10);

  const second = coordinator.begin("session-b", 20);
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(coordinator.navigationEpochRef.current, 2);
  assert.equal(coordinator.desiredSessionIdRef.current, "session-b");
  assert.equal(coordinator.consumeStartedAt(1), undefined);
  assert.equal(coordinator.consumeStartedAt(2), 20);
  assert.equal(coordinator.consumeStartedAt(2), undefined);
  coordinator.finish(2, second.controller);
  assert.equal(coordinator.navigationAbortRef.current, null);
});

test("invalidating cancellation returns intent to the committed pane", () => {
  const coordinator = new SessionNavigationCoordinator();
  const navigation = coordinator.begin("session-b", 10);
  coordinator.cancel(true, "session-a");
  assert.equal(navigation.controller.signal.aborted, true);
  assert.equal(coordinator.navigationEpochRef.current, 2);
  assert.equal(coordinator.desiredSessionIdRef.current, "session-a");
  assert.equal(coordinator.navigationStartedAtRef.current.size, 0);
});

test("non-invalidating cancellation aborts transport without changing navigation intent", () => {
  const coordinator = new SessionNavigationCoordinator();
  const navigation = coordinator.begin("session-b", 10);
  coordinator.cancel(false, "session-a");
  assert.equal(navigation.controller.signal.aborted, true);
  assert.equal(coordinator.navigationEpochRef.current, 1);
  assert.equal(coordinator.desiredSessionIdRef.current, "session-b");
});
