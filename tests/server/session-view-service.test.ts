import assert from "node:assert/strict";
import test from "node:test";
import { readSessionView } from "../../src/server/services/session-view-service";

test("session view service falls back cold when a hot RPC generation is replaced", async () => {
  let released = false;
  const view = await readSessionView({
    isPrimary: () => true,
    secondaryExists: () => false,
    acquirePrimary: () => ({ generation: 1, rpcGeneration: 1, release: () => { released = true; } }),
    primaryCurrent: () => false,
    acquireSecondary: () => { throw new Error("unused"); },
    secondaryCurrent: () => false,
    hotView: () => ({ session: { id: "s" } } as never),
    currentProjection: async () => ({ session: { id: "s" } } as never),
    coldView: async () => ({ session: { id: "s" }, runtimeStatus: "view-only" } as never),
    forkOrigin: async () => undefined,
  }, "s", 10, "client");
  assert.equal(view?.runtimeStatus, "view-only");
  assert.equal(released, true);
});
