import assert from "node:assert/strict";
import test from "node:test";
import { checkPiRuntimeUpdate, comparePiVersions, PI_RUNTIME_PACKAGE } from "../src/server/pi-runtime-update";

test("Pi Runtime version comparison handles release versions", () => {
  assert.equal(comparePiVersions("1.0.1", "1.0.1"), 0);
  assert.equal(comparePiVersions("1.0.0", "1.0.1"), -1);
  assert.equal(comparePiVersions("1.2.0", "1.1.9"), 1);
  assert.equal(comparePiVersions(undefined, "1.0.1"), null);
});

test("Pi Runtime update check is read-only and reports the npm latest version", async () => {
  let requested = "";
  const result = await checkPiRuntimeUpdate("1.0.1", async (input) => {
    requested = input;
    return new Response(JSON.stringify({ "dist-tags": { latest: "1.1.0" } }), { status: 200 });
  });
  assert.equal(requested, "https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent");
  assert.equal(result.packageName, PI_RUNTIME_PACKAGE);
  assert.equal(result.currentVersion, "1.0.1");
  assert.equal(result.latestVersion, "1.1.0");
  assert.equal(result.updateAvailable, true);
  assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("Pi Runtime update check fails closed on malformed registry metadata", async () => {
  await assert.rejects(
    checkPiRuntimeUpdate("1.0.1", async () => new Response(JSON.stringify({ "dist-tags": {} }), { status: 200 })),
    /检查 Pi Runtime 更新失败/,
  );
});
