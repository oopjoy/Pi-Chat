import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  MAX_RPC_INBOUND_LINE_BYTES,
  MAX_RPC_OUTBOUND_LINE_BYTES,
} from "../shared/rpc-contracts.js";

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  requestType: string;
  written: boolean;
  readOnly: boolean;
}

export type RpcWriteOutcome = "not-written" | "written-outcome-unknown";

export class RpcRequestTimeoutError extends Error {
  readonly code = "PI_RPC_REQUEST_TIMEOUT";

  constructor(
    readonly requestType: string,
    readonly outcome: RpcWriteOutcome = "written-outcome-unknown",
  ) {
    super(`Pi RPC 请求超时：${requestType}${outcome === "written-outcome-unknown" ? "（执行结果未知）" : "（尚未写入）"}`);
    this.name = "RpcRequestTimeoutError";
  }

  get outcomeUnknown(): boolean { return this.outcome === "written-outcome-unknown"; }
}

export function isRpcOutcomeUnknown(error: unknown): error is RpcRequestTimeoutError {
  return error instanceof RpcRequestTimeoutError && error.outcomeUnknown;
}

export class RpcFrameTooLargeError extends Error {
  readonly code = "PI_RPC_FRAME_TOO_LARGE";
  readonly status = 413;

  constructor(readonly direction: "stdin" | "stdout", readonly bytes: number, readonly maximumBytes: number) {
    super(`Pi RPC ${direction} 单行超过安全上限（${bytes} > ${maximumBytes} bytes）`);
    this.name = "RpcFrameTooLargeError";
  }
}

export class RpcProcessExitUnconfirmedError extends Error {
  readonly code = "PI_RPC_EXIT_UNCONFIRMED";

  constructor(readonly pid?: number) {
    super(`Pi RPC 进程退出无法确认${pid ? `（PID ${pid}）` : ""}`);
    this.name = "RpcProcessExitUnconfirmedError";
  }
}

function encodeOutboundFrame(value: Record<string, unknown>): string {
  const frame = `${JSON.stringify(value)}\n`;
  const bytes = Buffer.byteLength(frame, "utf8");
  if (bytes > MAX_RPC_OUTBOUND_LINE_BYTES)
    throw new RpcFrameTooLargeError("stdin", bytes, MAX_RPC_OUTBOUND_LINE_BYTES);
  return frame;
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

type EventListener = (
  event: Record<string, unknown>,
  source?: RpcEventSource,
) => void | Promise<void>;

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
  /** Retained until exit is observed; a retry must never forget an orphan candidate. */
  private unconfirmedChild: ChildProcessWithoutNullStreams | null = null;
  private stopOperation: Promise<void> | null = null;

  constructor(private readonly options: RpcClientOptions) {}

  /** The currently live child generation, or zero for legacy in-process test doubles. */
  currentGeneration(): number { return this.source?.generation || 0; }

  async start(extraArgs: string[] = []): Promise<Record<string, unknown>> {
    if (this.child || this.unconfirmedChild)
      throw new Error("Pi RPC 已有未确认退出的进程，拒绝启动重复 Session writer");
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

  private logRpcError(kind: string, error: unknown): void {
    const detail =
      error instanceof Error ? (error.stack || error.message) : String(error);
    console.error(`[Pi Chat] RPC ${kind}：${detail}`);
  }

  /** Every Pi lifecycle frame, including child exit, crosses this containment boundary. */
  private emitEvent(event: Record<string, unknown>, source?: RpcEventSource): void {
    for (const listener of this.listeners) {
      try {
        // Keep stream ordering synchronous while also containing an accidental
        // async listener rejection from a future host integration.
        void Promise.resolve(listener(event, source)).catch((error) =>
          this.logRpcError("事件处理错误", error),
        );
      } catch (error) {
        this.logRpcError("事件处理错误", error);
      }
    }
  }

  private attachJsonlReader(stream: NodeJS.ReadableStream, source?: RpcEventSource): void {
    let decoder = new StringDecoder("utf8");
    let parts: string[] = [];
    let lineBytes = 0;
    let failed = false;

    const failOversizedLine = (observedBytes: number) => {
      if (failed) return;
      failed = true;
      parts = [];
      const error = new RpcFrameTooLargeError(
        "stdout",
        observedBytes,
        MAX_RPC_INBOUND_LINE_BYTES,
      );
      this.logRpcError("流解析错误", error);
      const activeSource = source && this.source?.generation === source.generation
        ? this.source
        : null;
      if (activeSource) {
        // Reject transport work immediately, but retain the child as owned until
        // stop() observes exit. A successful kill() call proves only signal
        // delivery, not process termination, especially on Windows.
        this.child = null;
        this.unconfirmedChild = activeSource.child;
        this.source = null;
        this.rejectPending(error, true);
        this.emitEvent(
          { type: "pi_chat_process_error", error: error.message },
          activeSource,
        );
        activeSource.child.kill("SIGKILL");
      }
    };

    const append = (part: Buffer): boolean => {
      lineBytes += part.length;
      if (lineBytes > MAX_RPC_INBOUND_LINE_BYTES) {
        failOversizedLine(lineBytes);
        return false;
      }
      const decoded = decoder.write(part);
      if (decoded) parts.push(decoded);
      return true;
    };

    stream.on("data", (value: Buffer | string) => {
      if (failed) return;
      try {
        const chunk = typeof value === "string" ? Buffer.from(value, "utf8") : value;
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(0x0a, start);
          const end = newline < 0 ? chunk.length : newline;
          if (!append(chunk.subarray(start, end))) return;
          if (newline < 0) return;
          const tail = decoder.end();
          if (tail) parts.push(tail);
          let line = parts.join("");
          if (line.endsWith("\r")) line = line.slice(0, -1);
          parts = [];
          lineBytes = 0;
          decoder = new StringDecoder("utf8");
          if (line) this.handleLine(line, source);
          start = newline + 1;
        }
      } catch (error) {
        this.logRpcError("流解析错误", error);
      }
    });
    stream.on("error", (error) => this.logRpcError("流读取错误", error));
    stream.on("end", () => {
      if (failed) return;
      try {
        const tail = decoder.end();
        if (tail) parts.push(tail);
        if (parts.length) {
          let line = parts.join("");
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line) this.handleLine(line, source);
        }
      } catch (error) {
        this.logRpcError("流解析错误", error);
      }
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
    this.emitEvent(data, source);
  }

  private rejectPending(error: Error, unexpected = false): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        unexpected && !pending.readOnly && pending.written
          ? new RpcRequestTimeoutError(pending.requestType, "written-outcome-unknown")
          : error,
      );
    }
    this.pending.clear();
    this.readQueries.clear();
    this.outstandingReadQueryIds.clear();
  }

  private handleExit(source: RpcEventSource, error: Error): void {
    if (!this.source || this.source.generation !== source.generation) return;
    this.child = null;
    if (this.unconfirmedChild === this.source.child) this.unconfirmedChild = null;
    this.source = null;
    this.rejectPending(error, true);
    this.emitEvent(
      { type: "pi_chat_process_error", error: error.message },
      source,
    );
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  async sendRaw(command: Record<string, unknown>, timeoutMs = 10_000): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.stdin.writable)
      throw new Error("Pi RPC 未运行");
    const requestType = typeof command.type === "string" ? command.type : "unknown";
    const frame = encodeOutboundFrame(command);
    await new Promise<void>((resolve, reject) => {
      let writeReturned = false;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("close", onExit);
        child.stdin.off("error", onStdinError);
        if (error) reject(error);
        else resolve();
      };
      const uncertain = () => new RpcRequestTimeoutError(
        requestType,
        writeReturned ? "written-outcome-unknown" : "not-written",
      );
      const onExit = () => finish(uncertain());
      const onStdinError = () => finish(uncertain());
      const timer = setTimeout(() => finish(uncertain()), timeoutMs);
      timer.unref?.();
      child.once("exit", onExit);
      child.once("close", onExit);
      child.stdin.once("error", onStdinError);
      try {
        child.stdin.write(frame, (error) => {
          if (!error) finish();
          else finish(writeReturned ? uncertain() : error);
        });
        writeReturned = true;
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private waitForReadQuery(query: Promise<Record<string, unknown>>, type: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RpcRequestTimeoutError(type, "written-outcome-unknown")), timeoutMs);
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
    let frame: string;
    try {
      frame = encodeOutboundFrame(payload);
    } catch (error) {
      if (sharedRead && this.outstandingReadQueryIds.get(type) === id)
        this.outstandingReadQueryIds.delete(type);
      throw error;
    }
    const request = new Promise<Record<string, unknown>>((resolve, reject) => {
      let writeReturned = false;
      const pending: PendingRequest = {
        resolve,
        reject,
        timer: undefined as unknown as NodeJS.Timeout,
        requestType: type || "unknown",
        written: false,
        readOnly,
      };
      pending.timer = setTimeout(() => {
        if (this.pending.get(id) !== pending) return;
        this.pending.delete(id);
        reject(new RpcRequestTimeoutError(
          pending.requestType,
          pending.written ? "written-outcome-unknown" : "not-written",
        ));
      }, timeoutMs);
      this.pending.set(id, pending);
      try {
        child.stdin.write(frame, (error) => {
          if (!error || this.pending.get(id) !== pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          if (sharedRead && this.outstandingReadQueryIds.get(type) === id)
            this.outstandingReadQueryIds.delete(type);
          // A callback invoked before write() returns is a definite rejection.
          // After return, Node may already have buffered bytes even when its
          // eventual callback reports a transport failure.
          reject(
            writeReturned && !readOnly
              ? new RpcRequestTimeoutError(pending.requestType, "written-outcome-unknown")
              : error,
          );
        });
        // A non-throwing write transfers the frame to Node's stream buffer. From
        // this point the host cannot prove that a mutation was not accepted.
        writeReturned = true;
        pending.written = true;
      } catch (error) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (sharedRead && this.outstandingReadQueryIds.get(type) === id)
          this.outstandingReadQueryIds.delete(type);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
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
    if (this.stopOperation) return this.stopOperation;
    const child = this.child || this.unconfirmedChild;
    if (!child) return;
    const operation = (async () => {
      const pid = child.pid;
      this.child = null;
      this.unconfirmedChild = child;
      if (this.source?.child === child) this.source = null;
      this.rejectPending(new Error("Pi RPC 已停止"));
      const waitForExit = (timeoutMs: number) => new Promise<boolean>((resolve) => {
        // Node documents signalCode as nullable, but lightweight embeddings and
        // test doubles may omit it. Only an explicit exit/signal proves exit.
        if (child.exitCode !== null || (child.signalCode !== null && child.signalCode !== undefined)) {
          if (this.unconfirmedChild === child) this.unconfirmedChild = null;
          resolve(true);
          return;
        }
        let settled = false;
        const finish = (exited: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.off("exit", onExit);
          child.off("close", onExit);
          if (exited && this.unconfirmedChild === child) this.unconfirmedChild = null;
          resolve(exited);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
        child.once("exit", onExit);
        child.once("close", onExit);
      });
      child.kill("SIGTERM");
      if (await waitForExit(1_500)) return;
      child.kill("SIGKILL");
      if (await waitForExit(1_500)) return;
      // Keep unconfirmedChild so every later stop/restart remains fail-closed.
      throw new RpcProcessExitUnconfirmedError(pid);
    })();
    this.stopOperation = operation;
    try {
      await operation;
    } finally {
      if (this.stopOperation === operation) this.stopOperation = null;
    }
  }
}

export function rpcData<T>(response: Record<string, unknown>): T {
  return response.data as T;
}
