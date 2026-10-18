import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { writeFileAtomic } from "./file-transaction.js";
import { attachedFileLines } from "../shared/attachment-reference.js";
import { HttpRequestError } from "./http-transport.js";

export const MAX_STAGED_DROPPED_FILE_BYTES = 64 * 1024 * 1024;
export const DRAFT_ATTACHMENT_LEASE_MS = 30 * 24 * 60 * 60 * 1000;
export const STAGING_GRACE_MS = 24 * 60 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OWNER = /^[A-Za-z0-9_-]{1,128}$/;

export function attachmentDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  // Separate user data from both the install destination and sensitive Pi
  // config directories. Ordinary persisted reply links can still name files.
  const data = process.platform === "win32"
    ? env.LOCALAPPDATA || join(env.USERPROFILE || homedir(), "AppData", "Local")
    : env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  return resolve(data, "PiChatData", "attachments");
}

type Metadata = { version: 1; name: string; bytes: number; createdAt: number };
type Lease = { revision: number; expiresAt: number };
export type AttachmentStorageStats = { drafts: number; retained: number; bytes: number; removed: number; skipped: number; truncated: boolean };

export function safeDroppedFileName(name: string): string {
  let base = basename(name.replaceAll(String.fromCharCode(92), "/"))
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim();
  if (base.length > 160) {
    const extension = extname(base).slice(0, 16);
    base = base.slice(0, 160 - extension.length) + extension;
  }
  base = base.replace(/[. ]+$/, "");
  if (!base || base === "." || base === "..") base = "dropped.bin";
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  return base;
}

/** Immutable payloads, monotonic owner leases and a permanent possibly-sent marker. */
export class DroppedFileStore {
  readonly root: string;
  private maintenanceCursor = 0;
  constructor(root: string, private readonly now = Date.now) { this.root = resolve(root); }

  private parts(path: string): string[] | null {
    const parts = relative(this.root, resolve(path)).split(/[\\/]/);
    return parts.length === 3 && UUID.test(parts[0]) && parts[1] === "payload"
      && parts[2] === safeDroppedFileName(parts[2]) ? parts : null;
  }
  manages(path: string): boolean { return Boolean(this.parts(path)); }

  private async directory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("附件存储目录无效");
  }
  private async smallJson(path: string): Promise<unknown> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error("附件记录无效");
    return JSON.parse(await readFile(path, "utf8"));
  }
  private async metadata(entry: string, requireComplete = true): Promise<Metadata> {
    const data = await this.smallJson(join(entry, "metadata.json")) as Metadata;
    if (data.version !== 1 || typeof data.name !== "string" || data.name !== safeDroppedFileName(data.name)
      || !Number.isSafeInteger(data.bytes) || data.bytes < 1 || data.bytes > MAX_STAGED_DROPPED_FILE_BYTES
      || !Number.isFinite(data.createdAt)) throw new Error("附件记录无效");
    await this.directory(join(entry, "payload"));
    try {
      const file = await lstat(join(entry, "payload", data.name));
      if (!file.isFile() || file.isSymbolicLink() || file.size > data.bytes || requireComplete && file.size !== data.bytes)
        throw new Error("附件不存在或已被修改");
    } catch (error) {
      if (requireComplete || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return data;
  }
  private async retained(entry: string): Promise<boolean> {
    try {
      const info = await lstat(join(entry, "retained"));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("附件保留标记无效");
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  /** Cross-process lock: no cleanup can race an acknowledged lease/retain. */
  private async locked<T>(path: string, action: (entry: string, data: Metadata) => Promise<T>, requireComplete = true): Promise<T> {
    const parts = this.parts(path);
    if (!parts) throw new Error("路径无效");
    const entry = join(this.root, parts[0]);
    await this.directory(this.root);
    await this.directory(entry);
    const lock = join(entry, "lock");
    const deadline = Date.now() + 2500;
    let handle;
    while (!handle) {
      try {
        const acquired = await open(lock, "wx", 0o600);
        try { await acquired.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() })); }
        catch (error) { await acquired.close(); await unlink(lock).catch(() => undefined); throw error; }
        handle = acquired;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A crash must not strand a lock forever; never break a live PID's lock.
        try {
          const owner = await this.smallJson(lock) as { pid: number; at: number };
          if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && Date.now() - owner.at > 60_000) {
            try { process.kill(owner.pid, 0); }
            catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ESRCH") await unlink(lock); }
          }
        } catch { /* unknown lock ownership fails closed */ }
        if (Date.now() >= deadline) throw new Error("附件正在保存或维护，请稍后再试");
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    try {
      const data = await this.metadata(entry, requireComplete);
      if (data.name !== parts[2]) throw new Error("路径无效");
      return await action(entry, data);
    } finally { await handle.close(); await unlink(lock).catch(() => undefined); }
  }

  async ensureDirectory(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.directory(this.root);
  }

  async stage(name: string, bytes: Buffer, owner: string): Promise<string> {
    if (!OWNER.test(owner)) throw new Error("附件草稿归属无效");
    if (!bytes.length || bytes.length > MAX_STAGED_DROPPED_FILE_BYTES) throw new Error("拖入的文件为空或超过 64 MB");
    await this.ensureDirectory();
    const entry = join(this.root, randomUUID());
    const data: Metadata = { version: 1, name: safeDroppedFileName(name), bytes: bytes.length, createdAt: this.now() };
    try {
      await mkdir(join(entry, "payload"), { recursive: true, mode: 0o700 });
      await mkdir(join(entry, "leases"), { mode: 0o700 });
      // Record ownership before the large write so an interrupted upload can
      // later be reclaimed without trusting an unknown UUID directory.
      await writeFileAtomic(join(entry, "metadata.json"), JSON.stringify(data), 0o600);
      await writeFile(join(entry, "payload", data.name), bytes, { mode: 0o600, flag: "wx" });
      // An unadopted upload gets a staging grace period, not a 30-day draft lease.
      await writeFileAtomic(join(entry, "leases", owner), JSON.stringify({ revision: 0, expiresAt: this.now() + STAGING_GRACE_MS }), 0o600);
      return join(entry, "payload", data.name);
    } catch (error) { await rm(entry, { recursive: true, force: true }); throw error; }
  }

  private async updateLease(entry: string, owner: string, revision: number, active: boolean): Promise<void> {
    if (!OWNER.test(owner) || !Number.isSafeInteger(revision) || revision < 1) throw new Error("附件租约无效");
    const directory = join(entry, "leases");
    await this.directory(directory);
    const path = join(directory, owner);
    let previous: Lease | undefined;
    try { previous = await this.smallJson(path) as Lease; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (previous && (!Number.isSafeInteger(previous.revision) || !Number.isFinite(previous.expiresAt)))
      throw new Error("附件租约记录无效");
    if (previous && previous.revision >= revision) return;
    await writeFileAtomic(path, JSON.stringify({ revision, expiresAt: active ? this.now() + DRAFT_ATTACHMENT_LEASE_MS : 0 }), 0o600);
  }
  private async hasLease(entry: string): Promise<boolean> {
    const directory = join(entry, "leases");
    await this.directory(directory);
    const names = await readdir(directory);
    const truncated = names.length > 512;
    for (const name of names.slice(0, 512)) {
      if (/^[A-Za-z0-9_-]{1,128}\.pi-chat-[0-9]+-[0-9]+-[a-f0-9]+\.tmp$/.test(name)) {
        const info = await lstat(join(directory, name));
        if (info.isFile() && !info.isSymbolicLink()) continue;
      }
      if (!OWNER.test(name)) return true;
      const lease = await this.smallJson(join(directory, name)) as Lease;
      if (!Number.isSafeInteger(lease.revision) || !Number.isFinite(lease.expiresAt)) return true;
      if (lease.expiresAt > this.now()) return true;
      await unlink(join(directory, name));
    }
    return truncated; // another bounded pass will inspect the remaining owners
  }

  async lease(paths: string[], owner: string, revision: number, active: boolean): Promise<string[]> {
    const missing: string[] = [];
    for (const path of new Set(paths)) {
      if (!this.manages(path)) continue; // arbitrary user files are not cache entries
      try {
        if (active) await this.locked(path, async (entry) => this.updateLease(entry, owner, revision, true));
        else await this.discard(path, owner, revision);
      } catch { missing.push(path); }
    }
    return missing;
  }

  /** Must succeed before the existing send pipeline can hand a path to Pi. */
  async retainPrompt(message: string): Promise<void> {
    try {
      const paths = [...new Set(attachedFileLines(message).filter((path) => this.manages(path)))];
      if (paths.length > 32) throw new Error("附件过多");
      await this.retain(paths);
    } catch {
      // This is a definite preflight failure, not an unknown Pi write outcome.
      throw new HttpRequestError(400, "本地附件不存在或无法保留，消息未提交给 Pi；请重新附加文件", "ATTACHMENT_UNAVAILABLE");
    }
  }

  async retain(paths: string[]): Promise<void> {
    for (const path of new Set(paths)) {
      if (!this.manages(path)) continue;
      await this.locked(path, async (entry) => {
        if (!await this.retained(entry))
          await writeFile(join(entry, "retained"), String(this.now()), { mode: 0o600, flag: "wx" });
      });
    }
  }

  async discard(path: string, owner: string, revision: number): Promise<void> {
    if (!this.manages(path)) throw new Error("路径无效");
    let removed = false;
    try {
      removed = await this.locked(path, async (entry, data) => {
        await this.updateLease(entry, owner, revision, false);
        if (await this.retained(entry) || await this.hasLease(entry)) return false;
        await unlink(join(entry, "payload", data.name));
        return true;
      });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (removed) await this.removeEmptyShell(join(this.root, this.parts(path)![0]));
  }

  private async removeEmptyShell(entry: string): Promise<void> {
    // Never recursively erase extra files a user or another program put here.
    // Delete only our known bookkeeping and then remove empty directories.
    try { await this.directory(this.root); await this.directory(entry); } catch { return; }
    const metadata = join(entry, "metadata.json");
    const metadataInfo = await lstat(metadata).catch(() => null);
    if (metadataInfo?.isFile() && !metadataInfo.isSymbolicLink()) await unlink(metadata).catch(() => undefined);
    const leases = join(entry, "leases");
    try { await this.directory(leases); } catch { return; }
    for (const name of await readdir(leases).catch(() => [] as string[])) {
      if (!OWNER.test(name) && !/^[A-Za-z0-9_-]{1,128}\.pi-chat-[0-9]+-[0-9]+-[a-f0-9]+\.tmp$/.test(name)) continue;
      const path = join(leases, name);
      const info = await lstat(path).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) await unlink(path).catch(() => undefined);
    }
    await rmdir(leases).catch(() => undefined);
    await rmdir(join(entry, "payload")).catch(() => undefined);
    await rmdir(entry).catch(() => undefined);
  }

  async maintain(cleanup = true): Promise<AttachmentStorageStats> {
    const result: AttachmentStorageStats = { drafts: 0, retained: 0, bytes: 0, removed: 0, skipped: 0, truncated: false };
    let entries: string[];
    try { await this.directory(this.root); entries = await readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
    result.truncated = entries.length > 10_000;
    entries.sort();
    if (this.maintenanceCursor >= entries.length) this.maintenanceCursor = 0;
    const batch = entries.slice(this.maintenanceCursor, this.maintenanceCursor + 10_000);
    this.maintenanceCursor = this.maintenanceCursor + batch.length >= entries.length ? 0 : this.maintenanceCursor + batch.length;
    for (const id of batch) {
      if (!UUID.test(id)) { result.skipped += 1; continue; }
      const entry = join(this.root, id);
      try {
        await this.directory(entry);
        const data = await this.metadata(entry, false);
        const path = join(entry, "payload", data.name);
        const status = await this.locked(path, async (directory, metadata) => {
          if (await this.retained(directory)) {
            if (cleanup) await this.hasLease(directory).catch(() => true); // prune expired bookkeeping only
            return "retained";
          }
          if (cleanup && this.now() - metadata.createdAt >= STAGING_GRACE_MS && !await this.hasLease(directory)) {
            await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
            return "removed";
          }
          return "draft";
        }, false);
        if (status === "removed") {
          result.removed += 1;
          await this.removeEmptyShell(entry);
        } else {
          result.bytes += data.bytes;
          if (status === "retained") result.retained += 1;
          else result.drafts += 1;
        }
      } catch { result.skipped += 1; /* malformed, locked or unowned entries are conservatively retained */ }
    }
    return result;
  }
}
