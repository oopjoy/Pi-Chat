import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { access, readdir, readFile, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export interface ApplicationRestartOptions {
  projectRoot: string;
  /** Expected staged artifact fingerprint; handoff rejects a stale candidate. */
  expectedBuildFingerprint?: string;
  serverEntry: string;
  host: string;
  port: number;
  cwd: string;
  dev: boolean;
  parentPid?: number;
  /**
   * Promote the staged dist only after this process has fully exited.
   * Avoids Windows EPERM when the live server still holds handles under dist/.
   */
  promoteAfterExit?: DistPromotionPaths;
}

export interface DistPromotionPaths {
  liveDist: string;
  stagedDist: string;
  previousDist: string;
}

export interface StagedApplicationBuild {
  readonly distPath: string;
  readonly buildFingerprint: string;
  readonly liveDist: string;
  readonly previousDist: string;
  promote(): Promise<void>;
  discard(): Promise<void>;
}

const RENAME_RETRY_MS = [50, 100, 200, 400, 800, 1_200, 2_000];

function isRetryableFsError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : "";
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "EAGAIN";
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RENAME_RETRY_MS.length; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableFsError(error) || attempt === RENAME_RETRY_MS.length) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, RENAME_RETRY_MS[attempt]));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const delay = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return true;
  return Promise.race([
    new Promise<boolean>((resolveExit) => child.once("exit", () => resolveExit(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

/** Stop the complete build/server process tree, including Windows cmd/npm descendants. */
export async function terminateProcessTree(child: ChildProcess, graceMs = 2_000): Promise<void> {
  if (!child.pid || childExited(child)) return;
  if (process.platform === "win32") {
    // Do not kill only the wrapper first: it may exit while npm/node descendants
    // remain alive, after which Windows can no longer discover the tree by PID.
    await new Promise<void>((resolveKill) => {
      const killer = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `taskkill /PID ${child.pid} /T /F`], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolveKill());
      killer.once("exit", () => resolveKill());
    });
    await waitForChildExit(child, Math.max(graceMs, 5_000));
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  if (await waitForChildExit(child, graceMs)) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  await waitForChildExit(child, 5_000);
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
      // Unix needs a separate process group for negative-PID termination.
      // Windows taskkill /T follows descendants without CREATE_NEW_PROCESS_GROUP,
      // which can make cmd/npm startup fail in constrained launch contexts.
      detached: process.platform !== "win32",
    });
    let settled = false;
    let timedOut = false;
    let output = "";
    const append = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-12_000); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child).finally(() => finish(new Error(`Pi Chat 构建超时，已终止构建进程树${output ? `\n${output}` : ""}`)));
    }, 10 * 60 * 1_000);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (timedOut) return;
      if (code === 0) finish();
      else finish(new Error(`Pi Chat 构建失败（${signal || `退出码 ${code ?? "未知"}`}）${output ? `\n${output}` : ""}`));
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

/**
 * Atomically replace live dist with a staged tree.
 * Retries rename on Windows lock races; rolls live back if the staged swap fails.
 */
export async function promoteStagedDist(liveDist: string, stagedDist: string, previousDist: string, options: { keepPrevious?: boolean } = {}): Promise<void> {
  if (!existsSync(stagedDist)) {
    throw new Error(`Pi Chat 无法切换到已完成的构建：暂存目录不存在（${stagedDist}）`);
  }
  const hadLiveDist = existsSync(liveDist);
  try {
    if (hadLiveDist) await renameWithRetry(liveDist, previousDist);
    try {
      await renameWithRetry(stagedDist, liveDist);
    } catch (error) {
      if (hadLiveDist && existsSync(previousDist) && !existsSync(liveDist)) {
        await renameWithRetry(previousDist, liveDist).catch(() => undefined);
      }
      throw error;
    }
  } catch (error) {
    await rm(stagedDist, { recursive: true, force: true }).catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    const hint = isRetryableFsError(error)
      ? " 请关闭其他占用 dist 的进程（旧 Pi Chat、资源管理器预览、杀毒扫描）后重试，或手动 npm run build && npm start。"
      : "";
    throw new Error(`Pi Chat 无法切换到已完成的构建：${detail}${hint}`);
  }
  // Production handoff retains the old tree until the candidate server answers
  // /api/health. Direct/manual promotions keep the previous best-effort cleanup.
  if (!options.keepPrevious) await rm(previousDist, { recursive: true, force: true }).catch(() => undefined);
}

/** Restore the retained old dist after a promoted candidate fails to start. */
export async function rollbackPromotedDist(liveDist: string, previousDist: string): Promise<void> {
  if (!existsSync(previousDist)) throw new Error(`Pi Chat 无法回滚：旧版本备份不存在（${previousDist}）`);
  const failedDist = join(dirname(liveDist), `.pi-chat-dist-failed-${process.pid}-${Date.now()}`);
  const hadCandidate = existsSync(liveDist);
  try {
    if (hadCandidate) await renameWithRetry(liveDist, failedDist);
    try {
      await renameWithRetry(previousDist, liveDist);
    } catch (error) {
      if (hadCandidate && existsSync(failedDist) && !existsSync(liveDist)) {
        await renameWithRetry(failedDist, liveDist).catch(() => undefined);
      }
      throw error;
    }
  } catch (error) {
    throw new Error(`Pi Chat 自动回滚旧版本失败：${error instanceof Error ? error.message : String(error)}`);
  }
  await rm(failedDist, { recursive: true, force: true }).catch(() => undefined);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove abandoned staging / previous / failed trees left by dead restart processes. */
export async function cleanupStaleDistArtifacts(projectRoot: string): Promise<number> {
  const root = resolve(projectRoot);
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const match = /^\.pi-chat-dist-(?:staging|previous|failed)-(\d+)(?:-|$)/.exec(name);
    if (!match) continue;
    // Another Pi Chat process may be building or promoting this tree right now.
    // Deleting by prefix alone races concurrent windows and corrupts the build.
    if (processIsAlive(Number(match[1]))) continue;
    try {
      await rm(join(root, name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // Still locked — leave for a later start.
    }
  }
  return removed;
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

  const identity = JSON.parse(await readFile(join(stagedDist, "build-identity.json"), "utf8")) as { fingerprint?: unknown };
  if (typeof identity.fingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(identity.fingerprint)) {
    await rm(stagedDist, { recursive: true, force: true });
    throw new Error("Pi Chat 暂存构建缺少有效 build identity");
  }

  return {
    distPath: stagedDist,
    buildFingerprint: identity.fingerprint,
    liveDist,
    previousDist,
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
 * this listener to release its port (and optionally promotes staged dist after
 * file handles are released), then starts the freshly built server.
 */
export function handOffApplicationRestart(options: ApplicationRestartOptions): void {
  const handoff = fileURLToPath(new URL("./restart-handoff.js", import.meta.url));
  const authority = options.host.includes(":") ? `[${options.host}]:${options.port}` : `${options.host}:${options.port}`;
  const payload = JSON.stringify({
    parentPid: options.parentPid || process.pid,
    command: process.execPath,
    args: restartServerArgs(options),
    cwd: options.projectRoot,
    healthUrl: `http://${authority}/api/health`,
    ...(options.expectedBuildFingerprint ? { expectedBuildFingerprint: options.expectedBuildFingerprint } : {}),
    logPath: join(tmpdir(), "pi-chat-restart-handoff.log"),
    ...(options.promoteAfterExit ? { promoteAfterExit: options.promoteAfterExit } : {}),
  });
  const helper = spawn(process.execPath, [handoff, payload], { cwd: options.projectRoot, detached: true, stdio: "ignore", windowsHide: true });
  helper.unref();
}
