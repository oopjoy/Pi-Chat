import type { BuildIdentity } from "../../shared/types";

declare const __PI_CHAT_BUILD_IDENTITY__: BuildIdentity | undefined;

/** The compiled bundle's build contract. Undefined is tolerated only in dev/tests. */
export const webBuildIdentity: BuildIdentity = typeof __PI_CHAT_BUILD_IDENTITY__ === "undefined"
  ? { schemaVersion: 1, packageVersion: "unknown", revision: "unknown", fingerprint: "unknown", builtAt: "unknown" }
  : __PI_CHAT_BUILD_IDENTITY__;

export function buildIdentityMatches(server: BuildIdentity): boolean {
  // Dev/test sources intentionally have no generated artifact. Production
  // fingerprints are authoritative and must match exactly before mutations.
  return webBuildIdentity.fingerprint === "unknown"
    || server.fingerprint === "unknown"
    || webBuildIdentity.schemaVersion === server.schemaVersion
      && webBuildIdentity.fingerprint === server.fingerprint;
}

export function buildIdentityLabel(identity: BuildIdentity): string {
  return `${identity.packageVersion} · ${identity.fingerprint.slice(0, 12)}`;
}
