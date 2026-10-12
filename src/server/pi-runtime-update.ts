import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { PiRuntimeUpdateCheck } from "../shared/pi-runtime-update.js";

const execFileAsync = promisify(execFile);

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
    inPlaceUpdateAvailable: false,
  };
}

export interface ManagedPiInstall {
  /** The managed install root that owns `current-version` and `releases/`. */
  root: string;
  /** Current entry resolved through this managed root, when it is the live one. */
  currentEntry: string | null;
  /** Bundled npm-cli.js usable for installing new versions. */
  npmCliPath: string | null;
}

/**
 * Locate the managed install root that owns the current Pi entry. Only a
 * PiChat-managed root (or the shared `~/.pi/agent/install` layout) may be
 * upgraded in place; a user-owned npm/global install is never modified.
 */
export function resolveManagedPiInstall(
  currentEntry: string | null,
  env: NodeJS.ProcessEnv = process.env,
  projectRoot: string = process.cwd(),
): ManagedPiInstall | null {
  const home = process.platform === "win32" ? (env.USERPROFILE || "") : (env.HOME || "");
  const candidates: string[] = [];
  const envRoot = env.PI_CHAT_MANAGED_INSTALL_ROOT?.trim() || env.PI_MANAGED_INSTALL_ROOT?.trim();
  if (envRoot) candidates.push(resolve(envRoot));
  if (home) candidates.push(resolve(home, ".pi", "agent", "install"));
  const nodeRoot = resolve(projectRoot, "..", "runtime", "node");
  const npmCliPath = join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js");
  for (const root of candidates) {
    const releases = join(root, "releases");
    if (!currentEntry || !currentEntry.startsWith(releases + "\\") && !currentEntry.startsWith(releases + "/")) continue;
    return { root, currentEntry, npmCliPath: existsSync(npmCliPath) ? npmCliPath : null };
  }
  return null;
}

export async function assertPiVersionExists(version: string): Promise<void> {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Pi Runtime 版本号无效：${version}`);
  }
  const response = await fetch(`${PI_RUNTIME_REGISTRY_URL}/${encodeURIComponent(version)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`npm Registry 中不存在 Pi Runtime ${version}。`);
}

/**
 * Install one pinned Pi Runtime version into a managed root without touching
 * the live `current-version` pointer. The pointer flips only after the install
 * succeeds and the service quiescence gate has passed.
 */
/**
 * Locate a usable npm-cli.js for installing managed Pi versions: prefer the
 * runtime bundled next to the app, then the system-global npm installation.
 */
export async function resolveNpmCli(projectRoot: string = process.cwd()): Promise<string | null> {
  const bundled = join(resolve(projectRoot, "..", "runtime", "node"), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(bundled)) return bundled;
  // npm bundled inside the Node.js installation (the common Windows layout):
  // the npm command shim sits next to node.exe, with npm-cli.js beside it.
  const searchPath = process.env.PATH || (process.platform === "win32" ? process.env.Path : "") || "";
  for (const rawEntry of searchPath.split(delimiter)) {
    const pathEntry = rawEntry.replace(/^"(.*)"$/, "$1").trim();
    if (!pathEntry) continue;
    const shimName = process.platform === "win32" ? "npm.cmd" : "npm";
    if (!existsSync(join(pathEntry, shimName))) continue;
    const nodeBundledCli = join(pathEntry, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(nodeBundledCli)) return nodeBundledCli;
  }
  // npm installed as a true global package (its own node_modules root).
  const appData = process.env.APPDATA;
  if (appData) {
    const appDataCli = join(appData, "npm", "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(appDataCli)) return appDataCli;
  }
  try {
    // Windows .cmd shims require a shell; npm root -g only prints a path.
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const { stdout } = await execFileAsync(npmCmd, ["root", "-g"], { shell: process.platform === "win32", windowsHide: true, maxBuffer: 1024 * 1024 });
    const globalRoot = stdout.trim().split(/\r?\n/).pop()?.trim();
    if (globalRoot) {
      const globalCli = join(globalRoot, "npm", "bin", "npm-cli.js");
      if (existsSync(globalCli)) return globalCli;
    }
  } catch {
    // No usable system npm; callers surface a clear update-unavailable error.
  }
  return null;
}

/** Persist (or replace) the managed-root binding in the launcher's runtime.env. */
export async function writeManagedRuntimeEnv(projectRoot: string, managedRoot: string): Promise<string> {
  const { access, readFile } = await import("node:fs/promises");
  const localConfig = join(projectRoot, "config");
  const parentConfig = join(projectRoot, "..", "config");
  let configRoot = localConfig;
  try {
    await access(localConfig);
  } catch {
    configRoot = parentConfig;
  }
  await mkdir(configRoot, { recursive: true });
  const envFile = join(configRoot, "runtime.env");
  let lines: string[] = [];
  try {
    lines = (await readFile(envFile, "utf8")).split(/\r?\n/)
      .filter((line) => line.trim() && !/^PI_CHAT_MANAGED_INSTALL_ROOT=/.test(line));
  } catch {
    // First managed binding; start from an empty env file.
  }
  lines.push(`PI_CHAT_MANAGED_INSTALL_ROOT=${managedRoot}`);
  await writeFile(envFile, lines.join("\n") + "\n", "utf8");
  return envFile;
}

export async function installManagedPiVersion(
  managedRoot: string,
  version: string,
  npmCliPath: string,
  nodePath: string = process.execPath,
): Promise<void> {
  await assertPiVersionExists(version);
  const releaseRoot = join(managedRoot, "releases", version);
  if (!existsSync(join(releaseRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "rpc-entry.js"))) {
    await mkdir(releaseRoot, { recursive: true });
    await execFileAsync(
      nodePath,
      [npmCliPath, "install", "--prefix", releaseRoot, `${PI_RUNTIME_PACKAGE}@${version}`, "--ignore-scripts", "--no-audit", "--no-fund"],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
  }
  const entry = join(releaseRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "rpc-entry.js");
  if (!existsSync(entry)) throw new Error(`Pi Runtime ${version} 安装后缺少 RPC 入口。`);
}

/** Atomically move a managed root to a new installed version. */
export async function switchManagedPiVersion(managedRoot: string, version: string): Promise<void> {
  const entry = join(managedRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "rpc-entry.js");
  if (!existsSync(entry)) throw new Error(`Pi Runtime ${version} 尚未安装完成。`);
  const pointer = join(managedRoot, "current-version");
  const temporary = join(dirname(pointer), `.current-version-${process.pid}.tmp`);
  await writeFile(temporary, version, "ascii");
  await rename(temporary, pointer);
}
