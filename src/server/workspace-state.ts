import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

export async function saveWorkspace(cwd: string): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ cwd: resolve(cwd) }, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
