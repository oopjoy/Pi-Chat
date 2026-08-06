import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Serialize each persisted state target, including callers outside PiChatApp. */
const saveTails = new Map<string, Promise<void>>();

export interface SaveWorkspaceOptions {
  /** Test seam to hold one persisted write immediately before its replacement. */
  beforeReplace?: () => Promise<void>;
  /** Test seam for a partially written temporary file that then fails. */
  writeTemporary?: (temporary: string, contents: string) => Promise<void>;
}

function statePath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "pi-chat-workspace.json");
}

export async function loadWorkspace(fallback: string): Promise<string> {
  try {
    const value = JSON.parse(await readFile(statePath(), "utf8")) as { cwd?: unknown };
    if (typeof value.cwd === "string" && existsSync(value.cwd)) return resolve(value.cwd);
  } catch {
    // Missing or invalid state falls back to the configured startup directory.
  }
  return resolve(fallback);
}

export async function saveWorkspace(cwd: string, options: SaveWorkspaceOptions = {}): Promise<void> {
  const path = statePath();
  const previous = saveTails.get(path) || Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolveTurn) => { releaseTurn = resolveTurn; });
  const queued = previous.catch(() => undefined).then(() => turn);
  saveTails.set(path, queued);
  void queued.then(() => {
    if (saveTails.get(path) === queued) saveTails.delete(path);
  });

  await previous.catch(() => undefined);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    const contents = `${JSON.stringify({ cwd: resolve(cwd) }, null, 2)}\n`;
    if (options.writeTemporary) await options.writeTemporary(temporary, contents);
    else await writeFile(temporary, contents, "utf8");
    await options.beforeReplace?.();
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    releaseTurn();
  }
}
