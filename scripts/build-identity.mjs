import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";

const projectRoot = resolve(process.cwd());
const distRoot = resolve(process.env.PI_CHAT_DIST_DIR || "dist");
const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const inputRoots = ["src", "scripts", "vite.config.ts", "tsconfig.json", "tsconfig.server.json", "package.json", "package-lock.json"];

async function collectFiles(path) {
  const absolute = resolve(projectRoot, path);
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
  if (!entries.length) return [absolute];
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = `${path}${sep}${entry.name}`;
    if (entry.isDirectory()) files.push(...await collectFiles(child));
    else if (entry.isFile()) files.push(resolve(projectRoot, child));
  }
  return files;
}

const files = [];
for (const input of inputRoots) files.push(...await collectFiles(input));
const hash = createHash("sha256");
for (const file of [...new Set(files)].sort()) {
  const name = relative(projectRoot, file).split(sep).join("/");
  hash.update(name);
  hash.update("\0");
  hash.update(await readFile(file));
  hash.update("\0");
}
const fingerprint = hash.digest("hex");
const identity = {
  schemaVersion: 1,
  packageVersion: typeof packageJson.version === "string" ? packageJson.version : "unknown",
  revision: process.env.PI_CHAT_BUILD_REVISION || "unknown",
  fingerprint,
  builtAt: new Date().toISOString(),
};

await mkdir(distRoot, { recursive: true });
await writeFile(resolve(distRoot, "build-identity.json"), `${JSON.stringify(identity, null, 2)}\n`, "utf8");
process.stdout.write(`[Pi Chat] build identity ${fingerprint.slice(0, 12)}\n`);
