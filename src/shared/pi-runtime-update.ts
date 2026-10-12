/**
 * How an in-place Pi Runtime upgrade is executed for the live engine:
 * - managed:     the entry lives under a managed install root; switch the
 *                pinned `current-version` pointer after installing the release.
 * - npm-global:  the entry is an npm global installation; run an explicit
 *                `npm install -g` so the user's Pi CLI upgrades in lockstep.
 * - null:        the entry source is unknown or explicit; never modify it.
 */
export type PiRuntimeUpdateMode = "managed" | "npm-global";

/** Result of an explicit, read-only check against the Pi Runtime package registry. */
export interface PiRuntimeUpdateCheck {
  packageName: string;
  currentVersion?: string;
  latestVersion: string;
  registryUrl: string;
  checkedAt: string;
  updateAvailable: boolean | null;
  /** How the service may upgrade in place; null means update is not offered. */
  updateMode: PiRuntimeUpdateMode | null;
}
