import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertCommittedLf } from "../scripts/check-committed-text.mjs";
import { applicationPackageFiles } from "../scripts/setup-package.mjs";
import { assertSetupArtifactName, assertReleaseIdentity, isSetupPreviewTag, packageRelease, releaseManifest, sha256File, writeArtifactChecksum } from "../scripts/release-package.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(import.meta.dirname, "..");
const runtime = { nodeVersion: "22.19.0", nodeArchiveSha256: "a".repeat(64), compilerVersion: "6.4.3" };
const git = (args: string[], cwd = repositoryRoot) => spawnSync("git", args, { cwd, encoding: "utf8" });

test("release packaging emits only Setup names and path-free checksum records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-release-guards-"));
  try {
    const artifactPath = join(root, "pi-chat-setup.exe"), checksumPath = artifactPath + ".sha256";
    await writeFile(artifactPath, "MZ fixture\n");
    const result = await writeArtifactChecksum({ artifactPath, checksumPath });
    assert.equal(await readFile(checksumPath, "utf8"), result.record);
    assert.match(result.record, /^[0-9a-f]{64} \*pi-chat-setup\.exe\n$/);
    for (const invalid of ["C:/temp/pi-chat-setup.exe", "CON.exe", "pi-chat-setup-web.exe", "pi-chat-windows.zip", "../pi-chat-setup.exe"]) assert.throws(() => assertSetupArtifactName(invalid), /portable basename/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release identity requires tag, HEAD and embedded identity to agree", () => {
  const identity = { schemaVersion: 1, revision: "abc123", packageVersion: "0.5.2", fingerprint: "f".repeat(64) };
  const input = { buildIdentity: identity, packageVersion: "0.5.2", headRevision: "abc123", tagRevision: "abc123", tag: "v0.5.2" };
  assert.doesNotThrow(() => assertReleaseIdentity(input));
  assert.throws(() => assertReleaseIdentity({ ...input, tagRevision: "different" }), /does not match HEAD/);
  assert.throws(() => assertReleaseIdentity({ ...input, tag: "v0.5.3" }), /does not match package version/);
  assert.throws(() => assertReleaseIdentity({ ...input, buildIdentity: { ...identity, schemaVersion: 2 } }), /Unsupported embedded/);
  assert.throws(() => assertReleaseIdentity({ ...input, buildIdentity: { ...identity, fingerprint: "invalid" } }), /64 lowercase hexadecimal/);
  assert.throws(() => assertReleaseIdentity({ ...input, buildIdentity: { ...identity, revision: "old" } }), /does not match release revision/);
  assert.throws(() => assertReleaseIdentity({ ...input, buildIdentity: { ...identity, packageVersion: "0.5.1" } }), /does not match/);
  assert.deepEqual(releaseManifest({ packageVersion: "0.5.2", tag: "v0.5.2", revision: "abc123", buildIdentity: identity, setupName: "pi-chat-setup.exe", setupSize: 12, checksum: "a".repeat(64), runtime }), {
    schemaVersion: 2, packageVersion: "0.5.2", tag: "v0.5.2", revision: "abc123", fingerprint: identity.fingerprint,
    setup: { name: "pi-chat-setup.exe", size: 12, sha256: "a".repeat(64), format: "inno-setup" }, runtime,
  });
});

test("Setup previews bind the package version and exact revision without weakening stable-tag checks", () => {
  const revision = "a".repeat(40);
  const tag = `v0.5.2-setup-preview.${revision.slice(0, 12)}`;
  const input = { buildIdentity: { schemaVersion: 1, revision, packageVersion: "0.5.2", fingerprint: "f".repeat(64) }, packageVersion: "0.5.2", headRevision: revision, tagRevision: revision, tag };
  assert.equal(isSetupPreviewTag(tag, "0.5.2", revision), true);
  assert.doesNotThrow(() => assertReleaseIdentity(input));
  for (const wrong of ["v0.5.3", "v0.5.2-beta", "v0.5.2-setup-preview.bbbbbbbbbbbb", "v0.6.0-setup-preview.aaaaaaaaaaaa"]) {
    assert.equal(isSetupPreviewTag(wrong, "0.5.2", revision), false);
    assert.throws(() => assertReleaseIdentity({ ...input, tag: wrong }), /does not match package version/);
  }
  assert.throws(() => assertReleaseIdentity({ ...input, tagRevision: "b".repeat(40) }), /does not match HEAD/);
});

test("release build identity uses the exact checked-out commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-release-identity-"));
  try {
    await execFile(process.execPath, ["scripts/build-identity.mjs"], { cwd: repositoryRoot, env: { ...process.env, PI_CHAT_DIST_DIR: root, PI_CHAT_RELEASE_MODE: "1", PI_CHAT_RELEASE_TAG: "HEAD" } });
    const identity = JSON.parse(await readFile(join(root, "build-identity.json"), "utf8"));
    assert.equal(identity.revision, git(["rev-parse", "HEAD"]).stdout.trim());
    assert.match(identity.revision, /^[a-f0-9]{40}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release build identity rejects a tag that does not point to HEAD", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-release-identity-"));
  try {
    await assert.rejects(execFile(process.execPath, ["scripts/build-identity.mjs"], { cwd: repositoryRoot, env: { ...process.env, PI_CHAT_DIST_DIR: root, PI_CHAT_RELEASE_MODE: "1", PI_CHAT_RELEASE_TAG: "HEAD~1" } }), /does not point to checked-out HEAD/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release packaging produces one Setup and matching sidecars, with no ZIP or Web executable", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-chat-release-repo-"));
  const stage = await mkdtemp(join(tmpdir(), "pi-chat-release-stage-"));
  const output = await mkdtemp(join(tmpdir(), "pi-chat-release-output-"));
  try {
    for (const file of [...applicationPackageFiles, ".gitattributes"]) await cp(join(repositoryRoot, file), join(repo, file), { recursive: true });
    for (const args of [["init", "--quiet"], ["config", "core.autocrlf", "false"], ["config", "user.email", "pi-chat@example.invalid"], ["config", "user.name", "Pi Chat Test"], ["add", "."], ["commit", "--quiet", "-m", "fixture"]]) assert.equal(git(args, repo).status, 0);
    const revision = git(["rev-parse", "HEAD"], repo).stdout.trim();
    const version = JSON.parse(await readFile(join(repo, "package.json"), "utf8")).version;
    const required: string[] = JSON.parse(await readFile(join(repositoryRoot, "scripts/runtime-required-files.json"), "utf8"));
    for (const file of required.filter(name => name.startsWith("dist/"))) {
      const path = join(stage, file.slice(5)); await mkdir(resolve(path, ".."), { recursive: true }); await writeFile(path, "fixture\n");
    }
    await writeFile(join(stage, "build-identity.json"), JSON.stringify({ schemaVersion: 1, packageVersion: version, revision, fingerprint: "f".repeat(64) }));
    await mkdir(join(stage, "web/assets")); await writeFile(join(stage, "web/assets/index.js"), "//fixture");
    await writeFile(join(stage, "web/index.html"), '<script src="/assets/index.js"></script>');
    const buildInstaller = async (input: { outputPath: string }) => { await writeFile(input.outputPath, "MZ fixture"); return runtime; };
    const input = { repoRoot: repo, stagingDir: stage, outputDir: output, tag: "HEAD", buildInstaller };
    const result = await packageRelease(input);
    assert.deepEqual((await readdir(output)).sort(), ["pi-chat-setup.exe", "pi-chat-setup.exe.manifest.json", "pi-chat-setup.exe.sha256"]);
    assert.equal(result.manifest.revision, revision);
    assert.equal(result.manifest.fingerprint, "f".repeat(64));
    assert.equal(result.manifest.setup.sha256, await sha256File(result.outputPath));
    assert.deepEqual(result.manifest.runtime, runtime);
    assert.match(await readFile(result.checksumPath, "utf8"), /\*pi-chat-setup\.exe\n$/);
    await rm(join(stage, "server/server/index.js"));
    await assert.rejects(packageRelease(input), /runtime files are missing/);
    for (const path of [result.outputPath, result.checksumPath, result.manifestPath]) await assert.rejects(stat(path), /ENOENT/);
    await writeFile(join(repo, "README.md"), "dirty source\n");
    await assert.rejects(packageRelease(input), /clean Git worktree/);
    await assert.rejects(packageRelease({ ...input, setupName: "pi-chat-setup-web.exe" }), /portable basename/);
  } finally { for (const path of [repo, stage, output]) await rm(path, { recursive: true, force: true }); }
});

test("release packaging rejects live-dist aliases and overlapping staging/output", async () => {
  const stage = await mkdtemp(join(tmpdir(), "pi-chat-release-overlap-"));
  const output = await mkdtemp(join(tmpdir(), "pi-chat-release-output-"));
  try {
    await assert.rejects(packageRelease({ stagingDir: stage, outputDir: join(stage, "output"), tag: "HEAD" }), /distinct, non-overlapping/);
    await assert.rejects(packageRelease({ stagingDir: join(repositoryRoot, "dist"), outputDir: output, tag: "HEAD" }), /must not be live dist/);
  } finally { await rm(stage, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
});

test("push diff policy distinguishes branch, tag and deleted-ref failures", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github/workflows/windows-ci.yml"), "utf8");
  for (const pattern of [/github\.ref_type/, /github\.event\.deleted != true/, /Cannot resolve github.event.before/, /check-committed-text.mjs --all/, /Unsupported push ref type/]) assert.match(workflow, pattern);
});

test("branch CI and tag release CI are separated and every third-party action is SHA pinned", async () => {
  for (const name of (await readdir(join(repositoryRoot, ".github/workflows"))).filter(name => /\.ya?ml$/.test(name))) {
    const source = await readFile(join(repositoryRoot, ".github/workflows", name), "utf8");
    for (const match of source.matchAll(/uses:\s*(actions\/[^\s#]+)/g)) assert.match(match[1], /@[a-f0-9]{40}$/);
    if (name === "windows-ci.yml") { assert.match(source, /push:\n\s+branches:/); assert.doesNotMatch(source, /tags:/); }
    if (name === "windows-release-ci.yml") {
      assert.match(source, /push:\n\s+tags:/); assert.match(source, /PI_CHAT_RELEASE_MODE: ["']?1/);
      assert.match(source, /pi-chat-setup.exe/); assert.doesNotMatch(source, /--clobber|Filter "\*\.zip"/);
      assert.match(source, /\$channelArgs = @\('--prerelease', '--latest=false'\)/);
      assert.match(source, /Preview tag must name the exact checked-out revision/);
    }
  }
});

test("main Setup delivery is verified and commit-addressed without release or tag writes", async () => {
  const source = await readFile(join(repositoryRoot, ".github/workflows/windows-ci.yml"), "utf8");
  assert.match(source, /contents: read/);
  assert.match(source, /name: pi-chat-setup-main-\$\{\{ github.sha \}\}/);
  assert.match(source, /--tag HEAD/);
  assert.match(source, /\$manifest\.revision -ne \$env:GITHUB_SHA/);
  assert.match(source, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Main Setup artifact verification failed' \}/);
  assert.doesNotMatch(source, /git push|git tag|gh release|contents: write/);
  assert.ok(source.indexOf("Verify self-contained Setup") < source.indexOf("Upload verified main Setup"));
  assert.ok(source.indexOf("Main Setup artifact verification failed") < source.indexOf("Upload verified main Setup"));
});

test("the committed workflow blob is LF even when Windows checkout conversion is enabled", async () => {
  await assertCommittedLf({ repoRoot: repositoryRoot, paths: [".github/workflows/windows-ci.yml"] });
});

test("committed text check rejects CR bytes in a Git blob", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-committed-text-"));
  try {
    for (const args of [["init", "--quiet"], ["config", "core.autocrlf", "false"], ["config", "user.email", "pi-chat@example.invalid"], ["config", "user.name", "Pi Chat Test"]]) git(args, root);
    await writeFile(join(root, "sample.yml"), "name: bad\r\n"); git(["add", "."], root); git(["commit", "--quiet", "-m", "fixture"], root);
    await assert.rejects(assertCommittedLf({ repoRoot: root, paths: ["sample.yml"] }), /contains CR bytes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
