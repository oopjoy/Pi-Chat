#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promoteStagedDist, type DistPromotionPaths } from "./application-restart.js";

type RestartPayload = {
  parentPid: number;
  command: string;
  args: string[];
  cwd: string;
  promoteAfterExit?: DistPromotionPaths;
};

const payload = JSON.parse(process.argv[2] || "{}") as Partial<RestartPayload>;
if (!Number.isInteger(payload.parentPid) || typeof payload.command !== "string" || !Array.isArray(payload.args) || typeof payload.cwd !== "string") {
  process.exit(1);
}

async function parentExited(pid: number): Promise<void> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      // Give Windows a short moment to release directory handles after the PID vanishes.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待旧 Pi Chat 服务退出超时");
}

try {
  await parentExited(payload.parentPid as number);
  if (payload.promoteAfterExit) {
    const { liveDist, stagedDist, previousDist } = payload.promoteAfterExit;
    if (typeof liveDist === "string" && typeof stagedDist === "string" && typeof previousDist === "string") {
      await promoteStagedDist(liveDist, stagedDist, previousDist);
    }
  }
  const child = spawn(payload.command as string, payload.args as string[], {
    cwd: payload.cwd as string,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
} catch (error) {
  console.error("[Pi Chat handoff]", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
