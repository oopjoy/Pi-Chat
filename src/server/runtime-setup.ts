import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { RuntimeEntryInfo, RuntimeSetupChange, RuntimeSetupStatus } from "../shared/runtime-setup.js";
import { writeFileAtomic } from "./file-transaction.js";
import { HttpRequestError } from "./http-transport.js";
import { resolvePiEntry, resolvePiVersion } from "./rpc-client.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function parseRuntimeSetupChange(body: Record<string, unknown>): RuntimeSetupChange {
  if (typeof body.mode !== "string" || !["retry", "automatic", "select"].includes(body.mode)
    || typeof body.configurationRevision !== "string" || !/^[a-f0-9]{64}$/.test(body.configurationRevision)
    || Object.keys(body).some(key => !["mode", "configurationRevision", "entry"].includes(key))
    || (body.mode === "select" ? typeof body.entry !== "string" || !body.entry.trim() || body.entry.length > 4096 : body.entry !== undefined)) {
    throw new HttpRequestError(400, "Pi 入口设置请求无效，请重新检测后操作", "RUNTIME_SETUP_INVALID");
  }
  return body as unknown as RuntimeSetupChange;
}

/** Selection is an explicit local-code trust decision, not an arbitrary file launcher. */
export function validateRuntimeEntry(value: string): RuntimeEntryInfo {
  try {
    if (!isAbsolute(value) || value.length > 4096 || value.includes("\0")) throw new Error("invalid path");
    const entry = realpathSync(value);
    if (basename(entry) !== "rpc-entry.js" || basename(dirname(entry)) !== "dist" || !statSync(entry).isFile()) throw new Error("not an RPC entry");
    const manifestPath = join(dirname(dirname(entry)), "package.json");
    if (statSync(manifestPath).size > 128 * 1024) throw new Error("metadata too large");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown; version?: unknown };
    if (manifest.name !== "@earendil-works/pi-coding-agent" || typeof manifest.version !== "string" || !manifest.version || manifest.version.length > 100) throw new Error("not Pi metadata");
    return { entry, version: manifest.version };
  } catch {
    throw new HttpRequestError(400, "请选择可信 Pi 安装包中的 dist/rpc-entry.js，并确认上级 package.json 属于 @earendil-works/pi-coding-agent。不会执行所选文件进行验证。", "RUNTIME_ENTRY_INVALID");
  }
}

/** Per-checkout preference, not a second model/config store or a live launch-plan writer. */
export class RuntimeSetupStore {
  readonly path: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(projectRoot: string, agentDir: string, env: NodeJS.ProcessEnv = process.env) {
    let canonicalRoot = resolve(projectRoot);
    if (existsSync(canonicalRoot)) canonicalRoot = realpathSync(canonicalRoot);
    if (process.platform === "win32") canonicalRoot = canonicalRoot.toLowerCase();
    this.path = join(agentDir, "pi-chat", "runtime", `${digest(canonicalRoot).slice(0, 24)}.json`);
    this.env = { ...env };
  }

  private snapshot(): { raw: string | null; revision: string } {
    let raw: string | null = null;
    try {
      if (statSync(this.path).size > 16 * 1024) throw new Error("Pi 入口配置文件过大，请手动检查配置文件");
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { raw, revision: digest(raw === null ? "absent" : `present:${raw}`) };
  }

  private savedEntry(raw: string | null): string | null {
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw) as { schemaVersion?: unknown; entry?: unknown };
      if (value.schemaVersion !== 1 || !(value.entry === null || typeof value.entry === "string")) throw new Error("invalid config");
      return value.entry === null ? null : validateRuntimeEntry(value.entry).entry;
    } catch {
      throw new HttpRequestError(400, "已保存的 Pi 入口配置无效。请重新选择入口，或明确选择自动发现后应用。", "RUNTIME_CONFIG_INVALID");
    }
  }

  private automatic(): RuntimeEntryInfo | null {
    const env = { ...this.env };
    delete env.PI_CHAT_PI_ENTRY;
    const entry = resolvePiEntry(env);
    return entry ? { entry, version: resolvePiVersion(entry) } : null;
  }

  resolveLaunch(): { candidate: RuntimeEntryInfo | null; source: RuntimeSetupStatus["source"] } {
    if (this.env.PI_CHAT_PI_ENTRY?.trim()) {
      const entry = resolvePiEntry(this.env);
      return { candidate: entry ? { entry, version: resolvePiVersion(entry) } : null, source: "environment" };
    }
    const saved = this.savedEntry(this.snapshot().raw);
    if (saved) return { candidate: validateRuntimeEntry(saved), source: "saved" };
    return { candidate: this.automatic(), source: "automatic" };
  }

  status(current: RuntimeEntryInfo | null): RuntimeSetupStatus {
    const snapshot = this.snapshot();
    const environmentOverride = Boolean(this.env.PI_CHAT_PI_ENTRY?.trim());
    let configured: RuntimeEntryInfo | null = null;
    let automatic: RuntimeEntryInfo | null = null;
    let source: RuntimeSetupStatus["source"] = environmentOverride ? "environment" : snapshot.raw ? "saved" : "automatic";
    let error: string | undefined;
    let automaticError: string | undefined;
    try { ({ candidate: configured, source } = this.resolveLaunch()); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    try { automatic = this.automatic(); }
    catch { automaticError = "自动发现未能完成，请检查 Pi 安装或手动选择入口。"; }
    if (!error && !configured) error = "未发现可用的 Pi 安装。请先安装 Pi，或选择已有安装中的 dist/rpc-entry.js。";
    return { current, configured, automatic, source, environmentOverride, configurationRevision: snapshot.revision, error, automaticError, pickerAvailable: process.platform === "win32", restartAvailable: true };
  }

  /** Read-only preparation; persist only after the App's second quiescence check. */
  prepare(change: RuntimeSetupChange): { commit(): Promise<void> } {
    const check = (): RuntimeEntryInfo => {
      if (this.snapshot().revision !== change.configurationRevision)
        throw new HttpRequestError(409, "Pi 入口设置已变化，请重新检测后再应用。", "RUNTIME_CONFIG_CHANGED");
      if (this.env.PI_CHAT_PI_ENTRY?.trim() && change.mode !== "retry")
        throw new HttpRequestError(409, "PI_CHAT_PI_ENTRY 环境变量优先。请先在启动环境中修改或移除它，再重新启动 Pi Chat。", "RUNTIME_ENV_OVERRIDE");
      const candidate = change.mode === "select" ? validateRuntimeEntry(change.entry || "")
        : change.mode === "automatic" ? this.automatic() : this.resolveLaunch().candidate;
      if (!candidate) throw new HttpRequestError(400, "尚未发现 Pi，未修改配置或重启服务。请先完成安装再重新检测。", "RUNTIME_NOT_FOUND");
      return candidate;
    };
    const candidate = check();
    return { commit: async () => {
      const fresh = check();
      if (fresh.entry !== candidate.entry || fresh.version !== candidate.version)
        throw new HttpRequestError(409, "Pi 安装在检测后发生变化，请重新检测。", "RUNTIME_INSTALL_CHANGED");
      if (change.mode !== "retry") {
        await writeFileAtomic(this.path, `${JSON.stringify({ schemaVersion: 1, entry: change.mode === "select" ? fresh.entry : null }, null, 2)}\n`, 0o600);
      }
    } };
  }
}
