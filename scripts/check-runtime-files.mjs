import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const requiredFiles = JSON.parse(await readFile(new URL("./runtime-required-files.json", import.meta.url), "utf8"));

/** Shared by release packaging and Windows preflight; never installs or builds. */
export async function assertRuntimeFiles(projectDirectory, distDirectory = resolve(projectDirectory, "dist")) {
  const root = resolve(projectDirectory);
  const dist = resolve(distDirectory);
  const missing = [];
  for (const file of requiredFiles) {
    const path = file.startsWith("dist/") ? resolve(dist, file.slice(5)) : resolve(root, file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size === 0) missing.push(file);
  }
  if (missing.length) throw new Error(`Pi Chat runtime files are missing or empty:\n${missing.map(file => `  ${file}`).join("\n")}`);

  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const identity = JSON.parse(await readFile(resolve(dist, "build-identity.json"), "utf8"));
  if (pkg.type !== "module" || pkg.name !== "pi-chat" || identity.schemaVersion !== 1
      || identity.packageVersion !== pkg.version || typeof identity.revision !== "string" || !identity.revision
      || !/^[a-f0-9]{64}$/.test(identity.fingerprint || "")) {
    throw new Error("Pi Chat package metadata and build identity are invalid or inconsistent.");
  }
  // Check HTML entry assets as well: an index.html alone is not a runnable Web build.
  const web = resolve(dist, "web");
  const html = await readFile(resolve(web, "index.html"), "utf8");
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map(match => match[1]).filter(path => /\.(?:js|css)(?:[?#]|$)/i.test(path));
  if (!assets.some(path => /\.js(?:[?#]|$)/i.test(path))) throw new Error("Pi Chat Web build has no JavaScript entry asset.");
  for (const asset of assets) {
    const path = resolve(web, asset.replace(/^\//, "").split(/[?#]/)[0]);
    const local = relative(web, path);
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`) || /^[a-z]+:/i.test(asset)) {
      throw new Error(`Pi Chat Web asset must be local: ${asset}`);
    }
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size === 0) throw new Error(`Pi Chat Web asset is missing or empty: ${asset}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] || dirname(dirname(fileURLToPath(import.meta.url))));
  try {
    await assertRuntimeFiles(root);
  } catch (error) {
    console.error(`[Pi Chat] ${error.message}`);
    if (await stat(resolve(root, "src/server/index.ts")).catch(() => null)) {
      console.error("This is a source checkout. In this project directory, run:");
      console.error("  npm ci --include=dev");
      console.error("  npm run build");
      console.error("Or download the runnable pi-chat-windows ZIP from GitHub Releases, not Source code.");
    } else {
      console.error("The Windows package is incomplete. Re-download and fully extract the pi-chat-windows ZIP from GitHub Releases.");
      console.error("Do not run npm install or build inside the release package.");
    }
    process.exitCode = 1;
  }
}
