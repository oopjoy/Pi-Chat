import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { cp as copy, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertCommittedLf } from "../scripts/check-committed-text.mjs";
import {
  assertPortableArtifactName,
  assertReleaseIdentity,
  packageRelease,
  releaseManifest,
  sha256File,
  writePortableChecksum,
} from "../scripts/release-package.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(import.meta.dirname, "..");

function git(args: string[], cwd = repositoryRoot) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

async function archiveEntries(zipPath: string) {
  if (process.platform !== "win32") {
    const { stdout } = await execFile("unzip", ["-Z1", zipPath]);
    return stdout.trim().split(/\r?\n/).filter(Boolean);
  }
  const extraction = await mkdtemp(join(tmpdir(), "pi-chat-archive-inspect-"));
  try {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const command = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(extraction)} -Force`;
    await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
    const entries: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name);
        if (entry.isDirectory()) await visit(child);
        else entries.push(relative(extraction, child).split("\\").join("/"));
      }
    };
    await visit(extraction);
    return entries;
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
}

test("release packaging writes a portable checksum basename", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-release-guards-"));
  try {
    const zipPath = join(root, "pi-chat-windows-0.4.7.zip");
    const checksumPath = join(root, "pi-chat-windows-0.4.7.zip.sha256");
    await writeFile(zipPath, "test archive\n", "utf8");
    const result = await writePortableChecksum({
      zipPath,
      checksumPath,
      artifactName: "pi-chat-windows-0.4.7.zip",
    });
    const checksum = await readFile(checksumPath, "utf8");
    assert.equal(checksum, result.record);
    assert.match(checksum, /^[0-9a-f]{64} \*pi-chat-windows-0\.4\.7\.zip\n$/);
    assert.throws(
      () => assertPortableArtifactName("C:\\temp\\pi-chat-windows-0.4.7.zip"),
      /portable basename/,
    );
    assert.throws(
      () => assertPortableArtifactName("CON.zip"),
      /portable basename/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release identity requires tag, HEAD and embedded identity to agree", () => {
  const identity = {
    schemaVersion: 1,
    revision: "abc123",
    packageVersion: "0.4.7",
    fingerprint: "f".repeat(64),
  };
  assert.doesNotThrow(() => assertReleaseIdentity({
    buildIdentity: identity,
    packageVersion: "0.4.7",
    headRevision: "abc123",
    tagRevision: "abc123",
    tag: "v0.4.7",
  }));
  assert.throws(
    () => assertReleaseIdentity({
      buildIdentity: identity,
      packageVersion: "0.4.7",
      headRevision: "abc123",
      tagRevision: "def456",
      tag: "v0.4.7",
    }),
    /does not match HEAD/,
  );
  assert.throws(
    () => assertReleaseIdentity({
      buildIdentity: identity,
      packageVersion: "0.4.7",
      headRevision: "abc123",
      tagRevision: "abc123",
      tag: "v0.4.8",
    }),
    /does not match package version/,
  );
  assert.throws(
    () => assertReleaseIdentity({
      buildIdentity: { ...identity, schemaVersion: 2 },
      packageVersion: "0.4.7",
      headRevision: "abc123",
      tagRevision: "abc123",
      tag: "v0.4.7",
    }),
    /Unsupported embedded build identity schema/,
  );
  assert.throws(
    () => assertReleaseIdentity({
      buildIdentity: { ...identity, fingerprint: "not-a-fingerprint" },
      packageVersion: "0.4.7",
      headRevision: "abc123",
      tagRevision: "abc123",
      tag: "v0.4.7",
    }),
    /64 lowercase hexadecimal/,
  );
  assert.deepEqual(
    releaseManifest({
      packageVersion: "0.4.7",
      tag: "v0.4.7",
      revision: "abc123",
      buildIdentity: identity,
      zipName: "pi-chat-windows-0.4.7.zip",
      zipSize: 12,
      checksum: "a".repeat(64),
    }),
    {
      schemaVersion: 1,
      packageVersion: "0.4.7",
      tag: "v0.4.7",
      revision: "abc123",
      fingerprint: "f".repeat(64),
      zip: { name: "pi-chat-windows-0.4.7.zip", size: 12, sha256: "a".repeat(64) },
    },
  );
});

test("release build identity uses the exact checked-out commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-release-identity-"));
  try {
    const { stdout: revisionOutput } = await execFile("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
    await execFile(process.execPath, ["scripts/build-identity.mjs"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PI_CHAT_DIST_DIR: root,
        PI_CHAT_RELEASE_MODE: "1",
        PI_CHAT_RELEASE_TAG: "HEAD",
      },
    });
    const identity = JSON.parse(await readFile(join(root, "build-identity.json"), "utf8")) as { revision: string };
    assert.equal(identity.revision, revisionOutput.trim());
    assert.match(identity.revision, /^[0-9a-f]{40}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release build identity rejects a tag that does not point to HEAD", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-release-identity-mismatch-"));
  try {
    await assert.rejects(
      execFile(process.execPath, ["scripts/build-identity.mjs"], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PI_CHAT_DIST_DIR: root,
          PI_CHAT_RELEASE_MODE: "1",
          PI_CHAT_RELEASE_TAG: "HEAD~1",
        },
      }),
      /does not point to checked-out HEAD/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release packaging creates a ZIP, portable checksum and identity manifest", async () => {
  const fixtureRepo = await mkdtemp(join(tmpdir(), "pi-chat-release-repo-"));
  const staging = await mkdtemp(join(tmpdir(), "pi-chat-release-stage-"));
  const output = await mkdtemp(join(tmpdir(), "pi-chat-release-output-"));
  try {
    await copy(join(repositoryRoot, "package.json"), join(fixtureRepo, "package.json"));
    const packageVersion = JSON.parse(
      await readFile(join(fixtureRepo, "package.json"), "utf8"),
    ).version as string;
    await copy(join(repositoryRoot, "README.md"), join(fixtureRepo, "README.md"));
    await copy(join(repositoryRoot, "SECURITY.md"), join(fixtureRepo, "SECURITY.md"));
    await copy(join(repositoryRoot, ".gitattributes"), join(fixtureRepo, ".gitattributes"));
    await copy(join(repositoryRoot, "resources"), join(fixtureRepo, "resources"), { recursive: true });
    for (const file of ["pi-chat-launch.cmd", "start-pi-chat.cmd", "start-pi-chat-ui.ps1"]) {
      await copy(join(repositoryRoot, file), join(fixtureRepo, file));
    }
    await mkdir(join(fixtureRepo, "scripts"), { recursive: true });
    for (const file of ["install-shortcuts.ps1", "pi-chat-launch-process.ps1", "pi-chat-port-ready.ps1"]) {
      await copy(join(repositoryRoot, "scripts", file), join(fixtureRepo, "scripts", file));
    }
    assert.equal(git(["init", "--quiet"], fixtureRepo).status, 0);
    assert.equal(git(["config", "core.autocrlf", "false"], fixtureRepo).status, 0);
    assert.equal(git(["config", "user.email", "pi-chat@example.invalid"], fixtureRepo).status, 0);
    assert.equal(git(["config", "user.name", "Pi Chat Test"], fixtureRepo).status, 0);
    assert.equal(git(["add", "."], fixtureRepo).status, 0);
    assert.equal(git(["commit", "--quiet", "-m", "fixture"], fixtureRepo).status, 0);
    const { stdout: revisionOutput } = await execFile("git", ["rev-parse", "HEAD"], { cwd: fixtureRepo });
    await writeFile(join(staging, "build-identity.json"), JSON.stringify({
      schemaVersion: 1,
      packageVersion,
      revision: revisionOutput.trim(),
      fingerprint: "f".repeat(64),
    }), "utf8");
    await writeFile(join(staging, "marker.txt"), "staged\n", "utf8");
    const result = await packageRelease({
      repoRoot: fixtureRepo,
      stagingDir: staging,
      outputDir: output,
      tag: "HEAD",
      zipName: "pi-chat-windows-test.zip",
    });
    assert.equal((await stat(result.outputPath)).isFile(), true);
    assert.match(await readFile(result.checksumPath, "utf8"), /\*pi-chat-windows-test\.zip\n$/);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
      packageVersion: string;
      tag: string;
      revision: string;
      fingerprint: string;
      zip: { name: string; size: number; sha256: string };
    };
    assert.equal(manifest.packageVersion, packageVersion);
    assert.equal(manifest.tag, "HEAD");
    assert.equal(manifest.revision, revisionOutput.trim());
    assert.equal(manifest.fingerprint, "f".repeat(64));
    assert.equal(manifest.zip.name, "pi-chat-windows-test.zip");
    assert.equal(manifest.zip.size, (await stat(result.outputPath)).size);
    assert.equal(manifest.zip.sha256, await sha256File(result.outputPath));
    assert.equal(manifest.zip.sha256, (await readFile(result.checksumPath, "utf8")).split(" ")[0]);
    const entries = await archiveEntries(result.outputPath);
    for (const entry of [
      `pi-chat-windows-${packageVersion}/pi-chat-launch.cmd`,
      `pi-chat-windows-${packageVersion}/SECURITY.md`,
      `pi-chat-windows-${packageVersion}/start-pi-chat-ui.ps1`,
      `pi-chat-windows-${packageVersion}/scripts/pi-chat-launch-process.ps1`,
      `pi-chat-windows-${packageVersion}/scripts/pi-chat-port-ready.ps1`,
      `pi-chat-windows-${packageVersion}/resources/icons/pi-chat.ico`,
      `pi-chat-windows-${packageVersion}/dist/build-identity.json`,
    ]) assert.ok(entries.includes(entry), `missing ZIP entry: ${entry}`);
    await writeFile(join(output, "pi-chat-windows-dirty.zip.sha256"), "stale\n", "utf8");
    await writeFile(join(output, "pi-chat-windows-dirty.zip.manifest.json"), "stale\n", "utf8");
    await writeFile(join(fixtureRepo, "README.md"), "dirty release source\n", "utf8");
    await assert.rejects(
      packageRelease({
        repoRoot: fixtureRepo,
        stagingDir: staging,
        outputDir: output,
        tag: "HEAD",
        zipName: "pi-chat-windows-dirty.zip",
      }),
      /clean Git worktree/,
    );
    await assert.rejects(stat(join(output, "pi-chat-windows-dirty.zip.sha256")), /ENOENT/);
    await assert.rejects(stat(join(output, "pi-chat-windows-dirty.zip.manifest.json")), /ENOENT/);
  } finally {
    await rm(fixtureRepo, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test("release packaging rejects live-dist aliases and overlapping staging/output", async () => {
  const stage = await mkdtemp(join(tmpdir(), "pi-chat-release-overlap-stage-"));
  const output = join(stage, "output");
  const safeOutput = await mkdtemp(join(tmpdir(), "pi-chat-release-safe-output-"));
  try {
    await mkdir(output, { recursive: true });
    await assert.rejects(
      packageRelease({ repoRoot: repositoryRoot, stagingDir: stage, outputDir: output, tag: "HEAD" }),
      /distinct, non-overlapping directories/,
    );
    await assert.rejects(
      packageRelease({ repoRoot: repositoryRoot, stagingDir: join(repositoryRoot, "dist"), outputDir: safeOutput, tag: "HEAD" }),
      /must not be live dist/,
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(safeOutput, { recursive: true, force: true });
  }
});

test("push diff policy distinguishes branch, tag and deleted-ref failures", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/windows-ci.yml"), "utf8");
  assert.match(workflow, /github\.ref_type/);
  assert.match(workflow, /github\.event\.deleted != true/);
  assert.match(workflow, /Cannot resolve github\.event\.before for a branch push/);
  assert.match(workflow, /node scripts\/check-committed-text\.mjs --all/);
  assert.match(workflow, /Unsupported push ref type/);
});

test("branch CI and tag release CI are separated and every third-party action is SHA pinned", async () => {
  const workflowDirectory = join(repositoryRoot, ".github", "workflows");
  const workflowNames = (await readdir(workflowDirectory)).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  assert.ok(workflowNames.includes("windows-ci.yml"));
  assert.ok(workflowNames.includes("windows-release-ci.yml"));
  const workflows = await Promise.all(workflowNames.map(async (name) => [
    name,
    await readFile(join(workflowDirectory, name), "utf8"),
  ] as const));
  const branch = workflows.find(([name]) => name === "windows-ci.yml")?.[1] || "";
  const release = workflows.find(([name]) => name === "windows-release-ci.yml")?.[1] || "";
  assert.match(branch, /push:\n\s+branches:\n\s+- main/);
  assert.doesNotMatch(branch, /tags:/);
  assert.match(release, /push:\n\s+tags:\n\s+- ["']?v\*/);
  assert.match(release, /PI_CHAT_RELEASE_MODE: ["']?1/);
  assert.match(release, /PI_CHAT_RELEASE_TAG: \$\{\{ github\.ref_name \}\}/);
  for (const [name, workflow] of workflows) {
    for (const match of workflow.matchAll(/uses:\s*([^\s#]+)/g)) {
      const reference = match[1];
      if (!reference.startsWith("actions/")) continue;
      assert.match(reference, /@[0-9a-f]{40}$/, `${name} must pin ${reference} to a full commit SHA`);
    }
  }
});

test("the committed workflow blob is LF even when Windows checkout conversion is enabled", async () => {
  await assertCommittedLf({
    repoRoot: repositoryRoot,
    paths: [".github/workflows/windows-ci.yml"],
  });
});

test("committed text check rejects CR bytes in a Git blob", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-committed-text-"));
  try {
    assert.equal(git(["init", "--quiet"], root).status, 0);
    assert.equal(git(["config", "core.autocrlf", "false"], root).status, 0);
    assert.equal(git(["config", "user.email", "pi-chat@example.invalid"], root).status, 0);
    assert.equal(git(["config", "user.name", "Pi Chat Test"], root).status, 0);
    await writeFile(join(root, "sample.yml"), "name: bad\r\n", "utf8");
    assert.equal(git(["add", "sample.yml"], root).status, 0);
    assert.equal(git(["commit", "--quiet", "-m", "fixture"], root).status, 0);
    await assert.rejects(
      assertCommittedLf({ repoRoot: root, paths: ["sample.yml"] }),
      /contains CR bytes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
