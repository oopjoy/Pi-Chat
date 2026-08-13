import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ApplicationLifecycle } from "../shared/types.js";

export type IncidentRuntimeKind = "host" | "primary" | "secondary";
export type IncidentControlState =
  | "unowned"
  | "owned-by-this-window"
  | "owned-by-other-present-window"
  | "owned-by-stale-window"
  | "no-browser-identity";
export type IncidentOutcome =
  | "started"
  | "succeeded"
  | "failed"
  | "rejected"
  | "not-written"
  | "written-outcome-unknown"
  | "exit-unconfirmed"
  | "oversized";
export type IncidentOperation =
  | "host.start"
  | "host.ready"
  | "host.shutdown"
  | "lifecycle.restart"
  | "lifecycle.shutdown"
  | "runtime.start"
  | "runtime.recovery"
  | "runtime.settlement"
  | "navigation.bootstrap"
  | "navigation.session-view"
  | "navigation.request"
  | "control.takeover"
  | "prompt.send"
  | "prompt.abort"
  | "extension.respond"
  | "rpc.get-state"
  | "rpc.get-messages"
  | "rpc.get-models"
  | "rpc.get-commands"
  | "rpc.get-stats"
  | "rpc.prompt"
  | "rpc.abort"
  | "rpc.extension-response"
  | "rpc.stop"
  | "rpc.stdout-frame"
  | "rpc.child-exit"
  | "rpc.other";

export interface IncidentFields {
  sessionId?: string;
  browserId?: string;
  pageId?: string;
  runtimeKind?: IncidentRuntimeKind;
  rpcGeneration?: number;
  childPid?: number;
  rpcRequestId?: string;
  operation: IncidentOperation;
  lifecycle?: ApplicationLifecycle;
  queueLength?: number;
  controlState?: IncidentControlState;
  outcome: IncidentOutcome;
  durationMs?: number;
  errorCode?: string;
}

export interface IncidentReference { incidentId: string }
export interface IncidentAwareError { incidentId?: string; errorCode?: string }
export interface IncidentDiagnostics {
  readonly directory: string | null;
  readonly hostId: string;
  record(fields: IncidentFields): IncidentReference;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface IncidentDiagnosticsOptions {
  runEpoch: string;
  revision: string;
  directory?: string;
  maximumBytes?: number;
  archiveCount?: number;
  key?: Buffer;
  now?: () => Date;
}

const INCIDENT_ID_PATTERN = /^PC-[A-Z0-9_-]{8}$/;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;
const REQUEST_ID_PATTERN = /^pi-chat-[0-9]{1,20}$/;
const DEFAULT_MAXIMUM_BYTES = 5 * 1024 * 1024;
const DEFAULT_ARCHIVE_COUNT = 4;

function nextIncidentId(): string {
  return `PC-${randomBytes(6).toString("base64url").toUpperCase().slice(0, 8)}`;
}

function stableHash(key: Buffer, domain: string, value = ""): string | null {
  return value
    ? createHmac("sha256", key).update(`${domain}:${value}`).digest("hex").slice(0, 16)
    : null;
}

function integer(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null;
}

function defaultDirectory(): string {
  if (process.platform === "win32") {
    if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA 不可用");
    return join(process.env.LOCALAPPDATA, "Pi Chat", "diagnostics");
  }
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "pi-chat",
    "diagnostics",
  );
}

async function loadKey(directory: string): Promise<Buffer> {
  const path = join(directory, "diagnostic-key");
  try {
    const key = await readFile(path);
    if (key.length !== 32) throw new Error("诊断密钥文件无效");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(32);
  try {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(key); }
    finally { await handle.close(); }
    if (process.platform !== "win32") await chmod(path, 0o600);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (existing.length !== 32) throw new Error("诊断密钥文件无效");
    return existing;
  }
}

export function incidentReference(value: unknown): IncidentReference | null {
  if (!value || typeof value !== "object") return null;
  const incidentId = (value as IncidentAwareError).incidentId;
  return typeof incidentId === "string" && INCIDENT_ID_PATTERN.test(incidentId)
    ? { incidentId }
    : null;
}

export function incidentErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const code = (value as IncidentAwareError).errorCode;
  return typeof code === "string" && ERROR_CODE_PATTERN.test(code) ? code : null;
}

export function attachIncidentReference(
  value: unknown,
  reference: IncidentReference,
  errorCode?: string,
): void {
  if (!value || typeof value !== "object") return;
  try {
    Object.defineProperty(value, "incidentId", { configurable: true, value: reference.incidentId });
    if (errorCode && ERROR_CODE_PATTERN.test(errorCode))
      Object.defineProperty(value, "errorCode", { configurable: true, value: errorCode });
  } catch {
    // Frozen errors can still be correlated by the returned reference.
  }
}

export function recordIncident(
  diagnostics: IncidentDiagnostics | undefined,
  error: unknown,
  fields: IncidentFields,
): IncidentReference {
  const existing = incidentReference(error);
  if (existing) return existing;
  const reference = diagnostics?.record(fields) || { incidentId: nextIncidentId() };
  attachIncidentReference(error, reference, fields.errorCode);
  return reference;
}

export function incidentMessage(message: string, incidentId: unknown): string {
  return typeof incidentId === "string" && INCIDENT_ID_PATTERN.test(incidentId)
    ? `${message}（事件 ID：${incidentId}）`
    : message;
}

class FileIncidentDiagnostics implements IncidentDiagnostics {
  readonly hostId: string;
  private tail = Promise.resolve();
  private disabled = false;

  constructor(
    readonly directory: string,
    private readonly key: Buffer,
    private readonly options: Required<Pick<IncidentDiagnosticsOptions, "runEpoch" | "revision" | "maximumBytes" | "archiveCount" | "now">>,
  ) {
    this.hostId = stableHash(key, "host", "local") || "unknown";
  }

  record(fields: IncidentFields): IncidentReference {
    const reference = { incidentId: nextIncidentId() };
    if (this.disabled) return reference;
    const record = {
      timestamp: this.options.now().toISOString(),
      incidentId: reference.incidentId,
      hostId: this.hostId,
      runEpoch: this.options.runEpoch,
      revision: this.options.revision,
      sessionHash: stableHash(this.key, "session", fields.sessionId),
      browserHash: stableHash(this.key, "browser", fields.browserId),
      pageHash: stableHash(this.key, "page", fields.pageId),
      runtimeKind: fields.runtimeKind || null,
      rpcGeneration: integer(fields.rpcGeneration),
      rpcRequestId: fields.rpcRequestId && REQUEST_ID_PATTERN.test(fields.rpcRequestId)
        ? fields.rpcRequestId
        : null,
      childPid: integer(fields.childPid),
      operation: fields.operation,
      lifecycle: fields.lifecycle || "idle",
      queueLength: integer(fields.queueLength),
      controlState: fields.controlState || null,
      outcome: fields.outcome,
      durationMs: integer(fields.durationMs),
      errorCode: fields.errorCode && ERROR_CODE_PATTERN.test(fields.errorCode)
        ? fields.errorCode
        : null,
    };
    const line = `${JSON.stringify(record)}\n`;
    this.tail = this.tail.then(() => this.append(line)).catch((error) => {
      this.disabled = true;
      console.error(`[Pi Chat] 本地 incident 日志已禁用：${error instanceof Error ? error.message : String(error)}`);
    });
    return reference;
  }

  async flush(): Promise<void> { await this.tail; }
  async close(): Promise<void> { await this.flush(); }

  private async append(line: string): Promise<void> {
    const path = join(this.directory, "incidents.jsonl");
    let size = 0;
    try { size = (await stat(path)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (size && size + Buffer.byteLength(line) > this.options.maximumBytes)
      await this.rotate(path);
    const handle = await open(path, "a", 0o600);
    try { await handle.writeFile(line, "utf8"); }
    finally { await handle.close(); }
    if (process.platform !== "win32") await chmod(path, 0o600);
  }

  private async rotate(path: string): Promise<void> {
    await rm(`${path}.${this.options.archiveCount}`, { force: true });
    for (let index = this.options.archiveCount - 1; index >= 1; index -= 1) {
      try { await rename(`${path}.${index}`, `${path}.${index + 1}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    try { await rename(path, `${path}.1`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

class NullIncidentDiagnostics implements IncidentDiagnostics {
  readonly directory = null;
  readonly hostId = "disabled";
  record(): IncidentReference { return { incidentId: nextIncidentId() }; }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

export async function createIncidentDiagnostics(
  options: IncidentDiagnosticsOptions,
): Promise<IncidentDiagnostics> {
  try {
    const directory = resolve(options.directory || defaultDirectory());
    // Default storage is outside the project/workspace. Keep initialization
    // best-effort: diagnostics must never prevent local chat startup.
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const key = options.key || await loadKey(directory);
    return new FileIncidentDiagnostics(directory, key, {
      runEpoch: options.runEpoch,
      revision: options.revision,
      maximumBytes: Math.max(4 * 1024, options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES),
      archiveCount: Math.max(1, Math.floor(options.archiveCount ?? DEFAULT_ARCHIVE_COUNT)),
      now: options.now || (() => new Date()),
    });
  } catch (error) {
    console.error(`[Pi Chat] 本地 incident 日志初始化失败，已禁用：${error instanceof Error ? error.message : String(error)}`);
    return new NullIncidentDiagnostics();
  }
}
