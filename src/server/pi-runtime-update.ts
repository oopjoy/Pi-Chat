import type { PiRuntimeUpdateCheck } from "../shared/pi-runtime-update.js";

export const PI_RUNTIME_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_RUNTIME_REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PI_RUNTIME_PACKAGE)}`;

function versionParts(value: string | undefined): [number, number, number] | null {
  if (!value) return null;
  const match = value.trim().replace(/^v/i, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
}

export function comparePiVersions(current: string | undefined, latest: string): number | null {
  const left = versionParts(current);
  const right = versionParts(latest);
  if (!left || !right) return null;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function checkPiRuntimeUpdate(
  currentVersion: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<PiRuntimeUpdateCheck> {
  const response = await fetchImpl(PI_RUNTIME_REGISTRY_URL, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  const value = await response.json().catch(() => ({})) as {
    "dist-tags"?: { latest?: unknown };
  };
  const latestVersion = value["dist-tags"]?.latest;
  if (!response.ok || typeof latestVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(latestVersion)) {
    throw new Error(`检查 Pi Runtime 更新失败（${response.status}）`);
  }
  const comparison = comparePiVersions(currentVersion, latestVersion);
  return {
    packageName: PI_RUNTIME_PACKAGE,
    ...(currentVersion ? { currentVersion } : null),
    latestVersion,
    registryUrl: PI_RUNTIME_REGISTRY_URL,
    checkedAt: new Date().toISOString(),
    updateAvailable: comparison === null ? null : comparison < 0,
  };
}
