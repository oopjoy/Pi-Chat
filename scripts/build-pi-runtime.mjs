import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, version as esbuildVersion } from "esbuild";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const BUNDLE_SCHEMA_VERSION = 2;
const BUNDLE_LAYOUT_VERSION = 1;
const BUNDLE_RECIPE_VERSION = 3;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

async function regularFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await regularFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Unexpected linked Runtime artifact: ${path}`);
  }
  return files.sort();
}

function isInside(path, parent) {
  const offset = relative(parent, path);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

async function findPackageRoot(entryPath, expectedName) {
  let directory = dirname(entryPath);
  while (true) {
    const manifestPath = join(directory, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (
        typeof manifest.name === "string"
        && typeof manifest.version === "string"
        && (!expectedName || manifest.name === expectedName)
      ) return { root: directory, manifest };
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate package root from ${entryPath}`);
    directory = parent;
  }
}

function packageEntry() {
  return fileURLToPath(import.meta.resolve(PI_PACKAGE_NAME));
}

const distRoot = resolve(process.env.PI_CHAT_DIST_DIR || "dist");
const finalRuntimeRoot = resolve(distRoot, "resources", "pi-runtime");
const runtimeRoot = resolve(distRoot, "resources", `.pi-runtime-stage-${process.pid}-${Date.now()}`);
const packageRoot = resolve(runtimeRoot, "package");
const packageDist = resolve(packageRoot, "dist");
const resolvedEntry = packageEntry();
const sourcePackage = await findPackageRoot(resolvedEntry, PI_PACKAGE_NAME);
const piVersion = sourcePackage.manifest.version;
if (typeof piVersion !== "string" || !piVersion) throw new Error("Bundled Pi package has no version");

const rpcEntry = resolve(sourcePackage.root, "dist", "rpc-entry.js");
const extensionLoader = resolve(sourcePackage.root, "dist", "core", "extensions", "loader.js");
const rpcMode = resolve(sourcePackage.root, "dist", "modes", "rpc", "rpc-mode.js");
if (!isInside(rpcEntry, sourcePackage.root) || !isInside(extensionLoader, sourcePackage.root) || !isInside(rpcMode, sourcePackage.root)) {
  throw new Error("Pi runtime source paths escaped the package root");
}

await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(packageDist, { recursive: true });

try {
const { patchPiRpcModeSource } = await import(pathToFileURL(resolve("resources", "runtime", "pi-chat-rpc-loader.mjs")).href);
const loaderMarker = `...(isBunBinary\n            ? { virtualModules: VIRTUAL_MODULES, tryNative: false }\n            : isTypeScriptSourceRuntime`;
const bundledLoaderMarker = `...(isBunBinary || process.env.PI_CHAT_BUNDLED_RUNTIME === "1"\n            ? { virtualModules: VIRTUAL_MODULES, tryNative: false }\n            : isTypeScriptSourceRuntime`;
let transformedLoader = false;
let transformedRpcMode = false;
const extensionLoaderPlugin = {
  name: "pi-chat-bundled-extension-loader",
  setup(context) {
    context.onLoad({ filter: /(?:loader|rpc-mode)\.js$/ }, async (args) => {
      if (resolve(args.path) === rpcMode) {
        const source = await readFile(args.path, "utf8");
        const patched = patchPiRpcModeSource(source);
        transformedRpcMode = patched !== source;
        return { contents: patched, loader: "js" };
      }
      if (resolve(args.path) !== extensionLoader) return undefined;
      const source = await readFile(args.path, "utf8");
      if (!source.includes(loaderMarker)) {
        throw new Error("Installed Pi extension loader is incompatible with the bundled-runtime transform");
      }
      transformedLoader = true;
      const tracedSource = source
        .replace(loaderMarker, bundledLoaderMarker)
        .replace(
          "const module = await jiti.import(extensionPath, { default: true });",
          "const extensionOrdinal = (globalThis.__piChatStartupExtensionOrdinal = (globalThis.__piChatStartupExtensionOrdinal || 0) + 1);\n    globalThis.__piChatStartupMark?.(\"X\", extensionOrdinal);\n    const module = await jiti.import(extensionPath, { default: true });\n    globalThis.__piChatStartupMark?.(\"Y\", extensionOrdinal);",
        )
        .replace(
          "await factory(api);",
          "globalThis.__piChatStartupMark?.(\"F\", globalThis.__piChatStartupExtensionOrdinal);\n        await factory(api);\n        globalThis.__piChatStartupMark?.(\"G\", globalThis.__piChatStartupExtensionOrdinal);",
        );
      return {
        contents: tracedSource,
        loader: "js",
      };
    });
  },
};

const sharedBuildOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "warning",
  mainFields: ["module", "main"],
  conditions: ["node", "import"],
  external: ["@silvia-odwyer/photon-node"],
};
const bundlePath = resolve(packageDist, "rpc-entry.bundle.mjs");
const mainBuild = await build({
  ...sharedBuildOptions,
  entryPoints: [rpcEntry],
  outfile: bundlePath,
  metafile: true,
  plugins: [extensionLoaderPlugin],
  banner: {
    js: "import { createRequire as __piChatCreateRequire } from 'node:module'; import { writeSync as __piChatWriteStartupMarker } from 'node:fs'; const require = __piChatCreateRequire(import.meta.url); globalThis.__piChatStartupMark = (marker, ordinal) => { try { __piChatWriteStartupMarker(3, marker + (Number.isSafeInteger(ordinal) ? ':' + ordinal : '') + '\\n'); } catch {} }; globalThis.__piChatStartupMark('B');",
  },
});
if (!transformedLoader) throw new Error("Pi extension loader was not included in the runtime bundle");
if (!transformedRpcMode) throw new Error("Pi RPC mode was not included in the native Steer dequeue transform");
const imageWorkerPath = resolve(packageDist, "image-resize-worker.js");
const workerBuild = await build({
  ...sharedBuildOptions,
  entryPoints: [resolve(sourcePackage.root, "dist", "utils", "image-resize-worker.js")],
  outfile: imageWorkerPath,
  metafile: true,
});

await cp(
  resolve(sourcePackage.root, "node_modules", "@silvia-odwyer", "photon-node"),
  resolve(packageRoot, "node_modules", "@silvia-odwyer", "photon-node"),
  { recursive: true },
);

const originalBin = sourcePackage.manifest.bin;
const originalCliRelative = typeof originalBin === "string"
  ? originalBin
  : originalBin && typeof originalBin === "object" && typeof originalBin.pi === "string"
    ? originalBin.pi
    : "dist/cli.js";
const packageManifest = {
  name: PI_PACKAGE_NAME,
  version: piVersion,
  type: "module",
  bin: { pi: "dist/cli.js" },
};
await writeFile(resolve(packageRoot, "package.json"), `${JSON.stringify(packageManifest, null, 2)}\n`, "utf8");
await writeFile(
  resolve(packageDist, "cli.js"),
  `#!/usr/bin/env node\nimport { pathToFileURL } from "node:url";\nconst cli = process.env.PI_CHAT_ORIGINAL_PI_CLI;\nif (!cli) throw new Error("PI_CHAT_ORIGINAL_PI_CLI is unavailable");\nawait import(pathToFileURL(cli).href);\n`,
  "utf8",
);

const bundledInputs = [...new Set([
  ...Object.keys(mainBuild.metafile.inputs),
  ...Object.keys(workerBuild.metafile.inputs),
])].map((path) => resolve(path));
const sourceInputs = [];
for (const inputPath of bundledInputs) {
  const owner = await findPackageRoot(inputPath);
  const packageLocator = relative(sourcePackage.root, owner.root).split(/[/\\\\]/).join("/") || ".";
  const relativePath = relative(owner.root, inputPath).split(/[/\\\\]/).join("/");
  if (
    packageLocator.startsWith("../")
    || isAbsolute(packageLocator)
    || !relativePath
    || relativePath.startsWith("../")
    || isAbsolute(relativePath)
  ) throw new Error(`Bundled input escaped the pinned Pi installation: ${inputPath}`);
  sourceInputs.push({
    packageName: owner.manifest.name,
    packageVersion: owner.manifest.version,
    packageLocator,
    relativePath,
    sha256: await sha256File(inputPath),
  });
}
sourceInputs.sort((left, right) =>
  left.packageName.localeCompare(right.packageName)
  || left.packageVersion.localeCompare(right.packageVersion)
  || left.packageLocator.localeCompare(right.packageLocator)
  || left.relativePath.localeCompare(right.relativePath));
const outputHashes = Object.fromEntries(await Promise.all(
  (await regularFiles(packageRoot)).map(async (path) => [
    `package/${relative(packageRoot, path).split(/[/\\\\]/).join("/")}`,
    await sha256File(path),
  ]),
));
const manifest = {
  schemaVersion: BUNDLE_SCHEMA_VERSION,
  layoutVersion: BUNDLE_LAYOUT_VERSION,
  piPackageName: PI_PACKAGE_NAME,
  piVersion,
  minimumNodeMajor: 22,
  supportedPlatforms: ["win32"],
  supportedArchitectures: ["x64"],
  bundleRelativePath: "package/dist/rpc-entry.bundle.mjs",
  bundleSha256: outputHashes["package/dist/rpc-entry.bundle.mjs"],
  originalCliRelativePath: originalCliRelative,
  recipeVersion: BUNDLE_RECIPE_VERSION,
  esbuildVersion,
  sourceInputs,
  outputHashes,
};
await writeFile(resolve(runtimeRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await rm(finalRuntimeRoot, { recursive: true, force: true });
await rename(runtimeRoot, finalRuntimeRoot);
console.log(`[Pi Chat] Built Pi RPC runtime bundle ${piVersion} (${manifest.bundleSha256.slice(0, 12)})`);
} catch (error) {
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  throw error;
}
