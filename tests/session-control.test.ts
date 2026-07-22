import assert from "node:assert/strict";
import test from "node:test";
import { SessionControl, SessionControlConflictError } from "../src/server/session-control.ts";

test("controlState hides grace and ghost foreign owners from the observing banner", () => {
  const control = new SessionControl({
    controllerReleaseMs: 50,
    onControlChanged: () => {},
  });
  const sessionId = "aaaaaaaaaaaaaaaaaaaa";
  const owner = "11111111-1111-4111-8111-111111111111";
  const observer = "22222222-2222-4222-8222-222222222222";

  control.clientConnected(owner);
  control.setController(sessionId, owner);
  assert.deepEqual(control.controlState(sessionId, observer), {
    controlOwner: owner,
    controlledByThisWindow: false,
  });

  // SSE dropped: owner enters grace. Banner must not flash for the other window.
  control.clientDisconnected(owner);
  assert.deepEqual(control.controlState(sessionId, observer), { controlledByThisWindow: false });
  // Self still sees ownership while held.
  assert.deepEqual(control.controlState(sessionId, owner), {
    controlOwner: owner,
    controlledByThisWindow: true,
  });
});

test("sole live window claims over a ghost foreign owner without takeover", () => {
  const control = new SessionControl({
    controllerReleaseMs: 5_000,
    onControlChanged: () => {},
  });
  const sessionId = "bbbbbbbbbbbbbbbbbbbb";
  const ghost = "11111111-1111-4111-8111-111111111111";
  const alone = "22222222-2222-4222-8222-222222222222";

  control.sessionControllers.set(sessionId, ghost);
  control.clientConnected(alone);
  control.markViewed(alone, sessionId);

  assert.equal(control.sessionControllers.get(sessionId), alone);
  assert.deepEqual(control.controlState(sessionId, alone), {
    controlOwner: alone,
    controlledByThisWindow: true,
  });
  assert.doesNotThrow(() => control.requireControl(sessionId, alone));
});

test("two live windows still enforce exclusive control", () => {
  const control = new SessionControl({ onControlChanged: () => {} });
  const sessionId = "cccccccccccccccccccc";
  const owner = "11111111-1111-4111-8111-111111111111";
  const observer = "22222222-2222-4222-8222-222222222222";

  control.clientConnected(owner);
  control.clientConnected(observer);
  control.setController(sessionId, owner);

  assert.throws(
    () => control.requireControl(sessionId, observer),
    (error: unknown) => error instanceof SessionControlConflictError,
  );

  control.setController(sessionId, observer);
  assert.deepEqual(control.controlState(sessionId, observer), {
    controlOwner: observer,
    controlledByThisWindow: true,
  });
});

test("API clients without SSE still use exclusive ownership until takeover", () => {
  const control = new SessionControl({ onControlChanged: () => {} });
  const sessionId = "dddddddddddddddddddd";
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";

  control.requireControl(sessionId, first);
  assert.throws(
    () => control.requireControl(sessionId, second),
    (error: unknown) => error instanceof SessionControlConflictError,
  );
  control.setController(sessionId, second);
  assert.doesNotThrow(() => control.requireControl(sessionId, second));
});

test("sole live SSE window may claim during foreign grace without banner", () => {
  const control = new SessionControl({
    controllerReleaseMs: 5_000,
    onControlChanged: () => {},
  });
  const sessionId = "eeeeeeeeeeeeeeeeeeee";
  const owner = "11111111-1111-4111-8111-111111111111";
  const alone = "22222222-2222-4222-8222-222222222222";

  control.clientConnected(owner);
  control.setController(sessionId, owner);
  control.clientDisconnected(owner);
  control.clientConnected(alone);

  assert.deepEqual(control.controlState(sessionId, alone), { controlledByThisWindow: false });
  assert.doesNotThrow(() => control.requireControl(sessionId, alone));
  assert.equal(control.sessionControllers.get(sessionId), alone);
});

test("SSE lease expiry clears ownership after grace", async () => {
  const control = new SessionControl({
    controllerReleaseMs: 15,
    onControlChanged: () => {},
  });
  const sessionId = "ffffffffffffffffffff";
  const owner = "11111111-1111-4111-8111-111111111111";
  const next = "22222222-2222-4222-8222-222222222222";

  control.clientConnected(owner);
  control.setController(sessionId, owner);
  control.clientDisconnected(owner);
  assert.equal(control.sessionControllers.get(sessionId), owner);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(control.sessionControllers.has(sessionId), false);
  assert.doesNotThrow(() => control.requireControl(sessionId, next));
});
