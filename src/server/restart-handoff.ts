#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, rm } from "node:fs/promises";
import { promoteStagedDist, rollbackPromotedDist, type DistPromotionPaths } from "./application-restart.js";

type RestartPayload = {
  parentPid: number;
  command: string;
  args: string[];
  cwd: string;
  healthUrl: string;
  logPath: string;
  promoteAfterExit?: DistPromotionPaths;
};

const payload = JSON.parse(process.argv[2] || "{}") as Partial<RestartPayload>;
if (!Number.isInteger(payload.parentPid) || typeof payload.command !== "string" || !Array.isArray(payload.args) || typeof payload.cwd !== "string" || typeof payload.healthUrl !== "string" || typeof payload.logPath !== "string") {
  process.exit(1);
}

const logPath = payload.logPath as string;
const log = async (message: string): Promise<void> => {
  await appendFile(logPath, `${new Date().toISOString()} ${message}\n`, "utf8").catch(() => undefined);
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function parentExited(pid: number): Promise<void> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      // Give Windows a short moment to release directory handles after the PID vanishes.
      await delay(150);
      return;
    }
    await delay(100);
  }
  throw new Error("等待旧 Pi Chat 服务退出超时");
}

function spawnServer(protectRollbackBackup: boolean): ChildProcess {
  const descriptor = openSync(logPath, "a");
  try {
    return spawn(payload.command as string, payload.args as string[], {
      cwd: payload.cwd as string,
      detached: true,
      stdio: ["ignore", descriptor, descriptor],
      windowsHide: true,
      env: { ...process.env, ...(protectRollbackBackup ? { PI_CHAT_SKIP_STALE_DIST_CLEANUP: "1" } : {}) },
    });
  } finally {
    closeSync(descriptor);
  }
}

async function waitForHealthy(child: ChildProcess): Promise<void> {
  let exit: string | null = null;
  let spawnError: Error | null = null;
  child.once("error", (error) => { spawnError = error; });
  child.once("exit", (code, signal) => { exit = signal || `退出码 ${code ?? "未知"}`; });
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    if (spawnError) throw spawnError;
    if (exit) throw new Error(`候选服务启动失败（${exit}）`);
    try {
      const response = await fetch(payload.healthUrl as string, { signal: AbortSignal.timeout(1_500) });
      const state = await response.json() as { ok?: boolean; service?: string };
      if (response.ok && state.ok === true && state.service === "pi-chat") return;
    } catch {
      // Candidate is still starting Pi RPC or has not bound the listener yet.
    }
    await delay(250);
  }
  throw new Error("候选服务在 45 秒内未通过健康检查");
}

async function stopCandidate(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(5_000).then(() => undefined),
  ]);
  await delay(150);
}

try {
  await parentExited(payload.parentPid as number);
  let promoted = false;
  let candidate: ChildProcess | undefined;
  try {
    if (payload.promoteAfterExit) {
      const { liveDist, stagedDist, previousDist } = payload.promoteAfterExit;
      if (typeof liveDist === "string" && typeof stagedDist === "string" && typeof previousDist === "string") {
        await promoteStagedDist(liveDist, stagedDist, previousDist, { keepPrevious: true });
        promoted = true;
      }
    }
    candidate = spawnServer(promoted);
    await waitForHealthy(candidate);
    candidate.unref();
    if (promoted && payload.promoteAfterExit) {
      await rm(payload.promoteAfterExit.previousDist, { recursive: true, force: true }).catch(() => undefined);
    }
    await log("候选 Pi Chat 已通过健康检查，重启完成。");
  } catch (candidateError) {
    await log(`候选 Pi Chat 启动失败：${candidateError instanceof Error ? candidateError.message : String(candidateError)}`);
    await stopCandidate(candidate);
    if (promoted && payload.promoteAfterExit) {
      await rollbackPromotedDist(payload.promoteAfterExit.liveDist, payload.promoteAfterExit.previousDist);
      await log("已恢复旧 dist，正在重新启动旧版本。");
    }
    const fallback = spawnServer(false);
    await waitForHealthy(fallback);
    fallback.unref();
    await log("旧版本已恢复并通过健康检查。");
  }
} catch (error) {
  await log(`Pi Chat handoff 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
