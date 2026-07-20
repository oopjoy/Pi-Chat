import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface ApplicationRestartOptions {
  projectRoot: string;
  serverEntry: string;
  host: string;
  port: number;
  cwd: string;
  dev: boolean;
  parentPid?: number;
}

/** Build the local Pi Chat working tree; no network package update is performed. */
export async function buildPiChat(projectRoot: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // Node on Windows cannot CreateProcess an npm .cmd shim directly in every
    // launch context (it raises EINVAL). cmd.exe receives a fixed command; the
    // project directory is passed via cwd rather than interpolated into a shell.
    const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm run build"] : ["run", "build"];
    const child = spawn(command, args, { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const append = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-12_000); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Pi Chat 构建失败（${signal || `退出码 ${code ?? "未知"}`}）${output ? `\n${output}` : ""}`));
    });
  });
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
