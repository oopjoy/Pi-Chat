import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export interface ApplicationRestartOptions {
  projectRoot: string;
  serverEntry: string;
  host: string;
  port: number;
  cwd: string;
  dev: boolean;
  parentPid?: number;
}

export interface StagedApplicationBuild {
  readonly distPath: string;
  promote(): Promise<void>;
  discard(): Promise<void>;
}

function runBuild(projectRoot: string, distPath: string): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    // Node on Windows cannot CreateProcess an npm .cmd shim directly in every
    // launch context (it raises EINVAL). cmd.exe receives a fixed command; all
    // paths remain in cwd/environment rather than interpolated shell source.
    const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm run build"] : ["run", "build"];
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, PI_CHAT_DIST_DIR: distPath },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const append = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-12_000); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`Pi Chat 构建失败（${signal || `退出码 ${code ?? "未知"}`}）${output ? `\n${output}` : ""}`));
    });
  });
}

async function validateBuild(distPath: string): Promise<void> {
  for (const required of [
    join(distPath, "server", "server", "index.js"),
    join(distPath, "server", "server", "restart-handoff.js"),
    join(distPath, "web", "index.html"),
  ]) await access(required);
}

export async function promoteStagedDist(liveDist: string, stagedDist: string, previousDist: string): Promise<void> {
  const hadLiveDist = existsSync(liveDist);
  try {
    if (hadLiveDist) await rename(liveDist, previousDist);
    try {
      await rename(stagedDist, liveDist);
    } catch (error) {
      if (hadLiveDist && existsSync(previousDist) && !existsSync(liveDist)) await rename(previousDist, liveDist);
      throw error;
    }
  } catch (error) {
    await rm(stagedDist, { recursive: true, force: true });
    throw new Error(`Pi Chat 无法切换到已完成的构建：${error instanceof Error ? error.message : String(error)}`);
  }
  // Antivirus/indexers may briefly retain a handle to the old tree on Windows.
  // The completed live swap remains valid; backup cleanup is best effort.
  await rm(previousDist, { recursive: true, force: true }).catch(() => undefined);
}

/** Build into a sibling staging directory without touching the live dist tree. */
export async function buildPiChat(projectRoot: string): Promise<StagedApplicationBuild> {
  const root = resolve(projectRoot);
  const liveDist = join(root, "dist");
  const stagedDist = join(root, `.pi-chat-dist-staging-${process.pid}-${Date.now()}`);
  const previousDist = join(root, `.pi-chat-dist-previous-${process.pid}-${Date.now()}`);
  let promoted = false;
  try {
    await runBuild(root, stagedDist);
    await validateBuild(stagedDist);
  } catch (error) {
    await rm(stagedDist, { recursive: true, force: true });
    throw error;
  }

  return {
    distPath: stagedDist,
    async promote(): Promise<void> {
      if (promoted) return;
      await promoteStagedDist(liveDist, stagedDist, previousDist);
      promoted = true;
    },
    async discard(): Promise<void> {
      if (!promoted) await rm(stagedDist, { recursive: true, force: true });
    },
  };
}

export function restartServerArgs(options: ApplicationRestartOptions): string[] {
  return [
    options.serverEntry,
    "--host", options.host,
    "--port", String(options.port),
    "--cwd", options.cwd,
    ...(options.dev ? ["--dev"] : []),
  ];
}

/**
 * Start a detached helper before terminating this process. The helper waits for
 * this listener to release its port, then starts the freshly built server.
 */
export function handOffApplicationRestart(options: ApplicationRestartOptions): void {
  const handoff = fileURLToPath(new URL("./restart-handoff.js", import.meta.url));
  const payload = JSON.stringify({
    parentPid: options.parentPid || process.pid,
    command: process.execPath,
    args: restartServerArgs(options),
    cwd: options.projectRoot,
  });
  const helper = spawn(process.execPath, [handoff, payload], { cwd: options.projectRoot, detached: true, stdio: "ignore", windowsHide: true });
  helper.unref();
}
