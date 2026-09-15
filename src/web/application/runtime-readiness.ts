import type { PrimaryRuntimeReadiness } from "../../shared/types";

/**
 * Merge a Primary readiness observation without allowing an older generation,
 * or an equal-generation startup snapshot, to erase terminal/capability facts.
 * Runtime provenance remains owned by the caller; this module only defines the
 * readiness transition used at that already-admitted boundary.
 */
export function acceptPrimaryReadiness(
  current: PrimaryRuntimeReadiness,
  incoming: PrimaryRuntimeReadiness,
): PrimaryRuntimeReadiness {
  if (incoming.generation > current.generation) return incoming;
  if (incoming.generation < current.generation) return current;
  if (incoming.status === "starting" && current.status !== "starting")
    return current;
  // SSE/legacy snapshots may omit adopted model/session fields. Equal-generation
  // frames refine one readiness record; they must never erase capability proof
  // from the controller's atomic adoption.
  return { ...current, ...incoming };
}
