import assert from "node:assert/strict";
import test from "node:test";
import { buildIdentityLabel } from "../src/web/lib/build-identity.js";

test("build labels expose the deploy revision separately from package version", () => {
  assert.equal(
    buildIdentityLabel({
      schemaVersion: 1,
      packageVersion: "0.4.4",
      revision: "4d1b7051d461f0b5e16353781678410577ce8c62",
      fingerprint: "081b3dab208077385ad6f3abe0143d49f185799a03c4696ae26d8c1ea844b655",
      builtAt: "2026-08-20T01:35:36.460Z",
    }),
    "0.4.4 · rev 4d1b7051d461 · fp 081b3dab",
  );
});

test("unknown development build fields remain explicit", () => {
  assert.equal(
    buildIdentityLabel({
      schemaVersion: 1,
      packageVersion: "unknown",
      revision: "unknown",
      fingerprint: "unknown",
      builtAt: "unknown",
    }),
    "unknown · rev unknown · fp unknown",
  );
});
