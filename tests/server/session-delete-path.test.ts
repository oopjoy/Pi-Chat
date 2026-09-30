import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateSessionDeletePath } from "../../src/server/services/session-delete-path";
import { idForPath } from "../../src/server/session-index";

test("Session delete path validation accepts only the indexed in-root JSONL identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-delete-path-"));
  try {
    const path = join(root, "session.jsonl");
    await writeFile(path, "{}\n");
    const id = idForPath(path);
    const result = await validateSessionDeletePath({
      sessionRoot: () => root,
      indexedPath: () => path,
    }, path, id);
    assert.equal(result, resolve(path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Session delete path validation rejects outside and symlink targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-delete-path-reject-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "pi-chat-delete-outside-"));
  try {
    const outside = join(outsideRoot, "outside.jsonl");
    await writeFile(outside, "{}\n");
    await assert.rejects(
      () => validateSessionDeletePath({ sessionRoot: () => root, indexedPath: () => outside }, outside, idForPath(outside)),
      /不在 Session 目录内|索引不一致/,
    );
    const link = join(root, "link.jsonl");
    try {
      await symlink(outside, link);
      await assert.rejects(
        () => validateSessionDeletePath({ sessionRoot: () => root, indexedPath: () => link }, link, idForPath(link)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  }
});
