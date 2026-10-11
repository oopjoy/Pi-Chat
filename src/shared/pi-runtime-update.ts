/** Result of an explicit, read-only check against the Pi Runtime package registry. */
export interface PiRuntimeUpdateCheck {
  packageName: string;
  currentVersion?: string;
  latestVersion: string;
  registryUrl: string;
  checkedAt: string;
  updateAvailable: boolean | null;
}
