import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RpcClientOptions {
  cwd: string;
  piEntry?: string;
  args?: string[];
}

type EventListener = (event: Record<string, unknown>) => void;

export function resolvePiEntry(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.PI_CHAT_PI_ENTRY;
  if (configured && existsSync(configured)) return configured;

  const candidates: string[] = [
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js",
    "/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js",
  ];
  const appData = env.APPDATA;
  if (appData) {
    candidates.push(join(appData, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "rpc-entry.js"));
  }
  for (const pathEntry of (env.PATH || "").split(delimiter)) {
    if (!pathEntry) continue;
    candidates.push(join(pathEntry, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "rpc-entry.js"));
    candidates.push(join(dirname(pathEntry), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "rpc-entry.js"));
    const piExecutable = join(pathEntry, process.platform === "win32" ? "pi.cmd" : "pi");
    if (existsSync(piExecutable)) {
      try {
        const resolvedExecutable = realpathSync(piExecutable);
        if (resolvedExecutable.endsWith("cli.js")) candidates.push(join(dirname(resolvedExecutable), "rpc-entry.js"));
      } catch {
        // Windows npm command shims are covered by the APPDATA candidate above.
      }
    }
  }
  return candidates.find(existsSync) ?? null;
}

export class PiRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private listeners = new Set<EventListener>();
  private pending = new Map<string, PendingRequest>();
  private requestId = 0;
  private stderrTail = "";

  constructor(private readonly options: RpcClientOptions) {}

  async start(extraArgs: string[] = []): Promise<void> {
    if (this.child) throw new Error("Pi RPC is already running");
    const piEntry = this.options.piEntry ?? resolvePiEntry();
    if (!piEntry) {
      throw new Error("找不到全局 Pi。请先安装 Pi，或设置 PI_CHAT_PI_ENTRY 指向 dist/rpc-entry.js。");
    }

    const child = spawn(process.execPath, [piEntry, ...(this.options.args ?? []), ...extraArgs], {
      cwd: this.options.cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-8_000);
    });
    child.once("error", (error) => this.handleExit(new Error(`Pi RPC 启动失败：${error.message}`)));
    child.once("exit", (code, signal) => {
      this.handleExit(new Error(`Pi RPC 已退出（code=${code}, signal=${signal}）。${this.stderrTail}`));
    });
    this.attachJsonlReader(child.stdout);

    await this.waitUntilReady();
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + 20_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (!this.child || this.child.exitCode !== null) {
        throw new Error(`Pi RPC 在初始化期间退出。${this.stderrTail}`);
      }
      try {
        await this.send({ type: "get_state" }, 2_000);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("等待 Pi RPC 就绪超时");
  }

  private attachJsonlReader(stream: NodeJS.ReadableStream): void {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    stream.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line) this.handleLine(line);
      }
    });
    stream.on("end", () => {
      buffer += decoder.end();
      if (buffer) this.handleLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    });
  }

  private handleLine(line: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (data.type === "response" && typeof data.id === "string") {
      const pending = this.pending.get(data.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(data.id);
        if (data.success === false) pending.reject(new Error(String(data.error || "Pi RPC 请求失败")));
        else pending.resolve(data);
        return;
      }
    }
    for (const listener of this.listeners) listener(data);
  }

  private handleExit(error: Error): void {
    if (!this.child) return;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners) listener({ type: "pi_chat_process_error", error: error.message });
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendRaw(command: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.exitCode !== null) throw new Error("Pi RPC 未运行");
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async send(command: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child || child.exitCode !== null) throw new Error("Pi RPC 未运行");
    const id = `pi-chat-${++this.requestId}`;
    const payload = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC 请求超时：${String(command.type)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async restart(sessionPath?: string, cwd?: string): Promise<void> {
    await this.stop();
    if (cwd) this.options.cwd = cwd;
    await this.start(sessionPath ? ["--session", sessionPath] : []);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

export function rpcData<T>(response: Record<string, unknown>): T {
  return response.data as T;
}
