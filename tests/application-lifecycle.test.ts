import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationBusyError, ApplicationLifecycleConflictError, ApplicationLifecycleCoordinator } from "../src/server/application-lifecycle";

test("lifecycle coordinator serializes barriers and broadcasts state transitions", async () => {
  const changes: string[] = [];
  const lifecycle = new ApplicationLifecycleCoordinator((value) => changes.push(value));
  await lifecycle.run("resources-reloading", async () => {
    assert.equal(lifecycle.lifecycle, "resources-reloading");
    assert.throws(() => lifecycle.beginMutation(), ApplicationLifecycleConflictError);
  });
  assert.equal(lifecycle.lifecycle, "idle");
  assert.deepEqual(changes, ["resources-reloading", "idle"]);
});

test("an admitted mutation lease prevents a lifecycle barrier until released", () => {
  const lifecycle = new ApplicationLifecycleCoordinator();
  const release = lifecycle.beginMutation();
  assert.equal(lifecycle.activeMutations, 1);
  assert.throws(() => lifecycle.begin("restarting"), ApplicationBusyError);
  release();
  release();
  assert.equal(lifecycle.activeMutations, 0);
  lifecycle.begin("restarting");
  lifecycle.end("restarting");
  assert.equal(lifecycle.lifecycle, "idle");
});
