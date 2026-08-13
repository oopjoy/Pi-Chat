import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, lstat, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function e2eSessionIdForPath(path) {
  return createHash("sha256").update(resolve(path).toLowerCase()).digest("hex").slice(0, 20);
}

/**
 * Import explicit benchmark-owned JSONL fixtures into an already-disposable
 * E2E Session root. The ordinary E2E fixture remains unchanged when no source
 * directory is supplied.
 */
export async function importE2eSessionFixtures(sourceDirectory, destinationDirectory) {
  if (!sourceDirectory) return [];
  const source = resolve(sourceDirectory);
  const destination = resolve(destinationDirectory);
  const sourceLinkStats = await lstat(source).catch(() => null);
  const sourceStats = await stat(source).catch(() => null);
  if (sourceLinkStats?.isSymbolicLink())
    throw new Error(`E2E fixture source must not be a symbolic link: ${source}`);
  if (!sourceStats?.isDirectory())
    throw new Error(`E2E fixture source is not a directory: ${source}`);

  const imported = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new Error(`E2E fixture source must not contain symbolic links: ${entry.name}`);
    if (!entry.name.toLowerCase().endsWith(".jsonl")) continue;
    const sourcePath = join(source, entry.name);
    const sourceEntry = await lstat(sourcePath);
    if (!entry.isFile() || !sourceEntry.isFile())
      throw new Error(`E2E fixture must be a regular top-level JSONL file: ${entry.name}`);
    const destinationPath = join(destination, entry.name);
    if (await pathExists(destinationPath))
      throw new Error(`E2E fixture name collides with an existing Session: ${entry.name}`);
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
    imported.push(entry.name);
  }
  return imported.sort();
}
