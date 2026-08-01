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
  control.noteClientPresence(owner);
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

test("a frozen foreign EventSource stops blocking a visible window after foreground lease expiry", () => {
  let now = 0;
  const control = new SessionControl({
    controllerReleaseMs: 5_000,
    presenceTtlMs: 50,
    now: () => now,
    onControlChanged: () => {},
  });
  const sessionId = "abababababababababab";
  const frozen = "11111111-1111-4111-8111-111111111111";
  const visible = "22222222-2222-4222-8222-222222222222";

  control.clientConnected(frozen);
  control.clientConnected(visible);
  control.noteClientPresence(frozen);
  control.noteClientPresence(visible);
  control.markViewed(frozen, sessionId);
  control.setController(sessionId, frozen);
  assert.deepEqual(control.controlState(sessionId, visible), {
    controlOwner: frozen,
    controlledByThisWindow: false,
  });

  // The visible page renews while an old frozen renderer keeps only its socket.
  now = 30;
  control.noteClientPresence(visible);
  now = 60;

  assert.deepEqual(control.controlState(sessionId, visible), { controlledByThisWindow: false });
  assert.equal(control.viewedSessionsByClient.get(frozen), sessionId, "presence expiry must not alter the separate viewed-session pin");
  assert.doesNotThrow(() => control.requireControl(sessionId, visible));
  assert.equal(control.sessionControllers.get(sessionId), visible);
  control.clear();
});

test("multiple fresh observers retain an explicit takeover path until stale ownership expires", async () => {
  let now = 0;
  const control = new SessionControl({
    presenceTtlMs: 20,
    now: () => now,
    onControlChanged: () => {},
  });
  const sessionId = "adadadadadadadadadad";
  const frozen = "11111111-1111-4111-8111-111111111111";
  const first = "22222222-2222-4222-8222-222222222222";
  const second = "33333333-3333-4333-8333-333333333333";

  for (const clientId of [frozen, first, second]) control.clientConnected(clientId);
  control.noteClientPresence(frozen);
  control.noteClientPresence(first);
  control.noteClientPresence(second);
  control.setController(sessionId, frozen);
  now = 10;
  control.noteClientPresence(first);
  control.noteClientPresence(second);
  now = 21;

  assert.deepEqual(control.controlState(sessionId, first), {
    controlOwner: frozen,
    controlledByThisWindow: false,
  });
  assert.throws(
    () => control.requireControl(sessionId, first),
    (error: unknown) => error instanceof SessionControlConflictError,
  );

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(control.sessionControllers.has(sessionId), false);
  assert.deepEqual(control.controlState(sessionId, first), {
    controlledByThisWindow: false,
  });
  assert.doesNotThrow(() => control.requireControl(sessionId, first));
  control.clear();
});

test("an expired owner becomes fresh again and broadcasts the changed control projection", () => {
  let now = 0;
  const changed: string[] = [];
  const control = new SessionControl({
    presenceTtlMs: 50,
    now: () => now,
    onControlChanged: (id) => changed.push(id),
  });
  const sessionId = "acacacacacacacacacac";
  const owner = "11111111-1111-4111-8111-111111111111";
  const observer = "22222222-2222-4222-8222-222222222222";

  control.clientConnected(owner);
  control.clientConnected(observer);
  control.noteClientPresence(owner);
  control.noteClientPresence(observer);
  control.setController(sessionId, owner);
  now = 51;
  assert.deepEqual(control.controlState(sessionId, observer), { controlledByThisWindow: false });

  // pageshow/focus/visibility on the owner map to a foreground renewal.
  control.noteClientPresence(owner);
  assert.deepEqual(control.controlState(sessionId, observer), {
    controlOwner: owner,
    controlledByThisWindow: false,
  });
  assert.ok(changed.filter((id) => id === sessionId).length >= 2);
  control.clear();
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
  assert.equal(control.sessionControllers.get(sessionId), ghost, "viewing alone must not implicitly renew or claim foreground control");
  control.noteClientPresence(alone);
  control.claimIfSolePresentWindow(sessionId, alone);

  assert.equal(control.sessionControllers.get(sessionId), alone);
  assert.deepEqual(control.controlState(sessionId, alone), {
    controlOwner: alone,
    controlledByThisWindow: true,
  });
  assert.doesNotThrow(() => control.requireControl(sessionId, alone));
});

test("two simultaneously fresh windows preserve foreign projection and exclusive control", () => {
  const control = new SessionControl({ onControlChanged: () => {} });
  const sessionId = "cccccccccccccccccccc";
  const owner = "11111111-1111-4111-8111-111111111111";
  const observer = "22222222-2222-4222-8222-222222222222";

  control.clientConnected(owner);
  control.clientConnected(observer);
  control.noteClientPresence(owner);
  control.noteClientPresence(observer);
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
  control.noteClientPresence(owner);
  control.setController(sessionId, owner);
  control.clientDisconnected(owner);
  control.clientConnected(alone);
  control.noteClientPresence(alone);

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
  control.noteClientPresence(owner);
  control.setController(sessionId, owner);
  control.clientDisconnected(owner);
  assert.equal(control.sessionControllers.get(sessionId), owner);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(control.sessionControllers.has(sessionId), false);
  assert.doesNotThrow(() => control.requireControl(sessionId, next));
});
