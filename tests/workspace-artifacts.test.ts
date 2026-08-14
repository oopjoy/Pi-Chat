import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyWorkspaceArtifact,
  scanWorkspaceArtifacts,
} from "../scripts/workspace-artifacts.mjs";

async function makeOld(path: string, now: number): Promise<void> {
  const old = new Date(now - 48 * 60 * 60 * 1000);
  await utimes(path, old, old);
}

test("workspace artifact classification excludes restart leases and cleanup quarantine", () => {
  assert.equal(classifyWorkspaceArtifact(".pi-chat-audit-unit-stage", true), "legacy-stage");
  assert.equal(classifyWorkspaceArtifact(".pi-chat-dist-staging-manual", true), "legacy-stage");
  assert.equal(classifyWorkspaceArtifact(".pi-chat-dist-staging-123-456", true), null);
  assert.equal(classifyWorkspaceArtifact(".pi-chat-dist-previous-123-456", true), null);
  assert.equal(classifyWorkspaceArtifact(".pi-chat-cleanup-quarantine-123-x", true), null);
  assert.equal(classifyWorkspaceArtifact("dist", true), null);
  assert.equal(
    classifyWorkspaceArtifact("nul", false),
    process.platform === "win32" ? "windows-nul" : null,
  );
});

test("workspace artifact scan finds only old literal directories outside protected paths", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-artifact-scan-"));
  const now = Date.now();
  const oldStage = join(root, ".pi-chat-old-stage");
  const protectedStage = join(root, ".pi-chat-protected-stage");
  const recentStage = join(root, ".pi-chat-recent-stage");
  const restartStage = join(root, ".pi-chat-dist-staging-123-456");
  try {
    for (const path of [oldStage, protectedStage, recentStage, restartStage]) {
      await mkdir(path);
      await writeFile(join(path, "artifact.txt"), path);
    }
    await makeOld(oldStage, now);
    await makeOld(protectedStage, now);
    await makeOld(restartStage, now);

    const link = join(root, ".pi-chat-linked-stage");
    try {
      await symlink(oldStage, link, process.platform === "win32" ? "junction" : "dir");
      await makeOld(link, now);
    } catch (error) {
      context.diagnostic(`symlink unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const candidates = await scanWorkspaceArtifacts(root, {
      now,
      minAgeHours: 24,
      protectedPaths: [protectedStage],
    });
    assert.deepEqual(candidates.map((candidate) => candidate.name), [
      ".pi-chat-old-stage",
    ]);
    assert.ok(candidates[0]!.bytes > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace artifact scan protects a configured output nested below a root stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-artifact-protected-"));
  const now = Date.now();
  const protectedStage = join(root, ".pi-chat-protected-stage");
  const otherStage = join(root, ".pi-chat-other-stage");
  try {
    for (const path of [protectedStage, otherStage]) {
      await mkdir(join(path, "dist"), { recursive: true });
      await writeFile(join(path, "dist", "artifact.txt"), "old");
      await makeOld(path, now);
    }
    const candidates = await scanWorkspaceArtifacts(root, {
      now,
      minAgeHours: 24,
      protectedPaths: [join(protectedStage, "dist")],
    });
    assert.deepEqual(candidates.map((candidate) => candidate.name), [
      ".pi-chat-other-stage",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
