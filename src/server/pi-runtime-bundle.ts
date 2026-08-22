import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolvePiEntry } from "./rpc-client.js";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const BUNDLE_SCHEMA_VERSION = 2;
const BUNDLE_LAYOUT_VERSION = 1;
const BUNDLE_RECIPE_VERSION = 3;
const BUNDLE_ESBUILD_VERSION = "0.28.1";
const BUNDLED_RUNTIME_DISABLED_ENV = "PI_CHAT_DISABLE_BUNDLED_PI_RUNTIME";

interface InstalledPiPackage {
  root: string;
  version: string;
  cliPath: string;
}

interface PiRuntimeBundleManifest {
  schemaVersion: number;
  layoutVersion: number;
  piPackageName: string;
  piVersion: string;
  minimumNodeMajor: number;
  supportedPlatforms: string[];
  supportedArchitectures: string[];
  bundleRelativePath: string;
  bundleSha256: string;
  originalCliRelativePath: string;
  recipeVersion: number;
  esbuildVersion: string;
  sourceInputs: Array<{
    packageName: string;
    packageVersion: string;
    packageLocator: string;
    relativePath: string;
    sha256: string;
  }>;
  outputHashes: Record<string, string>;
}

export interface PiRuntimeLaunch {
  piEntry: string | null;
  childEnvironment: Record<string, string>;
  bundled: boolean;
  piVersion?: string;
  diagnostic: string;
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isInside(path: string, parent: string): boolean {
  const offset = relative(parent, path);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function parseManifest(value: unknown): PiRuntimeBundleManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== BUNDLE_SCHEMA_VERSION
    || record.layoutVersion !== BUNDLE_LAYOUT_VERSION
    || record.piPackageName !== PI_PACKAGE_NAME
    || typeof record.piVersion !== "string"
    || !record.piVersion
    || !Number.isSafeInteger(record.minimumNodeMajor)
    || !Array.isArray(record.supportedPlatforms)
    || record.supportedPlatforms.some((value) => typeof value !== "string" || !value)
    || !Array.isArray(record.supportedArchitectures)
    || record.supportedArchitectures.some((value) => typeof value !== "string" || !value)
    || typeof record.bundleRelativePath !== "string"
    || !record.bundleRelativePath
    || typeof record.bundleSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(record.bundleSha256)
    || typeof record.originalCliRelativePath !== "string"
    || !record.originalCliRelativePath
    || record.recipeVersion !== BUNDLE_RECIPE_VERSION
    || record.esbuildVersion !== BUNDLE_ESBUILD_VERSION
    || !Array.isArray(record.sourceInputs)
    || record.sourceInputs.length === 0
    || record.sourceInputs.length > 2_048
    || !record.outputHashes
    || typeof record.outputHashes !== "object"
    || Array.isArray(record.outputHashes)
  ) return null;
  const parseHashes = (value: Record<string, unknown>): Record<string, string> | null => {
    const hashes: Record<string, string> = {};
    for (const [path, digest] of Object.entries(value)) {
      if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..") || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
        return null;
      hashes[path] = digest;
    }
    return Object.keys(hashes).length > 0 ? hashes : null;
  };
  const sourceInputs = [] as PiRuntimeBundleManifest["sourceInputs"];
  for (const value of record.sourceInputs) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    if (
      typeof input.packageName !== "string"
      || !input.packageName
      || typeof input.packageVersion !== "string"
      || !input.packageVersion
      || typeof input.packageLocator !== "string"
      || !input.packageLocator
      || isAbsolute(input.packageLocator)
      || input.packageLocator.split(/[\\/]/).includes("..")
      || typeof input.relativePath !== "string"
      || !input.relativePath
      || isAbsolute(input.relativePath)
      || input.relativePath.split(/[\\/]/).includes("..")
      || typeof input.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(input.sha256)
    ) return null;
    sourceInputs.push({
      packageName: input.packageName,
      packageVersion: input.packageVersion,
      packageLocator: input.packageLocator,
      relativePath: input.relativePath,
      sha256: input.sha256,
    });
  }
  const outputHashes = parseHashes(record.outputHashes as Record<string, unknown>);
  if (!outputHashes) return null;
  return {
    schemaVersion: record.schemaVersion,
    layoutVersion: record.layoutVersion,
    piPackageName: record.piPackageName,
    piVersion: record.piVersion,
    minimumNodeMajor: record.minimumNodeMajor as number,
    supportedPlatforms: record.supportedPlatforms as string[],
    supportedArchitectures: record.supportedArchitectures as string[],
    bundleRelativePath: record.bundleRelativePath,
    bundleSha256: record.bundleSha256,
    originalCliRelativePath: record.originalCliRelativePath,
    recipeVersion: record.recipeVersion,
    esbuildVersion: record.esbuildVersion,
    sourceInputs,
    outputHashes,
  };
}

function inspectInstalledPi(entryPath: string): InstalledPiPackage | null {
  let canonicalEntry: string;
  try { canonicalEntry = realpathSync(entryPath); }
  catch { return null; }
  let directory = dirname(canonicalEntry);
  while (true) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          name?: unknown;
          version?: unknown;
          bin?: unknown;
        };
        if (manifest.name === PI_PACKAGE_NAME) {
          if (typeof manifest.version !== "string" || !manifest.version) return null;
          const bin = manifest.bin;
          const cliRelative = typeof bin === "string"
            ? bin
            : bin && typeof bin === "object" && typeof (bin as Record<string, unknown>).pi === "string"
              ? (bin as Record<string, string>).pi
              : null;
          if (!cliRelative || isAbsolute(cliRelative)) return null;
          const cliPath = resolve(directory, cliRelative);
          if (!isInside(cliPath, directory) || !existsSync(cliPath)) return null;
          return { root: directory, version: manifest.version, cliPath };
        }
      } catch { return null; }
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function inspectPackageDirectory(
  directory: string,
  expectedName: string,
  expectedVersion: string,
): string | null {
  try {
    const canonical = realpathSync(directory);
    const manifest = JSON.parse(readFileSync(join(canonical, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return manifest.name === expectedName && manifest.version === expectedVersion
      ? canonical
      : null;
  } catch { return null; }
}

async function fileMatches(path: string, expectedHash: string): Promise<boolean> {
  try { return sha256(await readFile(path)) === expectedHash; }
  catch { return false; }
}

export async function resolvePiRuntimeLaunch(options: {
  runtimeDist: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PiRuntimeLaunch> {
  const env = options.env ?? process.env;
  let originalEntry: string | null = null;
  try { originalEntry = resolvePiEntry(env); }
  catch (error) {
    return {
      piEntry: null,
      childEnvironment: {},
      bundled: false,
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
  if (!originalEntry) {
    return {
      piEntry: null,
      childEnvironment: {},
      bundled: false,
      diagnostic: "找不到全局 Pi；历史 JSONL 保持可浏览，Runtime 写操作将不可用",
    };
  }
  if (env.PI_CHAT_PI_ENTRY) {
    return {
      piEntry: originalEntry,
      childEnvironment: {},
      bundled: false,
      diagnostic: "显式 PI_CHAT_PI_ENTRY 保持 authoritative，未替换为内置 Bundle",
    };
  }
  if (env[BUNDLED_RUNTIME_DISABLED_ENV] === "1") {
    return {
      piEntry: originalEntry,
      childEnvironment: {},
      bundled: false,
      diagnostic: `${BUNDLED_RUNTIME_DISABLED_ENV}=1`,
    };
  }

  const installed = inspectInstalledPi(originalEntry);
  if (!installed) {
    return {
      piEntry: originalEntry,
      childEnvironment: {},
      bundled: false,
      diagnostic: "无法验证全局 Pi package identity",
    };
  }
  if (env.PI_PACKAGE_DIR) {
    try {
      if (realpathSync(env.PI_PACKAGE_DIR) !== realpathSync(installed.root)) {
        return {
          piEntry: originalEntry,
          childEnvironment: {},
          bundled: false,
          piVersion: installed.version,
          diagnostic: "显式 PI_PACKAGE_DIR 与全局 Pi package root 不同，保持 direct authority",
        };
      }
    } catch {
      return {
        piEntry: originalEntry,
        childEnvironment: {},
        bundled: false,
        piVersion: installed.version,
        diagnostic: "显式 PI_PACKAGE_DIR 不可验证，保持 direct authority",
      };
    }
  }
  const runtimeRoot = resolve(options.runtimeDist, "resources", "pi-runtime");
  const manifestPath = resolve(runtimeRoot, "manifest.json");
  let manifest: PiRuntimeBundleManifest | null = null;
  try { manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8"))); }
  catch {}
  if (!manifest) {
    return {
      piEntry: originalEntry,
      childEnvironment: {},
      bundled: false,
      piVersion: installed.version,
      diagnostic: "Pi Runtime Bundle manifest 不可用",
    };
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (
    !manifest.supportedPlatforms.includes(process.platform)
    || !manifest.supportedArchitectures.includes(process.arch)
  ) {
    return {
      piEntry: originalEntry,
      childEnvironment: {},
      bundled: false,
      piVersion: installed.version,
      diagnostic: `Pi Runtime Bundle 未验证当前平台（${process.platform}/${process.arch}）`,
    };
  }
  if (nodeMajor < manifest.minimumNodeMajor) {
    return {
      piEntry: originalEntry,
      childEnvironment: {},
      bundled: false,
      piVersion: installed.version,
      diagnostic: `Node ${nodeMajor} 低于 Bundle 要求 ${manifest.minimumNodeMajor}`,
    };
  }
  if (manifest.piVersion !== installed.version) {
    return {
      piEntry: originalEntry,
      childEnvironment: {},
      bundled: false,
      piVersion: installed.version,
      diagnostic: `Pi 版本不匹配（installed=${installed.version}, bundled=${manifest.piVersion}）`,
    };
  }
  const packageRoots = new Map<string, string>();
  for (const input of manifest.sourceInputs) {
    const packageKey = `${input.packageName}@${input.packageVersion}:${input.packageLocator}`;
    let packageRoot = packageRoots.get(packageKey);
    if (!packageRoot) {
      const candidate = resolve(installed.root, input.packageLocator);
      packageRoot = isInside(candidate, installed.root)
        ? inspectPackageDirectory(candidate, input.packageName, input.packageVersion) ?? undefined
        : undefined;
      if (!packageRoot) {
        return {
          piEntry: originalEntry,
          childEnvironment: {},
          bundled: false,
          piVersion: installed.version,
          diagnostic: `Pi source package fingerprint 不匹配：${packageKey}`,
        };
      }
      packageRoots.set(packageKey, packageRoot);
    }
    const sourcePath = resolve(packageRoot, input.relativePath);
    if (!isInside(sourcePath, packageRoot) || !await fileMatches(sourcePath, input.sha256)) {
      return {
        piEntry: originalEntry,
        childEnvironment: {},
        bundled: false,
        piVersion: installed.version,
        diagnostic: `Pi source fingerprint 不匹配：${packageKey}/${input.relativePath}`,
      };
    }
  }
  for (const [output, expectedHash] of Object.entries(manifest.outputHashes)) {
    const outputPath = resolve(runtimeRoot, output);
    if (!isInside(outputPath, runtimeRoot) || !await fileMatches(outputPath, expectedHash)) {
      return {
        piEntry: originalEntry,
        childEnvironment: {},
        bundled: false,
        piVersion: installed.version,
        diagnostic: `Pi Runtime Bundle output fingerprint 不匹配：${output}`,
      };
    }
  }
  const bundlePath = resolve(runtimeRoot, manifest.bundleRelativePath);
  if (!isInside(bundlePath, runtimeRoot) || manifest.outputHashes[manifest.bundleRelativePath] !== manifest.bundleSha256) {
    return {
      piEntry: originalEntry,
      childEnvironment: {},
      bundled: false,
      piVersion: installed.version,
      diagnostic: "Pi Runtime Bundle entry manifest 不一致",
    };
  }
  return {
    piEntry: bundlePath,
    childEnvironment: {
      PI_CHAT_BUNDLED_RUNTIME: "1",
      PI_CHAT_ORIGINAL_PI_ENTRY: originalEntry,
      PI_CHAT_ORIGINAL_PI_CLI: installed.cliPath,
      PI_PACKAGE_DIR: installed.root,
      ...(env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT
        ? {}
        : { PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: installed.root }),
    },
    bundled: true,
    piVersion: installed.version,
    diagnostic: `已验证 Pi ${installed.version} Bundle ${manifest.bundleSha256.slice(0, 12)}`,
  };
}
