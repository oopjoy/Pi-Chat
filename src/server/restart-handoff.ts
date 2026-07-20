#!/usr/bin/env node
import { spawn } from "node:child_process";

type RestartPayload = { parentPid: number; command: string; args: string[]; cwd: string };

const payload = JSON.parse(process.argv[2] || "{}") as Partial<RestartPayload>;
if (!Number.isInteger(payload.parentPid) || typeof payload.command !== "string" || !Array.isArray(payload.args) || typeof payload.cwd !== "string") process.exit(1);

async function parentExited(pid: number): Promise<void> {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待旧 Pi Chat 服务退出超时");
}

try {
  await parentExited(payload.parentPid as number);
  const child = spawn(payload.command as string, payload.args as string[], { cwd: payload.cwd as string, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
} catch {
  process.exitCode = 1;
}
