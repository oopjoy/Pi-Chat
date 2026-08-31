import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { assertCommittedLf } from "./check-committed-text.mjs";
import { validateDistTarget } from "./dist-paths.mjs";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(import.meta.dirname, "..");
const packageFiles = [
  "package.json",
  "README.md",
  "pi-chat-launch.cmd",
  "start-pi-chat.cmd",
  "start-pi-chat-ui.ps1",
  "resources",
  "scripts/install-shortcuts.ps1",
  "scripts/pi-chat-launch-process.ps1",
  "scripts/pi-chat-port-ready.ps1",
];

export function assertPortableArtifactName(name) {
  if (
    !name
    || name !== basename(name)
    || /[\\/:\u0000-\u001f\u007f]/.test(name)
    || name === "."
    || name === ".."
    || /[ .]$/.test(name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)
  ) {
    throw new Error(`Artifact name must be a portable basename: ${name}`);
  }
  if (!name.endsWith(".zip")) throw new Error(`Artifact must be a ZIP: ${name}`);
  return name;
}

export async function sha256File(path) {
  const contents = await readFile(path);
  return createHash("sha256").update(contents).digest("hex");
}

export async function writePortableChecksum({ zipPath, checksumPath, artifactName = basename(zipPath) }) {
  assertPortableArtifactName(artifactName);
  const checksum = await sha256File(zipPath);
  const record = `${checksum} *${artifactName}\n`;
  await writeFile(checksumPath, record, "utf8");
  return { checksum, record };
}

export function assertReleaseIdentity({ buildIdentity, packageVersion, headRevision, tagRevision, tag }) {
  if (buildIdentity?.schemaVersion !== 1) {
    throw new Error(`Unsupported embedded build identity schema: ${buildIdentity?.schemaVersion}`);
  }
  if (!/^[a-f0-9]{64}$/.test(buildIdentity?.fingerprint || "")) {
    throw new Error("Embedded build fingerprint must be 64 lowercase hexadecimal characters");
  }
  if (headRevision !== tagRevision) {
    throw new Error(`Release tag ${tag} does not match HEAD ${headRevision}`);
  }
  if (buildIdentity.revision !== headRevision) {
    throw new Error(
      `Embedded build revision ${buildIdentity.revision} does not match release revision ${headRevision}`,
    );
  }
  if (buildIdentity.packageVersion !== packageVersion) {
    throw new Error(
      `Embedded package version ${buildIdentity.packageVersion} does not match ${packageVersion}`,
    );
  }
}

export function releaseManifest({ packageVersion, tag, revision, buildIdentity, zipName, zipSize, checksum }) {
  return {
    schemaVersion: 1,
    packageVersion,
    tag,
    revision,
    fingerprint: buildIdentity.fingerprint,
    zip: { name: zipName, size: zipSize, sha256: checksum },
  };
}

async function gitCommit(repoRoot, ref) {
  const { stdout } = await execFile("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repoRoot,
    windowsHide: true,
  });
  return stdout.trim();
}

async function assertCleanWorktree(repoRoot) {
  const { stdout } = await execFile("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: repoRoot,
    windowsHide: true,
  });
  if (stdout.trim()) {
    throw new Error("Release packaging requires a clean Git worktree");
  }
}

async function canonicalExistingPath(path) {
  const suffix = [];
  let current = resolve(path);
  while (true) {
    try {
      const existing = await realpath(current);
      return resolve(existing, ...suffix.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(current, ...suffix.reverse());
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function sameOrInside(base, target) {
  const remainder = relative(base, target);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

async function createArchive({ packageRootName, outputPath, packageStage }) {
  if (process.platform === "win32") {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const command = `$ErrorActionPreference='Stop'; Compress-Archive -Path ${quote(packageRootName)} -DestinationPath ${quote(outputPath)} -Force`;
    await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: packageStage,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return;
  }
  await execFile("zip", ["-q", "-9", "-r", outputPath, packageRootName], {
    cwd: packageStage,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

export async function packageRelease({
  repoRoot = projectRoot,
  stagingDir,
  outputDir,
  tag,
  zipName,
} = {}) {
  if (!stagingDir || !outputDir || !tag) {
    throw new Error("stagingDir, outputDir and tag are required");
  }
  const root = resolve(repoRoot);
  const stage = resolve(stagingDir);
  const output = resolve(outputDir);
  const liveDist = resolve(root, "dist");
  const stageValidation = validateDistTarget({ projectRoot: root, requested: stage });
  if (stageValidation.kind === "live") throw new Error("Release staging must not be live dist");
  const outputValidation = validateDistTarget({ projectRoot: root, requested: output });
  if (outputValidation.kind === "live") throw new Error("Release output must not be live dist");
  const canonicalLive = await canonicalExistingPath(liveDist);
  const canonicalStage = await canonicalExistingPath(stage);
  const canonicalOutput = await canonicalExistingPath(output);
  if (sameOrInside(canonicalLive, canonicalStage) || sameOrInside(canonicalLive, canonicalOutput)) {
    throw new Error("Release staging and output must not resolve inside live dist");
  }
  if (sameOrInside(canonicalStage, canonicalOutput) || sameOrInside(canonicalOutput, canonicalStage)) {
    throw new Error("Release staging and output must be distinct, non-overlapping directories");
  }
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const finalZipName = assertPortableArtifactName(zipName || `pi-chat-windows-${packageJson.version}.zip`);
  const outputPath = join(output, finalZipName);
  const checksumPath = `${outputPath}.sha256`;
  const manifestPath = `${outputPath}.manifest.json`;
  await mkdir(output, { recursive: true });
  await Promise.all([
    rm(outputPath, { force: true }),
    rm(checksumPath, { force: true }),
    rm(manifestPath, { force: true }),
  ]);
  await assertCleanWorktree(root);
  await access(join(stage, "build-identity.json"));
  await assertCommittedLf({ repoRoot: root });

  const headRevision = await gitCommit(root, "HEAD");
  const tagRevision = await gitCommit(root, tag);
  const buildIdentity = JSON.parse(await readFile(join(stage, "build-identity.json"), "utf8"));
  assertReleaseIdentity({
    buildIdentity,
    packageVersion: packageJson.version,
    headRevision,
    tagRevision,
    tag,
  });

  const packageRootName = `pi-chat-windows-${packageJson.version}`;
  const packageStage = await mkdtemp(join(output, ".pi-chat-package-"));
  const packageRoot = join(packageStage, packageRootName);
  try {
    await mkdir(packageRoot, { recursive: true });
    for (const file of packageFiles) await cp(join(root, file), join(packageRoot, file), { recursive: true });
    await cp(stage, join(packageRoot, "dist"), { recursive: true });
    await createArchive({ packageRootName, outputPath, packageStage });
    const { checksum } = await writePortableChecksum({
      zipPath: outputPath,
      checksumPath,
      artifactName: finalZipName,
    });
    const zipStat = await stat(outputPath);
    const manifest = releaseManifest({
      packageVersion: packageJson.version,
      tag,
      revision: headRevision,
      buildIdentity,
      zipName: finalZipName,
      zipSize: zipStat.size,
      checksum,
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { outputPath, checksumPath, manifestPath, manifest };
  } catch (error) {
    await Promise.all([
      rm(outputPath, { force: true }),
      rm(checksumPath, { force: true }),
      rm(manifestPath, { force: true }),
    ]);
    throw error;
  } finally {
    await rm(packageStage, { recursive: true, force: true });
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const stagingDir = option(args, "--staging");
  const outputDir = option(args, "--output");
  const tag = option(args, "--tag");
  if (args.includes("--help") || !stagingDir || !outputDir || !tag || args.length % 2 !== 0) {
    console.error("Usage: node scripts/release-package.mjs --staging <dir> --output <dir> --tag <tag> [--zip-name <name>]");
    process.exitCode = 2;
    return;
  }
  const result = await packageRelease({
    stagingDir,
    outputDir,
    tag,
    zipName: option(args, "--zip-name"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(`[Pi Chat] Release packaging failed: ${error.message}`);
    process.exitCode = 1;
  });
}
