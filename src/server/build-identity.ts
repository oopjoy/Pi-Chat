import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BuildIdentity } from "../shared/types.js";

const UNKNOWN_BUILD_IDENTITY: BuildIdentity = {
  schemaVersion: 1,
  packageVersion: "unknown",
  revision: "unknown",
  fingerprint: "unknown",
  builtAt: "unknown",
};

function isBuildIdentity(value: unknown): value is BuildIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schemaVersion === 1
    && typeof candidate.packageVersion === "string"
    && typeof candidate.revision === "string"
    && typeof candidate.fingerprint === "string"
    && /^[a-f0-9]{64}$/i.test(candidate.fingerprint)
    && typeof candidate.builtAt === "string";
}

/** Loads the identity adjacent to the dist tree actually serving this process. */
export async function loadBuildIdentity(runtimeDist: string): Promise<BuildIdentity> {
  try {
    const value: unknown = JSON.parse(await readFile(join(resolve(runtimeDist), "build-identity.json"), "utf8"));
    if (isBuildIdentity(value)) return value;
  } catch {
    // Development/test hosts intentionally work without a compiled dist tree.
  }
  return UNKNOWN_BUILD_IDENTITY;
}
