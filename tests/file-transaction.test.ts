import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { snapshotFile, writeFileAtomic } from "../src/server/file-transaction";

test("file snapshots restore existing content after an atomic mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-file-transaction-"));
  const path = join(root, "settings.json");
  try {
    await writeFileAtomic(path, "old\n");
    const snapshot = await snapshotFile(path);
    await writeFileAtomic(path, "new\n");
    assert.equal(await readFile(path, "utf8"), "new\n");
    await snapshot.restore();
    assert.equal(await readFile(path, "utf8"), "old\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a snapshot of a missing file removes a newly created mutation on rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-file-transaction-"));
  const path = join(root, "models.json");
  try {
    const snapshot = await snapshotFile(path);
    await writeFileAtomic(path, "created\n");
    await snapshot.restore();
    assert.equal(existsSync(path), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
