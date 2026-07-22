import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileSnapshot {
  readonly path: string;
  restore(): Promise<void>;
}

export async function writeFileAtomic(path: string, content: string | Buffer, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const effectiveMode = mode ?? (existsSync(path) ? (await stat(path)).mode : undefined);
  const temporary = `${path}.pi-chat-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, content, effectiveMode === undefined ? undefined : { mode: effectiveMode });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function snapshotFile(path: string): Promise<FileSnapshot> {
  const existed = existsSync(path);
  const content = existed ? await readFile(path) : null;
  const mode = existed ? (await stat(path)).mode : undefined;
  return {
    path,
    async restore(): Promise<void> {
      if (content === null) {
        await rm(path, { force: true });
        return;
      }
      await writeFileAtomic(path, content, mode);
    },
  };
}

export async function restoreSnapshots(snapshots: FileSnapshot[]): Promise<void> {
  const errors: string[] = [];
  for (const snapshot of [...snapshots].reverse()) {
    try { await snapshot.restore(); }
    catch (error) { errors.push(`${snapshot.path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}
