import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RpcRequestTimeoutError extends Error {
  constructor(readonly requestType: string) {
    super(`Pi RPC 请求超时：${requestType}`);
    this.name = "RpcRequestTimeoutError";
  }
}

export interface RpcClientOptions {
  cwd: string;
  piEntry?: string;
  args?: string[];
}

export interface PiRpcCompatibility {
  compatible: boolean;
  diagnostics: string[];
}

export interface RpcSendOptions {
  /**
   * Send a read command as its own FIFO request instead of joining a matching
   * read. Used only by ordering barriers that cannot inherit another caller's
   * shorter timeout budget.
   */
  independentRead?: boolean;
}

export interface RpcEventSource {
  /** Monotonic per-child spawn identity; stale children can never impersonate a replacement. */
  generation: number;
}

type EventListener = (event: Record<string, unknown>, source?: RpcEventSource) => void;

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
  private source: (RpcEventSource & { child: ChildProcessWithoutNullStreams; stderrTail: string }) | null = null;
  private sourceGeneration = 0;
  private listeners = new Set<EventListener>();
  private pending = new Map<string, PendingRequest>();
  private readonly readQueries = new Map<string, Promise<Record<string, unknown>>>();
  /** Read queries can outlive the caller timeout because the RPC protocol has no cancellation. */
  private readonly outstandingReadQueryIds = new Map<string, string>();
  private requestId = 0;
  private stderrTail = "";

  constructor(private readonly options: RpcClientOptions) {}

  /** The currently live child generation, or zero for legacy in-process test doubles. */
  currentGeneration(): number { return this.source?.generation || 0; }

  async start(extraArgs: string[] = []): Promise<Record<string, unknown>> {
    if (this.child) throw new Error("Pi RPC is already running");
    const piEntry = this.options.piEntry ?? resolvePiEntry();
    if (!piEntry) {
      throw new Error("找不到全局 Pi。请先安装 Pi，或设置 PI_CHAT_PI_ENTRY 指向 dist/rpc-entry.js。");
    }

    const child = spawn(process.execPath, [piEntry, ...(this.options.args ?? []), ...extraArgs], {
      cwd: this.options.cwd,
      // RPC mode has no interactive update prompt. Disable the unrelated
      // version lookup as well so every dedicated child avoids its startup I/O.
      env: { ...process.env, FORCE_COLOR: "0", PI_SKIP_VERSION_CHECK: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const source = { generation: ++this.sourceGeneration, child, stderrTail: "" };
    this.child = child;
    this.source = source;

    child.stderr.on("data", (chunk: Buffer) => {
      if (this.source !== source) return;
      source.stderrTail = `${source.stderrTail}${chunk.toString("utf8")}`.slice(-8_000);
      this.stderrTail = source.stderrTail;
    });
    child.once("error", (error) => this.handleExit(source, new Error(`Pi RPC 启动失败：${error.message}`)));
    child.once("exit", (code, signal) => {
      this.handleExit(source, new Error(`Pi RPC 已退出（code=${code}, signal=${signal}）。${source.stderrTail}`));
    });
    this.attachJsonlReader(child.stdout, source);

    try {
      return await this.waitUntilReady();
    } catch (error) {
      // A protocol/startup failure must not leave an untracked Pi child keeping
      // the server process alive or holding a Session JSONL open.
      await this.stop();
      throw error;
    }
  }

  private async waitUntilReady(): Promise<Record<string, unknown>> {
    // RPC has no cancellation protocol. A short per-attempt timeout therefore
    // leaves an in-flight get_state behind and makes the nominal retry loop
    // reject every following attempt with "still processing". Use one request
    // for the whole startup budget instead; a late response is then the result
    // of this startup attempt rather than an orphan competing with a retry.
    const startupTimeoutMs = 60_000;
    if (!this.child || this.child.exitCode !== null) {
      throw new Error(`Pi RPC 在初始化期间退出。${this.stderrTail}`);
    }
    return this.send({ type: "get_state" }, startupTimeoutMs);
  }

  private attachJsonlReader(stream: NodeJS.ReadableStream, source?: RpcEventSource): void {
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
        if (line) this.handleLine(line, source);
      }
    });
    stream.on("end", () => {
      buffer += decoder.end();
      if (buffer) this.handleLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer, source);
    });
  }

  private handleLine(line: string, source?: RpcEventSource): void {
    // Streams remain readable briefly after SIGTERM on Windows. Do not let an
    // old child resolve current requests or publish unsolicited lifecycle data.
    if (source && this.source?.generation !== source.generation) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (data.type === "response") {
      if (typeof data.id === "string") {
        for (const [type, id] of this.outstandingReadQueryIds) {
          if (id === data.id) this.outstandingReadQueryIds.delete(type);
        }
        const pending = this.pending.get(data.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(data.id);
          if (data.success === false) pending.reject(new Error(String(data.error || "Pi RPC 请求失败")));
          else pending.resolve(data);
        }
      }
      // A response can arrive after its caller timed out. It remains an RPC
      // response and must never leak into the unsolicited event/SSE channel.
      return;
    }
    for (const listener of this.listeners) listener(data, source);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.readQueries.clear();
    this.outstandingReadQueryIds.clear();
  }

  private handleExit(source: RpcEventSource, error: Error): void {
    if (!this.source || this.source.generation !== source.generation) return;
    this.child = null;
    this.source = null;
    this.rejectPending(error);
    for (const listener of this.listeners) listener({ type: "pi_chat_process_error", error: error.message });
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  sendRaw(command: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.exitCode !== null) throw new Error("Pi RPC 未运行");
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private waitForReadQuery(query: Promise<Record<string, unknown>>, type: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RpcRequestTimeoutError(type)), timeoutMs);
      query.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  async send(
    command: Record<string, unknown>,
    timeoutMs = 30_000,
    options: RpcSendOptions = {},
  ): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child || child.exitCode !== null) throw new Error("Pi RPC 未运行");
    const type = typeof command.type === "string" ? command.type : "";
    const readOnly = Object.keys(command).length === 1 && ["get_state", "get_messages", "get_available_models", "get_commands", "get_session_stats"].includes(type);
    const sharedRead = readOnly && !options.independentRead;
    if (sharedRead) {
      const existing = this.readQueries.get(type);
      if (existing) return this.waitForReadQuery(existing, type, timeoutMs);
      // A timed-out query is still inside Pi until its late response arrives.
      // Do not enqueue duplicates behind it and progressively clog the RPC pipe.
      if (this.outstandingReadQueryIds.has(type)) throw new Error(`Pi RPC 查询仍在处理中：${type}`);
    }
    const id = `pi-chat-${++this.requestId}`;
    if (sharedRead) this.outstandingReadQueryIds.set(type, id);
    const payload = { ...command, id };
    const request = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcRequestTimeoutError(String(command.type)));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        if (sharedRead && this.outstandingReadQueryIds.get(type) === id) this.outstandingReadQueryIds.delete(type);
        reject(error);
      });
    });
    if (sharedRead) {
      this.readQueries.set(type, request);
      const clear = () => { if (this.readQueries.get(type) === request) this.readQueries.delete(type); };
      request.then(clear, clear);
    }
    return request;
  }

  async probeCompatibility(initialState?: Record<string, unknown>): Promise<PiRpcCompatibility> {
    const diagnostics: string[] = [];
    const check = async (type: string, validate: (data: unknown) => boolean, label: string, initialResponse?: Record<string, unknown>) => {
      if (initialResponse) {
        if (!validate(initialResponse.data)) diagnostics.push(`RPC ${type} 返回格式不兼容（需要 ${label}）`);
        return;
      }
      try {
        const response = await this.send({ type }, 10_000);
        if (!validate(response.data)) diagnostics.push(`RPC ${type} 返回格式不兼容（需要 ${label}）`);
      } catch (error) {
        diagnostics.push(`RPC 不支持 ${type}：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await check("get_state", (data) => Boolean(data && typeof data === "object" && typeof (data as Record<string, unknown>).isStreaming === "boolean"), "isStreaming", initialState);
    await check("get_messages", (data) => Boolean(data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).messages)), "messages[]");
    await check("get_available_models", (data) => Boolean(data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).models)), "models[]");
    await check("get_commands", (data) => Boolean(data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).commands)), "commands[]");
    await check("get_session_stats", (data) => Boolean(data && typeof data === "object" && (data as Record<string, unknown>).tokens && typeof (data as Record<string, unknown>).tokens === "object"), "tokens");
    return { compatible: diagnostics.length === 0, diagnostics };
  }

  async restart(sessionPath?: string, cwd?: string): Promise<Record<string, unknown>> {
    // A Runtime's cwd is an immutable process identity boundary. Callers may
    // repeat it for assertion, but may never retarget a live client in place.
    if (cwd && cwd !== this.options.cwd) throw new Error("Pi RPC Runtime 工作目录不可在原进程上重绑定");
    await this.stop();
    return this.start(sessionPath ? ["--session", sessionPath] : []);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (this.source?.child === child) this.source = null;
    this.rejectPending(new Error("Pi RPC 已停止"));
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    ]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      // A service restart must not leave an old worker holding resources while
      // the replacement server starts. Give the forced termination a bounded
      // chance to be observed before continuing the process handoff.
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
      ]);
    }
  }
}

export function rpcData<T>(response: Record<string, unknown>): T {
  return response.data as T;
}
