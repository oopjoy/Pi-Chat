import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  discardManagedDroppedFile,
  droppedFilesRoot,
  isManagedDroppedFilePath,
  safeDroppedFileName,
  stageDroppedFileBytes,
} from "../src/server/dropped-files";

test("managed dropped paths stay inside the temp tree and discard removes unused files", async () => {
  const root = droppedFilesRoot();
  assert.equal(isManagedDroppedFilePath(root), false);
  assert.equal(isManagedDroppedFilePath(join(root, "..", "outside.txt")), false);
  assert.equal(isManagedDroppedFilePath(join(root, "uuid", "note.log")), true);
  assert.equal(safeDroppedFileName("..\\secret.exe"), "secret.exe");
  assert.equal(safeDroppedFileName(""), "dropped.bin");

  const path = await stageDroppedFileBytes("note.log", Buffer.from("hello"));
  assert.equal(isManagedDroppedFilePath(path), true);
  assert.equal(await readFile(path, "utf8"), "hello");
  await discardManagedDroppedFile(path);
  await assert.rejects(access(path));
  await assert.rejects(discardManagedDroppedFile(resolve("C:\\Windows\\notepad.exe")), /路径无效/);
});
