import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(process.cwd());
const distRoot = resolve(process.env.PI_CHAT_DIST_DIR || "dist");
const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const inputRoots = [
  "src",
  "scripts",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.server.json",
  "package.json",
  "package-lock.json",
  "README.md",
  "pi-chat-launch.cmd",
  "start-pi-chat.cmd",
  "start-pi-chat-ui.ps1",
  "resources",
];

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

export async function resolveReleaseRevision({
  cwd = projectRoot,
  tag = process.env.PI_CHAT_RELEASE_TAG?.trim(),
  runGit = (args) => execFile("git", args, { cwd, windowsHide: true }),
} = {}) {
  if (!tag) throw new Error("PI_CHAT_RELEASE_TAG is required for a release build");
  const [{ stdout: headOutput }, { stdout: tagOutput }] = await Promise.all([
    runGit(["rev-parse", "--verify", "HEAD^{commit}"]),
    runGit(["rev-parse", "--verify", `${tag}^{commit}`]),
  ]);
  const head = headOutput.trim();
  const tagCommit = tagOutput.trim();
  if (!head || !tagCommit || head !== tagCommit) {
    throw new Error(`Release tag ${tag} does not point to checked-out HEAD`);
  }
  return head;
}

async function buildRevision() {
  if (process.env.PI_CHAT_RELEASE_MODE === "1") {
    return resolveReleaseRevision();
  }
  const configured = process.env.PI_CHAT_BUILD_REVISION?.trim();
  if (configured) return configured;
  try {
    const { stdout } = await execFile("git", ["rev-parse", "--short", "HEAD"], {
      cwd: projectRoot,
      windowsHide: true,
    });
    return stdout.trim() || "unknown";
  } catch {
    // Packaged/source-only builds may intentionally run without Git metadata.
    return "unknown";
  }
}

const identity = {
  schemaVersion: 1,
  packageVersion: typeof packageJson.version === "string" ? packageJson.version : "unknown",
  revision: await buildRevision(),
  fingerprint,
  builtAt: new Date().toISOString(),
};

await mkdir(distRoot, { recursive: true });
await writeFile(resolve(distRoot, "build-identity.json"), `${JSON.stringify(identity, null, 2)}\n`, "utf8");
process.stdout.write(`[Pi Chat] build identity ${fingerprint.slice(0, 12)}\n`);
