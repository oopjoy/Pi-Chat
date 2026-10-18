import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Real-RPC tests must exercise the repository's exact development baseline,
// never a silently discovered user/global installation. Missing npm ci is an
// error rather than a reason to skip the integration checks.
const packagePath = new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url);
const installed = JSON.parse(readFileSync(packagePath, "utf8")) as { version: string };
const project = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  devDependencies: Record<string, string>;
};
assert.equal(project.devDependencies["@earendil-works/pi-coding-agent"], "1.3.0");
assert.equal(installed.version, "1.3.0", "Run npm ci to install the pinned Pi 1.3.0 baseline");

export const pinnedPiEntry = realpathSync(fileURLToPath(new URL("dist/rpc-entry.js", packagePath)));
