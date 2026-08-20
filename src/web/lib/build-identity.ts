import type { BuildIdentity } from "../../shared/types";

declare const __PI_CHAT_BUILD_IDENTITY__: BuildIdentity | undefined;

type TestBuildIdentityGlobal = typeof globalThis & {
  __PI_CHAT_TEST_WEB_BUILD_IDENTITY__?: BuildIdentity;
};

/** The compiled bundle's build contract. Undefined is tolerated only in dev/tests. */
export const webBuildIdentity: BuildIdentity = typeof __PI_CHAT_BUILD_IDENTITY__ === "undefined"
  ? { schemaVersion: 1, packageVersion: "unknown", revision: "unknown", fingerprint: "unknown", builtAt: "unknown" }
  : __PI_CHAT_BUILD_IDENTITY__;

function currentWebBuildIdentity(): BuildIdentity {
  // Node/JSDOM tests load source modules without Vite's compile-time define.
  // The override is deliberately impossible in the browser build, where
  // `process` is absent and the embedded production identity remains final.
  const testIdentity = typeof process !== "undefined" && process.env.NODE_ENV === "test"
    ? (globalThis as TestBuildIdentityGlobal).__PI_CHAT_TEST_WEB_BUILD_IDENTITY__
    : undefined;
  return testIdentity || webBuildIdentity;
}

export function buildIdentityMatches(server: BuildIdentity): boolean {
  // Dev/test sources intentionally have no generated artifact. Production
  // fingerprints are authoritative and must match exactly before mutations.
  const webIdentity = currentWebBuildIdentity();
  return webIdentity.fingerprint === "unknown"
    || server.fingerprint === "unknown"
    || webIdentity.schemaVersion === server.schemaVersion
      && webIdentity.fingerprint === server.fingerprint;
}

export function buildIdentityLabel(identity: BuildIdentity): string {
  const revision = identity.revision === "unknown"
    ? "unknown"
    : identity.revision.slice(0, 12);
  const fingerprint = identity.fingerprint === "unknown"
    ? "unknown"
    : identity.fingerprint.slice(0, 8);
  return `${identity.packageVersion} · rev ${revision} · fp ${fingerprint}`;
}
