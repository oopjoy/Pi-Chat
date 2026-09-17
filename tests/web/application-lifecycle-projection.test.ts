import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptApplicationLifecycle,
  isApplicationLifecycle,
} from "../../src/web/application/application-lifecycle";
import { lifecycleFromEvent } from "../../src/web/lib/pi-events";

test("application lifecycle projection accepts the complete server vocabulary", () => {
  for (const lifecycle of [
    "idle",
    "restarting",
    "shutting-down",
    "workspace-changing",
    "resources-reloading",
    "models-refreshing",
  ]) assert.equal(acceptApplicationLifecycle("idle", lifecycle), lifecycle);
});

test("application lifecycle projection fences malformed SSE payloads", () => {
  assert.equal(acceptApplicationLifecycle("resources-reloading", "shutdown-now"), "resources-reloading");
  assert.equal(acceptApplicationLifecycle("workspace-changing", undefined), "workspace-changing");
  assert.equal(acceptApplicationLifecycle("restarting", { lifecycle: "idle" }), "restarting");
  assert.equal(isApplicationLifecycle("idle"), true);
  assert.equal(isApplicationLifecycle(""), false);
  assert.equal(lifecycleFromEvent({ lifecycle: "idle" }), "idle");
  assert.equal(lifecycleFromEvent({ lifecycle: "" }), null);
  assert.equal(lifecycleFromEvent({}), null);
});
