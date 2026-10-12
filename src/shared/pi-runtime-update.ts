/** Result of an explicit, read-only check against the Pi Runtime package registry. */
export interface PiRuntimeUpdateCheck {
  packageName: string;
  currentVersion?: string;
  latestVersion: string;
  registryUrl: string;
  checkedAt: string;
  updateAvailable: boolean | null;
  /**
   * True only when the live Pi entry resolves through a PiChat-managed install
   * root that this service may upgrade in place. A user-owned npm/global Pi is
   * never claimed, and the UI must not offer a direct update for it.
   */
  inPlaceUpdateAvailable: boolean;
}
