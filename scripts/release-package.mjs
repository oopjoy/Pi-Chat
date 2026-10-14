import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { assertCommittedLf } from "./check-committed-text.mjs";
import { validateDistTarget } from "./dist-paths.mjs";
import { assertRuntimeFiles } from "./check-runtime-files.mjs";
import { buildSetup } from "./setup-package.mjs";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(import.meta.dirname, "..");

export function assertSetupArtifactName(name) {
  if (!name || name !== basename(name) || /[\\/:\u0000-\u001f\u007f]/.test(name)
    || /[ .]$/.test(name) || !/^pi-chat-setup(?:-\d+\.\d+\.\d+)?\.exe$/.test(name)) {
    throw new Error("Setup artifact must be a portable basename named pi-chat-setup[version].exe");
  }
  return name;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function writeArtifactChecksum({ artifactPath, checksumPath, artifactName = basename(artifactPath) }) {
  assertSetupArtifactName(artifactName);
  const checksum = await sha256File(artifactPath);
  const record = `${checksum} *${artifactName}\n`;
  await writeFile(checksumPath, record, "utf8");
  return { checksum, record };
}

export function assertReleaseIdentity({ buildIdentity, packageVersion, headRevision, tagRevision, tag }) {
  if (buildIdentity?.schemaVersion !== 1) throw new Error(`Unsupported embedded build identity schema: ${buildIdentity?.schemaVersion}`);
  if (!/^[a-f0-9]{64}$/.test(buildIdentity?.fingerprint || "")) throw new Error("Embedded build fingerprint must be 64 lowercase hexadecimal characters");
  if (tag !== "HEAD" && tag !== `v${packageVersion}`) throw new Error(`Release tag ${tag} does not match package version ${packageVersion}`);
  if (headRevision !== tagRevision) throw new Error(`Release tag ${tag} does not match HEAD ${headRevision}`);
  if (buildIdentity.revision !== headRevision) throw new Error(`Embedded build revision ${buildIdentity.revision} does not match release revision ${headRevision}`);
  if (buildIdentity.packageVersion !== packageVersion) throw new Error(`Embedded package version ${buildIdentity.packageVersion} does not match ${packageVersion}`);
}

export function releaseManifest({ packageVersion, tag, revision, buildIdentity, setupName, setupSize, checksum, runtime }) {
  return { schemaVersion: 2, packageVersion, tag, revision, fingerprint: buildIdentity.fingerprint,
    setup: { name: setupName, size: setupSize, sha256: checksum, format: "inno-setup" }, runtime };
}

async function gitCommit(repoRoot, ref) {
  const { stdout } = await execFile("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoRoot, windowsHide: true });
  return stdout.trim();
}

async function assertCleanWorktree(repoRoot) {
  const { stdout } = await execFile("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repoRoot, windowsHide: true });
  if (stdout.trim()) throw new Error("Release packaging requires a clean Git worktree");
}

async function canonicalExistingPath(path) {
  const suffix = [];
  let current = resolve(path);
  while (true) {
    try { return resolve(await realpath(current), ...suffix); }
    catch {
      const parent = dirname(current);
      if (parent === current) return resolve(current, ...suffix);
      suffix.unshift(basename(current)); current = parent;
    }
  }
}

function sameOrInside(base, target) {
  const remainder = relative(base, target);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

export async function packageRelease({ repoRoot = projectRoot, stagingDir, outputDir, tag, setupName = "pi-chat-setup.exe", buildInstaller = buildSetup } = {}) {
  if (!stagingDir || !outputDir || !tag) throw new Error("stagingDir, outputDir and tag are required");
  const root = resolve(repoRoot), stage = resolve(stagingDir), output = resolve(outputDir);
  for (const path of [stage, output]) {
    if (validateDistTarget({ projectRoot: root, requested: path }).kind === "live") throw new Error("Release staging/output must not be live dist");
  }
  const live = await canonicalExistingPath(resolve(root, "dist"));
  const canonicalStage = await canonicalExistingPath(stage), canonicalOutput = await canonicalExistingPath(output);
  if (sameOrInside(live, canonicalStage) || sameOrInside(live, canonicalOutput)) throw new Error("Release staging/output must not resolve inside live dist");
  if (sameOrInside(canonicalStage, canonicalOutput) || sameOrInside(canonicalOutput, canonicalStage)) throw new Error("Release staging and output must be distinct, non-overlapping directories");
  const name = assertSetupArtifactName(setupName);
  const outputPath = resolve(output, name), checksumPath = outputPath + ".sha256", manifestPath = outputPath + ".manifest.json";
  const cleanup = () => Promise.all([outputPath, checksumPath, manifestPath].map(path => rm(path, { force: true })));
  await mkdir(output, { recursive: true });
  await cleanup();
  try {
    await assertCleanWorktree(root);
    await assertCommittedLf({ repoRoot: root });
    const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    const headRevision = await gitCommit(root, "HEAD"), tagRevision = await gitCommit(root, tag);
    const buildIdentity = JSON.parse(await readFile(resolve(stage, "build-identity.json"), "utf8"));
    assertReleaseIdentity({ buildIdentity, packageVersion: packageJson.version, headRevision, tagRevision, tag });
    await assertRuntimeFiles(root, stage);
    await access(resolve(root, "LICENSE"));
    const runtime = await buildInstaller({ repoRoot: root, stagingDir: stage, outputPath });
    const { checksum } = await writeArtifactChecksum({ artifactPath: outputPath, checksumPath });
    const manifest = releaseManifest({ packageVersion: packageJson.version, tag, revision: headRevision, buildIdentity, setupName: name, setupSize: (await stat(outputPath)).size, checksum, runtime });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { outputPath, checksumPath, manifestPath, manifest };
  } catch (error) { await cleanup(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  const allowed = ["--staging", "--output", "--tag"];
  if (args.length !== 6 || !allowed.every(name => args.includes(name))) {
    console.error("Usage: node scripts/release-package.mjs --staging <isolated-dist> --output <dir> --tag <tag>");
    process.exitCode = 2;
  } else packageRelease({ stagingDir: option("--staging"), outputDir: option("--output"), tag: option("--tag") })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(`[Pi Chat] Release packaging failed: ${error.message}`, error.stderr || ""); process.exitCode = 1; });
}
